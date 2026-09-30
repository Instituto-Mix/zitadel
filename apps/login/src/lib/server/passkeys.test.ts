import type * as ZitadelClient from "@zitadel/client";
import { create, timestampDate, TimestampSchema } from "@zitadel/client";
import {
  FactorsSchema,
  PasswordFactorSchema,
  SessionSchema,
  UserFactorSchema,
  WebAuthNFactorSchema,
} from "@zitadel/proto/zitadel/session/v2/session_pb";
import { GetSessionResponseSchema } from "@zitadel/proto/zitadel/session/v2/session_service_pb";
import { PasskeyRegistrationCodeSchema } from "@zitadel/proto/zitadel/user/v2/auth_pb";
import { UserSchema } from "@zitadel/proto/zitadel/user/v2/user_pb";
import {
  CreatePasskeyRegistrationLinkResponseSchema,
  GetUserByIDResponseSchema,
  ListAuthenticationMethodTypesResponseSchema,
  RegisterPasskeyResponseSchema,
} from "@zitadel/proto/zitadel/user/v2/user_service_pb";
import { headers } from "next/headers";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { getSessionCookieById, getSessionCookieByLoginName } from "../cookies";
import { getServiceConfig } from "../service-url";
import { isSessionValid } from "../session";
import {
  createPasskeyRegistrationLink,
  getSession,
  getUserByID,
  listAuthenticationMethodTypes,
  registerPasskey,
  verifyPasskeyRegistration as zitadelVerifyPasskeyRegistration,
} from "../zitadel";
import { createSessionAndUpdateCookie } from "./cookie";
import { getPublicHost } from "./host";
import { registerPasskeyLink, sendPasskey, verifyPasskeyRegistration } from "./passkeys";

// Mock all the dependencies
vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

vi.mock("@zitadel/client", async () => {
  const actual = await vi.importActual<typeof ZitadelClient>("@zitadel/client");
  return {
    ...actual,
    Duration: vi.fn(),
    Timestamp: vi.fn(),
    timestampDate: vi.fn(),
  };
});

vi.mock("../service-url", () => ({
  getServiceConfig: vi.fn(),
}));

vi.mock("../zitadel", () => ({
  getLoginSettings: vi.fn(),
  getSession: vi.fn(),
  getUserByID: vi.fn(),
  listUsers: vi.fn(),
  createPasskeyRegistrationLink: vi.fn(),
  registerPasskey: vi.fn(),
  verifyPasskeyRegistration: vi.fn(),
  listAuthenticationMethodTypes: vi.fn(),
}));

vi.mock("./cookie", () => ({
  setSessionAndUpdateCookie: vi.fn(),
  createSessionAndUpdateCookie: vi.fn(),
}));

vi.mock("../session", () => ({
  isSessionValid: vi.fn().mockResolvedValue(true),
}));

vi.mock("../cookies", () => ({
  getSessionCookieById: vi.fn(),
  getSessionCookieByLoginName: vi.fn(),
  getMostRecentSessionCookie: vi.fn(),
}));

vi.mock("../verify-helper", () => ({
  checkEmailVerification: vi.fn(),
  checkUserVerification: vi.fn(),
}));

vi.mock("./host", () => ({
  getPublicHost: vi.fn(),
}));

vi.mock("../client", () => ({
  completeFlowOrGetUrl: vi.fn(),
}));

// Mock translations - returns the key itself for testing
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(() => (key: string) => key),
}));

