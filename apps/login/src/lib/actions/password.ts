"use server";

import { completeFlowOrGetUrl } from "@/lib/actions/flow";
import { usableEmail } from "@/lib/placeholder-email";
import { equalsIgnoreCase } from "@/lib/server/auth-utils";
import { getSessionCookieById, getSessionCookieByLoginName } from "@/lib/server/cookies";
import {
  discardFirstAccessTicket,
  FIRST_ACCESS_COOKIE_NAME,
  FIRST_ACCESS_TTL_MS,
  storeFirstAccessTicket,
  takeFirstAccessTicket,
} from "@/lib/server/first-access-ticket";
import { isClassifiedError } from "@/lib/server/grpc/interceptors/error-classification";
import { getPublicHostWithProtocol } from "@/lib/server/host";
import { resolveLegacyIdentifier, substituteLoginName } from "@/lib/server/legacy-identifier";
import { createLogger } from "@/lib/server/logger";
import { recordAuthAttempt, recordAuthFailure, recordAuthSuccess } from "@/lib/server/metrics";
import { tryLegacyFirstAccess } from "@/lib/server/password";
import { getPasswordCheckLifetime } from "@/lib/server/password-policy";
import { getServiceConfig } from "@/lib/server/service-url";
import { createSessionAndUpdateCookie, setSessionAndUpdateCookie } from "@/lib/server/session-cookie";
import {
  checkEmailVerification,
  checkMFAFactors,
  checkPasswordChangeRequired,
  checkUserVerification,
} from "@/lib/server/verify-helper";
import {
  getLockoutSettings,
  getLoginSettings,
  getPasswordExpirySettings,
  getSession,
  getUserByID,
  listAuthenticationMethodTypes,
  passwordReset,
  searchUsers,
  setPassword,
  setUserPassword,
} from "@/lib/server/zitadel";
import { Code, create } from "@zitadel/client";
import { Checks, ChecksSchema } from "@zitadel/proto/zitadel/session/v2/session_service_pb";
import { LoginSettings } from "@zitadel/proto/zitadel/settings/v2/login_settings_pb";
import { User, UserState } from "@zitadel/proto/zitadel/user/v2/user_pb";
import { SetPasswordRequestSchema } from "@zitadel/proto/zitadel/user/v2/user_service_pb";
import { getTranslations } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { setTimeout as delay } from "node:timers/promises";

const logger = createLogger("password");

type ResetPasswordCommand = {
  loginName: string;
  organization?: string;
  defaultOrganization?: string;
  requestId?: string;
};

export async function resetPassword(command: ResetPasswordCommand) {
  const _headers = await headers();
  const { serviceConfig } = getServiceConfig(_headers);

  const t = await getTranslations("password");

  // Get the original host that the user sees with protocol
  const hostWithProtocol = await getPublicHostWithProtocol(_headers);

  const loginSettings = await getLoginSettings({
    serviceConfig,
    organization: command.organization ?? command.defaultOrganization,
  });

  if (!loginSettings) {
    return { error: t("errors.couldNotSendResetLink") };
  }

  if (loginSettings.hidePasswordReset) {
    return { error: t("errors.passwordResetNotAllowed") };
  }

  if (loginSettings.allowLocalAuthentication) {
    const resolved = await resolveLegacyIdentifier(command.loginName);
    command = { ...command, loginName: substituteLoginName(command.loginName, resolved) };
  }

  const searchResult = await searchUsers({
    serviceConfig,
    searchValue: command.loginName,
    organizationId: command.organization,
    loginSettings,
  });

  if (
    !searchResult ||
    !("result" in searchResult) ||
    !searchResult.result ||
    searchResult.result.length !== 1 ||
    !searchResult.result[0].userId
  ) {
    if (loginSettings?.ignoreUnknownUsernames) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return {};
    }
    return { error: t("errors.couldNotSendResetLink") };
  }
  const user = searchResult.result[0];
  const humanUser = user.type.case === "human" ? user.type.value : undefined;

  const userLoginSettings = await getLoginSettings({ serviceConfig, organization: user.details?.resourceOwner });

  if (!userLoginSettings || userLoginSettings.hidePasswordReset) {
    return { error: t("errors.passwordResetNotAllowed") };
  }

  if (userLoginSettings?.disableLoginWithEmail && userLoginSettings?.disableLoginWithPhone) {
    if (!equalsIgnoreCase(user.preferredLoginName, command.loginName)) {
      if (userLoginSettings?.ignoreUnknownUsernames) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return {};
      }
      return { error: t("errors.couldNotSendResetLink") };
    }
  } else if (userLoginSettings?.disableLoginWithEmail) {
    if (
      !equalsIgnoreCase(user.preferredLoginName, command.loginName) &&
      !equalsIgnoreCase(humanUser?.phone?.phone, command.loginName)
    ) {
      if (userLoginSettings?.ignoreUnknownUsernames) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return {};
      }
      return { error: t("errors.couldNotSendResetLink") };
    }
  } else if (userLoginSettings?.disableLoginWithPhone) {
    if (
      !equalsIgnoreCase(user.preferredLoginName, command.loginName) &&
      !equalsIgnoreCase(humanUser?.email?.email, command.loginName)
    ) {
      if (userLoginSettings?.ignoreUnknownUsernames) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return {};
      }
      return { error: t("errors.couldNotSendResetLink") };
    }
  }

  if (!humanUser || !usableEmail(humanUser.email?.email)) {
    return { error: t("errors.noUsableResetEmail") };
  }

  const userId = user.userId;
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

  return passwordReset({
    serviceConfig,
    userId,
    urlTemplate:
      `${hostWithProtocol}${basePath}/password/set?code={{.Code}}&userId={{.UserID}}&organization={{.OrgID}}` +
      (command.requestId ? `&requestId=${command.requestId}` : ""),
  });
}

