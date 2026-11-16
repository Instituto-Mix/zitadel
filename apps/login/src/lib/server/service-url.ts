import "server-only";

import { getPublicHost } from "@/lib/server/host";
import { ServiceConfig } from "@/lib/server/zitadel";
import { ReadonlyHeaders } from "next/dist/server/web/spec-extension/adapters/headers";
import { NextRequest } from "next/server";

/**
 * Configures API routing for this standalone Login deployment.
 * ZITADEL_INSTANCE_HOST overrides the instance host derived from ZITADEL_API_URL.
 * Browser-facing hosts remain independent of the API instance host.
 */

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

export function getServiceConfig(_headers: ReadonlyHeaders): { serviceConfig: ServiceConfig } {
  if (!process.env.ZITADEL_API_URL) {
    throw new Error("ZITADEL_API_URL is not set");
  }

  // The separate Login origin is not a ZITADEL instance domain.
  // Do not forward browser hosts as API instance or public-host overrides.
  const instanceHostSource = process.env.ZITADEL_INSTANCE_HOST || process.env.ZITADEL_API_URL;
  const instanceHost = stripProtocol(instanceHostSource).replace(/\/.*$/, "");

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
