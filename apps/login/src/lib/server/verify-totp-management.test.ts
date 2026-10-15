import { SecondFactorType } from "@zitadel/proto/zitadel/settings/v2/login_settings_pb";
import { AuthenticationMethodType } from "@zitadel/proto/zitadel/user/v2/user_service_pb";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { verifyTOTP } from "./verify";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  getServiceConfig: vi.fn(),
  getSessionCookieById: vi.fn(),
  getMostRecentCookieWithLoginname: vi.fn(),
  getSession: vi.fn(),
  getLoginSettings: vi.fn(),
  verifyTOTPRegistration: vi.fn(),
  listAuthenticationMethodTypes: vi.fn(),
  checkUserVerification: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("../service-url", () => ({ getServiceConfig: mocks.getServiceConfig }));
vi.mock("../cookies", () => ({
  getSessionCookieById: mocks.getSessionCookieById,
  getMostRecentCookieWithLoginname: mocks.getMostRecentCookieWithLoginname,
}));
vi.mock("@/lib/zitadel", () => ({
  getSession: mocks.getSession,
  getLoginSettings: mocks.getLoginSettings,
  verifyTOTPRegistration: mocks.verifyTOTPRegistration,
  listAuthenticationMethodTypes: mocks.listAuthenticationMethodTypes,
}));
vi.mock("../verify-helper", () => ({
  checkUserVerification: mocks.checkUserVerification,
}));

const SESSION_ID = "selected-session";
const SESSION_TOKEN = "selected-session-token";
const USER_ID = "selected-session-user";
const LOGIN_NAME = "person@example.com";
const ORGANIZATION_ID = "selected-organization";
const SERVICE_CONFIG = { baseUrl: "https://zitadel.example" };
const CODE = "123456";
const RPC_RESULT = { verified: true };

function timestamp(offsetSeconds = 0) {
  return { seconds: BigInt(Math.floor(Date.now() / 1000) + offsetSeconds), nanos: 0 };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    expirationDate: timestamp(3600),
    factors: {
      user: { id: USER_ID, loginName: LOGIN_NAME, organizationId: ORGANIZATION_ID },
      password: { verifiedAt: timestamp() },
    },
    ...overrides,
  };
}

function identifyOnlySession(overrides: Record<string, unknown> = {}) {
  return session({
    factors: { user: { id: USER_ID, loginName: LOGIN_NAME, organizationId: ORGANIZATION_ID } },
    ...overrides,
  });
}

function useSession(value: unknown = session()) {
  const cookie = { id: SESSION_ID, token: SESSION_TOKEN };
  mocks.getSessionCookieById.mockResolvedValue(cookie);
  mocks.getMostRecentCookieWithLoginname.mockResolvedValue(cookie);
  mocks.getSession.mockResolvedValue({ session: value });
}