describe("sendPasskey", () => {
  let mockHeaders: any;
  let mockGetServiceUrlFromHeaders: any;
  let mockGetLoginSettings: any;
  let mockGetUserByID: any;
  let mockListUsers: any;
  let mockSetSessionAndUpdateCookie: any;
  let mockCreateSessionAndUpdateCookie: any;
  let mockGetSessionCookieById: any;
  let mockGetSessionCookieByLoginName: any;
  let mockGetMostRecentSessionCookie: any;
  let mockCheckEmailVerification: any;
  let mockCompleteFlowOrGetUrl: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Import mocked modules
    const { headers } = await import("next/headers");
    const { getServiceConfig } = await import("../service-url");
    const { getLoginSettings, getUserByID, listUsers } = await import("../zitadel");
    const { setSessionAndUpdateCookie, createSessionAndUpdateCookie } = await import("./cookie");
    const { getSessionCookieById, getSessionCookieByLoginName, getMostRecentSessionCookie } = await import("../cookies");
    const { checkEmailVerification } = await import("../verify-helper");
    const { completeFlowOrGetUrl } = await import("../client");
    const { getPublicHost } = await import("./host");

    // Setup mocks
    mockHeaders = vi.mocked(headers);
    mockGetServiceUrlFromHeaders = vi.mocked(getServiceConfig);
    mockGetLoginSettings = vi.mocked(getLoginSettings);
    mockGetUserByID = vi.mocked(getUserByID);
    mockListUsers = vi.mocked(listUsers);
    mockSetSessionAndUpdateCookie = vi.mocked(setSessionAndUpdateCookie);
    mockCreateSessionAndUpdateCookie = vi.mocked(createSessionAndUpdateCookie);
    mockCreateSessionAndUpdateCookie.mockResolvedValue({
      session: { id: "new-session", factors: { user: { id: "user-1", loginName: "user" } } } as any,
      sessionCookie: { id: "new-session", token: "token", loginName: "user" },
    });
    mockGetSessionCookieById = vi.mocked(getSessionCookieById);
    mockGetSessionCookieByLoginName = vi.mocked(getSessionCookieByLoginName);
    mockGetMostRecentSessionCookie = vi.mocked(getMostRecentSessionCookie);
    mockCheckEmailVerification = vi.mocked(checkEmailVerification);
    mockCompleteFlowOrGetUrl = vi.mocked(completeFlowOrGetUrl);
    vi.mocked(getPublicHost).mockReturnValue("test.com");

    // Default mock implementations
    const headersList = new Headers();
    headersList.set("host", "test.com");
    mockHeaders.mockResolvedValue(headersList);
    mockGetServiceUrlFromHeaders.mockReturnValue({
      serviceUrl: "https://example.com",
    });
    mockGetLoginSettings.mockResolvedValue({
      multiFactorCheckLifetime: {
        seconds: BigInt(300),
        nanos: 0,
      },
    });
  });

  describe("Session Cookie Retrieval", () => {
    test("should return error when session cookie not found by sessionId", async () => {
      mockGetSessionCookieById.mockResolvedValue(null);

      const result = await sendPasskey({
        sessionId: "test-session-id",
        checks: { webAuthN: { credentialAssertionData: {} } } as any,
      });

      expect(result).toEqual({
        error: "couldNotFindSession",
      });
      expect(mockGetSessionCookieById).toHaveBeenCalledWith({
        sessionId: "test-session-id",
      });
    });

    test("should return error when session cookie is not found by loginName", async () => {
      mockGetSessionCookieByLoginName.mockResolvedValue(null); // Not found
      mockCreateSessionAndUpdateCookie.mockRejectedValue(new Error("Creation failed")); // Force creation failure

      const result = await sendPasskey({
        loginName: "test@example.com",
        organization: "org-123",
        checks: { webAuthN: { credentialAssertionData: {} } } as any,
      });

      expect(result).toEqual({
        error: "couldNotFindSession",
      });
      expect(mockGetSessionCookieByLoginName).toHaveBeenCalledWith({
        loginName: "test@example.com",
        organization: "org-123",
      });
    });

    test("should return error when no session cookie found (most recent fallback)", async () => {
      mockGetMostRecentSessionCookie.mockResolvedValue(null);

      const result = await sendPasskey({
        checks: { webAuthN: { credentialAssertionData: {} } } as any,
      });

      expect(result).toEqual({
        error: "couldNotFindSession",
      });
      expect(mockGetMostRecentSessionCookie).toHaveBeenCalled();
    });
  });

  describe("Session Update Failures", () => {
    beforeEach(() => {
      mockGetSessionCookieById.mockResolvedValue({
        id: "session-123",
        token: "session-token",
        loginName: "test@example.com",
      });
    });

    test("should return error when setSessionAndUpdateCookie fails", async () => {
      mockSetSessionAndUpdateCookie.mockResolvedValue({
        error: "Failed to update session",
      });

      const result = await sendPasskey({
        sessionId: "session-123",
        checks: { webAuthN: { credentialAssertionData: {} } } as any,
      });

      expect(result).toEqual({
        error: "couldNotUpdateSession",
      });
    });

    test("should return error when setSessionAndUpdateCookie returns undefined", async () => {
      mockSetSessionAndUpdateCookie.mockResolvedValue(undefined as any);

      const result = await sendPasskey({
        sessionId: "session-123",
        checks: { webAuthN: { credentialAssertionData: {} } } as any,
      });

      expect(result).toEqual({
        error: "couldNotUpdateSession",
      });
    });

    test("should fallback to createSessionAndUpdateCookie when setSessionAndUpdateCookie fails and checks are present", async () => {
      mockSetSessionAndUpdateCookie.mockRejectedValue(new Error("session already terminated"));

      mockCreateSessionAndUpdateCookie.mockResolvedValue({
        session: {
          id: "new-session-123",
          factors: {
            user: {
              id: "user-123",
              loginName: "test@example.com",
            },
          },
        },
        sessionCookie: {
          id: "new-session-123",
          token: "new-token",
        },
      });

      mockListUsers.mockResolvedValue({
        details: { totalResult: BigInt(1) },
        result: [{ userId: "user-123" }],
      });

      mockGetUserByID.mockResolvedValue({
        user: {
          id: "user-123",
          type: {
            case: "human",
            value: { email: { isVerified: true } },
          },
        },
      });

      mockCheckEmailVerification.mockResolvedValue(true);
      mockCompleteFlowOrGetUrl.mockResolvedValue({ redirect: "/dashboard" });

      const result = await sendPasskey({
        sessionId: "session-123",
        checks: { webAuthN: { credentialAssertionData: {} } } as any,
      });

      // It should succeed with the new session
      expect(result).toEqual({
        redirect: "/dashboard",
      });

      expect(mockCreateSessionAndUpdateCookie).toHaveBeenCalled();
    });
  });

  describe("User Validation", () => {
    beforeEach(() => {
      mockGetSessionCookieById.mockResolvedValue({
        id: "session-123",
        token: "session-token",
        loginName: "test@example.com",
      });
      mockSetSessionAndUpdateCookie.mockResolvedValue({
        sessionId: "session-123",
        sessionToken: "new-token",
        factors: {
          user: {
            id: "user-123",
          },
        },
      });
    });

    test("should return error when getUserByID fails", async () => {
      mockGetUserByID.mockRejectedValue(new Error("User not found"));

      const result = await sendPasskey({
        sessionId: "session-123",
        checks: { webAuthN: { credentialAssertionData: {} } } as any,
      });

      expect(result).toEqual({
        error: "verify.errors.couldNotGetUser",
      });
    });
  });

  describe("Successful Passkey Verification", () => {
    beforeEach(() => {
      mockGetSessionCookieById.mockResolvedValue({
        id: "session-123",
        token: "session-token",
        loginName: "test@example.com",
      });
      mockSetSessionAndUpdateCookie.mockResolvedValue({
        id: "session-123",
        factors: {
          user: {
            id: "user-123",
            loginName: "test@example.com",
          },
        },
      });
      mockGetUserByID.mockResolvedValue({
        user: {
          id: "user-123",
          type: {
            case: "human",
            value: {
              email: {
                isVerified: true,
              },
            },
          },
        },
      });
      mockCheckEmailVerification.mockResolvedValue(true);
    });

    test("should redirect on successful verification without requestId", async () => {
      mockCompleteFlowOrGetUrl.mockResolvedValue({ redirect: "/dashboard" });

      const result = await sendPasskey({
        sessionId: "session-123",
        checks: { webAuthN: { credentialAssertionData: {} } } as any,
      });

      expect(result).toEqual({
        redirect: "/dashboard",
      });
    });

    test("should redirect on successful verification with requestId", async () => {
      mockCompleteFlowOrGetUrl.mockResolvedValue({ redirect: "/auth/callback" });

      const result = await sendPasskey({
        sessionId: "session-123",
        requestId: "request-123",
        checks: { webAuthN: { credentialAssertionData: {} } } as any,
      });

      expect(result).toEqual({
        redirect: "/auth/callback",
      });
    });

    test("should redirect for email verification when required", async () => {
      mockCheckEmailVerification.mockReturnValue({ redirect: "/verify" });

      const result = await sendPasskey({
        sessionId: "session-123",
        checks: { webAuthN: { credentialAssertionData: {} } } as any,
      });

      expect(result).toHaveProperty("redirect");
      if ("redirect" in result) {
        expect(result.redirect).toContain("/verify");
      }
    });
  });

  describe("Fallback Error Handling - Critical Fix", () => {
    beforeEach(() => {
      mockGetSessionCookieById.mockResolvedValue({
        id: "session-123",
        token: "session-token",
        loginName: "test@example.com",
      });
      mockSetSessionAndUpdateCookie.mockResolvedValue({
        id: "session-123",
        factors: {
          user: {
            id: "user-123",
            loginName: "test@example.com",
          },
        },
      });
      mockGetUserByID.mockResolvedValue({
        user: {
          id: "user-123",
          type: {
            case: "human",
            value: {
              email: {
                isVerified: true,
              },
            },
          },
        },
      });
      mockCheckEmailVerification.mockResolvedValue(true);
    });

    test("should return fallback error when completeFlowOrGetUrl returns undefined", async () => {
      mockCompleteFlowOrGetUrl.mockResolvedValue(undefined);

      const result = await sendPasskey({
        sessionId: "session-123",
        checks: { webAuthN: { credentialAssertionData: {} } } as any,
      });

      expect(result).toEqual({
        error: "verify.errors.couldNotDetermineRedirect",
      });
    });

    test("should return fallback error when completeFlowOrGetUrl returns empty string", async () => {
      mockCompleteFlowOrGetUrl.mockResolvedValue("");

      const result = await sendPasskey({
        sessionId: "session-123",
        checks: { webAuthN: { credentialAssertionData: {} } } as any,
      });

      expect(result).toEqual({
        error: "verify.errors.couldNotDetermineRedirect",
      });
    });
  });

  describe("Custom Lifetime Handling", () => {
    beforeEach(() => {
      mockGetSessionCookieById.mockResolvedValue({
        id: "session-123",
        token: "session-token",
        loginName: "test@example.com",
      });
      mockSetSessionAndUpdateCookie.mockResolvedValue({
        id: "session-123",
        factors: {
          user: {
            id: "user-123",
            loginName: "test@example.com",
          },
        },
      });
      mockGetUserByID.mockResolvedValue({
        user: {
          id: "user-123",
          type: {
            case: "human",
            value: {
              email: {
                isVerified: true,
              },
            },
          },
        },
      });
      mockCheckEmailVerification.mockResolvedValue(true);
      mockCompleteFlowOrGetUrl.mockResolvedValue({ redirect: "/dashboard" });
    });

    test("should use custom lifetime when provided", async () => {
      await sendPasskey({
        sessionId: "session-123",
        lifetime: { seconds: BigInt(600), nanos: 0 } as any,
        checks: { webAuthN: { credentialAssertionData: {} } } as any,
      });

      expect(mockSetSessionAndUpdateCookie).toHaveBeenCalledWith(
        expect.objectContaining({
          lifetime: expect.objectContaining({
            seconds: BigInt(600),
          }),
        }),
      );
    });

    test("should use default lifetime from login settings when not provided", async () => {
      await sendPasskey({
        sessionId: "session-123",
        checks: { webAuthN: { credentialAssertionData: {} } } as any,
      });

      expect(mockSetSessionAndUpdateCookie).toHaveBeenCalledWith(
        expect.objectContaining({
          lifetime: expect.objectContaining({
            seconds: BigInt(300),
          }),
        }),
      );
    });
  });
});

