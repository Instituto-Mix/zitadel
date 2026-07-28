import { create } from "@zitadel/client";
import { ChecksSchema } from "@zitadel/proto/zitadel/session/v2/session_service_pb";
import { UserState } from "@zitadel/proto/zitadel/user/v2/user_pb";
import { AuthenticationMethodType } from "@zitadel/proto/zitadel/user/v2/user_service_pb";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { sendPassword } from "./password";

// Mock dependencies
vi.mock("next/headers", () => ({
  headers: vi.fn(),
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
  // Real-ish: the forced-change redirect depends entirely on the freshness of the
  // humanUser passed in, which is what these tests are about.
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

/** The user as searchUsers returns it BEFORE migration: no password yet. */
const STALE_USER = {
  userId: "user123",
  preferredLoginName: "testuser",
  details: { resourceOwner: "org123" },
  state: UserState.ACTIVE,
  type: { case: "human", value: { email: { email: "a@b.com", isVerified: true }, passwordChangeRequired: false } },
};

/** The same user AFTER the backend set the ERP password with changeRequired=true. */
const FRESH_USER = {
  ...STALE_USER,
  type: { case: "human", value: { email: { email: "a@b.com", isVerified: true }, passwordChangeRequired: true } },
};

const SESSION = {
  id: "new-session-id",
  factors: {
    user: { id: "user123", loginName: "testuser", organizationId: "org123" },
    password: { verifiedAt: { seconds: 100 } },
  },
};

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

    const { headers } = await import("next/headers");
    const { getServiceConfig } = await import("../service-url");
    const { getSessionCookieByLoginName } = await import("../cookies");
    const { getLoginSettings, listAuthenticationMethodTypes, searchUsers, getUserByID, getLockoutSettings } =
      await import("../zitadel");
    const { createSessionAndUpdateCookie } = await import("@/lib/server/cookie");
    const { completeFlowOrGetUrl } = await import("../client");
    const { checkMFAFactors } = await import("../verify-helper");
    const { legacyMigratePassword, isLegacyMigrateEnabled } = await import("@/lib/server/legacy-migrate");

    vi.mocked(headers).mockResolvedValue({} as any);
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
    mockSearchUsers.mockResolvedValue({ result: [STALE_USER] });
    mockGetLoginSettings.mockResolvedValue({
      allowLocalAuthentication: true,
      passwordCheckLifetime: { seconds: BigInt(86400) },
    });
    mockGetLockoutSettings.mockResolvedValue({ maxPasswordAttempts: BigInt(0) });
    mockCheckMFAFactors.mockResolvedValue(null);
    mockCompleteFlowOrGetUrl.mockResolvedValue({ redirect: "/apps" });
    // getUserByID always returns the post-migration state
    mockGetUserByID.mockResolvedValue({ user: FRESH_USER });
  });

  const send = () =>
    sendPassword({
      loginName: "testuser",
      checks: create(ChecksSchema, { password: { password: "erp-password" } }) as any,
    });

  /**
   * A user with no PASSWORD method whose first session attempt fails, then
   * succeeds after the bridge. The forced-change screen MUST be reached: the
   * pre-migration copy of the user still says passwordChangeRequired=false, so
   * this only passes if the user is re-read after the retry.
   */
  test("reaches the forced password-change screen after a successful migration", async () => {
    mockCreateSessionAndUpdateCookie
      .mockRejectedValueOnce(new Error("password not set"))
      .mockResolvedValueOnce({ session: SESSION, sessionCookie: { id: "new-session-id", token: "t" } });
    // 1st call: the first-access check (no methods). 2nd: the MFA method listing.
    mockListAuthenticationMethodTypes
      .mockResolvedValueOnce({ authMethodTypes: [] })
      .mockResolvedValue({ authMethodTypes: [AuthenticationMethodType.PASSWORD] });
    mockLegacyMigratePassword.mockResolvedValue("migrated");

    const result = await send();

    expect(mockLegacyMigratePassword).toHaveBeenCalledWith({ loginName: "testuser", password: "erp-password" });
    // auth retried with the same password
    expect(mockCreateSessionAndUpdateCookie).toHaveBeenCalledTimes(2);
    // the user was re-read, so passwordChangeRequired=true was seen
    expect(mockGetUserByID).toHaveBeenCalledWith(expect.objectContaining({ userId: "user123" }));
    expect(result).toEqual({ redirect: "/password/change?loginName=testuser" });
    // the mandatory rotation is not suppressed — the flow stops here
    expect(mockCompleteFlowOrGetUrl).not.toHaveBeenCalled();
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
    "returns the generic error and does not retry on %s",
    async (outcome) => {
      mockCreateSessionAndUpdateCookie.mockRejectedValue(new Error("password not set"));
      mockListAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [] });
      mockLegacyMigratePassword.mockResolvedValue(outcome);

      const result = await send();

      expect(mockCreateSessionAndUpdateCookie).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ error: "errors.couldNotCreateSessionForUser" });
    },
  );

  test("surfaces the generic error when the retry itself fails", async () => {
    mockCreateSessionAndUpdateCookie.mockRejectedValue(new Error("still no good"));
    mockListAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [] });
    mockLegacyMigratePassword.mockResolvedValue("migrated");

    const result = await send();

    expect(mockCreateSessionAndUpdateCookie).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ error: "errors.couldNotCreateSessionForUser" });
  });

  test("never reaches the bridge when the first attempt succeeds", async () => {
    mockCreateSessionAndUpdateCookie.mockResolvedValue({
      session: SESSION,
      sessionCookie: { id: "new-session-id", token: "t" },
    });
    mockListAuthenticationMethodTypes.mockResolvedValue({ authMethodTypes: [AuthenticationMethodType.PASSWORD] });
    mockGetUserByID.mockResolvedValue({ user: STALE_USER });

    const result = await send();

    expect(mockLegacyMigratePassword).not.toHaveBeenCalled();
    expect(result).toEqual({ redirect: "/apps" });
  });
});
