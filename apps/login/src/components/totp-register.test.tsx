import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TotpRegister } from "./totp-register";

const mocks = vi.hoisted(() => ({
  verifyTOTP: vi.fn(),
  completeFlowOrGetUrl: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/server/verify", () => ({
  verifyTOTP: mocks.verifyTOTP,
}));

vi.mock("@/lib/client", () => ({
  completeFlowOrGetUrl: mocks.completeFlowOrGetUrl,
}));

vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="qr-code" data-value={value} />,
}));

describe("TotpRegister", () => {
  afterEach(cleanup);

  test("should autofocus the code input on mount", () => {
    const { getByTestId } = render(<TotpRegister uri="otpauth://totp/test" secret="SECRET" />);
    expect(getByTestId("code-text-input")).toHaveFocus();
  });

  test("shows a returned verification error without completing the flow", async () => {
    mocks.verifyTOTP.mockResolvedValue({ error: "Invalid code" });

    const { getByTestId, findByText } = render(
      <TotpRegister
        uri="otpauth://totp/test"
        secret="SECRET"
        sessionId="selected-session"
        loginName="person@example.com"
        organization="selected-organization"
        requestId="request-id"
      />,
    );
    fireEvent.change(getByTestId("code-text-input"), { target: { value: "123456" } });
    await waitFor(() => expect(getByTestId("submit-button")).toBeEnabled());
    fireEvent.click(getByTestId("submit-button"));

    expect(await findByText("Invalid code")).toBeInTheDocument();
    expect(mocks.verifyTOTP).toHaveBeenCalledWith(
      "123456",
      "selected-session",
      "person@example.com",
      "selected-organization",
    );
    expect(mocks.completeFlowOrGetUrl).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
