"use client";

import { updateEmail } from "@/lib/server/email";
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
  loginName?: string;
  organization?: string;
  requestId?: string;
};

export function EmailForm({ currentEmail, loginName, organization, requestId }: Props) {
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

  return (
    <form className="w-full" onSubmit={handleSubmit(onSubmit)}>
      {currentEmail && (
        <p className="ztdl-p mb-4 block">
          <Translated i18nKey="current" namespace="email" data={{ email: currentEmail }} />
        </p>
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
        label={t("label")}
        data-testid="email-text-input"
      />

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
