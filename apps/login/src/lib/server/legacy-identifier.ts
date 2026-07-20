import { createLogger } from "@/lib/logger";

const logger = createLogger("legacy-identifier");

/**
 * Legacy-identifier login (Track B).
 *
 * Users authenticate by typing a legacy identifier — a tax number (CPF, 11
 * digits) or a legacy username (e.g. "A0000") — instead of the Zitadel
 * loginName the provisioner assigned. Zitadel only knows each user by a single
 * loginName (usernames[0]); the tax number and any secondary legacy username
 * are NOT Zitadel loginNames and would otherwise resolve to "user not found".
 *
 * Before Login v2 searches for the user, we ask the backend resolver to
 * translate the typed identifier into the canonical Zitadel loginName. On a hit
 * we substitute; on a miss/error we fall through unchanged and let Zitadel's
 * normal "user not found" path handle it (fail-open).
 */

export type CredentialType = "tax_id" | "username";

export interface ResolveResponse {
  user_id: number;
  login_name: string;
  name?: string;
  active: boolean;
  user_types?: string[];
  has_affiliations?: boolean;
}

/**
 * Detect whether a typed identifier should be resolved as a tax number or a
 * legacy username. Exactly 11 digits → tax number; anything else → username.
 * The backend attempts the other lookup as a fallback anyway, so this only
 * needs to pick the most-likely primary lookup.
 */
export function detectCredentialType(value: string): CredentialType {
  return /^\d{11}$/.test(value.trim()) ? "tax_id" : "username";
}

/**
 * Pure substitution: given the typed identifier and a resolver result, return
 * the loginName Login v2 should search for. A hit for an active user with a
 * login_name substitutes; a miss (null), an inactive user, or a missing
 * login_name passes the typed value through unchanged.
 */
export function substituteLoginName(
  typedValue: string,
  resolved: ResolveResponse | null,
): string {
  if (resolved && resolved.active && resolved.login_name) {
    return resolved.login_name;
  }
  return typedValue;
}

/**
 * Call the backend resolver. Returns the canonical mapping on a hit, or null on
 * a miss (403), any error, or when AUTH_BACKEND_URL is not configured — the
 * caller falls through unchanged (fail-open). The typed value is never logged.
 */
export async function resolveLegacyIdentifier(
  typedValue: string,
): Promise<ResolveResponse | null> {
  const backendUrl = process.env.AUTH_BACKEND_URL;
  if (!backendUrl) {
    logger.debug("AUTH_BACKEND_URL not set, skipping legacy-identifier resolve");
    return null;
  }

  const token = process.env.AUTH_BACKEND_TOKEN;
  if (!token) {
    logger.warn("AUTH_BACKEND_TOKEN not set, skipping legacy-identifier resolve");
    return null;
  }

  const credentialType = detectCredentialType(typedValue);

  try {
    const response = await fetch(
      `${backendUrl.replace(/\/$/, "")}/v1/auth/resolve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          credential_type: credentialType,
          value: typedValue,
        }),
      },
    );

    // 403 = miss/inactive. Any non-2xx falls through (fail-open).
    if (!response.ok) {
      logger.debug("resolver returned non-ok status", { status: response.status });
      return null;
    }

    const data = (await response.json()) as ResolveResponse;
    return data;
  } catch (error) {
    // Fail-open: a resolver outage must not block logins by real loginName.
    logger.warn("legacy-identifier resolve failed, falling through", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
