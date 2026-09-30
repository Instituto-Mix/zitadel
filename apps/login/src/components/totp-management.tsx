"use client";

import { removeManagedTOTP } from "@/lib/server/totp-management";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertType } from "./alert";
import { Button, ButtonColors, ButtonVariants } from "./button";

type Props = {
  sessionId?: string;
  configured: boolean;
  setupAllowed?: boolean;
  setupHref?: string;
};

export function TotpManagement({ sessionId, configured, setupAllowed, setupHref }: Props) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState(false);

  async function confirmRemoval() {
    if (!sessionId || pending) {
      return;
    }

    setError(undefined);
    setPending(true);
    try {
      const result = await removeManagedTOTP(sessionId);
      if ("error" in result) {
        setError(result.error);
        return;
      }

      setSuccess(true);
      setConfirming(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove authenticator app");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mt-8 flex flex-col space-y-3" aria-labelledby="totp-management-title">
      <h2 id="totp-management-title" className="text-lg font-medium">
        Authenticator app (OTP)
      </h2>
      <p role="status">
        {configured
          ? "An authenticator app is configured for this account."
          : "No authenticator app is configured for this account."}
      </p>

      {configured ? (
        <>
          <p>
            Replacing this authenticator requires removing it before setting up another one, so TOTP will be unavailable
            between those steps.
          </p>
          {setupAllowed === false && <p>Your current sign-in policy does not allow setting up an authenticator app.</p>}
          {setupAllowed === undefined && (
            <p>Authenticator-app setup availability could not be confirmed from the current sign-in policy.</p>
          )}
          {setupAllowed && !setupHref && <p>Authenticator-app setup is unavailable for this account context.</p>}
          {sessionId && !confirming && (
            <Button variant={ButtonVariants.Secondary} onClick={() => setConfirming(true)}>
              Remove authenticator app
            </Button>
          )}
          {!sessionId && <Alert>Could not find an active session for authenticator management.</Alert>}
          {confirming && (
            <div className="border-divider-light dark:border-divider-dark flex flex-col space-y-3 rounded-md border p-4">
              <p>
                Removing this authenticator stops its codes from working. You must enroll a new authenticator after removal;
                whether setup is available depends on your current sign-in policy.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button
                  variant={ButtonVariants.Primary}
                  color={ButtonColors.Warn}
                  disabled={pending}
                  onClick={confirmRemoval}
                >
                  {pending ? "Removing authenticator…" : "Confirm removal"}
                </Button>
                <Button variant={ButtonVariants.Secondary} disabled={pending} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </>
      ) : setupHref ? (
        <Link
          href={setupHref}
          className="border-divider-light dark:border-divider-dark block rounded-md border px-5 py-3 font-medium hover:shadow-lg hover:dark:bg-white/10"
        >
          Set up authenticator (OTP)
        </Link>
      ) : (
        <Alert type={AlertType.INFO}>
          {setupAllowed === false
            ? "Your current sign-in policy does not allow setting up an authenticator app."
            : setupAllowed
              ? "Authenticator-app setup is unavailable for this account context."
              : "Authenticator-app setup availability could not be confirmed from the current sign-in policy."}
        </Alert>
      )}

      {success && (
        <Alert type={AlertType.INFO}>The authenticator was removed. Codes from the previous setup no longer work.</Alert>
      )}
      {error && (
        <div role="alert">
          <Alert>{error}</Alert>
        </div>
      )}
    </section>
  );
}
