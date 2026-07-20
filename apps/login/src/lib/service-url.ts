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
  const instanceHost = stripProtocol(process.env.ZITADEL_API_URL).replace(/\/.*$/, "");

  return {
    serviceConfig: {
      baseUrl: process.env.ZITADEL_API_URL,
      ...(instanceHost && { instanceHost }),
    },
  };
}

export function constructUrl(request: NextRequest, path: string) {
  const protocol = request.nextUrl.protocol;

  const forwardedHost = getPublicHost(request.headers);
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  return new URL(`${basePath}${path}`, `${protocol}//${forwardedHost}`);
}
