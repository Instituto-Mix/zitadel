import type * as SessionModule from "@/lib/session";
import { AuthenticationMethodType } from "@zitadel/proto/zitadel/user/v2/user_service_pb";
import { beforeEach, describe, expect, test, vi } from "vitest";
import Page from "./page";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  redirect: vi.fn(),
  getServiceConfig: vi.fn(),
  getSessionCookieById: vi.fn(),
  loadMostRecentSession: vi.fn(),
  checkUserVerification: vi.fn(),
  getActiveIdentityProviders: vi.fn(),
  getBrandingSettings: vi.fn(),
  getLoginSettings: vi.fn(),
  getSession: vi.fn(),
  getUserByID: vi.fn(),
  listAuthenticationMethodTypes: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/service-url", () => ({ getServiceConfig: mocks.getServiceConfig }));
vi.mock("@/lib/cookies", () => ({ getSessionCookieById: mocks.getSessionCookieById }));
vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionModule>()),
  loadMostRecentSession: mocks.loadMostRecentSession,
}));
vi.mock("@/lib/verify-helper", () => ({ checkUserVerification: mocks.checkUserVerification }));
vi.mock("@/lib/zitadel", () => ({
  getActiveIdentityProviders: mocks.getActiveIdentityProviders,
  getBrandingSettings: mocks.getBrandingSettings,
  getLoginSettings: mocks.getLoginSettings,
  getSession: mocks.getSession,
  getUserByID: mocks.getUserByID,
  listAuthenticationMethodTypes: mocks.listAuthenticationMethodTypes,
}));
vi.mock("@/components/alert", () => ({ Alert: () => null }));
vi.mock("@/components/back-button", () => ({ BackButton: () => null }));
vi.mock("@/components/choose-authenticator-to-setup", () => ({ ChooseAuthenticatorToSetup: () => null }));
vi.mock("@/components/dynamic-theme", () => ({ DynamicTheme: () => null }));
vi.mock("@/components/sign-in-with-idp", () => ({ SignInWithIdp: () => null }));
vi.mock("@/components/totp-management", () => ({ TotpManagement: () => null }));
vi.mock("@/components/translated", () => ({ Translated: () => null }));
vi.mock("@/components/user-avatar", () => ({ UserAvatar: () => null }));

const user = { id: "session-user", loginName: "person@example.com", organizationId: "session-org" };
const verifiedAt = { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 };

function session(authentication: Record<string, unknown> = {}, expiresInSeconds = 3600) {
  return {
    id: "selected-session",
    expirationDate: { seconds: BigInt(Math.floor(Date.now() / 1000) + expiresInSeconds), nanos: 0 },
    factors: { user, ...authentication },
  };
}

function renderPage(searchParams: Record<string, string> = {}) {
  return Page({ searchParams: Promise.resolve(searchParams) });
}

describe("authenticator setup authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(new Headers());
    mocks.redirect.mockImplementation((destination: string) => {
      throw new Error(`REDIRECT:${destination}`);
    });
    mocks.getServiceConfig.mockReturnValue({ serviceConfig: {} });
    mocks.loadMostRecentSession.mockResolvedValue(session({ password: { verifiedAt } }));
    mocks.getSessionCookieById.mockResolvedValue({ id: "selected-session", token: "selected-token" });
    mocks.getSession.mockResolvedValue({ session: session({ password: { verifiedAt } }) });
    mocks.checkUserVerification.mockResolvedValue(false);
    mocks.listAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [AuthenticationMethodType.PASSWORD] });
    mocks.getUserByID.mockResolvedValue({ user: { type: { case: "human", value: { email: { isVerified: true } } } } });
    mocks.getLoginSettings.mockResolvedValue({ secondFactors: [], allowExternalIdp: false });
    mocks.getBrandingSettings.mockResolvedValue(undefined);
    mocks.getActiveIdentityProviders.mockResolvedValue({ identityProviders: [] });
  });

  test.each([
    { name: "password", authentication: { password: { verifiedAt } } },
    { name: "user-verified passkey", authentication: { webAuthN: { verifiedAt, userVerified: true } } },
    { name: "IDP intent", authentication: { intent: { verifiedAt } } },
  ])("allows a current $name session without an onboarding proof", async ({ authentication }) => {
    mocks.loadMostRecentSession.mockResolvedValue(session(authentication));

    await renderPage({ loginName: user.loginName, organization: user.organizationId });

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.checkUserVerification).not.toHaveBeenCalled();
    expect(mocks.getActiveIdentityProviders).toHaveBeenCalledWith({
      serviceConfig: {},
      orgId: user.organizationId,
      linking_allowed: true,
    });
  });

  test("allows the selected authenticated session without an onboarding proof", async () => {
    await renderPage({ sessionId: "selected-session", organization: user.organizationId });

    expect(mocks.getSession).toHaveBeenCalledWith({
      serviceConfig: {},
      sessionId: "selected-session",
      sessionToken: "selected-token",
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.checkUserVerification).not.toHaveBeenCalled();
  });

  test("allows onboarding only after checking the proof against the session user", async () => {
    mocks.loadMostRecentSession.mockResolvedValue(session());
    mocks.listAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [] });
    mocks.checkUserVerification.mockResolvedValue(true);

    await renderPage({ loginName: "untrusted-hint", organization: "untrusted-org" });

    expect(mocks.checkUserVerification).toHaveBeenCalledWith(user.id);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  test("requires a valid proof for an identify-only onboarding session", async () => {
    mocks.loadMostRecentSession.mockResolvedValue(session());
    mocks.listAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [] });

    await expect(renderPage()).rejects.toThrow("REDIRECT:/verify?");

    expect(mocks.checkUserVerification).toHaveBeenCalledWith(user.id);
    expect(mocks.getActiveIdentityProviders).not.toHaveBeenCalled();
  });

  test("a proof cannot authorize an identify-only session with existing auth methods", async () => {
    mocks.loadMostRecentSession.mockResolvedValue(session());
    mocks.checkUserVerification.mockResolvedValue(true);

    await expect(renderPage()).rejects.toThrow("REDIRECT:/verify?");

    expect(mocks.checkUserVerification).not.toHaveBeenCalled();
    expect(mocks.getActiveIdentityProviders).not.toHaveBeenCalled();
  });

  test.each([
    { name: "expired", value: session({ password: { verifiedAt } }, -3600) },
    { name: "presence-only WebAuthn", value: session({ webAuthN: { verifiedAt, userVerified: false } }) },
  ])("does not treat a $name session as authenticated", async ({ value }) => {
    mocks.loadMostRecentSession.mockResolvedValue(value);

    await expect(renderPage()).rejects.toThrow("REDIRECT:/verify?");

    expect(mocks.getActiveIdentityProviders).not.toHaveBeenCalled();
  });
});
