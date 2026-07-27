import { DynamicTheme } from "@/components/dynamic-theme";
import { EmailForm } from "@/components/email-form";
import { NavLinks } from "@/components/nav-links";
import { Translated } from "@/components/translated";
import { UserAvatar } from "@/components/user-avatar";
import { getServiceConfig } from "@/lib/service-url";
import { loadMostRecentSession } from "@/lib/session";
import { getBrandingSettings, getUserByID } from "@/lib/zitadel";
import { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("email");
  return { title: t("title") };
}

/**
 * Self-service email change (fork feature). Signed-in user only — the session
 * supplies the user; the form submits to the updateEmail server action which
 * re-derives the userId from the session. See lib/server/email.ts.
 */
export default async function Page(props: { searchParams: Promise<Record<string, string | undefined>> }) {
  const searchParams = await props.searchParams;
  const { loginName, organization, requestId } = searchParams;

  const _headers = await headers();
  const { serviceConfig } = getServiceConfig(_headers);

  const sessionFactors = await loadMostRecentSession({
    serviceConfig,
    sessionParams: { loginName, organization },
  });

  const userId = sessionFactors?.factors?.user?.id;
  if (!userId) {
    redirect("/loginname");
  }

  const branding = await getBrandingSettings({ serviceConfig, organization });

  let currentEmail: string | undefined;
  const userResponse = await getUserByID({ serviceConfig, userId }).catch(() => undefined);
  const human = userResponse?.user?.type.case === "human" ? userResponse.user.type.value : undefined;
  currentEmail = human?.email?.email;

  return (
    <DynamicTheme branding={branding}>
      <div className="flex flex-col space-y-4">
        <h1>
          <Translated i18nKey="title" namespace="email" />
        </h1>
        <p className="ztdl-p mb-6 block">
          <Translated i18nKey="description" namespace="email" />
        </p>

        <UserAvatar
          loginName={loginName ?? sessionFactors?.factors?.user?.loginName}
          displayName={sessionFactors?.factors?.user?.displayName}
          showDropdown
          searchParams={searchParams}
        />
      </div>

      <div className="flex w-full flex-col space-y-6">
        <EmailForm
          currentEmail={currentEmail}
          loginName={loginName ?? sessionFactors?.factors?.user?.loginName}
          organization={organization}
          requestId={requestId}
        />
        <NavLinks current="email" />
      </div>
    </DynamicTheme>
  );
}
