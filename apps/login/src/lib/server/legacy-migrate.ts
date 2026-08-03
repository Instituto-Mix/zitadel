// This module holds a bearer secret. `server-only` makes an accidental import
// from a client component a build error rather than a leak.
import "server-only";

import { createLogger } from "@/lib/logger";

const logger = createLogger("legacy-migrate");

/**
 * Credentials for the call below. The whole auth concern for the bridge lives
 * here and nowhere else.
 *
 * AUTH_BACKEND_TOKEN must hold the PAT of the dedicated `login-page` Zitadel
 * machine user (382641673429057539) — not an ad hoc value. It is sent as
 * `x-zitadel-service-account` and must be treated as a bearer secret: env var
 * only, server-side only, never logged, never surfaced in an error message, and
 * never given a NEXT_PUBLIC_ name (which would put it in the client bundle).
 */
function getServiceAccountToken(): string | undefined {
  return process.env.AUTH_BACKEND_TOKEN;
}

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
 * and the password the user just typed. The ERP credential is PROOF OF IDENTITY
 * ONLY — it is never installed as the Zitadel password. The ERP stores an
 * unsalted MD5 that can neither be inspected nor reversed, so there is no way to
 * know in advance whether it satisfies Zitadel's complexity policy, and most
 * legacy passwords do not. Instead the backend returns a short-lived
 * password-reset code, and the user must choose a new, compliant password. That
 * choice IS the mandatory rotation — there is no separate forced-change screen,
 * because no old password is ever installed.
 *
 * The endpoint is idempotent-safe: a second call for a user who already has a
 * Zitadel password returns 409, never a re-migration.
 */

export type LegacyMigrateResult =
  /**
   * 200 — the ERP password matched. `resetCode` authorizes setting that user's
   * Zitadel password: it is BEARER-GRADE, must stay server-side, and must never
   * be logged, put in a URL, or sent to the browser.
   */
  | { outcome: "verified"; userId: string; resetCode: string }
  /** 409 — user already has a Zitadel password. Do not retry this endpoint. */
  | { outcome: "has_password" }
  /**
   * 403 — not verifiable: unknown user, no stored digest, wrong password, or
   * not yet provisioned. The backend deliberately collapses these into one
   * status; callers must not try to tell them apart or use it to probe accounts.
   */
  | { outcome: "not_verifiable" }
  /** Not configured, unreachable, or an unexpected status. Treated as a miss. */
  | { outcome: "unavailable" };

/**
 * Ask the backend to verify the typed password against the legacy ERP digest.
 * On a match it returns the user id and a password-reset code; the caller must
 * then have the user choose a new password and spend that code server-side.
 *
 * Never logs the loginName, the password, or the reset code.
 */
export async function legacyMigratePassword({
  loginName,
  password,
}: {
  loginName: string;
  password: string;
}): Promise<LegacyMigrateResult> {
  const backendUrl = process.env.AUTH_BACKEND_URL;
  if (!backendUrl) {
    logger.debug("AUTH_BACKEND_URL not set, skipping legacy-migrate");
    return { outcome: "unavailable" };
  }

  const token = getServiceAccountToken();
  if (!token) {
    logger.warn("service account token not set, skipping legacy-migrate");
    return { outcome: "unavailable" };
  }

  if (!loginName || !password) {
    return { outcome: "unavailable" };
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
      case 200: {
        const body = await response.json().catch(() => undefined);
        const userId = body?.user_id;
        const resetCode = body?.reset_code;

        if (userId === undefined || userId === null || !resetCode) {
          // Without both fields the rotation cannot be completed, and there is
          // no installed password to fall back on. Treat it as a miss.
          logger.warn("legacy-migrate returned 200 without user_id/reset_code");
          return { outcome: "unavailable" };
        }

        logger.info("legacy credential verified, prompting for a new password");
        return { outcome: "verified", userId: String(userId), resetCode: String(resetCode) };
      }
      case 409:
        return { outcome: "has_password" };
      case 403:
        return { outcome: "not_verifiable" };
      default:
        logger.warn("legacy-migrate returned unexpected status", { status: response.status });
        return { outcome: "unavailable" };
    }
  } catch (error) {
    logger.warn("legacy-migrate call failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { outcome: "unavailable" };
  }
}

/** True when the legacy first-access bridge is configured for this deployment. */
export function isLegacyMigrateEnabled(): boolean {
  return !!process.env.AUTH_BACKEND_URL && !!getServiceAccountToken();
}
