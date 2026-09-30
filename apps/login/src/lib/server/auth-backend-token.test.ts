import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OLD_ENV = { ...process.env };

async function loadTokenProvider() {
  return import("./auth-backend-token");
}

describe("getAuthBackendAccessToken", () => {
  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      ZITADEL_API_URL: "https://id.example.com/",
      AUTH_BACKEND_CLIENT_ID: "resolver-client",
      AUTH_BACKEND_CLIENT_SECRET: "resolver-secret",
      AUTH_BACKEND_AUDIENCE: "urn:zitadel:iam:org:project:id:123:aud",
    };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.restoreAllMocks();
  });

  it("exchanges the dedicated resolver client credentials for an API-audience token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), {
        status: 200,
      }),
    );
    const { getAuthBackendAccessToken } = await loadTokenProvider();

    await expect(getAuthBackendAccessToken()).resolves.toBe("access-token");

    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(
      "https://id.example.com/oauth/v2/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from("resolver-client:resolver-secret").toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        }),
        body: "grant_type=client_credentials&scope=openid+urn%3Azitadel%3Aiam%3Aorg%3Aproject%3Aid%3A123%3Aaud",
      }),
    );
  });

  it("reuses an unexpired token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), {
        status: 200,
      }),
    );
    const { getAuthBackendAccessToken } = await loadTokenProvider();

    await expect(getAuthBackendAccessToken()).resolves.toBe("access-token");
    await expect(getAuthBackendAccessToken()).resolves.toBe("access-token");

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("fails closed when required client configuration is absent", async () => {
    delete process.env.AUTH_BACKEND_CLIENT_SECRET;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { getAuthBackendAccessToken } = await loadTokenProvider();

    await expect(getAuthBackendAccessToken()).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
