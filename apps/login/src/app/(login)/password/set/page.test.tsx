import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import en from "../../../../../locales/en.json";
import pt from "../../../../../locales/pt.json";
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
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/lib/service-url", () => ({ getServiceConfig: mocks.getServiceConfig }));
vi.mock("@/lib/session", () => ({ loadMostRecentSession: mocks.loadMostRecentSession }));
vi.mock("@/lib/zitadel", () => ({
  getBrandingSettings: mocks.getBrandingSettings,
  getDefaultOrg: mocks.getDefaultOrg,
  getLoginSettings: mocks.getLoginSettings,
  getPasswordComplexitySettings: mocks.getPasswordComplexitySettings,
  getUserByID: mocks.getUserByID,
  searchUsers: mocks.searchUsers,
}));
vi.mock("@/components/dynamic-theme", () => ({
  DynamicTheme: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/set-password-form", () => ({
  SetPasswordForm: () => (
    <form aria-label="Set password">
      <input aria-label="New password" type="password" />
      <button type="submit">Set password</button>
      <button type="button">Resend code</button>
    </form>
  ),
}));
vi.mock("@/components/user-avatar", () => ({
  UserAvatar: ({ loginName }: { loginName?: string }) => <div aria-label="Account">{loginName}</div>,
}));

const registeredEmail = "jefferson@gmail.com";
const maskedConfirmation = /jef\*{5}@gmail\.com/;
const genericConfirmation = en.password.set.codeSent;
const permittedPolicy = {
  ignoreUnknownUsernames: false,
  hidePasswordReset: false,
  disableLoginWithEmail: false,
  disableLoginWithPhone: false,
};

function registeredUser(email: string | undefined = registeredEmail) {
  return {
    userId: "registered-user",
    preferredLoginName: "canonical@accounts.example",
    details: { resourceOwner: "user-org" },
    type: {
      case: "human",
      value: { email: { email }, phone: { phone: "+5511999999999" } },
    },
  };
}

async function renderPage(
  searchParams: Record<string, string> = { loginName: "canonical@accounts.example" },
  locale: "en" | "pt" = "en",
) {
  const page = await Page({ searchParams: Promise.resolve(searchParams) });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "pt" ? pt : en}>
      {page}
    </NextIntlClientProvider>,
  );
}

function expectGeneric(suppliedIdentifier?: string) {
  expect(screen.getByText(genericConfirmation)).toBeInTheDocument();
  expect(screen.queryByText(maskedConfirmation)).not.toBeInTheDocument();
  // The avatar may repeat the supplied identifier; it must not reveal a different registered address.
  if (suppliedIdentifier !== registeredEmail) {
    expect(document.body.innerHTML).not.toContain(registeredEmail);
  }
}

function expectSupport(locale: "en" | "pt" = "en") {
  const messages = locale === "pt" ? pt : en;
  expect(screen.getByText(messages.password.errors.noUsableResetEmail)).toBeInTheDocument();
  expect(screen.queryByRole("form", { name: "Set password" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.queryByText(messages.password.set.codeSent)).not.toBeInTheDocument();
  expect(screen.queryByText(maskedConfirmation)).not.toBeInTheDocument();
  expect(document.body.innerHTML).not.toContain("invalido.troque");
  expect(screen.queryByLabelText("Account")).not.toBeInTheDocument();
}

afterEach(cleanup);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.headers.mockResolvedValue(new Headers());
  mocks.getServiceConfig.mockReturnValue({ serviceConfig: {} });
  mocks.getDefaultOrg.mockResolvedValue({ id: "default-org" });
  mocks.getBrandingSettings.mockResolvedValue(undefined);
  mocks.getPasswordComplexitySettings.mockResolvedValue({ minLength: 8 });
  mocks.loadMostRecentSession.mockResolvedValue(undefined);
  mocks.getLoginSettings.mockResolvedValue(permittedPolicy);
  mocks.getUserByID.mockResolvedValue({ user: registeredUser() });
  mocks.searchUsers.mockResolvedValue({ result: [registeredUser()] });
});

