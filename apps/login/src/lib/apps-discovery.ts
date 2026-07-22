/**
 * App launcher discovery (fork feature).
 *
 * The /apps page discovers everything from Zitadel itself — no static config:
 *   user's ACTIVE authorizations → granted projects → each project's
 *   registered applications → launch URL derived from the app's config.
 *
 * Zitadel apps have no homepage field, so the launch URL is derived:
 *  - OIDC apps: the origin of the first https redirect URI
 *    (e.g. https://lms.example.com/api/auth/callback → https://lms.example.com).
 *  - Apps with only localhost/http dev redirect URIs are skipped.
 *  - API (machine) apps have no UI and are skipped.
 * See AUTHORIZATION.md for the access model (a role at ANY org counts).
 */

export interface DiscoverableApp {
  id: string;
  name: string;
  /** mirrors the app config oneof: which config the app carries */
  kind: "oidc" | "saml" | "api" | "unknown";
  redirectUris: string[];
}

export interface DiscoveredApp {
  id: string;
  name: string;
  url: string;
}

export interface GrantedProject {
  projectId: string;
  projectName: string;
  roles: string[];
}

/** Derive a launchable URL from an app's redirect URIs; null = not launchable. */
export function deriveLaunchUrl(app: DiscoverableApp): string | null {
  if (app.kind === "api") {
    return null; // machine app, no UI
  }
  for (const uri of app.redirectUris) {
    try {
      const url = new URL(uri);
      if (url.protocol !== "https:") continue; // skip http/custom-scheme (dev/native)
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") continue;
      return url.toString();
    } catch {
      continue;
    }
  }
  return null;
}

/** Map launchable apps of one project; non-launchable entries are dropped. */
export function toDiscoveredApps(apps: DiscoverableApp[]): DiscoveredApp[] {
  return apps.flatMap((app) => {
    const url = deriveLaunchUrl(app);
    return url ? [{ id: app.id, name: app.name, url }] : [];
  });
}
