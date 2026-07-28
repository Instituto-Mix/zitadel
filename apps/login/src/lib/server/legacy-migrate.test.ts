import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLegacyMigrateEnabled, legacyMigratePassword } from "./legacy-migrate";

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

function mockFetch(status: number) {
  const fetchMock = vi.fn().mockResolvedValue({ status } as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("legacyMigratePassword", () => {
  beforeEach(() => {
    process.env.AUTH_BACKEND_URL = "https://backend.example.com/v1";
    process.env.AUTH_BACKEND_TOKEN = "token-123";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("maps 204 to migrated", async () => {
    mockFetch(204);
    await expect(legacyMigratePassword({ loginName: "a@b.com", password: "pw" })).resolves.toBe("migrated");
  });

  it("maps 409 to has_password", async () => {
    mockFetch(409);
    await expect(legacyMigratePassword({ loginName: "a@b.com", password: "pw" })).resolves.toBe("has_password");
  });

  it("maps 403 to not_verifiable", async () => {
    mockFetch(403);
    await expect(legacyMigratePassword({ loginName: "a@b.com", password: "pw" })).resolves.toBe("not_verifiable");
  });

  it("maps any unexpected status to unavailable", async () => {
    mockFetch(500);
    await expect(legacyMigratePassword({ loginName: "a@b.com", password: "pw" })).resolves.toBe("unavailable");
  });

  it("returns unavailable when the backend is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(legacyMigratePassword({ loginName: "a@b.com", password: "pw" })).resolves.toBe("unavailable");
  });

  it("posts to /auth/legacy-migrate with the service-account header and no double slash", async () => {
    const fetchMock = mockFetch(204);
    process.env.AUTH_BACKEND_URL = "https://backend.example.com/v1/";

    await legacyMigratePassword({ loginName: "user@example.com", password: "secret" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://backend.example.com/v1/auth/legacy-migrate");
    expect(init.method).toBe("POST");
    expect(init.headers["x-zitadel-service-account"]).toBe("token-123");
    expect(JSON.parse(init.body)).toEqual({ login_name: "user@example.com", password: "secret" });
  });

  it("does not call the backend when it is not configured", async () => {
    const fetchMock = mockFetch(204);
    delete process.env.AUTH_BACKEND_URL;
    await expect(legacyMigratePassword({ loginName: "a@b.com", password: "pw" })).resolves.toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call the backend when the token is missing", async () => {
    const fetchMock = mockFetch(204);
    delete process.env.AUTH_BACKEND_TOKEN;
    await expect(legacyMigratePassword({ loginName: "a@b.com", password: "pw" })).resolves.toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call the backend without a password", async () => {
    const fetchMock = mockFetch(204);
    await expect(legacyMigratePassword({ loginName: "a@b.com", password: "" })).resolves.toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("service account token handling", () => {
  const SECRET = "super-secret-login-page-pat";

  beforeEach(() => {
    process.env.AUTH_BACKEND_URL = "https://backend.example.com/v1";
    process.env.AUTH_BACKEND_TOKEN = SECRET;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // The token is a bearer secret: it may travel in the request header and nowhere
  // else — not into logs, not into a returned value a caller might render.
  it.each([
    ["an unreachable backend", () => vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")))],
    ["an unexpected status", () => mockFetch(500)],
    ["a successful migration", () => mockFetch(204)],
  ])("never logs the token or credentials on %s", async (_case, arrange) => {
    logCalls.length = 0;
    arrange();

    const outcome = await legacyMigratePassword({ loginName: "testuser", password: "erp-password" });

    // sanity: this module really did log here, so the assertions below have teeth
    expect(logCalls.length).toBeGreaterThan(0);

    const logged = JSON.stringify(logCalls);
    expect(logged).not.toContain(SECRET);
    // the typed password and identifier must not be logged either
    expect(logged).not.toContain("erp-password");
    expect(logged).not.toContain("testuser");
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it("sends the token only in the x-zitadel-service-account header", async () => {
    const fetchMock = mockFetch(204);

    await legacyMigratePassword({ loginName: "testuser", password: "erp-password" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(init.headers["x-zitadel-service-account"]).toBe(SECRET);
    expect(url).not.toContain(SECRET);
    expect(init.body).not.toContain(SECRET);
    // not duplicated into a standard auth header
    expect(init.headers.Authorization).toBeUndefined();
  });
});

describe("isLegacyMigrateEnabled", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("requires both the url and the token", () => {
    process.env.AUTH_BACKEND_URL = "https://backend.example.com/v1";
    delete process.env.AUTH_BACKEND_TOKEN;
    expect(isLegacyMigrateEnabled()).toBe(false);

    process.env.AUTH_BACKEND_TOKEN = "token-123";
    expect(isLegacyMigrateEnabled()).toBe(true);
  });
});