describe("registerPasskeyLink", () => {
  let mockHeaders: any;
  let mockGetServiceConfig: any;
  let mockGetSession: any;
  let mockGetSessionCookieById: any;
  let mockCreatePasskeyRegistrationLink: any;
  let mockRegisterPasskey: any;
  let mockListAuthenticationMethodTypes: any;
  let mockGetPublicHost: any;
  let mockCheckUserVerification: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    const { headers } = await import("next/headers");
    const { getServiceConfig } = await import("../service-url");
    const { getSession, createPasskeyRegistrationLink, registerPasskey, listAuthenticationMethodTypes } =
      await import("../zitadel");
    const { getSessionCookieById } = await import("../cookies");
    const { getPublicHost } = await import("./host");
    const { checkUserVerification } = await import("../verify-helper");

    mockHeaders = vi.mocked(headers);
    mockGetServiceConfig = vi.mocked(getServiceConfig);
    mockGetSession = vi.mocked(getSession);
    mockGetSessionCookieById = vi.mocked(getSessionCookieById);
    mockCreatePasskeyRegistrationLink = vi.mocked(createPasskeyRegistrationLink);
    mockRegisterPasskey = vi.mocked(registerPasskey);
    mockListAuthenticationMethodTypes = vi.mocked(listAuthenticationMethodTypes);
    mockGetPublicHost = vi.mocked(getPublicHost);
    mockCheckUserVerification = vi.mocked(checkUserVerification);

    const headersList = new Headers();
    headersList.set("host", "test.com");
    mockHeaders.mockResolvedValue(headersList);
    mockGetServiceConfig.mockReturnValue({ serviceConfig: { baseUrl: "https://example.com" } });
    mockGetPublicHost.mockReturnValue("test.com");
  });

  test("should return error when neither sessionId nor userId is provided", async () => {
    const result = await registerPasskeyLink({});
    expect(result).toEqual({ error: "Either sessionId or userId must be provided" });
  });

  test("should return error when session cookie is not found", async () => {
    mockGetSessionCookieById.mockResolvedValue(null);

    const result = await registerPasskeyLink({ sessionId: "session-123" });
    expect(result).toEqual({ error: "Could not get session cookie" });
  });

  describe("IDP-authenticated session", () => {
    const sessionCookie = {
      id: "session-123",
      token: "session-token",
      loginName: "max@zitadel.com",
    };

    const idpSession = {
      session: {
        id: "session-123",
        factors: {
          user: { id: "user-123", loginName: "max@zitadel.com" },
          intent: {
            verifiedAt: { seconds: BigInt(1700000000), nanos: 0 },
          },
        },
      },
    };

    test("should succeed for session authenticated via IDP intent", async () => {
      mockGetSessionCookieById.mockResolvedValue(sessionCookie);
      mockGetSession.mockResolvedValue(idpSession);
      mockCreatePasskeyRegistrationLink.mockResolvedValue({
        code: { id: "code-id", code: "code-value" },
      });
      mockRegisterPasskey.mockResolvedValue({
        passkeyId: "passkey-123",
        publicKeyCredentialCreationOptions: {},
      });

      const result = await registerPasskeyLink({ sessionId: "session-123" });

      expect(result).toHaveProperty("passkeyId");
      expect(mockRegisterPasskey).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-123",
          domain: "test.com",
        }),
      );
    });

    test("should not require user verification or auth method check when IDP session is valid", async () => {
      mockGetSessionCookieById.mockResolvedValue(sessionCookie);
      mockGetSession.mockResolvedValue(idpSession);
      mockCreatePasskeyRegistrationLink.mockResolvedValue({
        code: { id: "code-id", code: "code-value" },
      });
      mockRegisterPasskey.mockResolvedValue({
        passkeyId: "passkey-123",
        publicKeyCredentialCreationOptions: {},
      });

      await registerPasskeyLink({ sessionId: "session-123" });

      // Should NOT call listAuthenticationMethodTypes or checkUserVerification
      // because the session is already valid via IDP intent
      expect(mockListAuthenticationMethodTypes).not.toHaveBeenCalled();
      expect(mockCheckUserVerification).not.toHaveBeenCalled();
    });
  });

  describe("password-authenticated session", () => {
    test("should succeed for session authenticated via password", async () => {
      mockGetSessionCookieById.mockResolvedValue({
        id: "session-123",
        token: "session-token",
        loginName: "max@zitadel.com",
      });
      mockGetSession.mockResolvedValue({
        session: {
          id: "session-123",
          factors: {
            user: { id: "user-123", loginName: "max@zitadel.com" },
            password: {
              verifiedAt: { seconds: BigInt(1700000000), nanos: 0 },
            },
          },
        },
      });
      mockCreatePasskeyRegistrationLink.mockResolvedValue({
        code: { id: "code-id", code: "code-value" },
      });
      mockRegisterPasskey.mockResolvedValue({
        passkeyId: "passkey-123",
        publicKeyCredentialCreationOptions: {},
      });

      const result = await registerPasskeyLink({ sessionId: "session-123" });

      expect(result).toHaveProperty("passkeyId");
    });
  });

  describe("session with no valid factors", () => {
    test("should return error when session has no verified factors and user has auth methods", async () => {
      mockGetSessionCookieById.mockResolvedValue({
        id: "session-123",
        token: "session-token",
        loginName: "max@zitadel.com",
      });
      mockGetSession.mockResolvedValue({
        session: {
          id: "session-123",
          factors: {
            user: { id: "user-123", loginName: "max@zitadel.com" },
            // No password, no webAuthN, no intent
          },
        },
      });
      mockListAuthenticationMethodTypes.mockResolvedValue({
        authMethodTypes: [1], // has at least one auth method
      });

      const result = await registerPasskeyLink({ sessionId: "session-123" });

      expect(result).toEqual({
        error: "You have to authenticate or have a valid User Verification Check",
      });
    });

    test("should check user verification when session has no factors and user has no auth methods", async () => {
      mockGetSessionCookieById.mockResolvedValue({
        id: "session-123",
        token: "session-token",
        loginName: "max@zitadel.com",
      });
      mockGetSession.mockResolvedValue({
        session: {
          id: "session-123",
          factors: {
            user: { id: "user-123", loginName: "max@zitadel.com" },
          },
        },
      });
      mockListAuthenticationMethodTypes.mockResolvedValue({
        authMethodTypes: [],
      });
      mockCheckUserVerification.mockResolvedValue(false);

      const result = await registerPasskeyLink({ sessionId: "session-123" });

      expect(result).toEqual({
        error: "User Verification Check has to be done",
      });
      expect(mockCheckUserVerification).toHaveBeenCalledWith("user-123");
    });

    test("should proceed when session has no factors but user verification passes", async () => {
      mockGetSessionCookieById.mockResolvedValue({
        id: "session-123",
        token: "session-token",
        loginName: "max@zitadel.com",
      });
      mockGetSession.mockResolvedValue({
        session: {
          id: "session-123",
          factors: {
            user: { id: "user-123", loginName: "max@zitadel.com" },
          },
        },
      });
      mockListAuthenticationMethodTypes.mockResolvedValue({
        authMethodTypes: [],
      });
      mockCheckUserVerification.mockResolvedValue(true);
      mockCreatePasskeyRegistrationLink.mockResolvedValue({
        code: { id: "code-id", code: "code-value" },
      });
      mockRegisterPasskey.mockResolvedValue({
        passkeyId: "passkey-123",
        publicKeyCredentialCreationOptions: {},
      });

      const result = await registerPasskeyLink({ sessionId: "session-123" });

      expect(result).toHaveProperty("passkeyId");
    });
  });
});

