import { create } from "@zitadel/client";
import { FactorsSchema, SessionSchema } from "@zitadel/proto/zitadel/session/v2/session_pb";
import { GetSessionResponseSchema } from "@zitadel/proto/zitadel/session/v2/session_service_pb";
import { LoginSettingsSchema, SecondFactorType } from "@zitadel/proto/zitadel/settings/v2/login_settings_pb";
import { VerifyTOTPRegistrationResponseSchema } from "@zitadel/proto/zitadel/user/v2/user_service_pb";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { sendVerification, trySendVerification, verifyTOTP } from "./verify";

import {
  createInviteCode,
  getLoginSettings,
  getSession,
  getUserByID,
  listAuthenticationMethodTypes,
  verifyEmail,
  verifyTOTPRegistration,
  sendEmailCode as zitadelSendEmailCode,
} from "@/lib/zitadel";
import { cookies, headers } from "next/headers";
import { getMostRecentCookieWithLoginname, getSessionCookieById, getSessionCookieByLoginName } from "../cookies";
import { createSessionAndUpdateCookie } from "./cookie";
import { getEnrollmentAuthorizationError } from "./enrollment-guard";

// Mock dependencies
vi.mock("@/lib/zitadel", () => ({
  verifyEmail: vi.fn(),
  verifyInviteCode: vi.fn(),
  getUserByID: vi.fn(),
  getSession: vi.fn(),
  listAuthenticationMethodTypes: vi.fn(),
  getLoginSettings: vi.fn(),
  sendEmailCode: vi.fn(),
  createInviteCode: vi.fn(),
  verifyTOTPRegistration: vi.fn(),
}));

