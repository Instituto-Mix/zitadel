import { create } from "@zitadel/client";
import { ChecksSchema } from "@zitadel/proto/zitadel/session/v2/session_service_pb";
import { UserState } from "@zitadel/proto/zitadel/user/v2/user_pb";
import { AuthenticationMethodType } from "@zitadel/proto/zitadel/user/v2/user_service_pb";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { completeFirstAccess, sendPassword } from "./password";

// Mock dependencies
const cookieStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
};

vi.mock("next/headers", () => ({
  headers: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock("@zitadel/client", () => ({
  create: vi.fn((schema, data) => data),
  ConnectError: class extends Error {
    code: number;
    constructor(msg: string, code: number) {
      super(msg);
      this.code = code;
    }
  },
  timestampDate: (ts: any) => new Date(ts.seconds * 1000),
  Code: { FailedPrecondition: 9 },
}));

vi.mock("@zitadel/client/v2", () => ({
  createUserServiceClient: vi.fn(),
}));

vi.mock("../service-url", () => ({
  getServiceConfig: vi.fn(),
}));

vi.mock("../zitadel", () => ({
  getLoginSettings: vi.fn(),
  listAuthenticationMethodTypes: vi.fn(),
  getSession: vi.fn(),
  setPassword: vi.fn(),
  createServerTransport: vi.fn(),
  getLockoutSettings: vi.fn(),
  passwordReset: vi.fn(),
  getPasswordExpirySettings: vi.fn(),
  getUserByID: vi.fn(),
  setUserPassword: vi.fn(),
  searchUsers: vi.fn(),
}));

vi.mock("../cookies", () => ({
  getSessionCookieByLoginName: vi.fn(),
  getSessionCookieById: vi.fn(),
}));

vi.mock("../client", () => ({
  completeFlowOrGetUrl: vi.fn(),
}));

vi.mock("@/lib/server/cookie", () => ({
  createSessionAndUpdateCookie: vi.fn(),
  setSessionAndUpdateCookie: vi.fn(),
}));

vi.mock("@/lib/server/legacy-migrate", () => ({
  isLegacyMigrateEnabled: vi.fn(() => true),
  legacyMigratePassword: vi.fn(),
}));

vi.mock("../verify-helper", () => ({
  checkPasswordChangeRequired: vi.fn((_expiry: any, _session: any, humanUser: any) =>
    humanUser?.passwordChangeRequired ? { redirect: "/password/change?loginName=testuser" } : undefined,
  ),
  checkEmailVerification: vi.fn(),
  checkMFAFactors: vi.fn(),
  checkUserVerification: vi.fn(),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(() => (key: string) => key),
}));

/** A provisioned user: no Zitadel password, only a legacy ERP digest. */
const USER = {
  userId: "user123",
  preferredLoginName: "testuser",
  details: { resourceOwner: "org123" },
  state: UserState.ACTIVE,
  type: { case: "human", value: { email: { email: "a@b.com", isVerified: true }, passwordChangeRequired: false } },
};

const SESSION = {
  id: "new-session-id",
  factors: {
    user: { id: "user123", loginName: "testuser", organizationId: "org123" },
    password: { verifiedAt: { seconds: 100 } },
  },
};

/**
 * The provisioner pins Zitadel's userId to the ERP pessoa id, so for a
 * provisioned user the backend's user_id equals the id the login app resolved.
 */
const VERIFIED = { outcome: "verified", userId: "user123", resetCode: "IBJMUC" } as const;

describe("sendPassword — legacy first-access bridge", () => {
  let mockSearchUsers: any;
  let mockGetLoginSettings: any;
  let mockCreateSessionAndUpdateCookie: any;
  let mockListAuthenticationMethodTypes: any;
  let mockGetUserByID: any;
  let mockGetLockoutSettings: any;
  let mockCompleteFlowOrGetUrl: any;
  let mockCheckMFAFactors: any;
  let mockLegacyMigratePassword: any;
  let mockIsLegacyMigrateEnabled: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    const { headers, cookies } = await import("next/headers");
    const { getServiceConfig } = await import("../service-url");
    const { getSessionCookieByLoginName } = await import("../cookies");
    const { getLoginSettings, listAuthenticationMethodTypes, searchUsers, getUserByID, getLockoutSettings } =
      await import("../zitadel");
    const { createSessionAndUpdateCookie } = await import("@/lib/server/cookie");
    const { completeFlowOrGetUrl } = await import("../client");
    const { checkMFAFactors } = await import("../verify-helper");
    const { legacyMigratePassword, isLegacyMigrateEnabled } = await import("@/lib/server/legacy-migrate");

    vi.mocked(headers).mockResolvedValue({} as any);
    vi.mocked(cookies).mockResolvedValue(cookieStore as any);
    cookieStore.get.mockReturnValue(undefined);
    vi.mocked(getServiceConfig).mockReturnValue({ serviceConfig: { baseUrl: "https://api.example.com" } } as any);
    vi.mocked(getSessionCookieByLoginName).mockResolvedValue(null as any);

    mockSearchUsers = vi.mocked(searchUsers);
    mockGetLoginSettings = vi.mocked(getLoginSettings);
    mockCreateSessionAndUpdateCookie = vi.mocked(createSessionAndUpdateCookie);
    mockListAuthenticationMethodTypes = vi.mocked(listAuthenticationMethodTypes);
    mockGetUserByID = vi.mocked(getUserByID);
    mockGetLockoutSettings = vi.mocked(getLockoutSettings);
    mockCompleteFlowOrGetUrl = vi.mocked(completeFlowOrGetUrl);
    mockCheckMFAFactors = vi.mocked(checkMFAFactors);
    mockLegacyMigratePassword = vi.mocked(legacyMigratePassword);
    mockIsLegacyMigrateEnabled = vi.mocked(isLegacyMigrateEnabled);

    mockIsLegacyMigrateEnabled.mockReturnValue(true);
    mockSearchUsers.mockResolvedValue({ result: [USER] });
    mockGetLoginSettings.mockResolvedValue({
      allowLocalAuthentication: true,
      passwordCheckLifetime: { seconds: BigInt(86400) },
    });
    mockGetLockoutSettings.mockResolvedValue({ maxPasswordAttempts: BigInt(0) });
    mockCheckMFAFactors.mockResolvedValue(null);
    mockCompleteFlowOrGetUrl.mockResolvedValue({ redirect: "/apps" });
    mockGetUserByID.mockResolvedValue({ user: USER });
  });

  const send = () =>
    sendPassword({
      loginName: "testuser",
      checks: create(ChecksSchema, { password: { password: "erp-password" } }) as any,
    });

  const arrangeFirstAccess = () => {
    mockCreateSessionAndUpdateCookie.mockRejectedValue(new Error("password not set"));
    mockListAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [] });
    mockLegacyMigratePassword.mockResolvedValue(VERIFIED);
  };

  /**
   * The ERP credential is proof of identity only: nothing is installed, so auth
   * must NOT be retried — the user is sent to choose a password instead.
   */
  test("redirects to the choose-a-password screen after the ERP credential verifies", async () => {
    arrangeFirstAccess();

    const result = await send();

    expect(mockLegacyMigratePassword).toHaveBeenCalledWith({ loginName: "testuser", password: "erp-password" });
    expect(mockCreateSessionAndUpdateCookie).toHaveBeenCalledTimes(1);
    // Route-relative: next/navigation adds NEXT_PUBLIC_BASE_PATH on the client,
    // so including it here would produce /ui/v2/login/ui/v2/login/... (seen live).
    expect(result).toEqual({ redirect: "/password/first-access" });
    expect(mockCompleteFlowOrGetUrl).not.toHaveBeenCalled();
  });

  test("puts only an opaque httpOnly handle in the browser — never the reset code", async () => {
    arrangeFirstAccess();

    const result = await send();

    expect(cookieStore.set).toHaveBeenCalledTimes(1);
    const cookie = cookieStore.set.mock.calls[0][0];
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.value).not.toContain("IBJMUC");
    expect(JSON.stringify(result)).not.toContain("IBJMUC");
  });

  /**
   * The ids only coincide for users the provisioner created. A mismatch means the
   * reset code belongs to a different id, so spending it would fail anyway — and
   * the typed credential was actually correct, so a password error would be a lie.
   */
  test("fails closed on an id mismatch instead of blaming the credential", async () => {
    mockCreateSessionAndUpdateCookie.mockRejectedValue(new Error("password not set"));
    mockListAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [] });
    mockLegacyMigratePassword.mockResolvedValue({ ...VERIFIED, userId: "382641673429057539" });

    const result = await send();

    expect(result).toEqual({ error: "firstAccess.errors.integrity" });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  test("does not call the backend when the user already has a PASSWORD method", async () => {
    mockCreateSessionAndUpdateCookie.mockRejectedValue(Object.assign(new Error("wrong"), { failedAttempts: 1 }));
    mockListAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [AuthenticationMethodType.PASSWORD] });

    const result = await send();

    expect(mockLegacyMigratePassword).not.toHaveBeenCalled();
    expect(mockCreateSessionAndUpdateCookie).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ error: "errors.failedToAuthenticateNoLimit" });
  });

  test("does not call the backend when the bridge is not configured", async () => {
    mockIsLegacyMigrateEnabled.mockReturnValue(false);
    mockCreateSessionAndUpdateCookie.mockRejectedValue(new Error("password not set"));
    mockListAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [] });

    await send();

    expect(mockLegacyMigratePassword).not.toHaveBeenCalled();
    expect(mockCreateSessionAndUpdateCookie).toHaveBeenCalledTimes(1);
  });

  // 409 / 403 / unavailable are indistinguishable to the user by design.
  test.each(["has_password", "not_verifiable", "unavailable"] as const)(
    "returns the generic error and starts no first-access flow on %s",
    async (outcome) => {
      mockCreateSessionAndUpdateCookie.mockRejectedValue(new Error("password not set"));
      mockListAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [] });
      mockLegacyMigratePassword.mockResolvedValue({ outcome });

      const result = await send();

      expect(mockCreateSessionAndUpdateCookie).toHaveBeenCalledTimes(1);
      expect(cookieStore.set).not.toHaveBeenCalled();
      expect(result).toEqual({ error: "errors.couldNotCreateSessionForUser" });
    },
  );

  test("never reaches the bridge when the first attempt succeeds", async () => {
    mockCreateSessionAndUpdateCookie.mockResolvedValue({
      session: SESSION,
      sessionCookie: { id: "new-session-id", token: "t" },
    });
    mockListAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [AuthenticationMethodType.PASSWORD] });

    const result = await send();

    expect(mockLegacyMigratePassword).not.toHaveBeenCalled();
    expect(result).toEqual({ redirect: "/apps" });
  });
});

