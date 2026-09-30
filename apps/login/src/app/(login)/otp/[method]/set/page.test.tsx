import { SecondFactorType } from "@zitadel/proto/zitadel/settings/v2/login_settings_pb";
import { beforeEach, describe, expect, test, vi } from "vitest";
import Page from "./page";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  cookies: vi.fn(),
  getServiceConfig: vi.fn(),
  getBrandingSettings: vi.fn(),
  getLoginSettings: vi.fn(),
  getSession: vi.fn(),
  getUserByID: vi.fn(),
  listAuthenticationMethodTypes: vi.fn(),
  registerTOTP: vi.fn(),
  addOTPSMS: vi.fn(),
  addOTPEmail: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers, cookies: mocks.cookies }));
vi.mock("@/lib/service-url", () => ({ getServiceConfig: mocks.getServiceConfig }));
vi.mock("@/lib/zitadel", () => ({
  getBrandingSettings: mocks.getBrandingSettings,
  getLoginSettings: mocks.getLoginSettings,
  getSession: mocks.getSession,
  getUserByID: mocks.getUserByID,
  listAuthenticationMethodTypes: mocks.listAuthenticationMethodTypes,
  registerTOTP: mocks.registerTOTP,
  addOTPSMS: mocks.addOTPSMS,
  addOTPEmail: mocks.addOTPEmail,
}));

const SERVICE_CONFIG = { baseUrl: "https://zitadel.example" };
const SELECTED_SESSION_ID = "selected-session";
const SELECTED_SESSION_TOKEN = "selected-token";
const SELECTED_USER_ID = "selected-user";
const SELECTED_LOGIN_NAME = "selected@example.com";
const SELECTED_ORGANIZATION = "selected-org";
const OTHER_SESSION_ID = "other-session";
const OTHER_SESSION_TOKEN = "other-token";
const OTHER_USER_ID = "other-user";
const OTHER_LOGIN_NAME = "other@example.com";

function timestamp(offsetSeconds = 0) {
  return { seconds: BigInt(Math.floor(Date.now() / 1000) + offsetSeconds), nanos: 0 };
}

type TestSessionCookie = {
  id: string;
  token: string;
  loginName: string;
  organization: string;
  creationTs: string;
  expirationTs: string;
  changeTs: string;
};

type SessionCookieInput = Pick<TestSessionCookie, "id" | "token" | "loginName" | "organization" | "changeTs">;

type SessionEntry = { cookie: TestSessionCookie; session: unknown };

function sessionCookie({ id, token, loginName, organization, changeTs }: SessionCookieInput): TestSessionCookie {
  return {
    id,
    token,
    loginName,
    organization,
    creationTs: "1",
    expirationTs: "4102444800000",
    changeTs,
  };
}

function authenticatedSession({
  id,
  userId,
  loginName,
  organization,
  expiresInSeconds = 3600,
  authentication = { password: { verifiedAt: timestamp() } },
}: {
  id: string;
  userId: string;
  loginName: string;
  organization: string;
  expiresInSeconds?: number;
  authentication?: Record<string, unknown>;
}) {
  return {
    id,
    expirationDate: timestamp(expiresInSeconds),
    factors: {
      user: { id: userId, loginName, organizationId: organization, displayName: loginName },
      ...authentication,
    },
  };
}

function useSessions(...entries: SessionEntry[]) {
  const sessionByToken = Object.fromEntries(entries.map(({ cookie, session }) => [cookie.token, session]));
  const serializedCookies = JSON.stringify(entries.map(({ cookie }) => cookie));

  mocks.cookies.mockResolvedValue({
    get: (name: string) => (name === "sessions" ? { value: serializedCookies } : undefined),
  });
  mocks.getSession.mockImplementation(async ({ sessionToken }: { sessionToken: string }) => ({
    session: sessionByToken[sessionToken],
  }));
}

