import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectCredentialType, type ResolveResponse, substituteLoginName } from "./legacy-identifier";

// Reload per test to isolate the server-side token cache.
async function resolveLegacyIdentifier(typedValue: string) {
  const module = await import("./legacy-identifier");
  return module.resolveLegacyIdentifier(typedValue);
}

describe("detectCredentialType", () => {
  it("treats exactly 11 digits as a tax number", () => {
    expect(detectCredentialType("12345678901")).toBe("tax_id");
  });

  it("trims surrounding whitespace before the digit check", () => {
    expect(detectCredentialType("  12345678901  ")).toBe("tax_id");
  });

  it("treats 10 or 12 digits as a username", () => {
    expect(detectCredentialType("1234567890")).toBe("username");
    expect(detectCredentialType("123456789012")).toBe("username");
  });

  it("treats alphanumeric legacy usernames as a username", () => {
    expect(detectCredentialType("A0000")).toBe("username");
  });
});

describe("substituteLoginName", () => {
  const hit: ResolveResponse = {
    user_id: 1458620,
    login_name: "canonical@example.com",
    active: true,
  };

  it("substitutes the canonical login_name on an active hit", () => {
    expect(substituteLoginName("12345678901", hit)).toBe("canonical@example.com");
  });

  it("passes the typed value through on a miss (null)", () => {
    expect(substituteLoginName("12345678901", null)).toBe("12345678901");
  });

  it("substitutes on a hit regardless of active (backend 403s for inactive)", () => {
    expect(substituteLoginName("A0000", { ...hit, active: false })).toBe("canonical@example.com");
  });

  it("passes through when login_name is missing", () => {
    expect(substituteLoginName("A0000", { ...hit, login_name: "" })).toBe("A0000");
  });
});

describe("resolveLegacyIdentifier", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    process.env.AUTH_BACKEND_URL = "https://backend.example.com/";
    process.env.ZITADEL_API_URL = "https://id.example.com/";
    process.env.AUTH_BACKEND_CLIENT_ID = "resolver-client";
    process.env.AUTH_BACKEND_CLIENT_SECRET = "resolver-secret";
    process.env.AUTH_BACKEND_AUDIENCE = "urn:zitadel:iam:org:project:id:123:aud";
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.restoreAllMocks();
  });

  it("returns null when AUTH_BACKEND_URL is not set", async () => {
    delete process.env.AUTH_BACKEND_URL;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await resolveLegacyIdentifier("A0000")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null when resolver client configuration is absent", async () => {
    delete process.env.AUTH_BACKEND_CLIENT_SECRET;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await resolveLegacyIdentifier("A0000")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts the detected credential_type and returns the mapping on a hit", async () => {
    const body: ResolveResponse = {
      user_id: 1458620,
      login_name: "canonical@example.com",
      active: true,
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));

    const result = await resolveLegacyIdentifier("12345678901");

    expect(result).toEqual(body);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, init] = fetchSpy.mock.calls[1];
    // AUTH_BACKEND_URL already includes /v1; trailing slash is normalized.
    expect(url).toBe("https://backend.example.com/auth/resolve");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer access-token",
      "ngrok-skip-browser-warning": "1",
    });
    expect(init?.headers).not.toHaveProperty("x-zitadel-service-account");
    expect(JSON.parse(init?.body as string)).toEqual({
      credential_type: "tax_id",
      value: "12345678901",
    });
  });

  it("skips the resolver for email inputs (never calls fetch)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await resolveLegacyIdentifier("eder@heisler.com.br")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null on a 403 miss", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect(await resolveLegacyIdentifier("A0000")).toBeNull();
  });

  it("returns null (fail-open) when the resolver request throws", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockRejectedValueOnce(new Error("network down"));
    expect(await resolveLegacyIdentifier("A0000")).toBeNull();
  });
});
