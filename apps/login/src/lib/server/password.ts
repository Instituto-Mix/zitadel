import "server-only";

import { isLegacyMigrateEnabled, legacyMigratePassword } from "@/lib/server/legacy-migrate";
import { createLogger } from "@/lib/server/logger";
import { listAuthenticationMethodTypes } from "@/lib/server/zitadel";
import { AuthenticationMethodType } from "@zitadel/proto/zitadel/user/v2/user_service_pb";

const logger = createLogger("password");

/**
 * First-access bridge (Track B). Called only after a normal Zitadel password
 * check has already failed. On success the backend has verified the typed
 * password against the legacy ERP digest and returned a password-reset code —
 * it has NOT installed a password, so the caller cannot retry auth; it must send
 * the user to the "choose a new password" screen instead.
 *
 * Returns undefined in every other case, including "user already has a Zitadel
 * password" (an ordinary wrong password, not a first access).
 *
 * Guarded on the user having no PASSWORD auth method, so a normal user's typo is
 * never forwarded to the backend.
 */
export async function tryLegacyFirstAccess({
  serviceConfig,
  userId,
  loginName,
  password,
}: {
  serviceConfig: Parameters<typeof listAuthenticationMethodTypes>[0]["serviceConfig"];
  userId: string;
  loginName: string;
  password?: string;
}): Promise<{ userId: string; resetCode: string } | "mismatch" | undefined> {
  if (!password || !isLegacyMigrateEnabled()) {
    return undefined;
  }

  try {
    const methods = await listAuthenticationMethodTypes({ serviceConfig, userId });
    if (methods.authMethodTypes?.includes(AuthenticationMethodType.PASSWORD)) {
      // The user does have a Zitadel password — this was simply the wrong one.
      return undefined;
    }
  } catch (error) {
    logger.warn("could not list auth methods for first-access check", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  const result = await legacyMigratePassword({ loginName, password });
  if (result.outcome !== "verified") {
    return undefined;
  }

  // The provisioner pins Zitadel's userId to the ERP pessoa id at creation, so
  // for every user it created the two ids are the same value and the reset code
  // is issued against that id. A user created out-of-band keeps a snowflake id,
  // and the code would then be issued against an id that is not this user's —
  // spending it would just fail ("Codigo nao encontrado", COMMAND-2M9fs).
  //
  // So a mismatch is an integrity problem between provisioning and the instance,
  // never a credential problem. Fail closed and say so, rather than telling the
  // user their password was wrong.
  if (result.userId !== userId) {
    logger.error("first-access id mismatch: backend reset code is not for the resolved Zitadel user", {
      resolvedUserId: userId,
      backendUserId: result.userId,
    });
    return "mismatch";
  }

  // Only the code is taken from the backend; the id is the one we resolved.
  return { userId, resetCode: result.resetCode };
}
