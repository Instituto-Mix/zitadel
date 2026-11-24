import { UNKNOWN_USER_ID } from "@/lib/constants";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { create } from "@zitadel/client";
import { PasswordComplexitySettingsSchema } from "@zitadel/proto/zitadel/settings/v2/password_settings_pb";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import en from "../../../../../locales/en.json";
import Page from "./page";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  getServiceConfig: vi.fn(),
  loadMostRecentSession: vi.fn(),
  getBrandingSettings: vi.fn(),
  getDefaultOrg: vi.fn(),
  getLoginSettings: vi.fn(),
  getPasswordComplexitySettings: vi.fn(),
  getUserByID: vi.fn(),
  searchUsers: vi.fn(),
  changePassword: vi.fn(),
  resetPassword: vi.fn(),
  sendPassword: vi.fn(),
  fetch: vi.fn(),
  router: { push: vi.fn(), back: vi.fn() },
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));
vi.mock("@/lib/server/service-url", () => ({ getServiceConfig: mocks.getServiceConfig }));
vi.mock("@/lib/server/session", () => ({ loadMostRecentSession: mocks.loadMostRecentSession }));
vi.mock("@/lib/server/zitadel", () => ({
  getBrandingSettings: mocks.getBrandingSettings,
  getDefaultOrg: mocks.getDefaultOrg,
  getLoginSettings: mocks.getLoginSettings,
  getPasswordComplexitySettings: mocks.getPasswordComplexitySettings,
  getUserByID: mocks.getUserByID,
  searchUsers: mocks.searchUsers,
}));
vi.mock("@/lib/actions/password", () => ({
  changePassword: mocks.changePassword,
  resetPassword: mocks.resetPassword,
  sendPassword: mocks.sendPassword,
}));
vi.mock("@/components/dynamic-theme", () => ({
  DynamicTheme: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const policy = {
  allowLocalAuthentication: true,
  ignoreUnknownUsernames: true,
  hidePasswordReset: false,
  disableLoginWithEmail: false,
  disableLoginWithPhone: false,
};
const user = {
  userId: "resolved-user",
  preferredLoginName: "canonical@accounts.example",
  details: { resourceOwner: "user-org" },
  type: { case: "human", value: { email: { email: "registered@accounts.example" } } },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("AUTH_BACKEND_URL", "https://backend.example/v1");
  vi.stubEnv("ZITADEL_API_URL", "https://id.example");
  vi.stubEnv("AUTH_BACKEND_CLIENT_ID", "synthetic-resolver-client");
  vi.stubEnv("AUTH_BACKEND_CLIENT_SECRET", "synthetic-test-secret");
  vi.stubEnv("AUTH_BACKEND_AUDIENCE", "synthetic-resolver-audience");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockImplementation(async (url, init) => {
    if (url === "https://id.example/oauth/v2/token") {
      return Response.json({ access_token: "synthetic-access-token", expires_in: 0 });
    }
    if (url === "https://backend.example/v1/auth/resolve") {
      return JSON.parse(init.body).value === "ERP0001"
        ? Response.json({ user_id: 101, login_name: "canonical@accounts.example", active: true })
        : new Response(null, { status: 403 });
    }
    throw new Error("Unexpected synthetic request");
  });
  mocks.headers.mockResolvedValue(new Headers());
  mocks.getServiceConfig.mockReturnValue({ serviceConfig: {} });
  mocks.getDefaultOrg.mockResolvedValue({ id: "default-org" });
  mocks.loadMostRecentSession.mockResolvedValue(undefined);
  mocks.getLoginSettings.mockResolvedValue(policy);
  mocks.getPasswordComplexitySettings.mockResolvedValue(create(PasswordComplexitySettingsSchema, { minLength: 8n }));
  mocks.searchUsers.mockImplementation(async ({ searchValue }) => ({
    result: searchValue === "canonical@accounts.example" ? [user] : [],
  }));
  mocks.changePassword.mockImplementation(async ({ userId, code }) =>
    userId === "resolved-user" && code === "reset-code"
      ? { $typeName: "zitadel.user.v2.SetPasswordResponse" }
      : { error: "Reset code could not be redeemed." },
  );
  mocks.sendPassword.mockResolvedValue({ error: "Synthetic sign-in failure." });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function renderPage(loginName = "ERP0001") {
  const page = await Page({
    searchParams: Promise.resolve({ loginName, organization: "context-org", requestId: "request-1", code: "reset-code" }),
  });
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {page}
    </NextIntlClientProvider>,
  );
}

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

describe("legacy identifier password reset route", () => {
  test("redeems the code for the resolved user while keeping the ERP alias in browser context", async () => {
    const { container } = await renderPage();
    expect(screen.getByText("ERP0001")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/accounts?organization=context-org&requestId=request-1&loginName=ERP0001",
    );

    await submitNewPassword();

    expect(mocks.changePassword).toHaveBeenCalledWith({
      userId: "resolved-user",
      code: "reset-code",
      password: "new-password-123",
      organization: "context-org",
    });
    expect(screen.getByRole("status")).toHaveTextContent(en.password.set.info.passwordChanged);
    expect(screen.getByRole("link", { name: en.password.set.signIn })).toHaveAttribute(
      "href",
      "/loginname?loginName=ERP0001&organization=context-org&requestId=request-1",
    );
    expect(container.innerHTML).not.toContain("canonical@accounts.example");
    expect(container.innerHTML).not.toContain("resolved-user");
  });

  test.each([
    { scenario: "the ERP alias is unresolved", loginName: "ERP_UNKNOWN", allowLocalAuthentication: true },
    { scenario: "local authentication is disabled", loginName: "ERP0001", allowLocalAuthentication: false },
  ])("keeps the unknown-user flow generic when $scenario", async ({ loginName, allowLocalAuthentication }) => {
    mocks.getLoginSettings.mockResolvedValue({ ...policy, allowLocalAuthentication });
    const { container } = await renderPage(loginName);
    expect(screen.getByText(en.password.set.codeSent)).toBeInTheDocument();
    expect(container.innerHTML).not.toContain("registered@accounts.example");
    expect(container.innerHTML).not.toContain("canonical@accounts.example");
    if (!allowLocalAuthentication) expect(mocks.fetch).not.toHaveBeenCalled();

    await submitNewPassword();

    expect(mocks.changePassword).toHaveBeenCalledWith(expect.objectContaining({ userId: UNKNOWN_USER_ID, code: "reset-code" }));
    expect(screen.getByText("Reset code could not be redeemed.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(mocks.sendPassword).not.toHaveBeenCalled();
  });
});
