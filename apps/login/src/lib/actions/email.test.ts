import { sendCurrentEmailVerification, updateEmail } from "@/lib/actions/email";
import { signSession } from "@/lib/server/session-cookie-signature";
import { create, timestampFromMs } from "@zitadel/client";
import { SessionSchema } from "@zitadel/proto/zitadel/session/v2/session_pb";
import { LoginSettingsSchema } from "@zitadel/proto/zitadel/settings/v2/login_settings_pb";
import { AuthenticationMethodType } from "@zitadel/proto/zitadel/user/v2/user_service_pb";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  headers: vi.fn(),
  getSession: vi.fn(),
  getLoginSettings: vi.fn(),
  listAuthenticationMethodTypes: vi.fn(),
  getUserByID: vi.fn(),
  setEmail: vi.fn(),
  resendVerification: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: mocks.cookies, headers: mocks.headers }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/server/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/server/zitadel", () => ({
  getSession: mocks.getSession,
  getLoginSettings: mocks.getLoginSettings,
  listAuthenticationMethodTypes: mocks.listAuthenticationMethodTypes,
  getUserByID: mocks.getUserByID,
  setEmail: mocks.setEmail,
}));
vi.mock("@/lib/actions/verify", () => ({ resendVerification: mocks.resendVerification }));

const NOW = new Date("2026-01-02T12:00:00.000Z");
const SESSION_ID = "browser-session";
const SESSION_TOKEN = "signed-cookie-session-token";
const USER_ID = "account-owner";
const LOGIN_NAME = "owner@example.test";
const ORGANIZATION = "org-1";
const PUBLIC_HOST = "login.example.test";
const SERVICE_CONFIG = {
  baseUrl: "https://id.example.test",
  instanceHost: PUBLIC_HOST,
  publicHost: PUBLIC_HOST,
};
const COMMAND = { loginName: LOGIN_NAME, organization: ORGANIZATION, requestId: "oidc_request-1" };
const SESSION_COOKIE = {
  id: SESSION_ID,
  token: SESSION_TOKEN,
  loginName: LOGIN_NAME,
  organization: ORGANIZATION,
  creationTs: NOW.toISOString(),
  expirationTs: new Date(NOW.getTime() + 3_600_000).toISOString(),
  changeTs: NOW.toISOString(),
};

let storedSessions: string;

function session({ password = false, totp = false } = {}) {
  const verifiedAt = timestampFromMs(NOW.getTime());
  return create(SessionSchema, {
    id: SESSION_ID,
    expirationDate: timestampFromMs(NOW.getTime() + 3_600_000),
    factors: {
      user: { id: USER_ID, loginName: LOGIN_NAME, organizationId: ORGANIZATION, verifiedAt },
      ...(password && { password: { verifiedAt } }),
      ...(totp && { totp: { verifiedAt } }),
    },
  });
}

