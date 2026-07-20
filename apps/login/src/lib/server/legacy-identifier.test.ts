import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectCredentialType,
  resolveLegacyIdentifier,
  ResolveResponse,
  substituteLoginName,
} from "./legacy-identifier";

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

  it("passes through when the resolved user is inactive", () => {
    expect(substituteLoginName("A0000", { ...hit, active: false })).toBe("A0000");
  });

  it("passes through when login_name is missing", () => {
    expect(
      substituteLoginName("A0000", { ...hit, login_name: "" }),
    ).toBe("A0000");
  });
});

describe("resolveLegacyIdentifier", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    process.env.AUTH_BACKEND_URL = "https://backend.example.com/";
    process.env.AUTH_BACKEND_TOKEN = "secret-token";
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

  it("returns null when AUTH_BACKEND_TOKEN is not set", async () => {
    delete process.env.AUTH_BACKEND_TOKEN;
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
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    );

    const result = await resolveLegacyIdentifier("12345678901");

    expect(result).toEqual(body);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    // trailing slash on the base URL is normalized
    expect(url).toBe("https://backend.example.com/v1/auth/resolve");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer secret-token",
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      credential_type: "tax_id",
      value: "12345678901",
    });
  });

  it("returns null on a 403 miss", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 403 }));
    expect(await resolveLegacyIdentifier("A0000")).toBeNull();
  });

  it("returns null (fail-open) when fetch throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(await resolveLegacyIdentifier("A0000")).toBeNull();
  });
});