describe("verifyTOTP credential management and onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(new Headers({ host: "login.example" }));
    mocks.getServiceConfig.mockReturnValue({ serviceConfig: SERVICE_CONFIG });
    useSession();
    mocks.getLoginSettings.mockResolvedValue({ secondFactors: [SecondFactorType.OTP] });
    mocks.verifyTOTPRegistration.mockResolvedValue(RPC_RESULT);
    mocks.listAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [AuthenticationMethodType.PASSWORD] });
    mocks.checkUserVerification.mockResolvedValue(false);
  });

  test("verifies using the selected session user and returns the service result", async () => {
    const result = await verifyTOTP(CODE, SESSION_ID, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toBe(RPC_RESULT);
    expect(mocks.getSessionCookieById).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    expect(mocks.getSession).toHaveBeenCalledWith({
      serviceConfig: SERVICE_CONFIG,
      sessionId: SESSION_ID,
      sessionToken: SESSION_TOKEN,
    });
    expect(mocks.verifyTOTPRegistration).toHaveBeenCalledWith({
      serviceConfig: SERVICE_CONFIG,
      code: CODE,
      userId: USER_ID,
    });
    expect(mocks.listAuthenticationMethodTypes).not.toHaveBeenCalled();
    expect(mocks.checkUserVerification).not.toHaveBeenCalled();
  });

  test("rejects a selected session whose returned identity does not match the requested session", async () => {
    useSession(session({ id: "different-session" }));

    const result = await verifyTOTP(CODE, SESSION_ID, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test("verifies the cookie-derived session when no session id is provided", async () => {
    const result = await verifyTOTP(CODE, undefined, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toBe(RPC_RESULT);
    expect(mocks.getMostRecentCookieWithLoginname).toHaveBeenCalledWith({
      loginName: LOGIN_NAME,
      organization: ORGANIZATION_ID,
    });
    expect(mocks.verifyTOTPRegistration).toHaveBeenCalledWith({
      serviceConfig: SERVICE_CONFIG,
      code: CODE,
      userId: USER_ID,
    });
  });

  test.each([
    ["login name", "other@example.com", ORGANIZATION_ID],
    ["organization", LOGIN_NAME, "other-organization"],
  ])("rejects a legacy %s that does not match its cookie-derived session", async (_, loginName, organization) => {
    const result = await verifyTOTP(CODE, undefined, loginName, organization);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test("rejects legacy TOTP verification when account policy disables OTP", async () => {
    mocks.getLoginSettings.mockResolvedValue({ secondFactors: [] });

    const result = await verifyTOTP(CODE, undefined, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test.each([
    ["login name", "other@example.com", ORGANIZATION_ID],
    ["organization", LOGIN_NAME, "other-organization"],
    ["login name and organization", "other@example.com", "other-organization"],
  ])("rejects a caller-supplied %s that does not match the selected session", async (_, loginName, organization) => {
    const result = await verifyTOTP(CODE, SESSION_ID, loginName, organization);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test("rejects a missing cookie for the selected session", async () => {
    mocks.getSessionCookieById.mockResolvedValue(null);

    const result = await verifyTOTP(CODE, SESSION_ID, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.getMostRecentCookieWithLoginname).not.toHaveBeenCalled();
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test("rejects an expired selected session", async () => {
    useSession(session({ expirationDate: timestamp(-3600) }));

    const result = await verifyTOTP(CODE, SESSION_ID, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test("rejects WebAuthn authentication that did not verify the user", async () => {
    useSession(
      session({
        factors: {
          user: { id: USER_ID, loginName: LOGIN_NAME, organizationId: ORGANIZATION_ID },
          webAuthN: { verifiedAt: timestamp(), userVerified: false },
        },
      }),
    );

    const result = await verifyTOTP(CODE, SESSION_ID, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
    expect(mocks.listAuthenticationMethodTypes).toHaveBeenCalledWith({
      serviceConfig: SERVICE_CONFIG,
      userId: USER_ID,
    });
    expect(mocks.checkUserVerification).not.toHaveBeenCalled();
  });

  test("rejects TOTP registration when the selected account policy disables OTP", async () => {
    mocks.getLoginSettings.mockResolvedValue({ secondFactors: [] });

    const result = await verifyTOTP(CODE, SESSION_ID, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test("rejects a selected cookie whose id does not match the returned session", async () => {
    mocks.getSessionCookieById.mockResolvedValue({ id: "another-cookie-session", token: SESSION_TOKEN });

    const result = await verifyTOTP(CODE, SESSION_ID, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.listAuthenticationMethodTypes).not.toHaveBeenCalled();
    expect(mocks.checkUserVerification).not.toHaveBeenCalled();
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test("rejects a fallback session whose id does not match the selected signed cookie", async () => {
    useSession(session({ id: "another-session" }));

    const result = await verifyTOTP(CODE, undefined, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.listAuthenticationMethodTypes).not.toHaveBeenCalled();
    expect(mocks.checkUserVerification).not.toHaveBeenCalled();
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test("allows first-time enrollment with no existing methods and a valid signed verification proof", async () => {
    useSession(identifyOnlySession());
    mocks.listAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [] });
    mocks.checkUserVerification.mockResolvedValue(true);

    const result = await verifyTOTP(CODE, SESSION_ID, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toBe(RPC_RESULT);
    expect(mocks.listAuthenticationMethodTypes).toHaveBeenCalledWith({
      serviceConfig: SERVICE_CONFIG,
      userId: USER_ID,
    });
    expect(mocks.checkUserVerification).toHaveBeenCalledWith(USER_ID);
    expect(mocks.getLoginSettings).toHaveBeenCalledWith({
      serviceConfig: SERVICE_CONFIG,
      organization: ORGANIZATION_ID,
    });
    expect(mocks.verifyTOTPRegistration).toHaveBeenCalledWith({
      serviceConfig: SERVICE_CONFIG,
      code: CODE,
      userId: USER_ID,
    });
  });

  test("rejects identify-only enrollment without a valid signed verification proof", async () => {
    useSession(identifyOnlySession());
    mocks.listAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [] });

    const result = await verifyTOTP(CODE, SESSION_ID, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toEqual({ error: "User Verification Check has to be done" });
    expect(mocks.checkUserVerification).toHaveBeenCalledWith(USER_ID);
    expect(mocks.getLoginSettings).not.toHaveBeenCalled();
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test("does not use another user's verification proof for the selected account", async () => {
    useSession(identifyOnlySession());
    mocks.listAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [] });
    mocks.checkUserVerification.mockImplementation(async (userId: string) => userId === "another-user");

    const result = await verifyTOTP(CODE, SESSION_ID, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toEqual({ error: "User Verification Check has to be done" });
    expect(mocks.checkUserVerification).toHaveBeenCalledWith(USER_ID);
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test("rejects identify-only enrollment with existing methods even when a signed proof is available", async () => {
    useSession(identifyOnlySession());
    mocks.checkUserVerification.mockResolvedValue(true);

    const result = await verifyTOTP(CODE, SESSION_ID, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toEqual({ error: "You have to authenticate or have a valid User Verification Check" });
    expect(mocks.checkUserVerification).not.toHaveBeenCalled();
    expect(mocks.getLoginSettings).not.toHaveBeenCalled();
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test("does not allow a signed verification proof to revive an expired onboarding session", async () => {
    useSession(identifyOnlySession({ expirationDate: timestamp(-3600) }));
    mocks.listAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [] });
    mocks.checkUserVerification.mockResolvedValue(true);

    const result = await verifyTOTP(CODE, SESSION_ID, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.checkUserVerification).not.toHaveBeenCalled();
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test("still enforces OTP policy after signed-proof onboarding authorization", async () => {
    useSession(identifyOnlySession());
    mocks.listAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [] });
    mocks.checkUserVerification.mockResolvedValue(true);
    mocks.getLoginSettings.mockResolvedValue({ secondFactors: [] });

    const result = await verifyTOTP(CODE, SESSION_ID, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toEqual({ error: "Authenticator app verification is not allowed by the login policy" });
    expect(mocks.checkUserVerification).toHaveBeenCalledWith(USER_ID);
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
  });
});
