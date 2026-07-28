import { createLogger } from "@/lib/logger";

const logger = createLogger("legacy-migrate");

/**
 * First-access bridge from the legacy ERP credential (Track B).
 *
 * Provisioned users have no Zitadel password — their only credential is an
 * unsalted MD5 digest in the ERP, which this instance cannot verify. The usual
 * "no primary auth method" fallback (send an invite/verification email) is dead
 * for this population: roughly half the addresses are missing or wrong, and the
 * provisioner substitutes the undeliverable placeholder `email@invalido.troque`.
 *
 * So first access bridges through the backend instead: we hand it the loginName
 * and the password the user just typed. If it matches the ERP digest, the
 * backend sets a real Zitadel password with changeRequired=true and we retry
 * normal Zitadel auth with the same password — Zitadel then drives its own
 * mandatory password-change screen.
 *
 * The endpoint is idempotent-safe: a second call for a user who already has a
 * Zitadel password returns 409, never a re-migration.
 */

export type LegacyMigrateOutcome =
  /** 204 — ERP password matched, a Zitadel password now exists. Retry auth. */
  | "migrated"
  /** 409 — user already has a Zitadel password. Do not retry this endpoint. */
  | "has_password"
  /**
   * 403 — not verifiable: unknown user, no stored digest, wrong password, or
   * not yet provisioned. The backend deliberately collapses these into one
   * status; callers must not try to tell them apart or use it to probe accounts.
   */
  | "not_verifiable"
  /** Not configured, unreachable, or an unexpected status. Treated as a miss. */
  | "unavailable";

/**
 * Ask the backend to verify the typed password against the legacy ERP digest and,
 * on a match, set it as the user's Zitadel password (changeRequired=true).
 *
 * Never logs the loginName or the password.
 */
export async function legacyMigratePassword({
  loginName,
  password,
}: {
  loginName: string;
  password: string;
}): Promise<LegacyMigrateOutcome> {
  const backendUrl = process.env.AUTH_BACKEND_URL;
  if (!backendUrl) {
    logger.debug("AUTH_BACKEND_URL not set, skipping legacy-migrate");
    return "unavailable";
  }

  const token = process.env.AUTH_BACKEND_TOKEN;
  if (!token) {
    logger.warn("AUTH_BACKEND_TOKEN not set, skipping legacy-migrate");
    return "unavailable";
  }

  if (!loginName || !password) {
    return "unavailable";
  }

  try {
    // AUTH_BACKEND_URL already includes the API version prefix (e.g. .../v1),
    // so the path here is just /auth/legacy-migrate.
    const response = await fetch(`${backendUrl.replace(/\/$/, "")}/auth/legacy-migrate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The backend guard checks this exact header (not Authorization: Bearer).
        "x-zitadel-service-account": token,
        // Bypass the ngrok free-tier browser interstitial for API calls.
        "ngrok-skip-browser-warning": "1",
      },
      body: JSON.stringify({ login_name: loginName, password }),
    });

    switch (response.status) {
      case 204:
        logger.info("legacy password migrated, retrying zitadel auth");
        return "migrated";
      case 409:
        return "has_password";
      case 403:
        return "not_verifiable";
      default:
        logger.warn("legacy-migrate returned unexpected status", { status: response.status });
        return "unavailable";
    }
  } catch (error) {
    logger.warn("legacy-migrate call failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "unavailable";
  }
}

/** True when the legacy first-access bridge is configured for this deployment. */
export function isLegacyMigrateEnabled(): boolean {
  return !!process.env.AUTH_BACKEND_URL && !!process.env.AUTH_BACKEND_TOKEN;
}
