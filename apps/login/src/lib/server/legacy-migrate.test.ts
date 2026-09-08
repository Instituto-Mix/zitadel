import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthBackendAccessToken } from "./auth-backend-token";
import { isLegacyMigrateEnabled, legacyMigratePassword } from "./legacy-migrate";

vi.mock("./auth-backend-token", () => ({
  getAuthBackendAccessToken: vi.fn(),
}));

// Capture everything handed to the logger. winston's own Console transport
// flushes asynchronously, so inspecting the log call arguments is both the
// deterministic check and the one that matches what this module controls.
const logCalls: any[][] = [];
vi.mock("@/lib/logger", () => {
  const record =
    () =>
    (...args: any[]) => {
      logCalls.push(args);
    };
  return {
    createLogger: () => ({ debug: record(), info: record(), warn: record(), error: record() }),
  };
});

const ORIGINAL_ENV = { ...process.env };

function mockFetch(status: number, body?: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    status,
    json: async () => {
      if (body === undefined) {
        throw new Error("no body");
      }
      return body;
    },
  } as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const OK_BODY = { user_id: 1458620, reset_code: "IBJMUC" };

describe("legacyMigratePassword", () => {
  beforeEach(() => {
    process.env.AUTH_BACKEND_URL = "https://backend.example.com/v1";
    vi.mocked(getAuthBackendAccessToken).mockResolvedValue("access-token");
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("maps 200 to verified, carrying the user id and reset code", async () => {
    mockFetch(200, OK_BODY);
    await expect(legacyMigratePassword({ loginName: "a@b.com", password: "pw" })).resolves.toEqual({
      outcome: "verified",
      userId: "1458620",
      resetCode: "IBJMUC",
    });
  });

  it("treats a 200 without a reset code as unavailable — the rotation cannot be completed", async () => {
    mockFetch(200, { user_id: 1458620 });
    await expect(legacyMigratePassword({ loginName: "a@b.com", password: "pw" })).resolves.toEqual({
      outcome: "unavailable",
    });
  });

  it("treats the old 204-no-body contract as unavailable", async () => {
    mockFetch(204);
    await expect(legacyMigratePassword({ loginName: "a@b.com", password: "pw" })).resolves.toEqual({
      outcome: "unavailable",
    });
  });

  it("maps 409 to has_password", async () => {
    mockFetch(409);
    await expect(legacyMigratePassword({ loginName: "a@b.com", password: "pw" })).resolves.toEqual({
      outcome: "has_password",
    });
  });

  it("maps 403 to not_verifiable", async () => {
    mockFetch(403);
    await expect(legacyMigratePassword({ loginName: "a@b.com", password: "pw" })).resolves.toEqual({
      outcome: "not_verifiable",
    });
  });

  it("maps any unexpected status to unavailable", async () => {
    mockFetch(500);
    await expect(legacyMigratePassword({ loginName: "a@b.com", password: "pw" })).resolves.toEqual({
      outcome: "unavailable",
    });
  });

  it("returns unavailable when the backend is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(legacyMigratePassword({ loginName: "a@b.com", password: "pw" })).resolves.toEqual({
      outcome: "unavailable",
    });
  });

  it("posts to /auth/legacy-migrate with the resolver bearer token and no double slash", async () => {
    const fetchMock = mockFetch(200, OK_BODY);
    process.env.AUTH_BACKEND_URL = "https://backend.example.com/v1/";

    await legacyMigratePassword({ loginName: "user@example.com", password: "secret" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://backend.example.com/v1/auth/legacy-migrate");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer access-token");
    expect(init.headers["x-zitadel-service-account"]).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ login_name: "user@example.com", password: "secret" });
  });

  it("does not call the backend when it is not configured", async () => {
    const fetchMock = mockFetch(200, OK_BODY);
    delete process.env.AUTH_BACKEND_URL;
    await expect(legacyMigratePassword({ loginName: "a@b.com", password: "pw" })).resolves.toEqual({
      outcome: "unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call the backend when the resolver token is unavailable", async () => {
    const fetchMock = mockFetch(200, OK_BODY);
    vi.mocked(getAuthBackendAccessToken).mockResolvedValue(undefined);
    await expect(legacyMigratePassword({ loginName: "a@b.com", password: "pw" })).resolves.toEqual({
      outcome: "unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call the backend without a password", async () => {
    const fetchMock = mockFetch(200, OK_BODY);
    await expect(legacyMigratePassword({ loginName: "a@b.com", password: "" })).resolves.toEqual({
      outcome: "unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("resolver access token handling", () => {
  const TOKEN = "access-token";

  beforeEach(() => {
    process.env.AUTH_BACKEND_URL = "https://backend.example.com/v1";
    vi.mocked(getAuthBackendAccessToken).mockResolvedValue(TOKEN);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ["an unreachable backend", () => vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")))],
    ["an unexpected status", () => mockFetch(500)],
    ["a successful verification", () => mockFetch(200, OK_BODY)],
  ])("never logs the token or credentials on %s", async (_case, arrange) => {
    logCalls.length = 0;
    arrange();

    const outcome = await legacyMigratePassword({ loginName: "testuser", password: "erp-password" });

    expect(logCalls.length).toBeGreaterThan(0);
    const logged = JSON.stringify(logCalls);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("erp-password");
    expect(logged).not.toContain("testuser");
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  it("sends the token only in the Authorization header", async () => {
    const fetchMock = mockFetch(200, OK_BODY);

    await legacyMigratePassword({ loginName: "testuser", password: "erp-password" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers["x-zitadel-service-account"]).toBeUndefined();
    expect(url).not.toContain(TOKEN);
    expect(init.body).not.toContain(TOKEN);
  });
});

describe("isLegacyMigrateEnabled", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("requires the backend URL and resolver client configuration", () => {
    process.env.AUTH_BACKEND_URL = "https://backend.example.com/v1";
    delete process.env.AUTH_BACKEND_CLIENT_SECRET;
    expect(isLegacyMigrateEnabled()).toBe(false);

    process.env.AUTH_BACKEND_CLIENT_SECRET = "resolver-secret";
    process.env.AUTH_BACKEND_CLIENT_ID = "resolver-client";
    process.env.AUTH_BACKEND_AUDIENCE = "urn:zitadel:iam:org:project:id:123:aud";
    expect(isLegacyMigrateEnabled()).toBe(true);
  });
});