function selectedSession() {
  return authenticatedSession({
    id: SELECTED_SESSION_ID,
    userId: SELECTED_USER_ID,
    loginName: SELECTED_LOGIN_NAME,
    organization: SELECTED_ORGANIZATION,
  });
}

function selectedCookie() {
  return sessionCookie({
    id: SELECTED_SESSION_ID,
    token: SELECTED_SESSION_TOKEN,
    loginName: SELECTED_LOGIN_NAME,
    organization: SELECTED_ORGANIZATION,
    changeTs: "1",
  });
}

async function renderSetPage(searchParams: Record<string, string | undefined> = {}) {
  return Page({
    params: Promise.resolve({ method: "time-based" }),
    searchParams: Promise.resolve(searchParams),
  });
}

const selectedAccountParams = {
  sessionId: SELECTED_SESSION_ID,
  loginName: SELECTED_LOGIN_NAME,
  organization: SELECTED_ORGANIZATION,
};
const legacyAccountParams = {
  loginName: SELECTED_LOGIN_NAME,
  organization: SELECTED_ORGANIZATION,
};

describe("TOTP registration route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.headers.mockResolvedValue(new Headers());
    mocks.getServiceConfig.mockReturnValue({ serviceConfig: SERVICE_CONFIG });
    mocks.getBrandingSettings.mockResolvedValue(undefined);
    mocks.getLoginSettings.mockResolvedValue({ secondFactors: [SecondFactorType.OTP] });
    mocks.getUserByID.mockResolvedValue({
      user: { type: { case: "human", value: { email: { isVerified: true } } } },
    });
    mocks.listAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [] });
    mocks.registerTOTP.mockResolvedValue({ uri: "otpauth://totp/account", secret: "totp-secret" });

    useSessions({ cookie: selectedCookie(), session: selectedSession() });
  });

  test("registers TOTP for the account in the selected session", async () => {
    const otherCookie = sessionCookie({
      id: OTHER_SESSION_ID,
      token: OTHER_SESSION_TOKEN,
      loginName: OTHER_LOGIN_NAME,
      organization: "other-org",
      changeTs: "2",
    });
    const otherSession = authenticatedSession({
      id: OTHER_SESSION_ID,
      userId: OTHER_USER_ID,
      loginName: OTHER_LOGIN_NAME,
      organization: "other-org",
    });
    useSessions({ cookie: selectedCookie(), session: selectedSession() }, { cookie: otherCookie, session: otherSession });

    await renderSetPage(selectedAccountParams);

    expect(mocks.registerTOTP).toHaveBeenCalledTimes(1);
    expect(mocks.registerTOTP).toHaveBeenCalledWith({ serviceConfig: SERVICE_CONFIG, userId: SELECTED_USER_ID });
  });

  test("rejects a loginName that does not match the selected session before registering TOTP", async () => {
    const otherCookie = sessionCookie({
      id: OTHER_SESSION_ID,
      token: OTHER_SESSION_TOKEN,
      loginName: OTHER_LOGIN_NAME,
      organization: "other-org",
      changeTs: "2",
    });
    const otherSession = authenticatedSession({
      id: OTHER_SESSION_ID,
      userId: OTHER_USER_ID,
      loginName: OTHER_LOGIN_NAME,
      organization: "other-org",
    });
    useSessions({ cookie: selectedCookie(), session: selectedSession() }, { cookie: otherCookie, session: otherSession });

    await expect(renderSetPage({ sessionId: SELECTED_SESSION_ID, loginName: OTHER_LOGIN_NAME })).rejects.toThrow();

    expect(mocks.registerTOTP).not.toHaveBeenCalled();
  });

  test("rejects an organization that does not match the selected session before registering TOTP", async () => {
    const sameLoginNameInOtherOrganization = sessionCookie({
      id: OTHER_SESSION_ID,
      token: OTHER_SESSION_TOKEN,
      loginName: SELECTED_LOGIN_NAME,
      organization: "other-org",
      changeTs: "2",
    });
    const otherOrganizationSession = authenticatedSession({
      id: OTHER_SESSION_ID,
      userId: OTHER_USER_ID,
      loginName: SELECTED_LOGIN_NAME,
      organization: "other-org",
    });
    useSessions(
      { cookie: selectedCookie(), session: selectedSession() },
      { cookie: sameLoginNameInOtherOrganization, session: otherOrganizationSession },
    );

    await expect(
      renderSetPage({
        sessionId: SELECTED_SESSION_ID,
        loginName: SELECTED_LOGIN_NAME,
        organization: "other-org",
      }),
    ).rejects.toThrow();

    expect(mocks.registerTOTP).not.toHaveBeenCalled();
  });

  test("rejects an expired selected session before registering TOTP", async () => {
    useSessions({
      cookie: selectedCookie(),
      session: authenticatedSession({
        id: SELECTED_SESSION_ID,
        userId: SELECTED_USER_ID,
        loginName: SELECTED_LOGIN_NAME,
        organization: SELECTED_ORGANIZATION,
        expiresInSeconds: -3600,
      }),
    });

    await expect(renderSetPage(selectedAccountParams)).rejects.toThrow();

    expect(mocks.registerTOTP).not.toHaveBeenCalled();
  });

  test("rejects an unverified selected session before registering TOTP", async () => {
    useSessions({
      cookie: selectedCookie(),
      session: authenticatedSession({
        id: SELECTED_SESSION_ID,
        userId: SELECTED_USER_ID,
        loginName: SELECTED_LOGIN_NAME,
        organization: SELECTED_ORGANIZATION,
        authentication: { webAuthN: { verifiedAt: timestamp(), userVerified: false } },
      }),
    });

    await expect(renderSetPage(selectedAccountParams)).rejects.toThrow();

    expect(mocks.registerTOTP).not.toHaveBeenCalled();
  });

  test.each(["expired", "unverified"] as const)(
    "rejects an %s legacy session before registering TOTP",
    async (invalidState) => {
      const invalidSession =
        invalidState === "expired"
          ? { expiresInSeconds: -3600 }
          : { authentication: { webAuthN: { verifiedAt: timestamp(), userVerified: false } } };
      useSessions({
        cookie: selectedCookie(),
        session: authenticatedSession({
          id: SELECTED_SESSION_ID,
          userId: SELECTED_USER_ID,
          loginName: SELECTED_LOGIN_NAME,
          organization: SELECTED_ORGANIZATION,
          ...invalidSession,
        }),
      });

      await expect(renderSetPage(legacyAccountParams)).rejects.toThrow();

      expect(mocks.registerTOTP).not.toHaveBeenCalled();
    },
  );

  test("registers TOTP for a valid loginName-selected legacy session", async () => {
    useSessions({ cookie: selectedCookie(), session: selectedSession() });

    await renderSetPage(legacyAccountParams);

    expect(mocks.registerTOTP).toHaveBeenCalledTimes(1);
    expect(mocks.registerTOTP).toHaveBeenCalledWith({ serviceConfig: SERVICE_CONFIG, userId: SELECTED_USER_ID });
  });

  test("rejects a legacy session when the account policy disables TOTP", async () => {
    mocks.getLoginSettings.mockResolvedValue({ secondFactors: [] });
    useSessions({ cookie: selectedCookie(), session: selectedSession() });

    await expect(renderSetPage(legacyAccountParams)).rejects.toThrow();

    expect(mocks.registerTOTP).not.toHaveBeenCalled();
  });

  test("rejects registration when the account policy disables TOTP", async () => {
    mocks.getLoginSettings.mockResolvedValue({ secondFactors: [] });

    await expect(renderSetPage(selectedAccountParams)).rejects.toThrow();

    expect(mocks.registerTOTP).not.toHaveBeenCalled();
  });
});
