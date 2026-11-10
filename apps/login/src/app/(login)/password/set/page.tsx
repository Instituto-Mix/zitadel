import { Alert, AlertType } from "@/components/alert";
import { DynamicTheme } from "@/components/dynamic-theme";
import { SetPasswordForm } from "@/components/set-password-form";
import { Translated } from "@/components/translated";
import { UserAvatar } from "@/components/user-avatar";
import { UNKNOWN_USER_ID } from "@/lib/constants";
import { maskEmail } from "@/lib/mask-email";
import { usableEmail } from "@/lib/placeholder-email";
import { getServiceConfig } from "@/lib/service-url";
import { loadMostRecentSession } from "@/lib/session";
import {
  getBrandingSettings,
  getDefaultOrg,
  getLoginSettings,
  getPasswordComplexitySettings,
  getUserByID,
  searchUsers,
} from "@/lib/zitadel";
import { Organization } from "@zitadel/proto/zitadel/org/v2/org_pb";
import { Session } from "@zitadel/proto/zitadel/session/v2/session_pb";
import { User } from "@zitadel/proto/zitadel/user/v2/user_pb";
import { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("password");
  return { title: t("set.title") };
}

export default async function Page(props: { searchParams: Promise<Record<string | number | symbol, string | undefined>> }) {
  const searchParams = await props.searchParams;

  let { userId, loginName, organization, requestId, code, initial } = searchParams;

  const _headers = await headers();
  const { serviceConfig } = getServiceConfig(_headers);

  let defaultOrganization;
  if (!organization) {
    const org: Organization | null = await getDefaultOrg({ serviceConfig });
    if (org) {
      defaultOrganization = org.id;
    }
  }

  // also allow no session to be found (ignoreUnkownUsername)
  let session: Session | undefined;
  if (loginName) {
    session = await loadMostRecentSession({
      serviceConfig,
      sessionParams: {
        loginName,
        organization,
      },
    });
  }

  const branding = await getBrandingSettings({ serviceConfig, organization: organization ?? defaultOrganization });

  const passwordComplexity = await getPasswordComplexitySettings({
    serviceConfig,
    organization: organization ?? session?.factors?.user?.organizationId ?? defaultOrganization,
  });

  const loginSettings = await getLoginSettings({
    serviceConfig,
    organization: organization ?? session?.factors?.user?.organizationId ?? defaultOrganization,
  });

  if (!loginSettings) {
    return (
      <DynamicTheme branding={branding}>
        <div className="mx-auto flex max-w-sm flex-col space-y-4 pt-4">
          <Alert>
            <Translated i18nKey="errors.couldNotGetLoginSettings" namespace="loginname" />
          </Alert>
        </div>
      </DynamicTheme>
    );
  }

  let user: User | undefined;
  if (userId) {
    const userResponse = await getUserByID({ serviceConfig, userId });
    user = userResponse.user;
  } else if (loginName) {
    const users = await searchUsers({
      serviceConfig,
      searchValue: loginName,
      loginSettings: loginSettings,
      organizationId: organization,
    });

    if (users.result && users.result.length === 1) {
      const foundUser = users.result[0];
      userId = foundUser.userId;
      user = foundUser;
    } else if (loginSettings?.ignoreUnknownUsernames) {
      // Preserve the generic reset flow for unknown users.
      userId = UNKNOWN_USER_ID;
    }
  }

  const noUsableResetEmail = initial !== "true" && user?.type.case === "human" && !usableEmail(user.type.value.email?.email);

  let maskedEmail: string | undefined;
  if (!initial && !noUsableResetEmail && user?.type.case === "human" && user.details?.resourceOwner) {
    // Match the reset action's context, not a possibly unrelated recent session.
    const contextualSettings =
      !organization && session?.factors?.user?.organizationId
        ? await getLoginSettings({ serviceConfig, organization: defaultOrganization })
        : loginSettings;
    const userSettings = await getLoginSettings({ serviceConfig, organization: user.details.resourceOwner });
    const human = user.type.value;
    if (
      contextualSettings &&
      userSettings &&
      [contextualSettings, userSettings].every(
        (settings) =>
          !settings.hidePasswordReset &&
          (!loginName ||
            user?.preferredLoginName === loginName ||
            (!settings.disableLoginWithEmail && !settings.disableLoginWithPhone) ||
            (!settings.disableLoginWithEmail && human.email?.email === loginName) ||
            (!settings.disableLoginWithPhone && human.phone?.phone === loginName)),
      )
    ) {
      maskedEmail = maskEmail(human.email?.email);
    }
  }

  return (
    <DynamicTheme branding={branding}>
      <div className="flex flex-col space-y-4">
        <h1>
          {(!noUsableResetEmail && session?.factors?.user?.displayName) || (
            <Translated i18nKey="set.title" namespace="password" />
          )}
        </h1>
        <p className="ztdl-p mb-6 block">
          <Translated i18nKey="set.description" namespace="password" />
        </p>

        {/* Only warn when there is neither a loginName nor a userId to continue with.
            A missing session is expected here: the set/reset flow works via code +
            userId, and under enumeration protection no session exists by design. */}
        {!loginName && !userId && (
          <div className="py-4">
            <Alert>
              <Translated i18nKey="unknownContext" namespace="error" />
            </Alert>
          </div>
        )}

        {!noUsableResetEmail &&
          (session ? (
            <UserAvatar
              loginName={loginName ?? session.factors?.user?.loginName}
              displayName={session.factors?.user?.displayName}
              showDropdown
              searchParams={searchParams}
            ></UserAvatar>
          ) : loginName ? (
            <UserAvatar loginName={loginName} displayName={loginName} showDropdown searchParams={searchParams}></UserAvatar>
          ) : null)}
      </div>

      <div className="w-full">
        {noUsableResetEmail ? (
          <Alert type={AlertType.INFO}>
            <Translated i18nKey="errors.noUsableResetEmail" namespace="password" />
          </Alert>
        ) : (
          !initial && (
            <Alert type={AlertType.INFO}>
              <Translated
                i18nKey={maskedEmail ? "set.codeSentTo" : "set.codeSent"}
                namespace="password"
                data={maskedEmail ? { email: maskedEmail } : undefined}
              />
            </Alert>
          )
        )}

        {!noUsableResetEmail &&
          (passwordComplexity &&
          (loginName ?? user?.preferredLoginName) &&
          (userId ?? session?.factors?.user?.id ?? (loginSettings?.ignoreUnknownUsernames ? UNKNOWN_USER_ID : undefined)) ? (
            <SetPasswordForm
              code={code}
              userId={userId ?? (session?.factors?.user?.id as string) ?? UNKNOWN_USER_ID}
              loginName={loginName ?? (user?.preferredLoginName as string)}
              requestId={requestId}
              organization={organization}
              defaultOrganization={defaultOrganization}
              passwordComplexitySettings={passwordComplexity}
              codeRequired={!(initial === "true")}
            />
          ) : (
            <div className="py-4">
              <Alert>
                <Translated i18nKey="failedLoading" namespace="error" />
              </Alert>
            </div>
          ))}
      </div>
    </DynamicTheme>
  );
}