export type UpdateSessionCommand = {
  loginName: string;
  organization?: string;
  defaultOrganization?: string;
  checks: Checks;
  requestId?: string;
};

export async function sendPassword(
  command: UpdateSessionCommand,
): Promise<{ error: string } | { redirect: string } | { samlData: { url: string; fields: Record<string, string> } }> {
  const _headers = await headers();
  const { serviceConfig } = getServiceConfig(_headers);
  const t = await getTranslations("password");

  recordAuthAttempt("password", command.organization);

  let session;
  let user: User | undefined;
  const loginSettingsByContext = await getLoginSettings({
    serviceConfig,
    organization: command.organization ?? command.defaultOrganization,
  });
  let loginSettingsByUser: LoginSettings | undefined;

  if (!loginSettingsByContext) {
    recordAuthFailure("password", "settings_unavailable", command.organization);
    return { error: t("errors.couldNotVerifyPassword") };
  }

  if (!loginSettingsByContext.allowLocalAuthentication) {
    recordAuthFailure("password", "local_auth_not_allowed", command.organization);
    return { error: t("errors.localAuthenticationNotAllowed") };
  }

  const resolved = await resolveLegacyIdentifier(command.loginName);
  command = { ...command, loginName: substituteLoginName(command.loginName, resolved) };
  let sessionCookie = await getSessionCookieByLoginName({
    loginName: command.loginName,
    organization: command.organization,
  });

  if (sessionCookie) {
    try {
      loginSettingsByUser = await getLoginSettings({ serviceConfig, organization: sessionCookie.organization });

      if (loginSettingsByUser) {
        if (!loginSettingsByUser.allowLocalAuthentication) {
          recordAuthFailure("password", "local_auth_not_allowed", command.organization);
          return { error: t("errors.localAuthenticationNotAllowed") };
        }

        const lifetime = getPasswordCheckLifetime(loginSettingsByUser);

        session = await setSessionAndUpdateCookie({
          recentCookie: sessionCookie,
          // Only the password check: any other check the caller sends would get the password check lifetime.
          checks: create(ChecksSchema, {
            password: { password: command.checks.password?.password },
          }),
          requestId: command.requestId,
          lifetime,
        });
      } else {
        // Force fallback if settings can't be loaded
        throw new Error("Could not load login settings");
      }
    } catch {
      logger.warn("[Password] Could not update session");
      // If the session was terminated or any other error occurred during update,
      // we fall back to creating a new session.
      sessionCookie = undefined;
      session = undefined;
    }
  }

  if (!sessionCookie) {
    // Resolve the user again if the previous session has expired or terminated.
    const searchResult = await searchUsers({
      serviceConfig,
      searchValue: command.loginName,
      organizationId: command.organization,
      loginSettings: loginSettingsByContext,
    });

    if (
      searchResult &&
      "result" in searchResult &&
      searchResult.result &&
      searchResult.result.length === 1 &&
      searchResult.result[0].userId
    ) {
      user = searchResult.result[0];
      const humanUser = user.type.case === "human" ? user.type.value : undefined;

      const userLoginSettings = await getLoginSettings({ serviceConfig, organization: user.details?.resourceOwner });

      if (!userLoginSettings) {
        recordAuthFailure("password", "settings_unavailable", command.organization);
        return {
          error: t(
            loginSettingsByContext.ignoreUnknownUsernames
              ? "errors.failedToAuthenticateNoLimit"
              : "errors.couldNotVerifyPassword",
          ),
        };
      }
      if (!userLoginSettings.allowLocalAuthentication) {
        recordAuthFailure("password", "local_auth_not_allowed", command.organization);
        if (loginSettingsByContext?.ignoreUnknownUsernames) {
          return { error: t("errors.failedToAuthenticateNoLimit") };
        }
        return { error: t("errors.localAuthenticationNotAllowed") };
      }
      loginSettingsByUser = userLoginSettings;

      // recheck login settings after user discovery, as the search might have been done without org scope
      if (userLoginSettings.disableLoginWithEmail && userLoginSettings.disableLoginWithPhone) {
        if (!equalsIgnoreCase(user.preferredLoginName, command.loginName)) {
          // emulate user not found to prevent enumeration (use context settings not user settings)
          recordAuthFailure("password", "login_name_mismatch", command.organization);
          if (loginSettingsByContext?.ignoreUnknownUsernames) {
            return { error: t("errors.failedToAuthenticateNoLimit") };
          }
          return { error: t("errors.couldNotVerifyPassword") };
        }
      } else if (userLoginSettings.disableLoginWithEmail) {
        if (
          !equalsIgnoreCase(user.preferredLoginName, command.loginName) &&
          !equalsIgnoreCase(humanUser?.phone?.phone, command.loginName)
        ) {
          recordAuthFailure("password", "login_name_mismatch", command.organization);
          if (loginSettingsByContext?.ignoreUnknownUsernames) {
            return { error: t("errors.failedToAuthenticateNoLimit") };
          }
          return { error: t("errors.couldNotVerifyPassword") };
        }
      } else if (userLoginSettings.disableLoginWithPhone) {
        if (
          !equalsIgnoreCase(user.preferredLoginName, command.loginName) &&
          !equalsIgnoreCase(humanUser?.email?.email, command.loginName)
        ) {
          recordAuthFailure("password", "login_name_mismatch", command.organization);
          if (loginSettingsByContext?.ignoreUnknownUsernames) {
            return { error: t("errors.failedToAuthenticateNoLimit") };
          }
          return { error: t("errors.couldNotVerifyPassword") };
        }
      }

      const checks = create(ChecksSchema, {
        user: { search: { case: "userId", value: user.userId } },
        password: { password: command.checks.password?.password },
      });

      try {
        const result = await createSessionAndUpdateCookie({
          checks,
          requestId: command.requestId,
          lifetime: getPasswordCheckLifetime(userLoginSettings),
        });
        session = result.session;
        sessionCookie = result.sessionCookie;
      } catch (error: any) {
        const bridged = await tryLegacyFirstAccess({
          serviceConfig,
          userId: user.userId,
          loginName: user.preferredLoginName ?? command.loginName,
          password: command.checks.password?.password,
        });

        if (bridged === "mismatch") {
          recordAuthFailure("password", "first_access_id_mismatch", command.organization);
          return { error: t("firstAccess.errors.integrity") };
        }

        if (bridged) {
          const handle = storeFirstAccessTicket({
            userId: bridged.userId,
            resetCode: bridged.resetCode,
            loginName: user.preferredLoginName ?? command.loginName,
            organization: command.organization,
            defaultOrganization: command.defaultOrganization,
            requestId: command.requestId,
          });
          const cookiesList = await cookies();
          cookiesList.set({
            name: FIRST_ACCESS_COOKIE_NAME,
            value: handle,
            httpOnly: true,
            path: "/",
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
            maxAge: FIRST_ACCESS_TTL_MS / 1000,
          });
          return { redirect: "/password/first-access" };
        }

        if ("failedAttempts" in error && error.failedAttempts) {
          recordAuthFailure("password", "invalid_password", command.organization);
          if (loginSettingsByContext?.ignoreUnknownUsernames) {
            return { error: t("errors.failedToAuthenticateNoLimit") };
          }
          const lockoutSettings = await getLockoutSettings({ serviceConfig, orgId: command.organization });

          const hasLimit =
            lockoutSettings?.maxPasswordAttempts !== undefined && lockoutSettings?.maxPasswordAttempts > BigInt(0);
          const locked = hasLimit && error.failedAttempts >= lockoutSettings?.maxPasswordAttempts;
          const messageKey = hasLimit ? "errors.failedToAuthenticate" : "errors.failedToAuthenticateNoLimit";

          return {
            error: t(messageKey, {
              failedAttempts: error.failedAttempts,
              maxPasswordAttempts: hasLimit ? String(lockoutSettings?.maxPasswordAttempts ?? 0) : "?",
              lockoutMessage: locked ? t("errors.accountLockedContactAdmin") : "",
            }),
          };
        }
        recordAuthFailure("password", "session_creation_failed", command.organization);
        if (loginSettingsByContext?.ignoreUnknownUsernames) {
          return { error: t("errors.failedToAuthenticateNoLimit") };
        }
        return { error: t("errors.couldNotCreateSessionForUser") };
      }
    } else {
      // this is a fake error message to hide that the user does not even exist
      recordAuthFailure("password", "user_not_found", command.organization);
      if (loginSettingsByContext?.ignoreUnknownUsernames) {
        return { error: t("errors.failedToAuthenticateNoLimit") };
      }
      return { error: t("errors.couldNotVerifyPassword") };
    }
  }

  if (!session?.factors?.user?.id) {
    recordAuthFailure("password", "session_invalid", command.organization);
    if (loginSettingsByContext?.ignoreUnknownUsernames) {
      return { error: t("errors.failedToAuthenticateNoLimit") };
    }
    return { error: t("errors.couldNotCreateSessionForUser") };
  }

  if (!user) {
    const userResponse = await getUserByID({ serviceConfig, userId: session?.factors?.user?.id });
    if (!userResponse.user) {
      recordAuthFailure("password", "user_not_found", command.organization);
      return { error: t("errors.userNotFound") };
    }
    user = userResponse.user;
  }

  if (!session?.factors?.user?.id || !sessionCookie) {
    recordAuthFailure("password", "session_invalid", command.organization);
    if (loginSettingsByContext?.ignoreUnknownUsernames) {
      return { error: t("errors.failedToAuthenticateNoLimit") };
    }
    return { error: t("errors.couldNotCreateSessionForUser") };
  }

  if (!loginSettingsByUser) {
    loginSettingsByUser = await getLoginSettings({
      serviceConfig,
      organization: command.organization ?? session.factors?.user?.organizationId ?? command.defaultOrganization,
    });
  }

  const humanUser = user.type.case === "human" ? user.type.value : undefined;

  const expirySettings = await getPasswordExpirySettings({
    serviceConfig,
    orgId: command.organization ?? session.factors?.user?.organizationId,
  });

  // check if the user has to change password first
  const passwordChangedCheck = checkPasswordChangeRequired(
    expirySettings,
    session,
    humanUser,
    command.organization,
    command.requestId,
  );

  if (passwordChangedCheck?.redirect) {
    return passwordChangedCheck;
  }

  // throw error if user is in initial state here and do not continue
  if (user.state === UserState.INITIAL) {
    recordAuthFailure("password", "user_initial_state", command.organization);
    return { error: t("errors.initialUserNotSupported") };
  }

  // check to see if user was verified
  const emailVerificationCheck = await checkEmailVerification(session, humanUser, command.organization, command.requestId);

  if (emailVerificationCheck?.redirect) {
    return emailVerificationCheck;
  }

  // if password, check if user has MFA methods
  let authMethods;
  if (command.checks && command.checks.password && session.factors?.user?.id) {
    const response = await listAuthenticationMethodTypes({ serviceConfig, userId: session.factors.user.id });
    if (response.authMethodTypes && response.authMethodTypes.length) {
      authMethods = response.authMethodTypes;
    }
  }

  if (!authMethods) {
    recordAuthFailure("password", "no_auth_methods", command.organization);
    return { error: t("errors.couldNotVerifyPassword") };
  }

  const mfaFactorCheck = await checkMFAFactors(
    serviceConfig,
    session,
    loginSettingsByUser,
    authMethods,
    command.organization,
    command.requestId,
  );

  if (mfaFactorCheck?.redirect) {
    return mfaFactorCheck;
  }

  let result: Awaited<ReturnType<typeof completeFlowOrGetUrl>>;

  if (command.requestId && session.id) {
    // OIDC/SAML flow
    logger.info("Password auth: OIDC/SAML flow with requestId:", { requestId: command.requestId, sessionId: session.id });
    result = await completeFlowOrGetUrl(
      {
        sessionId: session.id,
        requestId: command.requestId,
        organization: command.organization ?? session.factors?.user?.organizationId,
      },
      loginSettingsByUser?.defaultRedirectUri,
    );
  } else {
    // Regular flow (no requestId)
    logger.info("Password auth: Regular flow with loginName:", { loginName: session.factors.user.loginName });
    result = await completeFlowOrGetUrl(
      {
        loginName: session.factors.user.loginName,
        organization: session.factors?.user?.organizationId,
      },
      loginSettingsByUser?.defaultRedirectUri,
    );
  }

  if (result && typeof result === "object") {
    if ("redirect" in result) {
      recordAuthSuccess("password", command.organization);
    } else if ("error" in result) {
      recordAuthFailure("password", "flow_error", command.organization);
    }
    return result;
  }

  recordAuthFailure("password", "navigation_failed", command.organization);
  return { error: "Authentication completed but navigation failed" };
}

