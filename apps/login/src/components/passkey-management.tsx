"use client";

import { removeManagedPasskey } from "@/lib/server/passkey-management";
import { Passkey } from "@zitadel/proto/zitadel/user/v2/user_pb";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, AlertType } from "./alert";
import { Button, ButtonColors, ButtonVariants } from "./button";

type Props = {
  sessionId: string;
  passkeys: Passkey[];
  error?: string;
};

export function PasskeyManagement({ sessionId, passkeys: initialPasskeys, error: initialError }: Props) {
  const [passkeys, setPasskeys] = useState(initialPasskeys);
  const [error, setError] = useState(initialError);
  const [success, setSuccess] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    setPasskeys(initialPasskeys);
    setError(initialError);
  }, [initialPasskeys, initialError]);

  async function removePasskey(passkeyId: string) {
    setRemovingId(passkeyId);
    setError(undefined);
    setSuccess("");

    try {
      const result = await removeManagedPasskey(sessionId, passkeyId);
      if ("error" in result) {
        setError(result.error);
        return;
      }

      setPasskeys((current) => current.filter((passkey) => passkey.id !== passkeyId));
      setConfirmingId(null);
      setSuccess("Passkey removed.");
      router.refresh();
    } catch {
      setError("Could not remove this passkey.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <section className="flex flex-col gap-4 py-4" aria-labelledby="managed-passkeys-title">
      <div>
        <h2 id="managed-passkeys-title">Passkeys</h2>
        <p className="ztdl-p">To replace a passkey, register a new key first, then remove the old one.</p>
      </div>

      {error && <Alert>{error}</Alert>}
      {success && <div role="status">{success}</div>}

      {!error && passkeys.length === 0 ? (
        <Alert type={AlertType.INFO}>No passkeys have been registered for this account.</Alert>
      ) : (
        <ul className="flex flex-col gap-3">
          {passkeys.map((passkey) => (
            <li
              key={passkey.id}
              className="border-divider-light dark:border-divider-dark flex flex-col gap-2 rounded-md border p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{passkey.name}</span>
                <Button
                  variant={ButtonVariants.Secondary}
                  color={ButtonColors.Warn}
                  disabled={removingId !== null}
                  onClick={() => {
                    setError(undefined);
                    setSuccess("");
                    setConfirmingId(passkey.id);
                  }}
                >
                  Remove
                </Button>
              </div>

              {confirmingId === passkey.id && (
                <div className="flex flex-col gap-2" role="group" aria-label={`Confirm removal of ${passkey.name}`}>
                  <p className="ztdl-p">This passkey will stop working on Entrar.</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant={ButtonVariants.Primary}
                      color={ButtonColors.Warn}
                      disabled={removingId !== null}
                      onClick={() => removePasskey(passkey.id)}
                    >
                      {removingId === passkey.id ? "Removing…" : "Confirm removal"}
                    </Button>
                    <Button
                      variant={ButtonVariants.Secondary}
                      disabled={removingId !== null}
                      onClick={() => setConfirmingId(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
