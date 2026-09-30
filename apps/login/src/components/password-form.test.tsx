import { sendPassword } from "@/lib/server/password";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PasswordForm } from "./password-form";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/server/password", () => ({
  sendPassword: vi.fn().mockResolvedValue({ redirect: "/next" }),
  resetPassword: vi.fn(),
}));

describe("PasswordForm", () => {
  afterEach(cleanup);

  test("should autofocus the password input on mount", () => {
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
});
