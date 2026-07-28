"use client";

import { sendCurrentEmailVerification, updateEmail } from "@/lib/server/email";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Alert } from "./alert";
import { BackButton } from "./back-button";
import { Button, ButtonVariants } from "./button";
import { TextInput } from "./input";
import { Spinner } from "./spinner";
import { Translated } from "./translated";

type Inputs = { email: string };

type Props = {
  currentEmail?: string;
  verified?: boolean;
  loginName?: string;
  organization?: string;
  requestId?: string;
};

export function EmailForm({ currentEmail, verified, loginName, organization, requestId }: Props) {
  const { register, handleSubmit, formState } = useForm<Inputs>({
    mode: "onChange",
    defaultValues: { email: "" },
  });

  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const t = useTranslations("email");

  async function onSubmit(values: Inputs) {
    setLoading(true);
    setError("");
    const response = await updateEmail({
      email: values.email,
      loginName,
      organization,
      requestId,
    }).catch(() => ({ error: t("errors.couldNotUpdate") }));
    setLoading(false);

    if (response && "error" in response && response.error) {
      setError(response.error);
      return;
    }
    if (response && "redirect" in response && response.redirect) {
      router.push(response.redirect);
    }
  }

  async function onVerifyNow() {
    setLoading(true);
    setError("");
    const response = await sendCurrentEmailVerification({ loginName, organization, requestId }).catch(() => ({
      error: t("errors.couldNotUpdate"),
    }));
    setLoading(false);
    if (response && "error" in response && response.error) {
      setError(response.error);
      return;
    }
    if (response && "redirect" in response && response.redirect) {
      router.push(response.redirect);
    }
  }

  return (
    <form className="w-full" onSubmit={handleSubmit(onSubmit)}>
      <div className="border-divider-light dark:border-divider-dark flex flex-col rounded-md border p-4">
        {/* No usable address on file (missing, or the undeliverable provisioning
            placeholder) — this must read as "add your email", never show the
            placeholder as if it were the user's address. */}
        <div className="mb-4 flex flex-row flex-wrap items-center gap-2">
          <span className="ztdl-p !mb-0 min-w-0 break-all">
            {currentEmail ? (
              <Translated i18nKey="current" namespace="email" data={{ email: currentEmail }} />
            ) : (
              <Translated i18nKey="noEmail" namespace="email" />
            )}
          </span>
          <span
            className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium leading-none ${
              verified
                ? "bg-green-500/15 text-green-700 dark:text-green-300"
                : "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300"
            }`}
          >
            <Translated
              i18nKey={!currentEmail ? "missing" : verified ? "verified" : "unverified"}
              namespace="email"
            />
          </span>
        </div>

        {currentEmail && !verified && (
          <button
            type="button"
            onClick={onVerifyNow}
            disabled={loading}
            data-testid="verify-now-button"
            className="hover:text-primary-light-500 dark:hover:text-primary-dark-500 mb-4 self-start text-sm transition-all"
          >
            <Translated i18nKey="verifyNow" namespace="email" />
          </button>
        )}

        <TextInput
        type="email"
        autoComplete="email"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        autoFocus
        {...register("email", {
          required: t("required.email"),
          pattern: { value: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, message: t("required.email") },
        })}
        label={currentEmail ? t("label") : t("labelAdd")}
          data-testid="email-text-input"
        />
      </div>

      {error && (
        <div className="py-4" data-testid="error">
          <Alert>{error}</Alert>
        </div>
      )}

      <div className="mt-4 flex w-full flex-row items-center">
        <BackButton data-testid="back-button" />
        <span className="flex-grow"></span>
        <Button
          data-testid="submit-button"
          type="submit"
          className="self-end"
          variant={ButtonVariants.Primary}
          disabled={loading || !formState.isValid}
        >
          {loading && <Spinner className="mr-2 h-5 w-5" />}
          <Translated i18nKey="submit" namespace="email" />
        </Button>
      </div>
    </form>
  );
}
