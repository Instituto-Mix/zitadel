"use server";

import { isClassifiedError } from "@/lib/grpc/interceptors/error-classification";
import { createLogger } from "@/lib/logger";
import { recordAuthAttempt, recordAuthFailure, recordAuthSuccess } from "@/lib/metrics";
import { createSessionAndUpdateCookie, setSessionAndUpdateCookie } from "@/lib/server/cookie";
import {
  discardFirstAccessTicket,
  FIRST_ACCESS_COOKIE_NAME,
  FIRST_ACCESS_TTL_MS,
  storeFirstAccessTicket,
  takeFirstAccessTicket,
} from "@/lib/server/first-access-ticket";
import { isLegacyMigrateEnabled, legacyMigratePassword } from "@/lib/server/legacy-migrate";
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
} from "@/lib/zitadel";
import { Code, create, Duration } from "@zitadel/client";
import { Checks, ChecksSchema } from "@zitadel/proto/zitadel/session/v2/session_service_pb";
import { LoginSettings } from "@zitadel/proto/zitadel/settings/v2/login_settings_pb";
import { User, UserState } from "@zitadel/proto/zitadel/user/v2/user_pb";
import { AuthenticationMethodType, SetPasswordRequestSchema } from "@zitadel/proto/zitadel/user/v2/user_service_pb";
import { getTranslations } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { completeFlowOrGetUrl } from "../client";
import { getSessionCookieById, getSessionCookieByLoginName } from "../cookies";
import { getServiceConfig } from "../service-url";
import {
  checkEmailVerification,
  checkMFAFactors,
  checkPasswordChangeRequired,
  checkUserVerification,
} from "../verify-helper";
import { getPublicHostWithProtocol } from "./host";

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

  if (userLoginSettings?.disableLoginWithEmail && userLoginSettings?.disableLoginWithPhone) {
    if (user.preferredLoginName !== command.loginName) {
      if (userLoginSettings?.ignoreUnknownUsernames) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return {};
      }
      return { error: t("errors.couldNotSendResetLink") };
    }
  } else if (userLoginSettings?.disableLoginWithEmail) {
    if (user.preferredLoginName !== command.loginName && humanUser?.phone?.phone !== command.loginName) {
      if (userLoginSettings?.ignoreUnknownUsernames) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return {};
      }
      return { error: t("errors.couldNotSendResetLink") };
    }
  } else if (userLoginSettings?.disableLoginWithPhone) {
    if (user.preferredLoginName !== command.loginName && humanUser?.email?.email !== command.loginName) {
      if (userLoginSettings?.ignoreUnknownUsernames) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return {};
      }
      return { error: t("errors.couldNotSendResetLink") };
    }
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

/**
 * First-access bridge (Track B). Called only after a normal Zitadel password
 * check has already failed. On success the backend has verified the typed
 * password against the legacy ERP digest and returned a password-reset code —
 * it has NOT installed a password, so the caller cannot retry auth; it must send
 * the user to the "choose a new password" screen instead.
 *
 * Returns undefined in every other case, including "user already has a Zitadel
 * password" (an ordinary wrong password, not a first access).
 *
 * Guarded on the user having no PASSWORD auth method, so a normal user's typo is
 * never forwarded to the backend.
 */
