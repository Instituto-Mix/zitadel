import { AuthenticationMethodType } from "@zitadel/proto/zitadel/user/v2/user_service_pb";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { removeManagedTOTP } from "./totp-management";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  getServiceConfig: vi.fn(),
  getSessionCookieById: vi.fn(),
  getMostRecentCookieWithLoginname: vi.fn(),
  getSession: vi.fn(),
  getLoginSettings: vi.fn(),
  getUserByID: vi.fn(),
  listAuthenticationMethodTypes: vi.fn(),
  removeTOTP: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("../service-url", () => ({ getServiceConfig: mocks.getServiceConfig }));
vi.mock("../cookies", () => ({
  getSessionCookieById: mocks.getSessionCookieById,
  getMostRecentCookieWithLoginname: mocks.getMostRecentCookieWithLoginname,
}));
vi.mock("../zitadel", () => ({
  getSession: mocks.getSession,
  getLoginSettings: mocks.getLoginSettings,
  getUserByID: mocks.getUserByID,
  listAuthenticationMethodTypes: mocks.listAuthenticationMethodTypes,
  removeTOTP: mocks.removeTOTP,
}));

const SESSION_ID = "requested-session";
const SESSION_USER_ID = "user-from-authenticated-session";
const SERVICE_CONFIG = { baseUrl: "https://zitadel.example" };
const SESSION_COOKIE = { id: SESSION_ID, token: "session-cookie-token" };

function timestamp(offsetSeconds = 0) {
  return { seconds: BigInt(Math.floor(Date.now() / 1000) + offsetSeconds), nanos: 0 };
}

function authenticatedSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    expirationDate: timestamp(3600),
    factors: {
      user: { id: SESSION_USER_ID, organizationId: "session-org" },
      password: { verifiedAt: timestamp() },
      totp: { verifiedAt: timestamp() },
    },
    ...overrides,
  };
}

function useSession(session: unknown = authenticatedSession()) {
  mocks.getSessionCookieById.mockResolvedValue(SESSION_COOKIE);
  mocks.getSession.mockResolvedValue({ session });
}

describe("removeManagedTOTP", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.headers.mockResolvedValue(new Headers({ host: "login.example" }));
    mocks.getServiceConfig.mockReturnValue({ serviceConfig: SERVICE_CONFIG });
    mocks.getSessionCookieById.mockResolvedValue(SESSION_COOKIE);
    mocks.getSession.mockResolvedValue({ session: authenticatedSession() });
    mocks.getLoginSettings.mockResolvedValue({});
    mocks.getUserByID.mockResolvedValue({
      user: { type: { case: "human", value: { email: { isVerified: true } } } },
    });
    mocks.listAuthenticationMethodTypes.mockResolvedValue({
      authMethodTypes: [AuthenticationMethodType.PASSWORD, AuthenticationMethodType.TOTP],
    });
    mocks.removeTOTP.mockResolvedValue(undefined);
  });

  test("rejects a missing session cookie without removing a credential", async () => {
    mocks.getSessionCookieById.mockResolvedValue(null);

    const result = await removeManagedTOTP(SESSION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.removeTOTP).not.toHaveBeenCalled();
  });

  test("rejects a session that no longer exists on the server", async () => {
    mocks.getSession.mockResolvedValue({});

    const result = await removeManagedTOTP(SESSION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.removeTOTP).not.toHaveBeenCalled();
  });

  test("rejects an expired session without removing TOTP", async () => {
    useSession(authenticatedSession({ expirationDate: timestamp(-3600) }));

    const result = await removeManagedTOTP(SESSION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.removeTOTP).not.toHaveBeenCalled();
  });

  test("rejects a session with no verified authentication factor", async () => {
    useSession(
      authenticatedSession({
        factors: { user: { id: SESSION_USER_ID, organizationId: "session-org" } },
      }),
    );

    const result = await removeManagedTOTP(SESSION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.removeTOTP).not.toHaveBeenCalled();
  });

  test("rejects WebAuthn verification that did not verify the user", async () => {
    useSession(
      authenticatedSession({
        factors: {
          user: { id: SESSION_USER_ID, organizationId: "session-org" },
          webAuthN: { verifiedAt: timestamp(), userVerified: false },
        },
      }),
    );

    const result = await removeManagedTOTP(SESSION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.removeTOTP).not.toHaveBeenCalled();
  });

  test("rejects removing configured TOTP from a password-only session when TOTP is required", async () => {
    let totpConfigured = true;
    mocks.listAuthenticationMethodTypes.mockImplementation(async () => ({
      authMethodTypes: totpConfigured
        ? [AuthenticationMethodType.PASSWORD, AuthenticationMethodType.TOTP]
        : [AuthenticationMethodType.PASSWORD],
    }));
    mocks.removeTOTP.mockImplementation(async () => {
      totpConfigured = false;
    });
    useSession(
      authenticatedSession({
        factors: { user: { id: SESSION_USER_ID, organizationId: "session-org" }, password: { verifiedAt: timestamp() } },
      }),
    );

    const result = await removeManagedTOTP(SESSION_ID);

    expect(mocks.getSession).toHaveBeenCalledWith({
      serviceConfig: SERVICE_CONFIG,
      sessionId: SESSION_ID,
      sessionToken: SESSION_COOKIE.token,
    });
    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.removeTOTP).not.toHaveBeenCalled();
    expect(totpConfigured).toBe(true);
  });

  test("removes configured TOTP after the selected session verifies password and TOTP", async () => {
    useSession();

    const result = await removeManagedTOTP(SESSION_ID);

    expect(mocks.getSession).toHaveBeenCalledWith({
      serviceConfig: SERVICE_CONFIG,
      sessionId: SESSION_ID,
      sessionToken: SESSION_COOKIE.token,
    });
    expect(result).toEqual({ success: true });
    expect(mocks.removeTOTP).toHaveBeenCalledTimes(1);
    expect(mocks.removeTOTP).toHaveBeenCalledWith(
      expect.objectContaining({ serviceConfig: SERVICE_CONFIG, userId: SESSION_USER_ID }),
    );
  });

  test("does not report removal or call UserService when TOTP is not configured", async () => {
    mocks.listAuthenticationMethodTypes.mockResolvedValue({
      authMethodTypes: [AuthenticationMethodType.PASSWORD],
    });
    useSession(
      authenticatedSession({
        factors: { user: { id: SESSION_USER_ID }, password: { verifiedAt: timestamp() } },
      }),
    );

    const result = await removeManagedTOTP(SESSION_ID);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mocks.removeTOTP).not.toHaveBeenCalled();
  });

  test("returns an API error and succeeds when the caller retries after a transient failure", async () => {
    mocks.removeTOTP.mockRejectedValueOnce(new Error("UserService temporarily unavailable"));

    const failedAttempt = await removeManagedTOTP(SESSION_ID);
    const retriedAttempt = await removeManagedTOTP(SESSION_ID);

    expect(failedAttempt).toEqual({ error: expect.any(String) });
    expect(retriedAttempt).toEqual({ success: true });
    expect(mocks.removeTOTP).toHaveBeenCalledTimes(2);
    expect(mocks.removeTOTP).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ serviceConfig: SERVICE_CONFIG, userId: SESSION_USER_ID }),
    );
    expect(mocks.removeTOTP).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ serviceConfig: SERVICE_CONFIG, userId: SESSION_USER_ID }),
    );
  });
});