describe("completeFirstAccess", () => {
  let mockSetUserPassword: any;
  let mockCreateSessionAndUpdateCookie: any;
  let mockSearchUsers: any;
  let mockListAuthenticationMethodTypes: any;
  let mockLegacyMigratePassword: any;

  /** Runs a full first-access hand-off and returns the handle the cookie got. */
  async function startFirstAccess(): Promise<string> {
    mockCreateSessionAndUpdateCookie.mockRejectedValue(new Error("password not set"));
    mockListAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [] });
    mockLegacyMigratePassword.mockResolvedValue(VERIFIED);

    await sendPassword({
      loginName: "testuser",
      checks: create(ChecksSchema, { password: { password: "erp-password" } }) as any,
    });

    const handle = cookieStore.set.mock.calls.at(-1)![0].value;
    cookieStore.get.mockReturnValue({ value: handle });
    return handle;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useRealTimers();

    const { headers, cookies } = await import("next/headers");
    const { getServiceConfig } = await import("../service-url");
    const { getSessionCookieByLoginName } = await import("../cookies");
    const {
      getLoginSettings,
      listAuthenticationMethodTypes,
      searchUsers,
      getUserByID,
      getLockoutSettings,
      setUserPassword,
    } = await import("../zitadel");
    const { createSessionAndUpdateCookie } = await import("@/lib/server/cookie");
    const { completeFlowOrGetUrl } = await import("../client");
    const { checkMFAFactors } = await import("../verify-helper");
    const { legacyMigratePassword, isLegacyMigrateEnabled } = await import("@/lib/server/legacy-migrate");

    vi.mocked(headers).mockResolvedValue({} as any);
    vi.mocked(cookies).mockResolvedValue(cookieStore as any);
    cookieStore.get.mockReturnValue(undefined);
    vi.mocked(getServiceConfig).mockReturnValue({ serviceConfig: { baseUrl: "https://api.example.com" } } as any);
    vi.mocked(getSessionCookieByLoginName).mockResolvedValue(null as any);
    vi.mocked(isLegacyMigrateEnabled).mockReturnValue(true);

    mockSetUserPassword = vi.mocked(setUserPassword);
    mockCreateSessionAndUpdateCookie = vi.mocked(createSessionAndUpdateCookie);
    mockSearchUsers = vi.mocked(searchUsers);
    mockListAuthenticationMethodTypes = vi.mocked(listAuthenticationMethodTypes);
    mockLegacyMigratePassword = vi.mocked(legacyMigratePassword);

    mockSearchUsers.mockResolvedValue({ result: [USER] });
    vi.mocked(getLoginSettings).mockResolvedValue({
      allowLocalAuthentication: true,
      passwordCheckLifetime: { seconds: BigInt(86400) },
    } as any);
    vi.mocked(getLockoutSettings).mockResolvedValue({ maxPasswordAttempts: BigInt(0) } as any);
    vi.mocked(checkMFAFactors).mockResolvedValue(null as any);
    vi.mocked(completeFlowOrGetUrl).mockResolvedValue({ redirect: "/apps" } as any);
    vi.mocked(getUserByID).mockResolvedValue({ user: USER } as any);
    mockSetUserPassword.mockResolvedValue({});
  });

  test("rejects when there is no ticket for the handle", async () => {
    const result = await completeFirstAccess({ password: "Compliant1!" });

    expect(mockSetUserPassword).not.toHaveBeenCalled();
    expect(result).toEqual({ error: "firstAccess.errors.expired" });
  });

  test("spends the reset code against the resolved Zitadel user id", async () => {
    await startFirstAccess();

    await completeFirstAccess({ password: "Compliant1!" });

    expect(mockSetUserPassword).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user123", password: "Compliant1!", code: "IBJMUC" }),
    );
  });

  test("signs the user in with the new password and clears the handle", async () => {
    await startFirstAccess();
    mockCreateSessionAndUpdateCookie.mockReset();
    mockCreateSessionAndUpdateCookie.mockResolvedValue({
      session: SESSION,
      sessionCookie: { id: "new-session-id", token: "t" },
    });
    mockListAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [AuthenticationMethodType.PASSWORD] });

    const result = await completeFirstAccess({ password: "Compliant1!" });

    expect(mockCreateSessionAndUpdateCookie).toHaveBeenCalledWith(
      expect.objectContaining({ checks: expect.objectContaining({ password: { password: "Compliant1!" } }) }),
    );
    expect(cookieStore.delete).toHaveBeenCalledWith("first_access");
    expect(result).toEqual({ redirect: "/apps" });
  });

  test("surfaces Zitadel's complexity message and keeps the ticket usable for a retry", async () => {
    await startFirstAccess();
    mockSetUserPassword.mockRejectedValueOnce(
      Object.assign(new Error("A senha deve conter letras minusculas"), { code: 3, name: "ConnectError" }),
    );

    const rejected = await completeFirstAccess({ password: "NOLOWERCASE1!" });
    expect(rejected).toEqual({ error: "A senha deve conter letras minusculas" });

    // same ticket, corrected password
    mockSetUserPassword.mockResolvedValue({});
    await completeFirstAccess({ password: "Compliant1!" });
    expect(mockSetUserPassword).toHaveBeenLastCalledWith(expect.objectContaining({ code: "IBJMUC" }));
  });

  // A successful set consumes the reset code backend-side; reusing it would fail
  // with "Codigo nao encontrado", so the ticket must not survive the success.
  test("does not let the reset code be spent twice", async () => {
    await startFirstAccess();
    mockCreateSessionAndUpdateCookie.mockReset();
    mockCreateSessionAndUpdateCookie.mockResolvedValue({
      session: SESSION,
      sessionCookie: { id: "new-session-id", token: "t" },
    });
    mockListAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [AuthenticationMethodType.PASSWORD] });

    await completeFirstAccess({ password: "Compliant1!" });
    mockSetUserPassword.mockClear();

    const second = await completeFirstAccess({ password: "Another1!" });
    expect(second).toEqual({ error: "firstAccess.errors.expired" });
    expect(mockSetUserPassword).not.toHaveBeenCalled();
  });

  test("stops accepting attempts after the retry budget is spent", async () => {
    await startFirstAccess();
    mockSetUserPassword.mockRejectedValue(Object.assign(new Error("nope"), { code: 3, name: "ConnectError" }));

    for (let i = 0; i < 5; i++) {
      await completeFirstAccess({ password: "bad" });
    }

    const result = await completeFirstAccess({ password: "Compliant1!" });
    expect(result).toEqual({ error: "firstAccess.errors.expired" });
    expect(mockSetUserPassword).toHaveBeenCalledTimes(5);
  });
});
