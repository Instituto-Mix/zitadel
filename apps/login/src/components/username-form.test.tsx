import { sendLoginname } from "@/lib/server/loginname";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { UsernameForm } from "./username-form";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/server/loginname", () => ({
  sendLoginname: vi.fn().mockResolvedValue({ redirect: "/password" }),
}));

describe("UsernameForm", () => {
  afterEach(cleanup);

  test("should autofocus the loginName input on mount", () => {
    const { getByTestId } = render(
      <UsernameForm loginName="" requestId={undefined} loginSettings={undefined} submit={false} allowRegister={false} />,
    );
    expect(getByTestId("username-text-input")).toHaveFocus();
  });

  test("submits manually entered login name once on Enter and advances", async () => {
    const { getByTestId } = render(
      <UsernameForm loginName="" requestId={undefined} loginSettings={undefined} submit={false} allowRegister={false} />,
    );
    const input = getByTestId("username-text-input");
    fireEvent.change(input, { target: { value: "typed@example.com" } });
    await waitFor(() => expect(getByTestId("submit-button")).toBeEnabled());

    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(sendLoginname).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith("/password");
    });
    expect(sendLoginname).toHaveBeenCalledWith(expect.objectContaining({ loginName: "typed@example.com" }));
  });
});
