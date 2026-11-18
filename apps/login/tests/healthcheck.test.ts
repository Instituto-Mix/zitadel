// @vitest-environment node

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const healthcheckScript = fileURLToPath(new URL("../scripts/healthcheck.mjs", import.meta.url));
const serverScript = fileURLToPath(new URL("../scripts/server.mjs", import.meta.url));
const loginForm = '<html><body><form><input name="loginName" data-testid="username-text-input"></form></body></html>';
const idpForm = '<html><body><form><input type="hidden" name="provider" value="oidc"><button>Sign in</button></form></body></html>';

describe("container startup healthcheck", () => {
  let server: Server;
  let port: number;
  let temporaryDirectory: string;
  let basePath: string;
  let readyStatus: number;
  let healthyStatus: number;
  let loginStatus: number;
  let loginBody: string;
  let loginContentType: string;
  let paths: string[];

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "login-healthcheck-"));
    basePath = "";
    readyStatus = 200;
    healthyStatus = 200;
    loginStatus = 200;
    loginBody = loginForm;
    loginContentType = "text/html";
    paths = [];
    server = createServer((request, response) => {
      paths.push(request.url ?? "");
      if (request.url === `${basePath}/ready`) {
        response.writeHead(readyStatus, { "Content-Type": "text/plain" });
        response.end(readyStatus === 200 ? "OK" : "Service unavailable");
      } else if (request.url === `${basePath}/healthy`) {
        response.writeHead(healthyStatus, { "Content-Type": "application/json" });
        response.end("{}");
      } else if (request.url === `${basePath}/loginname`) {
        response.writeHead(loginStatus, { "Content-Type": loginContentType });
        response.end(loginBody);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(0, "localhost", listening.resolve);
    await listening.promise;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
    port = address.port;
  });

  afterEach(async () => {
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  function runNode(script: string, args: string[] = [], environment: NodeJS.ProcessEnv = {}) {
    const result = Promise.withResolvers<{ exitCode: number; stderr: string }>();
    execFile(
      process.execPath,
      [script, ...args],
      {
        env: {
          PORT: String(port),
          TMPDIR: temporaryDirectory,
          ZITADEL_TLS_ENABLED: "false",
          ZITADEL_FIPS_REQUIRED: "false",
          ...environment,
        },
        timeout: 8_000,
      },
      (error, _stdout, stderr) => {
        if (!error) return result.resolve({ exitCode: 0, stderr });
        if (typeof error.code === "number") return result.resolve({ exitCode: error.code, stderr });
        result.reject(error);
      },
    );
    return result.promise;
  }

  function startupProbe() {
    return runNode(healthcheckScript, [`${basePath}/ready`, "--startup"]);
  }

  test.each([
    { status: 500, body: "<html><body>Internal Server Error</body></html>", description: "HTTP 500" },
    { status: 200, body: "<html><body>Internal Server Error</body></html>", description: "HTTP 200 error page" },
    { status: 200, body: `${loginForm}<template data-dgst="123"></template>`, description: "concealed RSC error" },
    { status: 200, body: `${loginForm}<script>$RX("B:0","123")</script>`, description: "streamed RSC error" },
    { status: 200, body: "<html><body></body></html>", description: "empty login page" },
    { status: 302, body: loginForm, description: "redirect instead of login" },
  ])("rejects a backend-ready candidate with $description", async ({ status, body }) => {
    loginStatus = status;
    loginBody = body;

    expect((await startupProbe()).exitCode).toBe(1);
  });

  test("rejects non-HTML data containing login form text", async () => {
    loginContentType = "application/json";
    loginBody = JSON.stringify({ html: loginForm });

    expect((await startupProbe()).exitCode).toBe(1);
  });

  test("rejects backend or signing readiness failure without treating liveness as readiness", async () => {
    readyStatus = 503;

    expect((await startupProbe()).exitCode).toBe(1);
    expect((await runNode(healthcheckScript, ["/healthy"])).exitCode).toBe(0);
    expect(paths).not.toContain("/loginname");
  });

  test.each([
    { prefix: "", body: loginForm, description: "root-path local login" },
    { prefix: "/ui/v2/login", body: loginForm, description: "base-path local login" },
    { prefix: "", body: idpForm, description: "IdP-only login" },
  ])("accepts complete server-rendered $description", async ({ prefix, body }) => {
    basePath = prefix;
    loginBody = body;

    expect((await startupProbe()).exitCode).toBe(0);
    expect(paths).toEqual([`${prefix}/ready`, `${prefix}/loginname`]);
  });

  test("uses only local liveness after successful startup, even during a later backend outage", async () => {
    expect((await startupProbe()).exitCode).toBe(0);
    paths = [];
    readyStatus = 503;
    loginStatus = 500;

    expect((await startupProbe()).exitCode).toBe(0);
    expect(paths).toEqual(["/healthy"]);

    healthyStatus = 503;
    expect((await startupProbe()).exitCode).toBe(1);
  });

  test("clears a prior success before every standalone server startup, including a failed start", async () => {
    expect((await startupProbe()).exitCode).toBe(0);

    const restarted = await runNode(serverScript, [], { ZITADEL_TLS_ENABLED: "true" });
    expect(restarted.exitCode).toBe(1);
    expect(restarted.stderr).toContain("ZITADEL_TLS_CERTPATH or ZITADEL_TLS_KEYPATH are missing");
    loginStatus = 500;

    expect((await startupProbe()).exitCode).toBe(1);
  });
});
