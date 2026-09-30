import { SecondFactorType } from "@zitadel/proto/zitadel/settings/v2/login_settings_pb";
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

function useSession(value: unknown = session()) {
  const cookie = { id: SESSION_ID, token: SESSION_TOKEN };
  mocks.getSessionCookieById.mockResolvedValue(cookie);
  mocks.getMostRecentCookieWithLoginname.mockResolvedValue(cookie);
  mocks.getSession.mockResolvedValue({ session: value });
}

describe("verifyTOTP for signed-in credential management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(new Headers({ host: "login.example" }));
    mocks.getServiceConfig.mockReturnValue({ serviceConfig: SERVICE_CONFIG });
    useSession();
    mocks.getLoginSettings.mockResolvedValue({ secondFactors: [SecondFactorType.OTP] });
    mocks.verifyTOTPRegistration.mockResolvedValue(RPC_RESULT);
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

  test("rejects a legacy query that does not match its cookie-derived session", async () => {
    const result = await verifyTOTP(CODE, undefined, "other@example.com", ORGANIZATION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test("rejects legacy TOTP verification when account policy disables OTP", async () => {
    mocks.getLoginSettings.mockResolvedValue({ secondFactors: [] });

    const result = await verifyTOTP(CODE, undefined, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test("rejects caller-supplied account identifiers that do not match the selected session", async () => {
    const result = await verifyTOTP(CODE, SESSION_ID, "other@example.com", "other-organization");

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test("rejects a missing cookie for the selected session", async () => {
    mocks.getSessionCookieById.mockResolvedValue(null);

    const result = await verifyTOTP(CODE, SESSION_ID, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.getSession).not.toHaveBeenCalled();
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
  });

  test("rejects TOTP registration when the selected account policy disables OTP", async () => {
    mocks.getLoginSettings.mockResolvedValue({ secondFactors: [] });

    const result = await verifyTOTP(CODE, SESSION_ID, LOGIN_NAME, ORGANIZATION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.verifyTOTPRegistration).not.toHaveBeenCalled();
  });
});
