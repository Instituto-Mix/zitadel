import { AuthenticationMethodType } from "@zitadel/proto/zitadel/user/v2/user_service_pb";
import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getSessionCookieById } from "../cookies";
import { getLoginSettings, getSession, listAuthenticationMethodTypes, listPasskeys, removePasskey } from "../zitadel";
import { listManagedPasskeys, removeManagedPasskey } from "./passkey-management";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("../cookies", () => ({
  getSessionCookieById: vi.fn(),
}));

vi.mock("../zitadel", () => ({
  getSession: vi.fn(),
  getLoginSettings: vi.fn(),
  listAuthenticationMethodTypes: vi.fn(),
  listPasskeys: vi.fn(),
  removePasskey: vi.fn(),
}));

const sessionId = "session-123";
const sessionUserId = "signed-in-user";
const sessionToken = "session-cookie-token";
const sessionCookie = { id: sessionId, token: sessionToken };
const verifiedAt = { seconds: BigInt(1), nanos: 0 };

type PasskeyFixture = { id: string; name: string; state: number };

const firstPasskey: PasskeyFixture = { id: "passkey-1", name: "Work laptop", state: 2 };
const secondPasskey: PasskeyFixture = { id: "passkey-2", name: "Phone", state: 2 };
const foreignPasskey: PasskeyFixture = { id: "passkey-from-another-account", name: "Other key", state: 2 };

type SessionResponseFixture = {
  session: {
    id: string;
    expirationDate?: { seconds: bigint; nanos: number };
    factors: {
      user: { id: string };
      password?: { verifiedAt: { seconds: bigint; nanos: number } };
      totp?: { verifiedAt: { seconds: bigint; nanos: number } };
      webAuthN?: { verifiedAt: { seconds: bigint; nanos: number }; userVerified: boolean };
    };
  };
};

function sessionResponse({
  expirationDate,
  verified = true,
  verifiedFactor = "password",
  userVerified = true,
  totpVerified = false,
}: {
  expirationDate?: { seconds: bigint; nanos: number };
  verified?: boolean;
  verifiedFactor?: "password" | "passkey";
  userVerified?: boolean;
  totpVerified?: boolean;
} = {}): SessionResponseFixture {
  return {
    session: {
      id: sessionId,
      ...(expirationDate && { expirationDate }),
      factors: {
        user: { id: sessionUserId },
        ...(verified && verifiedFactor === "password" && { password: { verifiedAt } }),
        ...(verified && totpVerified && { totp: { verifiedAt } }),
        ...(verified && verifiedFactor === "passkey" && { webAuthN: { verifiedAt, userVerified } }),
      },
    },
  };
}

function setSessionResponse(response: SessionResponseFixture = sessionResponse()) {
  vi.mocked(getSession).mockImplementation(async ({ sessionId: requestedSessionId, sessionToken: requestedToken }) => {
    if (requestedSessionId !== sessionId || requestedToken !== sessionToken) {
      throw new Error("Session does not match the selected cookie");
    }
    return response as never;
  });
}

function installPasskeyStore(initial: Record<string, PasskeyFixture[]>) {
  const store = new Map<string, PasskeyFixture[]>(
    Object.entries(initial).map(([userId, passkeys]) => [userId, [...passkeys]] as const),
  );

  vi.mocked(listPasskeys).mockImplementation(
    async ({ userId }) =>
      ({
        result: [...(store.get(userId) ?? [])],
      }) as never,
  );
  vi.mocked(removePasskey).mockImplementation(async ({ userId, passkeyId }) => {
    const passkeys = store.get(userId) ?? [];
    store.set(
      userId,
      passkeys.filter((passkey) => passkey.id !== passkeyId),
    );
    return {} as never;
  });

  return store;
}

