import { resetPassword, sendPassword } from "@/lib/server/password";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PasswordForm } from "./password-form";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    ({ "verify.showPassword": "Show password", "verify.hidePassword": "Hide password" })[key] ?? key,
}));

vi.mock("@/lib/server/password", () => ({
  sendPassword: vi.fn().mockResolvedValue({ redirect: "/next" }),
  resetPassword: vi.fn(),
}));

describe("PasswordForm", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test("focuses the password input on mount", () => {
    const { getByTestId } = render(<PasswordForm loginSettings={undefined} loginName="test@example.com" />);
    expect(getByTestId("password-text-input")).toHaveFocus();
  });

  test("submits manually entered password once on Enter and advances", async () => {
    const { getByTestId } = render(<PasswordForm loginSettings={undefined} loginName="test@example.com" />);
    const input = getByTestId("password-text-input");
    fireEvent.change(input, { target: { value: "typed-password" } });
    await waitFor(() => expect(getByTestId("submit-button")).toBeEnabled());
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => {
      expect(sendPassword).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith("/next");
    });
    expect(sendPassword).toHaveBeenCalledWith(
      expect.objectContaining({
        loginName: "test@example.com",
        checks: expect.objectContaining({ password: expect.objectContaining({ password: "typed-password" }) }),
      }),
    );
  });

  test("shows and hides the exact password without submitting, then submits it unchanged", async () => {
    const { getByTestId, getByRole } = render(
      <PasswordForm
        loginName="person@example.com"
        loginSettings={undefined}
        organization="org"
        defaultOrganization="default-org"
        requestId="request"
      />,
    );
    const input = getByTestId("password-text-input");
    const password = "  test !@#$ %^&* Ω  ";

    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input, { target: { value: password } });
    await waitFor(() => expect(getByTestId("submit-button")).toBeEnabled());

    const show = getByRole("button", { name: "Show password" });
    expect(show).toHaveAttribute("type", "button");
    fireEvent.click(show);
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveValue(password);
    expect(sendPassword).not.toHaveBeenCalled();
    expect(resetPassword).not.toHaveBeenCalled();

    const hide = getByRole("button", { name: "Hide password" });
    expect(hide).toHaveAttribute("type", "button");
    fireEvent.click(hide);
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue(password);
    expect(sendPassword).not.toHaveBeenCalled();
    expect(resetPassword).not.toHaveBeenCalled();

    fireEvent.click(getByTestId("submit-button"));
    await waitFor(() => expect(sendPassword).toHaveBeenCalledTimes(1));
    expect(sendPassword).toHaveBeenCalledWith(
      expect.objectContaining({
        loginName: "person@example.com",
        organization: "org",
        defaultOrganization: "default-org",
        requestId: "request",
        checks: expect.objectContaining({ password: expect.objectContaining({ password }) }),
      }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/next"));
    expect(resetPassword).not.toHaveBeenCalled();
  });
});
