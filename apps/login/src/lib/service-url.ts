import { ReadonlyHeaders } from "next/dist/server/web/spec-extension/adapters/headers";
import { NextRequest } from "next/server";
import { getPublicHost } from "./server/host";
import { ServiceConfig } from "./zitadel";

/**
 * Extracts the service URL based on deployment mode and configuration.
 *
 * Priority:
 * 1. ZITADEL_API_URL (required) - Used by both self-hosted and multi-tenant
 * 2. x-zitadel-forward-host (multi-tenant only) - Set by Zitadel proxy
 * 3. host header (multi-tenant fallback) - For dynamic host resolution
 *
 * @param headers - Request headers
 * @returns Object containing the service Configuration
 * @throws Error if the service Configuration could not be determined
 */

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

export function getServiceConfig(headers: ReadonlyHeaders): { serviceConfig: ServiceConfig } {
  if (!process.env.ZITADEL_API_URL) {
    throw new Error("ZITADEL_API_URL is not set");
  }

  // Track B / standalone deploy: this login UI runs on its own domain
  // (e.g. entrar.institutomix.com.br) that is NOT a Zitadel instance domain.
  // In a normal Zitadel deployment the login app sits behind Zitadel's proxy,
  // which sets x-zitadel-instance-host to the instance's domain. Here nothing
  // does, so getInstanceHost() falls back to the browser Host (entrar), and
  // Zitadel's instance resolution (keyed on instance domains) 404s.
  //
  // The instance is always the one at ZITADEL_API_URL, so derive the instance
  // host from it. publicHost is intentionally omitted: with instanceHost equal
  // to the instance's own domain, Zitadel skips its public-domain trust check,
  // so this UI's domain does not need to be registered as a trusted domain.
  // Browser-facing URLs still use getPublicHost(headers) directly, so redirects
  // keep pointing at this UI's real host.
  //
  // ZITADEL_INSTANCE_HOST overrides the instance host sent to the API. Set it to
  // a shared PARENT domain (e.g. institutomix.com.br) when this UI runs on a
  // sibling subdomain of the Zitadel instance: Zitadel derives the WebAuthn
  // RP ID from this value, and the RP ID must be equal to or a parent of the
  // login origin for passkey/U2F to work. The parent must be registered as an
  // instance domain in Zitadel (logical only — no DNS required).
  const instanceHostSource = process.env.ZITADEL_INSTANCE_HOST || process.env.ZITADEL_API_URL;
  const instanceHost = stripProtocol(instanceHostSource).replace(/\/.*$/, "");

  return {
    serviceConfig: {
      baseUrl: process.env.ZITADEL_API_URL,
      ...(instanceHost && { instanceHost }),
    },
  };
}

/**
 * Rewrites an absolute asset URL returned by the Zitadel API (e.g. a user's
 * avatarUrl) so its host points at the instance that actually serves assets.
 *
 * Zitadel builds avatarUrl from the instance's external domain, which is the
 * value we send as instanceHost. When ZITADEL_INSTANCE_HOST is set to a shared
 * PARENT domain (for WebAuthn RP ID across sibling subdomains), that host does
 * not serve assets and the image 404s. The assets live at ZITADEL_API_URL
 * (serviceConfig.baseUrl), so force the host/protocol to that origin while
 * keeping the original path and query. Relative URLs are resolved against it.
 */
export function rebaseAssetUrl(assetUrl: string | undefined, baseUrl: string): string | undefined {
  if (!assetUrl) {
    return assetUrl;
  }
  try {
    const src = new URL(assetUrl, baseUrl);
    const base = new URL(baseUrl);
    src.protocol = base.protocol;
    src.host = base.host;
    return src.toString();
  } catch {
    return assetUrl;
  }
}

export function constructUrl(request: NextRequest, path: string) {
  const protocol = request.nextUrl.protocol;

  const forwardedHost = getPublicHost(request.headers);
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  return new URL(`${basePath}${path}`, `${protocol}//${forwardedHost}`);
}