vi.mock("./enrollment-guard", () => ({
  getEnrollmentAuthorizationError: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock("../cookies", () => ({
  getMostRecentCookieWithLoginname: vi.fn(),
  getSessionCookieById: vi.fn(),
  getSessionCookieByLoginName: vi.fn(),
}));

vi.mock("./cookie", () => ({
  createSessionAndUpdateCookie: vi.fn(),
}));

vi.mock("../service-url", () => ({
  getServiceConfig: vi.fn(() => ({ serviceConfig: {} })),
}));

vi.mock("../verification-check", () => ({
  setUserVerificationCheckCookie: vi.fn(),
}));

vi.mock("./host", () => ({
  getPublicHostWithProtocol: vi.fn(() => "https://example.com"),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(() => (key: string) => key),
}));

describe("sendVerification", () => {
  let mockVerifyEmail: any;
  let mockGetUserByID: any;
  let mockGetSession: any;
  let mockListAuthenticationMethodTypes: any;
  let mockGetSessionCookieByLoginName: any;
  let mockCreateSessionAndUpdateCookie: any;
  let mockCookies: any;

  beforeEach(() => {
    mockVerifyEmail = verifyEmail;
    mockGetUserByID = getUserByID;
    mockGetSession = getSession;
    mockListAuthenticationMethodTypes = listAuthenticationMethodTypes;
    mockGetSessionCookieByLoginName = getSessionCookieByLoginName;
    mockCreateSessionAndUpdateCookie = createSessionAndUpdateCookie;
    mockCookies = cookies;

    // Default valid checking setup
    mockVerifyEmail.mockResolvedValue({});
    mockGetUserByID.mockResolvedValue({
      user: { userId: "user-1", preferredLoginName: "test@example.com" },
    });
    mockCookies.mockResolvedValue({
      set: vi.fn(),
    });
  });

  test("should handle failing getSession when no auth methods exist (stale cookie scenario)", async () => {
    // 1. Cookie exists
    mockGetSessionCookieByLoginName.mockResolvedValue({
      id: "stale-session-id",
      token: "stale-token",
    });

    // 2. getSession fails (throws or returns null/invalid)
    // Simulating call returning nothing useful or throwing
    mockGetSession.mockRejectedValue(new Error("Session not found"));
    // OR: mockGetSession.mockResolvedValue({}); // depending on how generic client behaves

    // 3. No auth methods (user needs setup)
    mockListAuthenticationMethodTypes.mockResolvedValue({
      authMethodTypes: [],
    });

    // 4. Mock session creation success
    mockCreateSessionAndUpdateCookie.mockResolvedValue({
      session: {
        id: "new-session-id",
        factors: { user: { id: "user-1", loginName: "test@example.com", organizationId: "org-1" } },
      },
    });

    const result = await sendVerification({
      userId: "user-1",
      code: "123456",
      isInvite: false,
    });

    // Expect redirect to authenticator setup
    expect(result).toEqual({
      redirect: "/authenticator/set?sessionId=new-session-id&loginName=test%40example.com",
    });

    // Verify getSession was called (and failed, but we recovered)
    expect(mockGetSession).toHaveBeenCalled();
    // Verify creation was attempted
    expect(mockCreateSessionAndUpdateCookie).toHaveBeenCalled();
    // The signed verification check is issued for the verified user
    const { setUserVerificationCheckCookie } = await import("../verification-check");
    expect(setUserVerificationCheckCookie).toHaveBeenCalledWith("user-1");
  });

  test("should include requestId in /authenticator/set redirect when provided", async () => {
    // 1. No existing session cookie
    mockGetSessionCookieByLoginName.mockResolvedValue(undefined);

    // 2. No auth methods (user needs setup)
    mockListAuthenticationMethodTypes.mockResolvedValue({
      authMethodTypes: [],
    });

    // 3. Mock session creation success
    mockCreateSessionAndUpdateCookie.mockResolvedValue({
      session: {
        id: "new-session-id",
        factors: { user: { id: "user-1", loginName: "test@example.com", organizationId: "org-1" } },
      },
    });

    const result = await sendVerification({
      userId: "user-1",
      code: "123456",
      isInvite: false,
      requestId: "oidc_auth-req-123",
    });

    // Expect redirect to include requestId
    expect(result).toEqual({
      redirect: expect.stringContaining("/authenticator/set?"),
    });
    const redirectUrl = (result as { redirect: string }).redirect;
    const params = new URLSearchParams(redirectUrl.split("?")[1]);
    expect(params.get("requestId")).toBe("oidc_auth-req-123");
    expect(params.get("sessionId")).toBe("new-session-id");
    expect(params.get("loginName")).toBe("test@example.com");
  });

  test("should NOT include requestId in /authenticator/set redirect when not provided", async () => {
    // 1. No existing session cookie
    mockGetSessionCookieByLoginName.mockResolvedValue(undefined);

    // 2. No auth methods (user needs setup)
    mockListAuthenticationMethodTypes.mockResolvedValue({
      authMethodTypes: [],
    });

    // 3. Mock session creation success
    mockCreateSessionAndUpdateCookie.mockResolvedValue({
      session: {
        id: "new-session-id",
        factors: { user: { id: "user-1", loginName: "test@example.com", organizationId: "org-1" } },
      },
    });

    const result = await sendVerification({
      userId: "user-1",
      code: "123456",
      isInvite: false,
      // no requestId
    });

    const redirectUrl = (result as { redirect: string }).redirect;
    const params = new URLSearchParams(redirectUrl.split("?")[1]);
    expect(params.get("requestId")).toBeNull();
  });

  test("should fall back to user.preferredLoginName for session cookie lookup when loginName is undefined", async () => {
    // Simulate the email-link scenario: loginName is undefined but userId is provided
    mockGetSessionCookieByLoginName.mockResolvedValue(undefined);
    mockGetUserByID.mockResolvedValue({
      user: { userId: "user-1", preferredLoginName: "test@example.com" },
    });
    mockListAuthenticationMethodTypes.mockResolvedValue({
      authMethodTypes: [],
    });
    mockCreateSessionAndUpdateCookie.mockResolvedValue({
      session: {
        id: "new-session-id",
        factors: { user: { id: "user-1", loginName: "test@example.com", organizationId: "org-1" } },
      },
    });

    await sendVerification({
      userId: "user-1",
      code: "123456",
      isInvite: false,
      loginName: undefined, // explicitly undefined, like from email link
    });

    // The key assertion: session cookie lookup should use preferredLoginName as fallback
    expect(mockGetSessionCookieByLoginName).toHaveBeenCalledWith({
      loginName: "test@example.com",
      organization: undefined,
    });
  });
});

describe("trySendVerification", () => {
  let mockSendEmailCode: any;
  let mockCreateInviteCode: any;
  let originalBasePath: string | undefined;

  beforeEach(() => {
    originalBasePath = process.env.NEXT_PUBLIC_BASE_PATH;
    process.env.NEXT_PUBLIC_BASE_PATH = "/ui/v2/login";

    vi.clearAllMocks();
    mockSendEmailCode = zitadelSendEmailCode;
    mockCreateInviteCode = createInviteCode;
    mockSendEmailCode.mockResolvedValue({});
    mockCreateInviteCode.mockResolvedValue({});
  });

  afterEach(() => {
    if (originalBasePath === undefined) {
      Reflect.deleteProperty(process.env, "NEXT_PUBLIC_BASE_PATH");
    } else {
      process.env.NEXT_PUBLIC_BASE_PATH = originalBasePath;
    }
  });

  test("should call sendEmailCode with correct URL template for non-invite and return true", async () => {
    const result = await trySendVerification({
      userId: "user-1",
      isInvite: false,
    });

    expect(result).toBe(true);
    expect(mockSendEmailCode).toHaveBeenCalledWith({
      serviceConfig: {},
      userId: "user-1",
      urlTemplate: "https://example.com/ui/v2/login/verify?code={{.Code}}&userId={{.UserID}}&organization={{.OrgID}}",
    });
    expect(mockCreateInviteCode).not.toHaveBeenCalled();
  });

  test("should call createInviteCode with correct URL template for invite and return true", async () => {
    const result = await trySendVerification({
      userId: "user-1",
      isInvite: true,
    });

    expect(result).toBe(true);
    expect(mockCreateInviteCode).toHaveBeenCalledWith({
      serviceConfig: {},
      userId: "user-1",
      urlTemplate:
        "https://example.com/ui/v2/login/verify?code={{.Code}}&userId={{.UserID}}&organization={{.OrgID}}&invite=true",
    });
    expect(mockSendEmailCode).not.toHaveBeenCalled();
  });

  test("should include URL-encoded requestId in URL template", async () => {
    const result = await trySendVerification({
      userId: "user-1",
      isInvite: false,
      requestId: "req-123",
    });

    expect(result).toBe(true);
    expect(mockSendEmailCode).toHaveBeenCalledWith({
      serviceConfig: {},
      userId: "user-1",
      urlTemplate:
        "https://example.com/ui/v2/login/verify?code={{.Code}}&userId={{.UserID}}&organization={{.OrgID}}&requestId=req-123",
    });
  });

  test("should URL-encode special characters in requestId", async () => {
    const result = await trySendVerification({
      userId: "user-1",
      isInvite: false,
      requestId: "req&id=injected",
    });

    expect(result).toBe(true);
    expect(mockSendEmailCode).toHaveBeenCalledWith({
      serviceConfig: {},
      userId: "user-1",
      urlTemplate:
        "https://example.com/ui/v2/login/verify?code={{.Code}}&userId={{.UserID}}&organization={{.OrgID}}&requestId=req%26id%3Dinjected",
    });
  });

  test("should include invite=true and requestId for invite with requestId", async () => {
    const result = await trySendVerification({
      userId: "user-1",
      isInvite: true,
      requestId: "req-456",
    });

    expect(result).toBe(true);
    expect(mockCreateInviteCode).toHaveBeenCalledWith({
      serviceConfig: {},
      userId: "user-1",
      urlTemplate:
        "https://example.com/ui/v2/login/verify?code={{.Code}}&userId={{.UserID}}&organization={{.OrgID}}&invite=true&requestId=req-456",
    });
  });

  test("should return false when sendEmailCode fails", async () => {
    mockSendEmailCode.mockRejectedValue(new Error("Network error"));

    const result = await trySendVerification({
      userId: "user-1",
      isInvite: false,
    });

    expect(result).toBe(false);
  });

  test("should return false when createInviteCode fails", async () => {
    mockCreateInviteCode.mockRejectedValue(new Error("Already invited"));

    const result = await trySendVerification({
      userId: "user-1",
      isInvite: true,
    });

    expect(result).toBe(false);
  });
});

describe("verifyTOTP", () => {
  const mockGetSession = vi.mocked(getSession);
  const mockGetSessionCookieById = vi.mocked(getSessionCookieById);
  const mockGetMostRecentCookieWithLoginname = vi.mocked(getMostRecentCookieWithLoginname);
  const mockGetLoginSettings = vi.mocked(getLoginSettings);
  const mockVerifyTOTPRegistration = vi.mocked(verifyTOTPRegistration);
  const mockGetEnrollmentAuthorizationError = vi.mocked(getEnrollmentAuthorizationError);

  const sessionCookie = {
    id: "session-1",
    token: "session-token",
    loginName: "victim@example.com",
    organization: "org-1",
    creationTs: "",
    expirationTs: "",
    changeTs: "",
  };
  const totpUser = { id: "victim-1", loginName: "victim@example.com", organizationId: "org-1" };
  const totpSession = create(SessionSchema, { id: "session-1", factors: { user: totpUser } });
  const registrationResult = create(VerifyTOTPRegistrationResponseSchema, {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(headers).mockResolvedValue(new Headers());

    mockGetSessionCookieById.mockResolvedValue(sessionCookie);
    mockGetMostRecentCookieWithLoginname.mockResolvedValue(sessionCookie);
    mockGetSession.mockResolvedValue(create(GetSessionResponseSchema, { session: totpSession }));
    mockGetEnrollmentAuthorizationError.mockResolvedValue(null);
    mockGetLoginSettings.mockResolvedValue(create(LoginSettingsSchema, { secondFactors: [SecondFactorType.OTP] }));
    mockVerifyTOTPRegistration.mockResolvedValue(registrationResult);
  });

  test("rejects TOTP enrollment on an unauthenticated (identify-only) session", async () => {
    mockGetEnrollmentAuthorizationError.mockResolvedValue(
      "You have to authenticate or have a valid User Verification Check",
    );

    const result = await verifyTOTP("123456", "session-1", "victim@example.com", "org-1");

    expect(result).toEqual({ error: "You have to authenticate or have a valid User Verification Check" });
    expect(mockGetEnrollmentAuthorizationError).toHaveBeenCalledWith({
      serviceConfig: {},
      session: totpSession,
      userId: "victim-1",
    });
    expect(mockGetLoginSettings).not.toHaveBeenCalled();
    expect(mockVerifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test("verifies TOTP registration when the selected cookie-bound session is authorized", async () => {
    const result = await verifyTOTP("123456", "session-1", "victim@example.com", "org-1");

    expect(mockGetSessionCookieById).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(mockGetMostRecentCookieWithLoginname).not.toHaveBeenCalled();
    expect(mockGetSession).toHaveBeenCalledWith({
      serviceConfig: {},
      sessionId: "session-1",
      sessionToken: "session-token",
    });
    expect(mockGetLoginSettings).toHaveBeenCalledWith({ serviceConfig: {}, organization: "org-1" });
    expect(mockVerifyTOTPRegistration).toHaveBeenCalledWith({
      serviceConfig: {},
      code: "123456",
      userId: "victim-1",
    });
    expect(result).toEqual(registrationResult);
  });

  test("uses the login and organization cookie fallback only when no session id is provided", async () => {
    const result = await verifyTOTP("123456", undefined, "victim@example.com", "org-1");

    expect(result).toEqual(registrationResult);
    expect(mockGetSessionCookieById).not.toHaveBeenCalled();
    expect(mockGetMostRecentCookieWithLoginname).toHaveBeenCalledWith({
      loginName: "victim@example.com",
      organization: "org-1",
    });
    expect(mockGetSession).toHaveBeenCalledWith({
      serviceConfig: {},
      sessionId: "session-1",
      sessionToken: "session-token",
    });
  });

  test.each([
    { name: "session id", session: { ...totpSession, id: "another-session" } },
    {
      name: "login name",
      session: create(SessionSchema, {
        ...totpSession,
        factors: create(FactorsSchema, { user: { ...totpUser, loginName: "another@example.com" } }),
      }),
    },
    {
      name: "organization",
      session: create(SessionSchema, {
        ...totpSession,
        factors: create(FactorsSchema, { user: { ...totpUser, organizationId: "another-organization" } }),
      }),
    },
  ])("rejects a returned session whose $name is not bound to the request", async ({ session }) => {
    mockGetSession.mockResolvedValue(create(GetSessionResponseSchema, { session }));

    const result = await verifyTOTP("123456", "session-1", "victim@example.com", "org-1");

    expect(result).toEqual({ error: expect.any(String) });
    expect(mockGetEnrollmentAuthorizationError).not.toHaveBeenCalled();
    expect(mockVerifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test("rejects a missing selected cookie without falling back to another account", async () => {
    mockGetSessionCookieById.mockResolvedValue(undefined);

    const result = await verifyTOTP("123456", "session-1", "victim@example.com", "org-1");

    expect(result).toEqual({ error: "Could not find the requested session" });
    expect(mockGetMostRecentCookieWithLoginname).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockGetEnrollmentAuthorizationError).not.toHaveBeenCalled();
    expect(mockVerifyTOTPRegistration).not.toHaveBeenCalled();
  });

  test("rejects a session with no user id", async () => {
    mockGetSession.mockResolvedValue(
      create(GetSessionResponseSchema, { session: create(SessionSchema, { id: "session-1", factors: {} }) }),
    );

    const result = await verifyTOTP("123456");

    expect(result).toEqual({ error: "Could not determine user from session" });
    expect(mockGetEnrollmentAuthorizationError).not.toHaveBeenCalled();
    expect(mockVerifyTOTPRegistration).not.toHaveBeenCalled();
  });
});