/**
 * The legacy credential only proves identity. Install the user's chosen
 * password using the server-side reset ticket, then run normal authentication.
 */
export async function completeFirstAccess({
  password,
}: {
  password: string;
}): Promise<{ error: string } | { redirect: string } | { samlData: { url: string; fields: Record<string, string> } }> {
  const _headers = await headers();
  const { serviceConfig } = getServiceConfig(_headers);
  const t = await getTranslations("password");
  const cookiesList = await cookies();
  const handle = cookiesList.get(FIRST_ACCESS_COOKIE_NAME)?.value;
  const ticket = takeFirstAccessTicket(handle);

  if (!ticket) {
    return { error: t("firstAccess.errors.expired") };
  }

  const contextSettings = await getLoginSettings({
    serviceConfig,
    organization: ticket.organization ?? ticket.defaultOrganization,
  });
  const { user } = await getUserByID({ serviceConfig, userId: ticket.userId });
  if (!user || user.userId !== ticket.userId || !contextSettings) {
    return { error: t("set.errors.couldNotSetPassword") };
  }
  const userSettings = await getLoginSettings({ serviceConfig, organization: user.details?.resourceOwner });
  if (!userSettings) {
    return { error: t("set.errors.couldNotSetPassword") };
  }
  if (!contextSettings.allowLocalAuthentication || !userSettings.allowLocalAuthentication) {
    return { error: t("errors.localAuthenticationNotAllowed") };
  }

  try {
    const result = await setUserPassword({
      serviceConfig,
      userId: ticket.userId,
      password,
      code: ticket.resetCode,
    });
    if (result && "error" in result && result.error) {
      return { error: result.error };
    }
  } catch (error: unknown) {
    const isUserError = isClassifiedError(error)
      ? error.isUserError
      : error instanceof Error && error.name === "ConnectError";
    if (isUserError && error instanceof Error && error.message) {
      return { error: String(error.message).replace(/^\[[a-z_]+\]\s*/, "") };
    }
    logger.warn("could not set first-access password", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { error: t("set.errors.couldNotSetPassword") };
  }

  discardFirstAccessTicket(handle);
  cookiesList.delete(FIRST_ACCESS_COOKIE_NAME);
  await delay(2000);

  return sendPassword({
    loginName: ticket.loginName,
    organization: ticket.organization,
    defaultOrganization: ticket.defaultOrganization,
    requestId: ticket.requestId,
    checks: create(ChecksSchema, { password: { password } }),
  });
}

// this function lets users with code set a password or users with valid User Verification Check
export async function changePassword(command: { code?: string; userId: string; password: string; organization?: string }) {
  const _headers = await headers();
  const { serviceConfig } = getServiceConfig(_headers);
  const t = await getTranslations("password");

  // check for init state
  const { user } = await getUserByID({ serviceConfig, userId: command.userId });

  if (!user || user.userId !== command.userId) {
    const loginSettings = await getLoginSettings({ serviceConfig, organization: command.organization });
    if (loginSettings?.ignoreUnknownUsernames) {
      return { error: t("set.errors.couldNotSetPassword") };
    }
    return { error: t("errors.couldNotSendResetLink") };
  }
  const userId = user.userId;

  if (user.state === UserState.INITIAL) {
    return { error: t("errors.userInitialStateNotSupported") };
  }

  if (command.code && (user.type.case !== "human" || !usableEmail(user.type.value.email?.email))) {
    return { error: t("errors.noUsableResetEmail") };
  }

  // check if the user has no password set in order to set a password
  if (!command.code) {
    const authmethods = await listAuthenticationMethodTypes({ serviceConfig, userId });

    // if the user has no authmethods set, we need to check if the user was verified
    if (authmethods.authMethodTypes.length !== 0) {
      return {
        error: t("errors.codeOrVerificationRequired"),
      };
    }

    // check if a verification was done earlier
    const hasValidUserVerificationCheck = await checkUserVerification(user.userId);

    if (!hasValidUserVerificationCheck) {
      return { error: t("errors.verificationRequired") };
    }
  }

  return setUserPassword({ serviceConfig, userId, password: command.password, code: command.code });
}

type CheckSessionAndSetPasswordCommand = {
  sessionId: string;
  currentPassword: string;
  password: string;
};

export async function checkSessionAndSetPassword({
  sessionId,
  currentPassword,
  password,
}: CheckSessionAndSetPasswordCommand) {
  const _headers = await headers();
  const { serviceConfig } = getServiceConfig(_headers);
  const t = await getTranslations("password");

  const sessionCookie = await getSessionCookieById({ sessionId });

  if (!sessionCookie) {
    return { error: "Could not load session cookie" };
  }

  let session;
  try {
    const sessionResponse = await getSession({
      serviceConfig,
      sessionId: sessionCookie.id,
      sessionToken: sessionCookie.token,
    });
    session = sessionResponse.session;
  } catch (error) {
    logger.error("Error getting session:", { error });
    return { error: "Could not load session" };
  }

  if (!session || !session.factors?.user?.id) {
    return { error: t("errors.couldNotLoadSession") };
  }

  const loginSettings = await getLoginSettings({
    serviceConfig,
    organization: sessionCookie.organization,
  });

  if (!loginSettings) {
    return { error: t("change.errors.couldNotVerifyPassword") };
  }

  if (!loginSettings.allowLocalAuthentication) {
    return { error: t("errors.localAuthenticationNotAllowed") };
  }

  const lifetime = getPasswordCheckLifetime(loginSettings);

  const checks = create(ChecksSchema, {
    password: { password: currentPassword },
  });

  try {
    await setSessionAndUpdateCookie({
      recentCookie: sessionCookie,
      checks,
      lifetime,
      requestId: sessionCookie.requestId,
    });
  } catch (error: any) {
    if ("failedAttempts" in error && error.failedAttempts) {
      if (loginSettings?.ignoreUnknownUsernames) {
        return { error: t("errors.failedToAuthenticateNoLimit") };
      }
      const lockoutSettings = await getLockoutSettings({ serviceConfig, orgId: sessionCookie.organization });

      const hasLimit =
        lockoutSettings?.maxPasswordAttempts !== undefined && lockoutSettings?.maxPasswordAttempts > BigInt(0);
      const locked = hasLimit && error.failedAttempts >= lockoutSettings?.maxPasswordAttempts;
      const messageKey = hasLimit ? "errors.failedToAuthenticate" : "errors.failedToAuthenticateNoLimit";

      return {
        error: t(messageKey, {
          failedAttempts: error.failedAttempts,
          maxPasswordAttempts: hasLimit ? String(lockoutSettings?.maxPasswordAttempts ?? 0) : "?",
          lockoutMessage: locked ? t("errors.accountLockedContactAdmin") : "",
        }),
      };
    }
    if (loginSettings?.ignoreUnknownUsernames) {
      return { error: t("change.errors.couldNotVerifyPassword") };
    }
    return { error: t("change.errors.currentPasswordInvalid") };
  }

  const payload = create(SetPasswordRequestSchema, {
    userId: session.factors.user.id,
    newPassword: {
      password,
    },
  });

  return setPassword({ serviceConfig, payload }).catch((error) => {
    // throw error if failed precondition (ex. User is not yet initialized)
    if (isClassifiedError(error) && error.code === Code.FailedPrecondition && error.message) {
      return { error: t("errors.failedPrecondition") };
    }
    return { error: "Could not set password" };
  });
}
