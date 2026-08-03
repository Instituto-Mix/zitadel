"use client";

import { lowerCaseValidator, numberValidator, symbolValidator, upperCaseValidator } from "@/helpers/validators";
import { handleServerActionResponse } from "@/lib/client-utils";
import { completeFirstAccess } from "@/lib/server/password";
import { PasswordComplexitySettings } from "@zitadel/proto/zitadel/settings/v2/password_settings_pb";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FieldValues, useForm } from "react-hook-form";
import { Alert } from "./alert";
import { AutoSubmitForm } from "./auto-submit-form";
import { Button, ButtonVariants } from "./button";
import { TextInput } from "./input";
import { PasswordComplexity } from "./password-complexity";
import { Spinner } from "./spinner";
import { Translated } from "./translated";

type Inputs =
  | {
      password: string;
      confirmPassword: string;
    }
  | FieldValues;

type Props = {
  passwordComplexitySettings: PasswordComplexitySettings;
};

/**
 * First access (Track B): the legacy ERP credential has already proven who the
 * user is, and this screen collects the password that will actually be
 * installed. There is no code field — the reset code never leaves the server,
 * it is looked up from the httpOnly handle cookie inside the server action.
 *
 * The client-side complexity hints are a convenience; Zitadel is the authority
 * and its rejection is surfaced verbatim so the user can correct and retry.
 */
export function FirstAccessPasswordForm({ passwordComplexitySettings }: Props) {
  const { register, handleSubmit, watch, formState } = useForm<Inputs>({ mode: "onChange" });

  const t = useTranslations("password");

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [samlData, setSamlData] = useState<{ url: string; fields: Record<string, string> } | null>(null);

  const router = useRouter();

  async function submitPassword(values: Inputs) {
    setError("");
    setLoading(true);

    const response = await completeFirstAccess({ password: values.password }).catch(() => {
      setError(t("set.errors.couldNotSetPassword"));
      return undefined;
    });

    setLoading(false);

    if (!response) {
      setError((current) => current || t("set.errors.couldNotSetPassword"));
      return;
    }

    handleServerActionResponse(response as any, router, setSamlData, setError);
  }

  const { errors } = formState;

  const watchPassword = watch("password", "");
  const watchConfirmPassword = watch("confirmPassword", "");

  const hasMinLength = passwordComplexitySettings && watchPassword?.length >= passwordComplexitySettings.minLength;
  const hasSymbol = symbolValidator(watchPassword);
  const hasNumber = numberValidator(watchPassword);
  const hasUppercase = upperCaseValidator(watchPassword);
  const hasLowercase = lowerCaseValidator(watchPassword);

  const policyIsValid =
    passwordComplexitySettings &&
    (passwordComplexitySettings.requiresLowercase ? hasLowercase : true) &&
    (passwordComplexitySettings.requiresNumber ? hasNumber : true) &&
    (passwordComplexitySettings.requiresUppercase ? hasUppercase : true) &&
    (passwordComplexitySettings.requiresSymbol ? hasSymbol : true) &&
    hasMinLength;

  return (
    <>
      {samlData && <AutoSubmitForm url={samlData.url} fields={samlData.fields} />}
      <form className="w-full">
        <div className="mb-4 grid grid-cols-1 gap-4 pt-4">
          <div>
            <TextInput
              type="password"
              autoComplete="new-password"
              autoFocus
              required
              {...register("password", {
                required: t("set.required.newPassword"),
              })}
              label={t("set.labels.newPassword")}
              error={errors.password?.message as string}
              data-testid="password-set-text-input"
            />
          </div>
          <div>
            <TextInput
              type="password"
              required
              autoComplete="new-password"
              {...register("confirmPassword", {
                required: t("set.required.confirmPassword"),
              })}
              label={t("set.labels.confirmPassword")}
              error={errors.confirmPassword?.message as string}
              data-testid="password-set-confirm-text-input"
            />
          </div>
        </div>

        {passwordComplexitySettings && (
          <PasswordComplexity
            passwordComplexitySettings={passwordComplexitySettings}
            password={watchPassword}
            equals={!!watchPassword && watchPassword === watchConfirmPassword}
          />
        )}

        {error && <Alert>{error}</Alert>}

        <div className="mt-8 flex w-full flex-row items-center justify-end">
          <Button
            type="submit"
            variant={ButtonVariants.Primary}
            disabled={loading || !policyIsValid || !formState.isValid || watchPassword !== watchConfirmPassword}
            onClick={handleSubmit(submitPassword)}
            data-testid="submit-button"
          >
            {loading && <Spinner className="mr-2 h-5 w-5" />} <Translated i18nKey="set.submit" namespace="password" />
          </Button>
        </div>
      </form>
    </>
  );
}
