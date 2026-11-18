import { changePassword, resetPassword, sendPassword } from "@/lib/actions/password";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { create } from "@zitadel/client";
import { PasswordComplexitySettingsSchema } from "@zitadel/proto/zitadel/settings/v2/password_settings_pb";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SetPasswordForm } from "./set-password-form";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, back: vi.fn() }),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/actions/password", () => ({
  changePassword: vi.fn(),
  resetPassword: vi.fn(),
  sendPassword: vi.fn(),
}));

const defaultComplexitySettings = create(PasswordComplexitySettingsSchema, {
  minLength: 8n,
  requiresUppercase: false,
  requiresLowercase: false,
  requiresNumber: false,
  requiresSymbol: false,
});

const resetFormProps = {
  passwordComplexitySettings: defaultComplexitySettings,
  loginName: "test@example.com",
  userId: "user-1",
  organization: "org-1",
  requestId: "request-1",
  code: "reset-code",
  codeRequired: true,
};

async function submitNewPassword() {
  fireEvent.change(screen.getByTestId("password-set-text-input"), { target: { value: "new-password-123" } });
  fireEvent.change(screen.getByTestId("password-set-confirm-text-input"), { target: { value: "new-password-123" } });
  await waitFor(() => expect(screen.getByTestId("submit-button")).toBeEnabled());

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    fireEvent.click(screen.getByTestId("submit-button"));
  });
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  vi.useRealTimers();
}