async function tryLegacyFirstAccess({
  serviceConfig,
  userId,
  loginName,
  password,
}: {
  serviceConfig: Parameters<typeof listAuthenticationMethodTypes>[0]["serviceConfig"];
  userId: string;
  loginName: string;
  password?: string;
}): Promise<{ userId: string; resetCode: string } | "mismatch" | undefined> {
  if (!password || !isLegacyMigrateEnabled()) {
    return undefined;
  }

  try {
    const methods = await listAuthenticationMethodTypes({ serviceConfig, userId });
    if (methods.authMethodTypes?.includes(AuthenticationMethodType.PASSWORD)) {
      // The user does have a Zitadel password — this was simply the wrong one.
      return undefined;
    }
  } catch (error) {
    logger.warn("could not list auth methods for first-access check", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  const result = await legacyMigratePassword({ loginName, password });
  if (result.outcome !== "verified") {
    return undefined;
  }

  // The provisioner pins Zitadel's userId to the ERP pessoa id at creation, so
  // for every user it created the two ids are the same value and the reset code
  // is issued against that id. A user created out-of-band keeps a snowflake id,
  // and the code would then be issued against an id that is not this user's —
  // spending it would just fail ("Codigo nao encontrado", COMMAND-2M9fs).
  //
  // So a mismatch is an integrity problem between provisioning and the instance,
  // never a credential problem. Fail closed and say so, rather than telling the
  // user their password was wrong.
  if (result.userId !== userId) {
    logger.error("first-access id mismatch: backend reset code is not for the resolved Zitadel user", {
      resolvedUserId: userId,
      backendUserId: result.userId,
    });
    return "mismatch";
  }

  // Only the code is taken from the backend; the id is the one we resolved.
  return { userId, resetCode: result.resetCode };
}

export async function sendPassword(
  command: UpdateSessionCommand,
): Promise<{ error: string } | { redirect: string } | { samlData: { url: string; fields: Record<string, string> } }> {
  const _headers = await headers();
  const { serviceConfig } = getServiceConfig(_headers);
  const t = await getTranslations("password");

  recordAuthAttempt("password", command.organization);

  let sessionCookie = await getSessionCookieByLoginName({
    loginName: command.loginName,
    organization: command.organization,
  });

  let session;
  let user: User | undefined;
  let loginSettingsByContext: LoginSettings | undefined;
  let loginSettingsByUser: LoginSettings | undefined;

  // Perform policy check on context settings first if available, or fetch them if needed
  if (!sessionCookie) {
    if (!loginSettingsByContext) {
      loginSettingsByContext = await getLoginSettings({
        serviceConfig,
        organization: command.organization ?? command.defaultOrganization,
      });
    }

    if (loginSettingsByContext && !loginSettingsByContext.allowLocalAuthentication) {
      return { error: t("errors.localAuthenticationNotAllowed") };
    }
  }

  if (sessionCookie) {
    try {
      loginSettingsByUser = await getLoginSettings({ serviceConfig, organization: sessionCookie.organization });

      if (loginSettingsByUser) {
        let lifetime = loginSettingsByUser.passwordCheckLifetime;

        if (!lifetime || !lifetime.seconds) {
          logger.warn("No password lifetime provided, defaulting to 24 hours");
          lifetime = {
            seconds: BigInt(60 * 60 * 24), // default to 24 hours
            nanos: 0,
          } as Duration;
        }

        session = await setSessionAndUpdateCookie({
          recentCookie: sessionCookie,
          checks: command.checks,
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
    if (!loginSettingsByContext) {
      loginSettingsByContext = await getLoginSettings({
        serviceConfig,
        organization: command.organization ?? command.defaultOrganization,
      });
    }

    // Force fallback if settings can't be loaded
    if (!loginSettingsByContext) {
      // this is a fake error message to hide that the user does not even exist
      recordAuthFailure("password", "settings_unavailable", command.organization);
      return { error: t("errors.couldNotVerifyPassword") };
    }

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

      // recheck login settings after user discovery, as the search might have been done without org scope
      if (userLoginSettings?.disableLoginWithEmail && userLoginSettings?.disableLoginWithPhone) {
        if (user.preferredLoginName !== command.loginName) {
          // emulate user not found to prevent enumeration (use context settings not user settings)
          recordAuthFailure("password", "login_name_mismatch", command.organization);
          if (loginSettingsByContext?.ignoreUnknownUsernames) {
            return { error: t("errors.failedToAuthenticateNoLimit") };
          }
          return { error: t("errors.couldNotVerifyPassword") };
        }
      } else if (userLoginSettings?.disableLoginWithEmail) {
        if (user.preferredLoginName !== command.loginName && humanUser?.phone?.phone !== command.loginName) {
          recordAuthFailure("password", "login_name_mismatch", command.organization);
          if (loginSettingsByContext?.ignoreUnknownUsernames) {
            return { error: t("errors.failedToAuthenticateNoLimit") };
          }
          return { error: t("errors.couldNotVerifyPassword") };
        }
      } else if (userLoginSettings?.disableLoginWithPhone) {
        if (user.preferredLoginName !== command.loginName && humanUser?.email?.email !== command.loginName) {
          recordAuthFailure("password", "login_name_mismatch", command.organization);
          if (loginSettingsByContext?.ignoreUnknownUsernames) {
            return { error: t("errors.failedToAuthenticateNoLimit") };
          }
          return { error: t("errors.couldNotVerifyPassword") };
        }
      }

      const userId = user.userId;
      const attemptSession = () =>
        createSessionAndUpdateCookie({
          checks: create(ChecksSchema, {
            user: { search: { case: "userId", value: userId } },
            password: { password: command.checks.password?.password },
          }),
          requestId: command.requestId,
          lifetime: loginSettingsByContext?.passwordCheckLifetime,
        });

      // Shared failure rendering, so the first attempt and the post-migration
      // retry surface the same (deliberately vague) message.
      const passwordFailure = async (error: any): Promise<{ error: string }> => {
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
      };

      try {
        const result = await attemptSession();
        session = result.session;
        sessionCookie = result.sessionCookie;
      } catch (error: any) {
        // First access (Track B): provisioned users have no Zitadel password,
        // only a legacy ERP digest, and email flows are undeliverable for them.
        // Bridge through the backend, which verifies the typed password against
        // the ERP and — on a match — returns a password-reset code. The ERP
        // password is proof of identity only and is never installed, so there is
        // nothing to retry auth with: the user has to choose a new password now.
        const bridged = await tryLegacyFirstAccess({
          serviceConfig,
          userId,
          loginName: user.preferredLoginName ?? command.loginName,
          password: command.checks.password?.password,
        });

        if (bridged === "mismatch") {
          // Provisioning is out of step with this instance. The credential was
          // fine, so do not claim otherwise and do not count it as a failure.
          recordAuthFailure("password", "first_access_id_mismatch", command.organization);
          return { error: t("firstAccess.errors.integrity") };
        }

        if (!bridged) {
          return passwordFailure(error);
        }

        // The reset code stays server-side; the browser gets only an opaque
        // handle. Nothing about the ticket goes into the redirect URL.
        const handle = storeFirstAccessTicket({
          userId: bridged.userId,
          resetCode: bridged.resetCode,
          loginName: user.preferredLoginName ?? command.loginName,
          organization: command.organization,
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

        // Route-relative, like every other redirect this module returns: the
        // client pushes it through next/navigation, which prefixes
        // NEXT_PUBLIC_BASE_PATH itself. Adding it here doubles the prefix.
        return { redirect: "/password/first-access" };
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
 * Second half of first access (Track B): the user has proven their identity with
 * the legacy ERP credential and now chooses the password that will actually be
 * installed. This is the mandatory rotation — the ERP password is never used as
 * a Zitadel password, so there is no separate forced-change screen.
 *
 * The reset code is read from the server-side ticket store; the browser only
 * ever sent the opaque handle cookie. Zitadel enforces the complexity policy on
 * the call below, so its validation message is surfaced verbatim and the user
 * can retry with the same ticket.
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

  try {
    const result = await setUserPassword({
      serviceConfig,
      userId: ticket.userId,
      password,
      code: ticket.resetCode,
    });

    // setUserPassword folds a FailedPrecondition into a returned error instead of
    // throwing; the ticket stays alive so the user can correct and retry.
    if (result && "error" in result && result.error) {
      return { error: result.error };
    }
  } catch (error: any) {
    // Zitadel rejects a password that violates the complexity policy here. Its
    // message names the missing requirement ("A senha deve conter letras
    // minusculas"), which is exactly what the user needs, so pass it through
    // rather than a generic failure. Only for errors Zitadel classes as caused
    // by the input — a server fault must not have its internals rendered.
    const isUserError = isClassifiedError(error) ? error.isUserError : error?.name === "ConnectError";
    if (isUserError && error.message) {
      // ConnectError prefixes the message with its code, e.g. "[invalid_argument] …".
      return { error: String(error.message).replace(/^\[[a-z_]+\]\s*/, "") };
    }
    logger.warn("could not set first-access password", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { error: t("set.errors.couldNotSetPassword") };
  }

  // The password is installed: the ticket and its reset code must not outlive it.
  discardFirstAccessTicket(handle);
  cookiesList.delete(FIRST_ACCESS_COOKIE_NAME);

  // A freshly set password is not immediately visible to the session check.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Now authenticate normally with the password the user just chose, which runs
  // the usual session/MFA/redirect flow.
  return sendPassword({
    loginName: ticket.loginName,
    organization: ticket.organization,
    requestId: ticket.requestId,
    checks: create(ChecksSchema, {
      password: { password },
    }),
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

  let lifetime = loginSettings?.passwordCheckLifetime;
  if (!lifetime || !lifetime.seconds) {
    lifetime = {
      seconds: BigInt(60 * 60 * 24),
      nanos: 0,
    } as Duration;
  }

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
