/**
 * Best-effort site metadata for the /apps launcher cards: the target page's
 * <title> (shown as the card subtitle) and <meta name="description"> (shown
 * as a hover tooltip). Fetched server-side with a short timeout and cached
 * in-memory; any failure yields nulls and the card falls back to the URL.
 */

export interface SiteMeta {
  title: string | null;
  description: string | null;
}

/** Parse <title> and <meta name="description"> out of an HTML document. */
export function parseSiteMeta(html: string): SiteMeta {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);

  // tolerate attribute order: name before or after content
  const descMatch =
    html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) ??
    html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);

  const clean = (value: string | undefined) => {
    const trimmed = value?.replace(/\s+/g, " ").trim();
    return trimmed ? trimmed : null;
  };

  return {
    title: clean(titleMatch?.[1]),
    description: clean(descMatch?.[1]),
  };
}

const cache = new Map<string, { meta: SiteMeta; expires: number }>();
const TTL_MS = 60 * 60 * 1000; // 1 hour
const EMPTY: SiteMeta = { title: null, description: null };

/**
 * SSRF guard: only fetch https URLs whose host looks like a public DNS name.
 * The URLs come from admin-configured Zitadel redirect URIs (not end users),
 * but this server sits on the same Docker network as internal services, so we
 * refuse IP literals, dot-less hostnames and internal TLDs outright.
 */
export function isFetchableUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    const host = url.hostname;
    if (!host.includes(".")) return false; // bare/internal hostnames (docker service names)
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // IPv4 literal
    if (host.startsWith("[") || host.includes(":")) return false; // IPv6 literal
    if (/\.(local|internal|localdomain|lan|home|corp)$/i.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Fetch and parse a site's metadata; cached, 3s timeout, never throws. */
export async function fetchSiteMeta(url: string): Promise<SiteMeta> {
  const cached = cache.get(url);
  if (cached && cached.expires > Date.now()) {
    return cached.meta;
  }

  if (!isFetchableUrl(url)) {
    return EMPTY;
  }

  let meta = EMPTY;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers: { accept: "text/html" },
      redirect: "follow",
    });
    if (response.ok && (response.headers.get("content-type") ?? "").includes("text/html")) {
      // read at most ~64KB — title/description live in <head>
      const html = (await response.text()).slice(0, 65536);
      meta = parseSiteMeta(html);
    }
  } catch {
    // unreachable/slow site: fall back to EMPTY (card shows the URL)
  }

  cache.set(url, { meta, expires: Date.now() + TTL_MS });
  return meta;
}