describe("SetPasswordForm", () => {
  beforeEach(() => {
    vi.mocked(changePassword).mockReset().mockResolvedValue({ $typeName: "zitadel.user.v2.SetPasswordResponse" });
    vi.mocked(sendPassword).mockReset().mockResolvedValue({ redirect: "/signed-in" });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  test("should autofocus the code input when codeRequired is true", () => {
    const { getByTestId } = render(
      <SetPasswordForm
        passwordComplexitySettings={defaultComplexitySettings}
        loginName="test@example.com"
        userId="user-1"
        codeRequired={true}
      />,
    );
    expect(getByTestId("code-text-input")).toHaveFocus();
  });

  test("should use translated resend accessible name when codeRequired is true", () => {
    render(
      <SetPasswordForm
        passwordComplexitySettings={defaultComplexitySettings}
        loginName="test@example.com"
        userId="user-1"
        codeRequired={true}
      />,
    );

    expect(screen.getByRole("button", { name: "set.resend" })).toBeInTheDocument();
  });

  test("should autofocus the password input when codeRequired is false", () => {
    const { getByTestId } = render(
      <SetPasswordForm
        passwordComplexitySettings={defaultComplexitySettings}
        loginName="test@example.com"
        userId="user-1"
        codeRequired={false}
      />,
    );
    expect(getByTestId("password-set-text-input")).toHaveFocus();
  });

  test.each(["returned", "thrown", "missing", "unsupported"] as const)(
    "acknowledges the changed password and offers contextual sign-in without reset controls after a %s sign-in response",
    async (failure) => {
      if (failure === "returned") {
        vi.mocked(sendPassword).mockResolvedValue({ error: "Failed to authenticate." });
      } else if (failure === "thrown") {
        vi.mocked(sendPassword).mockRejectedValue(new Error("Synthetic sign-in transport failure"));
      } else {
        // Exercise missing or malformed payloads crossing the server-action boundary.
        vi.mocked(sendPassword).mockResolvedValue((failure === "missing" ? undefined : {}) as never);
      }
      const { container } = render(<SetPasswordForm {...resetFormProps} />);

      await submitNewPassword();

      expect(changePassword).toHaveBeenCalledTimes(1);
      expect(sendPassword).toHaveBeenCalledTimes(1);
      expect.soft(screen.queryByText("set.info.passwordChanged")).toBeInTheDocument();
      expect.soft(screen.queryByText("set.errors.signInFailed")).toBeInTheDocument();
      if (failure === "returned") {
        expect(screen.getByText("Failed to authenticate.")).toBeInTheDocument();
      }
      const signInLink = screen.getByRole("link", { name: "set.signIn" });
      const signInUrl = new URL(signInLink.getAttribute("href")!, "http://localhost");
      expect(signInUrl.pathname).toBe("/loginname");
      expect(signInUrl.searchParams.get("loginName")).toBe("test@example.com");
      expect(signInUrl.searchParams.get("organization")).toBe("org-1");
      expect(signInUrl.searchParams.get("requestId")).toBe("request-1");
      expect(signInUrl.searchParams.has("code")).toBe(false);
      expect(signInUrl.searchParams.has("password")).toBe(false);
      expect.soft(container.querySelector("form")).not.toBeInTheDocument();
      expect.soft(screen.queryByTestId("password-set-text-input")).not.toBeInTheDocument();
      expect.soft(screen.queryByTestId("password-set-confirm-text-input")).not.toBeInTheDocument();
      expect.soft(screen.queryByTestId("code-text-input")).not.toBeInTheDocument();
      expect.soft(screen.queryByTestId("submit-button")).not.toBeInTheDocument();
      expect.soft(screen.queryByTestId("resend-button")).not.toBeInTheDocument();
      expect(push).not.toHaveBeenCalled();
      expect(resetPassword).not.toHaveBeenCalled();
    },
  );

  test.each(["returned", "thrown"] as const)(
    "keeps the password form and reports a genuine %s password-write failure without attempting sign-in",
    async (failure) => {
      if (failure === "returned") {
        vi.mocked(changePassword).mockResolvedValue({ error: "Reset code has expired." });
      } else {
        vi.mocked(changePassword).mockRejectedValue(new Error("Synthetic password-write transport failure"));
      }
      render(<SetPasswordForm {...resetFormProps} />);

      await submitNewPassword();

      expect(screen.getByText(failure === "returned" ? "Reset code has expired." : "set.errors.couldNotSetPassword"))
        .toBeInTheDocument();
      expect(screen.queryByText("set.info.passwordChanged")).not.toBeInTheDocument();
      expect(screen.queryByText("set.errors.signInFailed")).not.toBeInTheDocument();
      expect(screen.getByTestId("password-set-text-input")).toHaveValue("new-password-123");
      expect(screen.getByTestId("password-set-confirm-text-input")).toHaveValue("new-password-123");
      expect(screen.getByTestId("code-text-input")).toHaveValue("reset-code");
      expect(screen.getByTestId("submit-button")).toBeEnabled();
      expect(screen.getByTestId("resend-button")).toBeEnabled();
      expect(changePassword).toHaveBeenCalledTimes(1);
      expect(sendPassword).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    },
  );

  test.each([
    { step: "normal sign-in", redirect: "/signed-in", codeRequired: true },
    { step: "MFA", redirect: "/otp/time-based?sessionId=session-1&requestId=request-1", codeRequired: true },
    { step: "email verification", redirect: "/verify?sessionId=session-1&requestId=request-1", codeRequired: true },
    { step: "verified no-code setup", redirect: "/signed-in", codeRequired: false },
  ])("preserves the $step continuation after a successful password write", async ({ redirect, codeRequired }) => {
    vi.mocked(sendPassword).mockResolvedValue({ redirect });
    render(<SetPasswordForm {...resetFormProps} codeRequired={codeRequired} />);

    await submitNewPassword();

    expect(push).toHaveBeenCalledExactlyOnceWith(redirect);
    expect(changePassword).toHaveBeenCalledTimes(1);
    expect(sendPassword).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("set.errors.signInFailed")).not.toBeInTheDocument();
  });

  test("preserves SAML form submission after a successful password write", async () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
    const samlData = {
      url: "https://sp.example.test/consume",
      fields: { SAMLResponse: "synthetic-saml-response", RelayState: "synthetic-relay-state" },
    };
    vi.mocked(sendPassword).mockResolvedValue({ samlData });
    const { container } = render(<SetPasswordForm {...resetFormProps} />);

    await submitNewPassword();

    const form = container.querySelector<HTMLFormElement>('form[action="https://sp.example.test/consume"]');
    expect(form).toHaveAttribute("method", "post");
    const fields = new FormData(form!);
    expect(fields.get("SAMLResponse")).toBe("synthetic-saml-response");
    expect(fields.get("RelayState")).toBe("synthetic-relay-state");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByText("set.errors.signInFailed")).not.toBeInTheDocument();
  });
});