describe.each([
  { name: "updateEmail", invoke: () => updateEmail({ ...COMMAND, email: "updated@example.com" }) },
  { name: "sendCurrentEmailVerification", invoke: () => sendCurrentEmailVerification(COMMAND) },
])("$name session authorization", ({ name, invoke }) => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("ZITADEL_SESSION_COOKIE_SECRET", "email-actions-test-secret-at-least-32-characters");
    vi.stubEnv("ZITADEL_API_URL", SERVICE_CONFIG.baseUrl);
    vi.stubEnv("ZITADEL_PUBLIC_HOST", PUBLIC_HOST);
    vi.stubEnv("EMAIL_UPDATE_MARK_VERIFIED", "false");
    vi.stubEnv("EMAIL_VERIFICATION", "false");

    storedSessions = JSON.stringify([signSession(SESSION_COOKIE)]);
    mocks.cookies.mockResolvedValue({
      get: (cookieName: string) => (cookieName === "sessions" ? { name: cookieName, value: storedSessions } : undefined),
    });
    mocks.headers.mockResolvedValue(new Headers({ host: PUBLIC_HOST }));
    mocks.getSession.mockResolvedValue({ session: session() });
    mocks.getLoginSettings.mockResolvedValue(create(LoginSettingsSchema, { allowLocalAuthentication: true, forceMfa: false }));
    mocks.listAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [AuthenticationMethodType.PASSWORD] });
    mocks.getUserByID.mockResolvedValue({
      user: { userId: USER_ID, type: { case: "human", value: { email: { email: "current@example.com" } } } },
    });
    mocks.setEmail.mockResolvedValue({});
    mocks.resendVerification.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test("rejects an identified-only account even with a valid signed browser session cookie", async () => {
    const result = await invoke();

    expect(result).toEqual({ error: "errors.noSession" });
    expect(mocks.getSession).toHaveBeenCalledWith({
      serviceConfig: SERVICE_CONFIG,
      sessionId: SESSION_ID,
      sessionToken: SESSION_TOKEN,
    });
    expect(mocks.setEmail).not.toHaveBeenCalled();
    expect(mocks.getUserByID).not.toHaveBeenCalled();
    expect(mocks.resendVerification).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  test("rejects password authentication while required MFA is incomplete", async () => {
    mocks.getSession.mockResolvedValue({ session: session({ password: true }) });
    mocks.getLoginSettings.mockResolvedValue(create(LoginSettingsSchema, { allowLocalAuthentication: true, forceMfa: true }));
    mocks.listAuthenticationMethodTypes.mockResolvedValue({
      authMethodTypes: [AuthenticationMethodType.PASSWORD, AuthenticationMethodType.TOTP],
    });

    expect(await invoke()).toEqual({ error: "errors.noSession" });
    expect(mocks.setEmail).not.toHaveBeenCalled();
    expect(mocks.resendVerification).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  test("allows the signed-cookie account after primary authentication and required MFA", async () => {
    mocks.getSession.mockResolvedValue({ session: session({ password: true, totp: true }) });
    mocks.getLoginSettings.mockResolvedValue(create(LoginSettingsSchema, { allowLocalAuthentication: true, forceMfa: true }));
    mocks.listAuthenticationMethodTypes.mockResolvedValue({
      authMethodTypes: [AuthenticationMethodType.PASSWORD, AuthenticationMethodType.TOTP],
    });

    expect(await invoke()).toEqual({
      redirect: "/verify?userId=account-owner&loginName=owner%40example.test&organization=org-1&requestId=oidc_request-1",
    });
    expect(mocks.getLoginSettings).toHaveBeenCalledWith({ serviceConfig: SERVICE_CONFIG, organization: ORGANIZATION });

    if (name === "updateEmail") {
      expect(mocks.setEmail).toHaveBeenCalledWith({
        serviceConfig: SERVICE_CONFIG,
        userId: USER_ID,
        email: "updated@example.com",
        verified: false,
      });
      expect(mocks.revalidatePath).toHaveBeenCalledWith("/email");
      expect(mocks.resendVerification).not.toHaveBeenCalled();
    } else {
      expect(mocks.getUserByID).toHaveBeenCalledWith({ serviceConfig: SERVICE_CONFIG, userId: USER_ID });
      expect(mocks.resendVerification).toHaveBeenCalledWith({
        userId: USER_ID,
        isInvite: false,
        requestId: COMMAND.requestId,
      });
      expect(mocks.setEmail).not.toHaveBeenCalled();
    }
  });

  test("rejects a cookie whose session token was changed without resigning", async () => {
    storedSessions = JSON.stringify([{ ...signSession(SESSION_COOKIE), token: "attacker-token" }]);

    expect(await invoke()).toEqual({ error: "errors.noSession" });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.setEmail).not.toHaveBeenCalled();
    expect(mocks.resendVerification).not.toHaveBeenCalled();
  });
});
