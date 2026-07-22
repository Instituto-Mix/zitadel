/**
 * App launcher catalog (fork feature).
 *
 * Zitadel knows which PROJECTS a user is authorized for (user grants), but has
 * no concept of an app landing page. The catalog supplies that presentation
 * data: which apps exist, which project gates each one, and where it launches.
 *
 * Configured via the APPS_CATALOG env var — a JSON array:
 *   [{ "projectId": "329...", "name": "LMS", "url": "https://lms.example.com",
 *      "description": "Learning platform" }]
 *
 * The /apps page intersects this catalog with the user's authorizations: an
 * app is shown iff the user holds an active grant on its projectId. Grants are
 * matched across ALL orgs (a role at any org counts).
 */

export interface CatalogApp {
  projectId: string;
  name: string;
  url: string;
  description?: string;
}

export interface GrantedProject {
  projectId: string;
  projectName: string;
  roles: string[];
}

/** Parse the APPS_CATALOG env JSON; invalid/missing config yields an empty catalog. */
export function parseAppsCatalog(raw: string | undefined): CatalogApp[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (e): e is CatalogApp =>
        !!e && typeof e.projectId === "string" && typeof e.name === "string" && typeof e.url === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Intersect the catalog with the user's granted projects, grouped by project.
 * Only projects with at least one catalog app appear. Pure and unit-testable.
 */
export function groupAppsByProject(
  catalog: CatalogApp[],
  granted: GrantedProject[],
): { projectId: string; projectName: string; roles: string[]; apps: CatalogApp[] }[] {
  return granted
    .map((g) => ({
      projectId: g.projectId,
      projectName: g.projectName,
      roles: g.roles,
      apps: catalog.filter((a) => a.projectId === g.projectId),
    }))
    .filter((g) => g.apps.length > 0);
}