const sessionCookie = {
  id: "session-123",
  token: "session-token",
  loginName: "max@zitadel.com",
  creationTs: "",
  expirationTs: "",
  changeTs: "",
};

describe("verifyPasskeyRegistration", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const headersList = new Headers();
    headersList.set("host", "test.com");
    vi.mocked(headers).mockResolvedValue(headersList);
    vi.mocked(getServiceConfig).mockReturnValue({ serviceConfig: { baseUrl: "https://example.com" } });
    vi.mocked(getPublicHost).mockReturnValue("test.com");
    vi.mocked(isSessionValid).mockResolvedValue(true);
  });

  test("does not create a passkey from WebAuthn verification without user verification", async () => {
    vi.mocked(isSessionValid).mockResolvedValue(true);
    vi.mocked(getSessionCookieById).mockResolvedValue(sessionCookie);
    vi.mocked(getSession).mockResolvedValue(
      create(GetSessionResponseSchema, {
        session: create(SessionSchema, {
          id: "session-123",
          factors: create(FactorsSchema, {
            user: create(UserFactorSchema, { id: "user-123", loginName: "max@zitadel.com" }),
            webAuthN: create(WebAuthNFactorSchema, {
              verifiedAt: create(TimestampSchema, { seconds: BigInt(1700000000), nanos: 0 }),
              userVerified: false,
            }),
          }),
        }),
      }),
    );
    vi.mocked(createPasskeyRegistrationLink).mockResolvedValue(
      create(CreatePasskeyRegistrationLinkResponseSchema, {
        code: create(PasskeyRegistrationCodeSchema, { id: "code-id", code: "code-value" }),
      }),
    );

    const result = await registerPasskeyLink({ sessionId: "session-123" });

    expect(result).toHaveProperty("error");
    expect(vi.mocked(registerPasskey)).not.toHaveBeenCalled();
    expect(vi.mocked(createPasskeyRegistrationLink)).not.toHaveBeenCalled();
  });

  test("rejects final verification when the session expired after challenge creation", async () => {
    vi.mocked(getSessionCookieById).mockResolvedValue(sessionCookie);
    vi.mocked(isSessionValid).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.mocked(getSession)
      .mockResolvedValueOnce(
        create(GetSessionResponseSchema, {
          session: create(SessionSchema, {
            id: "session-123",
            factors: create(FactorsSchema, {
              user: create(UserFactorSchema, { id: "user-123", loginName: "max@zitadel.com" }),
              password: create(PasswordFactorSchema, {
                verifiedAt: create(TimestampSchema, { seconds: BigInt(1700000000), nanos: 0 }),
              }),
            }),
          }),
        }),
      )
      .mockResolvedValueOnce(
        create(GetSessionResponseSchema, {
          session: create(SessionSchema, {
            id: "session-123",
            expirationDate: create(TimestampSchema, { seconds: BigInt(1), nanos: 0 }),
            factors: create(FactorsSchema, {
              user: create(UserFactorSchema, { id: "user-123", loginName: "max@zitadel.com" }),
              password: create(PasswordFactorSchema, {
                verifiedAt: create(TimestampSchema, { seconds: BigInt(1700000000), nanos: 0 }),
              }),
            }),
          }),
        }),
      );
    vi.mocked(createPasskeyRegistrationLink).mockResolvedValue(
      create(CreatePasskeyRegistrationLinkResponseSchema, {
        code: create(PasskeyRegistrationCodeSchema, { id: "code-id", code: "code-value" }),
      }),
    );
    vi.mocked(registerPasskey).mockResolvedValue(
      create(RegisterPasskeyResponseSchema, {
        passkeyId: "passkey-123",
        publicKeyCredentialCreationOptions: {},
      }),
    );
    vi.mocked(timestampDate).mockReturnValue(new Date(0));

    await expect(registerPasskeyLink({ sessionId: "session-123" })).resolves.toHaveProperty("passkeyId");
    expect(vi.mocked(registerPasskey)).toHaveBeenCalledTimes(1);

    await expect(
      verifyPasskeyRegistration({
        sessionId: "session-123",
        passkeyId: "passkey-123",
        publicKeyCredential: {},
      }),
    ).rejects.toThrow();

    expect(vi.mocked(zitadelVerifyPasskeyRegistration)).not.toHaveBeenCalled();
  });

  test("does not finalize registration using WebAuthn verification without user verification", async () => {
    vi.mocked(isSessionValid).mockResolvedValue(true);
    vi.mocked(getSessionCookieById).mockResolvedValue(sessionCookie);
    vi.mocked(getSession).mockResolvedValue(
      create(GetSessionResponseSchema, {
        session: create(SessionSchema, {
          id: "session-123",
          factors: create(FactorsSchema, {
            user: create(UserFactorSchema, { id: "user-123", loginName: "max@zitadel.com" }),
            webAuthN: create(WebAuthNFactorSchema, {
              verifiedAt: create(TimestampSchema, { seconds: BigInt(1700000000), nanos: 0 }),
              userVerified: false,
            }),
          }),
        }),
      }),
    );

    await expect(
      verifyPasskeyRegistration({
        sessionId: "session-123",
        passkeyId: "passkey-123",
        publicKeyCredential: {},
      }),
    ).rejects.toThrow();

    expect(vi.mocked(zitadelVerifyPasskeyRegistration)).not.toHaveBeenCalled();
  });

  test("allows registration for a cookie-backed session with user-verified WebAuthn", async () => {
    vi.mocked(getSessionCookieById).mockResolvedValue(sessionCookie);
    vi.mocked(getSession).mockResolvedValue(
      create(GetSessionResponseSchema, {
        session: create(SessionSchema, {
          id: "session-123",
          factors: create(FactorsSchema, {
            user: create(UserFactorSchema, { id: "user-123", loginName: "max@zitadel.com" }),
            webAuthN: create(WebAuthNFactorSchema, {
              verifiedAt: create(TimestampSchema, { seconds: BigInt(1700000000), nanos: 0 }),
              userVerified: true,
            }),
          }),
        }),
      }),
    );
    vi.mocked(createPasskeyRegistrationLink).mockResolvedValue(
      create(CreatePasskeyRegistrationLinkResponseSchema, {
        code: create(PasskeyRegistrationCodeSchema, { id: "code-id", code: "code-value" }),
      }),
    );
    vi.mocked(registerPasskey).mockResolvedValue(
      create(RegisterPasskeyResponseSchema, {
        passkeyId: "passkey-123",
        publicKeyCredentialCreationOptions: {},
      }),
    );

    await expect(registerPasskeyLink({ sessionId: "session-123" })).resolves.toHaveProperty("passkeyId");
    expect(vi.mocked(registerPasskey)).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-123" }));
  });

  test("keeps code-based invite registration available", async () => {
    vi.mocked(getUserByID).mockResolvedValue(
      create(GetUserByIDResponseSchema, {
        user: create(UserSchema, { preferredLoginName: "max@zitadel.com" }),
      }),
    );
    vi.mocked(createSessionAndUpdateCookie).mockResolvedValue({
      session: create(SessionSchema, {
        id: "created-session",
        factors: create(FactorsSchema, {
          user: create(UserFactorSchema, { id: "user-123" }),
        }),
      }),
      sessionCookie: {
        id: "created-session",
        token: "session-token",
        loginName: "max@zitadel.com",
        creationTs: "",
        expirationTs: "",
        changeTs: "",
      },
    });
    vi.mocked(registerPasskey).mockResolvedValue(
      create(RegisterPasskeyResponseSchema, {
        passkeyId: "passkey-123",
        publicKeyCredentialCreationOptions: {},
      }),
    );

    await expect(
      registerPasskeyLink({
        userId: "user-123",
        codeId: "invite-code-id",
        code: "invite-code",
      }),
    ).resolves.toHaveProperty("passkeyId");
    expect(vi.mocked(registerPasskey)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-123",
        code: { id: "invite-code-id", code: "invite-code" },
      }),
    );
  });

  test("verifies code-invite registration through the invitee's authenticated session", async () => {
    vi.mocked(isSessionValid).mockResolvedValue(false);
    vi.mocked(listAuthenticationMethodTypes).mockResolvedValue(
      create(ListAuthenticationMethodTypesResponseSchema, { authMethodTypes: [] }),
    );
    vi.mocked(getUserByID).mockResolvedValue(
      create(GetUserByIDResponseSchema, {
        user: create(UserSchema, { preferredLoginName: "max@zitadel.com" }),
      }),
    );
    vi.mocked(getSessionCookieByLoginName).mockResolvedValue(sessionCookie);
    vi.mocked(getSession).mockResolvedValue(
      create(GetSessionResponseSchema, {
        session: create(SessionSchema, {
          id: "session-123",
          factors: create(FactorsSchema, {
            user: create(UserFactorSchema, { id: "user-123", loginName: "max@zitadel.com" }),
          }),
        }),
      }),
    );

    await expect(
      verifyPasskeyRegistration({
        userId: "user-123",
        passkeyId: "passkey-123",
        publicKeyCredential: {},
      }),
    ).resolves.toHaveProperty("loginName", "max@zitadel.com");

    expect(vi.mocked(getSessionCookieByLoginName)).toHaveBeenCalledWith({ loginName: "max@zitadel.com" });
    expect(vi.mocked(getSession)).toHaveBeenCalledWith({
      serviceConfig: { baseUrl: "https://example.com" },
      sessionId: "session-123",
      sessionToken: "session-token",
    });
    expect(vi.mocked(zitadelVerifyPasskeyRegistration)).toHaveBeenCalled();
  });

  test("rejects final verification when the fetched session ID differs from the selected cookie", async () => {
    vi.mocked(getSessionCookieById).mockResolvedValue(sessionCookie);
    vi.mocked(getSession).mockResolvedValue(
      create(GetSessionResponseSchema, {
        session: create(SessionSchema, {
          id: "different-session",
          factors: create(FactorsSchema, {
            user: create(UserFactorSchema, { id: "user-123", loginName: "max@zitadel.com" }),
            password: create(PasswordFactorSchema, {
              verifiedAt: create(TimestampSchema, { seconds: BigInt(1700000000), nanos: 0 }),
            }),
          }),
        }),
      }),
    );

    await expect(
      verifyPasskeyRegistration({
        sessionId: "session-123",
        passkeyId: "passkey-123",
        publicKeyCredential: {},
      }),
    ).rejects.toThrow();

    expect(vi.mocked(zitadelVerifyPasskeyRegistration)).not.toHaveBeenCalled();
  });
});
