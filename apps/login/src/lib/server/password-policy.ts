import "server-only";

import type { Duration } from "@zitadel/client";
import type { LoginSettings } from "@zitadel/proto/zitadel/settings/v2/login_settings_pb";

/** Only the resolved user's policy may choose the lifetime of a password check. */
export function getPasswordCheckLifetime(loginSettings: LoginSettings): Duration {
  const lifetime = loginSettings.passwordCheckLifetime;
  if (lifetime?.seconds) {
    return lifetime;
  }
  // Session helpers accept the same plain duration initializer as before the cutover.
  const defaultLifetime = { seconds: BigInt(60 * 60 * 24), nanos: 0 } as Duration;
  return defaultLifetime;
}
