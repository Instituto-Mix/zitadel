import { Alert } from "@/components/alert";
import { DynamicTheme } from "@/components/dynamic-theme";
import { FirstAccessPasswordForm } from "@/components/first-access-password-form";
import { Translated } from "@/components/translated";
import { UserAvatar } from "@/components/user-avatar";
import { FIRST_ACCESS_COOKIE_NAME, peekFirstAccessTicket } from "@/lib/server/first-access-ticket";
import { getServiceConfig } from "@/lib/service-url";
import { getBrandingSettings, getDefaultOrg, getPasswordComplexitySettings } from "@/lib/zitadel";
import { Organization } from "@zitadel/proto/zitadel/org/v2/org_pb";
import { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { cookies, headers } from "next/headers";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("password");
  return { title: t("firstAccess.title") };
}

/**
 * First access (Track B), step 2: choose the password that will actually be
 * installed after the legacy ERP credential proved the user's identity.
 *
 * Everything this page needs comes from the server-side ticket looked up via the
 * httpOnly handle cookie — nothing is taken from the query string, because the
 * reset code behind that ticket authorizes setting the user's password and must
 * never appear in a URL.
 */
export default async function Page() {
  const _headers = await headers();
  const { serviceConfig } = getServiceConfig(_headers);

  const cookiesList = await cookies();
  const ticket = peekFirstAccessTicket(cookiesList.get(FIRST_ACCESS_COOKIE_NAME)?.value);

  let defaultOrganization;
  if (!ticket?.organization) {
    const org: Organization | null = await getDefaultOrg({ serviceConfig });
    if (org) {
      defaultOrganization = org.id;
    }
  }

  const organization = ticket?.organization ?? defaultOrganization;
  const branding = await getBrandingSettings({ serviceConfig, organization });

  if (!ticket) {
    // Expired, already spent, or the flow was never started on this instance.
    // Deliberately says nothing about the account.
    return (
      <DynamicTheme branding={branding}>
        <div className="mx-auto flex max-w-sm flex-col space-y-4 pt-4">
          <Alert>
            <Translated i18nKey="firstAccess.errors.expired" namespace="password" />
          </Alert>
        </div>
      </DynamicTheme>
    );
  }

  const passwordComplexity = await getPasswordComplexitySettings({ serviceConfig, organization });

  return (
    <DynamicTheme branding={branding}>
      <div className="flex flex-col space-y-4">
        <h1>
          <Translated i18nKey="firstAccess.title" namespace="password" />
        </h1>
        <p className="ztdl-p mb-6 block">
          <Translated i18nKey="firstAccess.description" namespace="password" />
        </p>

        <UserAvatar loginName={ticket.loginName} displayName={ticket.loginName} showDropdown={false}></UserAvatar>
      </div>

      <div className="w-full">
        {passwordComplexity ? (
          <FirstAccessPasswordForm passwordComplexitySettings={passwordComplexity} />
        ) : (
          <div className="py-4">
            <Alert>
              <Translated i18nKey="failedLoading" namespace="error" />
            </Alert>
          </div>
        )}
      </div>
    </DynamicTheme>
  );
}
