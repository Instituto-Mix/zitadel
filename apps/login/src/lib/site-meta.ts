/**
 * Best-effort site metadata for the /apps launcher cards: the target page's
 * <title> (shown as the card subtitle) and <meta name="description"> (shown
 * as a hover tooltip). Fetched server-side with a short timeout and cached
 * in-memory; any failure yields nulls and the card falls back to the URL.
 */

export interface SiteMeta {
  title: string | null;
  description: string | null;
  /** absolute URL of the site's favicon; defaults to <origin>/favicon.ico */
  favicon: string | null;
}

/** Extract an attribute value from a tag, tolerating "double", 'single' or unquoted values. */
function attrValue(tag: string, attr: string): string | undefined {
  const m = tag.match(new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  return m?.[1] ?? m?.[2] ?? m?.[3];
}

/** Find the first tag of `element` carrying attr=value (quotes optional), in any attribute order. */
function findTag(html: string, element: string, attr: string, valuePattern: string): string | undefined {
  const re = new RegExp(`<${element}[^>]*\\b${attr}\\s*=\\s*["']?(?:${valuePattern})["']?[^>]*>`, "gi");
  return re.exec(html)?.[0];
}

/** Parse <title>, <meta name="description"> and the favicon link out of an HTML document. */
export function parseSiteMeta(html: string, pageUrl?: string): SiteMeta {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);

  // attribute order and quoting style vary across sites — locate the tag first,
  // then pull its content/href attribute
  const descTag = findTag(html, "meta", "name", "description");
  const description = descTag ? attrValue(descTag, "content") : undefined;

  const iconTag = findTag(html, "link", "rel", "(?:shortcut )?icon|apple-touch-icon");
  const iconHref = iconTag ? attrValue(iconTag, "href") : undefined;

  const clean = (value: string | undefined) => {
    const trimmed = value?.replace(/\s+/g, " ").trim();
    return trimmed ? trimmed : null;
  };

  let favicon: string | null = null;
  if (pageUrl) {
    try {
      // resolve relative hrefs against the page; default to /favicon.ico
      favicon = new URL(iconHref ?? "/favicon.ico", pageUrl).toString();
      if (!favicon.startsWith("https:")) favicon = null; // browser loads it; https only
    } catch {
      favicon = null;
    }
  }

  return {
    title: clean(titleMatch?.[1]),
    description: clean(description),
    favicon,
  };
}

const cache = new Map<string, { meta: SiteMeta; expires: number }>();
const TTL_MS = 60 * 60 * 1000; // 1 hour
const EMPTY: SiteMeta = { title: null, description: null, favicon: null };

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
    // Follow redirects manually so every hop is re-validated by the SSRF
    // guard — a public URL must not be able to 3xx onto an internal host.
    let currentUrl = url;
    let response: Response | undefined;
    for (let hop = 0; hop < 4; hop++) {
      response = await fetch(currentUrl, {
        signal: AbortSignal.timeout(3000),
        headers: { accept: "text/html" },
        redirect: "manual",
      });
      if (response.status < 300 || response.status >= 400) {
        break;
      }
      const location = response.headers.get("location");
      if (!location) break;
      currentUrl = new URL(location, currentUrl).toString();
      if (!isFetchableUrl(currentUrl)) {
        response = undefined; // redirect target is not allowed — give up
        break;
      }
    }
    if (response?.ok && (response.headers.get("content-type") ?? "").includes("text/html")) {
      // read at most ~64KB — title/description live in <head>
      const html = (await response.text()).slice(0, 65536);
      meta = parseSiteMeta(html, currentUrl);
    }
  } catch {
    // unreachable/slow site: fall back to EMPTY (card shows the URL)
  }

  if (!meta.favicon) {
    try {
      meta = { ...meta, favicon: new URL("/favicon.ico", url).toString() };
    } catch {
      // keep favicon null
    }
  }

  cache.set(url, { meta, expires: Date.now() + TTL_MS });
  return meta;
}
