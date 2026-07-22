import { AppIcon } from "@/components/app-icon";
import { AppLink } from "@/components/app-link";
import { DynamicTheme } from "@/components/dynamic-theme";
import { NavLinks } from "@/components/nav-links";
import { Translated } from "@/components/translated";
import { UserAvatar } from "@/components/user-avatar";
import { DiscoverableApp, toDiscoveredApps } from "@/lib/apps-discovery";
import { fetchSiteMeta, SiteMeta } from "@/lib/site-meta";
import { getServiceConfig } from "@/lib/service-url";
import { loadMostRecentSession } from "@/lib/session";
import { getBrandingSettings, listApplications, listAuthorizations } from "@/lib/zitadel";
import { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("apps");
  return { title: t("title") };
}

/**
 * App launcher (fork feature): everything is discovered from Zitadel — the
 * user's ACTIVE authorizations (a role at ANY org counts) yield the granted
 * projects; each project's registered applications are listed and their
 * launch URLs derived from the app's redirect URIs. No static configuration.
 * See AUTHORIZATION.md and lib/apps-discovery.ts.
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

  let groups: {
    projectId: string;
    projectName: string;
    apps: { id: string; name: string; url: string; meta: SiteMeta }[];
  }[] = [];
  try {
    const response = await listAuthorizations({ serviceConfig, userId });

    // de-duplicate projects (a user may hold grants on the same project via
    // multiple orgs — org-granted projects count the same as the home org)
    const projects = new Map<string, string>();
    for (const authorization of response?.authorizations ?? []) {
      if (authorization.project?.id) {
        projects.set(authorization.project.id, authorization.project.name ?? "");
      }
    }

    groups = (
      await Promise.all(
        Array.from(projects.entries()).map(async ([projectId, projectName]) => {
          const appsResponse = await listApplications({ serviceConfig, projectId }).catch((error) => {
            console.error("Failed to list applications for project", { projectId, error });
            return undefined;
          });

          const discoverable: DiscoverableApp[] = (appsResponse?.applications ?? []).map((app) => ({
            id: app.id,
            name: app.name,
            kind:
              app.config?.case === "oidcConfig"
                ? "oidc"
                : app.config?.case === "samlConfig"
                  ? "saml"
                  : app.config?.case === "apiConfig"
                    ? "api"
                    : "unknown",
            redirectUris: app.config?.case === "oidcConfig" ? (app.config.value.redirectUris ?? []) : [],
          }));

          // enrich each launchable app with the target site's title/description
          const apps = await Promise.all(
            toDiscoveredApps(discoverable).map(async (app) => ({
              ...app,
              meta: await fetchSiteMeta(app.url),
            })),
          );

          return { projectId, projectName, apps };
        }),
      )
    ).filter((group) => group.apps.length > 0);
  } catch (error) {
    console.error("Failed to list authorizations for app launcher", error);
  }

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
                <AppLink
                  key={app.id}
                  href={app.url}
                  name={`app-${app.id}`}
                  title={app.meta.description ?? undefined}
                  className="border-divider-light dark:border-divider-dark hover:bg-black/5 dark:hover:bg-white/5 flex flex-row items-center space-x-3 rounded-md border px-4 py-3 transition-colors"
                >
                  <AppIcon name={app.name} favicon={app.meta.favicon} />
                  <span className="flex flex-col">
                    <span className="font-medium">{app.name}</span>
                    <span className="text-sm opacity-70">{app.meta.title ?? app.url}</span>
                  </span>
                </AppLink>
              ))}
            </div>
          </div>
        ))}

        <NavLinks current="apps" />
      </div>
    </DynamicTheme>
  );
}