describe("managed passkey actions", () => {
  let originalApiUrl: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalApiUrl = process.env.ZITADEL_API_URL;
    process.env.ZITADEL_API_URL = "https://api.example.test";

    vi.mocked(headers).mockResolvedValue(new Headers());
    vi.mocked(getLoginSettings).mockResolvedValue({} as never);
    vi.mocked(getSessionCookieById).mockImplementation(async ({ sessionId: requestedSessionId }) =>
      requestedSessionId === sessionId ? (sessionCookie as never) : undefined,
    );
    setSessionResponse();
    vi.mocked(listAuthenticationMethodTypes).mockResolvedValue({
      authMethodTypes: [AuthenticationMethodType.PASSWORD, AuthenticationMethodType.PASSKEY],
    } as never);
    vi.mocked(listPasskeys).mockResolvedValue({ result: [] } as never);
    vi.mocked(removePasskey).mockResolvedValue({} as never);
  });

  afterEach(() => {
    if (originalApiUrl === undefined) {
      Reflect.deleteProperty(process.env, "ZITADEL_API_URL");
    } else {
      process.env.ZITADEL_API_URL = originalApiUrl;
    }
  });

  test.each([
    ["missing", undefined],
    ["expired", sessionResponse({ expirationDate: { seconds: BigInt(1), nanos: 0 } })],
    ["unverified", sessionResponse({ verified: false })],
  ])("does not list or remove passkeys for a %s session", async (sessionState, response) => {
    if (sessionState === "missing") {
      vi.mocked(getSessionCookieById).mockResolvedValue(undefined);
    } else {
      setSessionResponse(response as SessionResponseFixture);
    }

    const listResult = await listManagedPasskeys(sessionId);
    const removeResult = await removeManagedPasskey(sessionId, firstPasskey.id);

    expect(listResult).toMatchObject({ error: expect.any(String) });
    expect(removeResult).toMatchObject({ error: expect.any(String) });
    expect(listPasskeys).not.toHaveBeenCalled();
    expect(removePasskey).not.toHaveBeenCalled();
  });

  test("rejects passkey management when WebAuthn is recent but not user-verified", async () => {
    const store = installPasskeyStore({ [sessionUserId]: [firstPasskey] });
    setSessionResponse(sessionResponse({ verifiedFactor: "passkey", userVerified: false }));

    const listResult = await listManagedPasskeys(sessionId);
    const removeResult = await removeManagedPasskey(sessionId, firstPasskey.id);

    expect(listResult).toMatchObject({ error: expect.any(String) });
    expect(removeResult).toMatchObject({ error: expect.any(String) });
    expect(store.get(sessionUserId)).toEqual([firstPasskey]);
    expect(removePasskey).not.toHaveBeenCalled();
  });

  test("lists only the signed-in account's passkeys", async () => {
    installPasskeyStore({
      [sessionUserId]: [firstPasskey],
      "another-user": [foreignPasskey],
    });

    const result = await listManagedPasskeys(sessionId);

    expect(result).toEqual({ passkeys: [firstPasskey] });
  });

  test("returns an empty passkey list for an account with no passkeys", async () => {
    installPasskeyStore({ [sessionUserId]: [] });

    const result = await listManagedPasskeys(sessionId);

    expect(result).toEqual({ passkeys: [] });
  });

  test("refuses to remove a passkey that does not belong to the signed-in account", async () => {
    const store = installPasskeyStore({
      [sessionUserId]: [firstPasskey],
      "another-user": [foreignPasskey],
    });

    const result = await removeManagedPasskey(sessionId, foreignPasskey.id);
    const remaining = await listManagedPasskeys(sessionId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(remaining).toEqual({ passkeys: [firstPasskey] });
    expect(store.get("another-user")).toEqual([foreignPasskey]);
    expect(removePasskey).not.toHaveBeenCalled();
  });

  test("refuses to remove the only passkey when it is the only usable sign-in method", async () => {
    installPasskeyStore({ [sessionUserId]: [firstPasskey] });
    setSessionResponse(sessionResponse({ verifiedFactor: "passkey" }));
    vi.mocked(listAuthenticationMethodTypes).mockResolvedValue({
      authMethodTypes: [AuthenticationMethodType.PASSKEY],
    } as never);

    const result = await removeManagedPasskey(sessionId, firstPasskey.id);
    const remaining = await listManagedPasskeys(sessionId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(remaining).toEqual({ passkeys: [firstPasskey] });
    expect(removePasskey).not.toHaveBeenCalled();
  });

  test("rejects passkey removal from a password-only session when configured TOTP is required", async () => {
    const store = installPasskeyStore({ [sessionUserId]: [firstPasskey] });
    setSessionResponse(sessionResponse({ verifiedFactor: "password" }));
    vi.mocked(listAuthenticationMethodTypes).mockResolvedValue({
      authMethodTypes: [AuthenticationMethodType.PASSWORD, AuthenticationMethodType.TOTP, AuthenticationMethodType.PASSKEY],
    } as never);

    const result = await removeManagedPasskey(sessionId, firstPasskey.id);
    const remaining = await listManagedPasskeys(sessionId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(remaining).toMatchObject({ error: expect.any(String) });
    expect(store.get(sessionUserId)).toEqual([firstPasskey]);
    expect(removePasskey).not.toHaveBeenCalled();
  });

  test("removes a passkey after the selected session verifies both password and configured TOTP", async () => {
    const store = installPasskeyStore({ [sessionUserId]: [firstPasskey] });
    setSessionResponse(sessionResponse({ verifiedFactor: "password", totpVerified: true }));
    vi.mocked(listAuthenticationMethodTypes).mockResolvedValue({
      authMethodTypes: [AuthenticationMethodType.PASSWORD, AuthenticationMethodType.TOTP, AuthenticationMethodType.PASSKEY],
    } as never);

    const result = await removeManagedPasskey(sessionId, firstPasskey.id);

    expect(result).toEqual({ success: true });
    expect(store.get(sessionUserId)).toEqual([]);
    expect(removePasskey).toHaveBeenCalledTimes(1);
  });

  test("removes the selected passkey when password remains available", async () => {
    installPasskeyStore({ [sessionUserId]: [firstPasskey] });
    vi.mocked(listAuthenticationMethodTypes).mockResolvedValue({
      authMethodTypes: [AuthenticationMethodType.PASSWORD, AuthenticationMethodType.PASSKEY],
    } as never);

    const result = await removeManagedPasskey(sessionId, firstPasskey.id);
    const remaining = await listManagedPasskeys(sessionId);

    expect(result).toEqual({ success: true });
    expect(remaining).toEqual({ passkeys: [] });
  });

  test("releases the removal lock after a passkey API failure", async () => {
    const store = installPasskeyStore({ [sessionUserId]: [firstPasskey] });
    vi.mocked(listAuthenticationMethodTypes).mockResolvedValue({
      authMethodTypes: [AuthenticationMethodType.PASSWORD, AuthenticationMethodType.PASSKEY],
    } as never);
    vi.mocked(removePasskey).mockRejectedValueOnce(new Error("Temporary API failure"));

    const failed = await removeManagedPasskey(sessionId, firstPasskey.id);
    const retried = await removeManagedPasskey(sessionId, firstPasskey.id);

    expect(failed).toMatchObject({ error: expect.any(String) });
    expect(retried).toEqual({ success: true });
    expect(store.get(sessionUserId)).toEqual([]);
  });

  test("removes the selected passkey when another passkey remains", async () => {
    installPasskeyStore({ [sessionUserId]: [firstPasskey, secondPasskey] });
    setSessionResponse(sessionResponse({ verifiedFactor: "passkey" }));
    vi.mocked(listAuthenticationMethodTypes).mockResolvedValue({
      authMethodTypes: [AuthenticationMethodType.PASSKEY],
    } as never);

    const result = await removeManagedPasskey(sessionId, firstPasskey.id);
    const remaining = await listManagedPasskeys(sessionId);

    expect(result).toEqual({ success: true });
    expect(remaining).toEqual({ passkeys: [secondPasskey] });
  });

  test("concurrent removals preserve one passkey when no independent sign-in method remains", async () => {
    const store = installPasskeyStore({ [sessionUserId]: [firstPasskey, secondPasskey] });
    setSessionResponse(sessionResponse({ verifiedFactor: "passkey" }));
    vi.mocked(listAuthenticationMethodTypes).mockResolvedValue({
      authMethodTypes: [AuthenticationMethodType.PASSKEY],
    } as never);

    const results = await Promise.all([
      removeManagedPasskey(sessionId, firstPasskey.id),
      removeManagedPasskey(sessionId, secondPasskey.id),
    ]);

    expect(results.filter((result) => "success" in result)).toHaveLength(1);
    expect(store.get(sessionUserId)).toHaveLength(1);
  });
});
