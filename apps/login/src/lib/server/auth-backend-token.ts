import "server-only";

import { createLogger } from "@/lib/logger";

const logger = createLogger("auth-backend-token");

let cachedToken: { value: string; expiresAt: number } | undefined;

/**
 * Obtain the Login v2 resolver's short-lived service token. The credentials are
 * server-only and the result is cached until one minute before expiry.
 */
export async function getAuthBackendAccessToken(): Promise<string | undefined> {
  const issuerUrl = process.env.ZITADEL_API_URL;
  const clientId = process.env.AUTH_BACKEND_CLIENT_ID;
  const clientSecret = process.env.AUTH_BACKEND_CLIENT_SECRET;
  const audience = process.env.AUTH_BACKEND_AUDIENCE;

  if (!issuerUrl || !clientId || !clientSecret || !audience) {
    logger.warn("resolver client configuration is incomplete");
    return undefined;
  }

  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }

  try {
    const response = await fetch(`${issuerUrl.replace(/\/$/, "")}/oauth/v2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: `openid ${audience}`,
      }).toString(),
    });

    if (!response.ok) {
      logger.warn("resolver token request failed", { status: response.status });
      return undefined;
    }

    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
      logger.warn("resolver token response is malformed");
      return undefined;
    }

    cachedToken = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(body.expires_in - 60, 0) * 1_000,
    };
    return cachedToken.value;
  } catch (error) {
    logger.warn("resolver token request failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