describe("password reset destination confirmation", () => {
  test("shows the registered email hint rather than the login identifier", async () => {
    const { container } = await renderPage({ loginName: "different@login.example" });
    expect(screen.getByText(maskedConfirmation)).toBeInTheDocument();
    expect(screen.queryByText(genericConfirmation)).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(registeredEmail);
    expect(container.innerHTML).not.toContain("dif*****@login.example");
    expect(screen.getByRole("form", { name: "Set password" })).toBeInTheDocument();
  });

  test.each(["malformed", "nonhuman", "unknown", "ambiguous"])(
    "retains the generic confirmation for a %s destination",
    async (kind) => {
      let user = registeredUser();
      if (kind === "malformed") user = registeredUser("not-an-address");
      if (kind === "nonhuman") {
        mocks.searchUsers.mockResolvedValue({
          result: [{ ...user, type: { case: "machine", value: {} } }],
        });
      } else {
        mocks.searchUsers.mockResolvedValue({ result: kind === "unknown" ? [] : kind === "ambiguous" ? [user, user] : [user] });
      }
      await renderPage();
      expectGeneric();
    },
  );

  test.each(["email@invalido.troque", "other@InVaLiDo.TrOqUe ", "", undefined])(
    "blocks reset controls and directs to support for unusable registered email %s",
    async (email) => {
      const user = registeredUser();
      user.type.value.email = { email };
      mocks.searchUsers.mockResolvedValue({ result: [user] });
      await renderPage();
      expectSupport();
    },
  );

  test("shows Brazilian Portuguese support guidance in the Portuguese locale", async () => {
    mocks.searchUsers.mockResolvedValue({ result: [registeredUser("email@invalido.troque")] });
    await renderPage({ loginName: "canonical@accounts.example" }, "pt");
    expectSupport("pt");
    expect(screen.queryByText(en.password.errors.noUsableResetEmail)).not.toBeInTheDocument();
  });

  test("blocks direct user-ID and code links for a placeholder registered email", async () => {
    mocks.getUserByID.mockResolvedValue({ user: registeredUser("email@invalido.troque") });
    await renderPage({ userId: "registered-user", code: "previously-issued-code" });
    expectSupport();
  });

  test("does not treat initial=false as no-code setup for a placeholder account", async () => {
    mocks.getUserByID.mockResolvedValue({ user: registeredUser("email@invalido.troque") });
    await renderPage({ userId: "registered-user", code: "previously-issued-code", initial: "false" });
    expectSupport();
  });

  test("omits placeholder account context on a direct user-ID and login-name link", async () => {
    const placeholder = "email@invalido.troque";
    mocks.getUserByID.mockResolvedValue({ user: registeredUser(placeholder) });
    mocks.loadMostRecentSession.mockResolvedValue({
      factors: { user: { loginName: placeholder, displayName: placeholder } },
    });
    await renderPage({ userId: "registered-user", loginName: placeholder, code: "previously-issued-code" });
    expectSupport();
  });

  test("blocks login-name and code links when the registered email is missing", async () => {
    const user = registeredUser();
    mocks.searchUsers.mockResolvedValue({ result: [{ ...user, type: { case: "human", value: {} } }] });
    await renderPage({ loginName: "canonical@accounts.example", code: "previously-issued-code" });
    expectSupport();
  });

  test.each(["loginName", "userId"])(
    "shows support for a known placeholder account on a %s link even when unknown usernames are ignored",
    async (identifier) => {
      mocks.getLoginSettings.mockResolvedValue({ ...permittedPolicy, ignoreUnknownUsernames: true });
      const user = registeredUser("email@invalido.troque");
      mocks.getUserByID.mockResolvedValue({ user });
      mocks.searchUsers.mockResolvedValue({ result: [user] });
      await renderPage({ [identifier]: identifier === "userId" ? "registered-user" : "canonical@accounts.example" });
      expectSupport();
    },
  );

  test.each(["email@invalido.troque", ""])(
    "preserves initial no-code password setup with unusable registered email %s",
    async (email) => {
      mocks.getUserByID.mockResolvedValue({ user: registeredUser(email) });
      await renderPage({ userId: "registered-user", initial: "true" });
      expect(screen.getByRole("form", { name: "Set password" })).toBeInTheDocument();
      expect(screen.queryByText(en.password.errors.noUsableResetEmail)).not.toBeInTheDocument();
      expect(screen.queryByText(genericConfirmation)).not.toBeInTheDocument();
      expect(document.body.innerHTML).not.toContain("invalido.troque");
    },
  );

  test("does not show a sent-code alert for initial password setup", async () => {
    await renderPage({ userId: "registered-user", initial: "true" });
    expect(screen.queryByText(maskedConfirmation)).not.toBeInTheDocument();
    expect(screen.queryByText(genericConfirmation)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(registeredEmail);
    expect(screen.getByRole("form", { name: "Set password" })).toBeInTheDocument();
  });

  test("shows a permitted destination on a userId link", async () => {
    await renderPage({ userId: "registered-user" });
    expect(screen.getByText(maskedConfirmation)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(registeredEmail);
  });

  test.each(
    ["loginName", "userId"].flatMap((identifier) =>
      ["default-org", "user-org"].map((organization) => ({ identifier, organization })),
    ),
  )("keeps $identifier generic when $organization hides password reset", async ({ identifier, organization }) => {
    mocks.getLoginSettings.mockImplementation(async (command) => ({
      ...permittedPolicy,
      hidePasswordReset: command.organization === organization,
    }));
    await renderPage({ [identifier]: identifier === "userId" ? "registered-user" : "canonical@accounts.example", code: "unverified-code" });
    expectGeneric();
  });

  test.each(["loginName", "userId"])("shows a known account on a %s link when ignoreUnknownUsernames is enabled", async (identifier) => {
    mocks.getLoginSettings.mockResolvedValue({ ...permittedPolicy, ignoreUnknownUsernames: true });
    await renderPage({ [identifier]: identifier === "userId" ? "registered-user" : "canonical@accounts.example" });
    expect(screen.getByText(maskedConfirmation)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(registeredEmail);
  });

  test("keeps an unknown account generic when ignoreUnknownUsernames is enabled", async () => {
    mocks.getLoginSettings.mockResolvedValue({ ...permittedPolicy, ignoreUnknownUsernames: true });
    mocks.searchUsers.mockResolvedValue({ result: [] });
    await renderPage({ loginName: "unknown@accounts.example" });
    expectGeneric();
  });

  test("fails closed when the user organization's policy is unavailable", async () => {
    mocks.getLoginSettings.mockImplementation(async ({ organization }) =>
      organization === "user-org" ? undefined : permittedPolicy,
    );
    await renderPage({ userId: "registered-user", code: "unverified-code" });
    expectGeneric();
  });

  test("retains the existing error without a destination when contextual settings are unavailable", async () => {
    mocks.getLoginSettings.mockResolvedValue(undefined);
    await renderPage();
    expect(screen.getByText(en.loginname.errors.couldNotGetLoginSettings)).toBeInTheDocument();
    expect(screen.queryByText(maskedConfirmation)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(registeredEmail);
  });

  test("fails closed when the resolved user's organization is missing", async () => {
    mocks.getUserByID.mockResolvedValue({ user: { ...registeredUser(), details: undefined } });
    await renderPage({ userId: "registered-user" });
    expectGeneric();
  });

  test("does not use a recent session's permissive policy instead of the reset context", async () => {
    mocks.loadMostRecentSession.mockResolvedValue({ factors: { user: { organizationId: "session-org" } } });
    mocks.getLoginSettings.mockImplementation(async ({ organization }) => ({
      ...permittedPolicy,
      hidePasswordReset: organization === "default-org",
    }));
    await renderPage();
    expectGeneric();
  });

  test.each([
    { loginName: registeredEmail, disableLoginWithEmail: true, disableLoginWithPhone: false, allowed: false },
    { loginName: "+5511999999999", disableLoginWithEmail: false, disableLoginWithPhone: true, allowed: false },
    { loginName: "canonical@accounts.example", disableLoginWithEmail: true, disableLoginWithPhone: true, allowed: true },
    { loginName: "+5511999999999", disableLoginWithEmail: true, disableLoginWithPhone: false, allowed: true },
    { loginName: registeredEmail, disableLoginWithEmail: false, disableLoginWithPhone: true, allowed: true },
    { loginName: "unrelated@login.example", disableLoginWithEmail: true, disableLoginWithPhone: true, allowed: false },
  ])("honors identifier restrictions for $loginName (email disabled: $disableLoginWithEmail, phone disabled: $disableLoginWithPhone)", async ({ loginName, disableLoginWithEmail, disableLoginWithPhone, allowed }) => {
    mocks.getLoginSettings.mockImplementation(async ({ organization }) => ({
      ...permittedPolicy,
      ...(organization === "user-org" ? { disableLoginWithEmail, disableLoginWithPhone } : {}),
    }));
    await renderPage({ loginName });
    if (allowed) expect(screen.getByText(maskedConfirmation)).toBeInTheDocument();
    else expectGeneric(loginName);
  });

  test("a user-ID parameter does not bypass restrictions on a supplied login name", async () => {
    mocks.getLoginSettings.mockResolvedValue({ ...permittedPolicy, disableLoginWithEmail: true, disableLoginWithPhone: true });
    await renderPage({ userId: "registered-user", loginName: "forbidden@login.example" });
    expectGeneric();
  });

  test("a user-ID-only link needs no login identifier but still observes privacy policy", async () => {
    mocks.getLoginSettings.mockResolvedValue({ ...permittedPolicy, disableLoginWithEmail: true, disableLoginWithPhone: true });
    await renderPage({ userId: "registered-user" });
    expect(screen.getByText(maskedConfirmation)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(registeredEmail);
  });
});
