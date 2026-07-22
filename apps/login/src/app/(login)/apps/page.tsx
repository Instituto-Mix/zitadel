import { DynamicTheme } from "@/components/dynamic-theme";
import { NavLinks } from "@/components/nav-links";
import { Translated } from "@/components/translated";
import { UserAvatar } from "@/components/user-avatar";
import { groupAppsByProject, parseAppsCatalog } from "@/lib/apps-catalog";
import { getServiceConfig } from "@/lib/service-url";
import { loadMostRecentSession } from "@/lib/session";
import { getBrandingSettings, listAuthorizations } from "@/lib/zitadel";
import { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("apps");
  return { title: t("title") };
}

/**
 * App launcher (fork feature): lists the applications the signed-in user has
 * access to, grouped by Zitadel project. Access = an ACTIVE authorization
 * (user grant) on the app's project, held at ANY organization. Presentation
 * data (names, launch URLs) comes from the APPS_CATALOG env. See
 * AUTHORIZATION.md for the model.
 */
export default async function Page(props: { searchParams: Promise<Record<string, string | undefined>> }) {
  const searchParams = await props.searchParams;
  const { loginName, organization } = searchParams;

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

  const catalog = parseAppsCatalog(process.env.APPS_CATALOG);

  let granted: { projectId: string; projectName: string; roles: string[] }[] = [];
  try {
    const response = await listAuthorizations({ serviceConfig, userId });
    granted = (response?.authorizations ?? []).map((a) => ({
      projectId: a.project?.id ?? "",
      projectName: a.project?.name ?? "",
      roles: (a.roles ?? []).map((r) => r.key),
    }));
  } catch (error) {
    console.error("Failed to list authorizations for app launcher", error);
  }

  const groups = groupAppsByProject(catalog, granted);

  return (
    <DynamicTheme branding={branding}>
      <div className="flex flex-col space-y-4">
        <h1>
          <Translated i18nKey="title" namespace="apps" />
        </h1>
        <p className="ztdl-p mb-6 block">
          <Translated i18nKey="description" namespace="apps" />
        </p>

        <UserAvatar
          loginName={loginName ?? sessionFactors?.factors?.user?.loginName}
          displayName={sessionFactors?.factors?.user?.displayName}
          showDropdown
          searchParams={searchParams}
        />
      </div>

      <div className="flex w-full flex-col space-y-6">
        {groups.length === 0 && (
          <p className="ztdl-p text-center">
            <Translated i18nKey="noResults" namespace="apps" />
          </p>
        )}

        {groups.map((group) => (
          <div key={group.projectId} className="flex flex-col space-y-2">
            <h2 className="text-sm font-medium opacity-70">{group.projectName}</h2>
            <div className="flex flex-col space-y-2">
              {group.apps.map((app) => (
                <Link
                  key={`${group.projectId}:${app.url}`}
                  href={app.url}
                  className="border-divider-light dark:border-divider-dark hover:bg-black/5 dark:hover:bg-white/5 flex flex-col rounded-md border px-4 py-3 transition-colors"
                >
                  <span className="font-medium">{app.name}</span>
                  {app.description && <span className="text-sm opacity-70">{app.description}</span>}
                </Link>
              ))}
            </div>
          </div>
        ))}

        <NavLinks current="apps" />
      </div>
    </DynamicTheme>
  );
}
