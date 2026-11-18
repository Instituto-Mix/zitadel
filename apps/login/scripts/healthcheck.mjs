import { getFips } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.ZITADEL_FIPS_REQUIRED === "true" && getFips() !== 1) {
  console.error("Healthcheck failed: FIPS mode required but not enabled");
  process.exit(1);
}

const scheme = process.env.ZITADEL_TLS_ENABLED === "true" ? "https" : "http";
const port = process.env.PORT || "3000";
const url = new URL(process.argv[2] || `/ui/v2/login/healthy`, `${scheme}://localhost:${port}`);
const startup = process.argv.includes("--startup");
const startupMarker = join(tmpdir(), `zitadel-login-startup-ready-${port}`);
const signal = AbortSignal.timeout(5_000);

const get = scheme === "https" ? https.get : http.get;

function probe(target, readBody = false) {
  const result = Promise.withResolvers();
  // Safe: localhost-only probe, self-signed certs expected.
  get(target, { rejectUnauthorized: false, signal }, (response) => {
    let body = "";
    if (readBody) {
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
    } else {
      response.resume();
    }
    response.on("error", result.reject);
    response.on("end", () => result.resolve({ response, body }));
  }).on("error", result.reject);
  return result.promise;
}

try {
  if (startup && existsSync(startupMarker)) {
    const { response } = await probe(new URL("./healthy", url));
    process.exit(response.statusCode === 200 ? 0 : 1);
  }

  const { response } = await probe(url);
  if (!startup) {
    process.exit(response.statusCode >= 200 && response.statusCode < 400 ? 0 : 1);
  }
  if (response.statusCode !== 200) {
    throw new Error("Startup readiness check failed");
  }

  const { response: loginResponse, body } = await probe(new URL("./loginname", url), true);
  // Read the complete stream: Next can return HTTP 200 before an RSC failure.
  // Accept both local authentication and IdP-only policies without submitting either form.
  const hasLoginForm = /<form\b[^>]*>[\s\S]*?<input\b[^>]*\bname=["'](?:loginName|provider)["'][^>]*>[\s\S]*?<\/form>/i.test(
    body,
  );
  const hasRenderError = /<!--\$!-->|<template\b[^>]*\bdata-dgst=|\$RX\(|__next_error__/i.test(body);
  if (
    loginResponse.statusCode !== 200 ||
    !loginResponse.headers["content-type"]?.startsWith("text/html") ||
    !/<\/html\s*>/i.test(body) ||
    !hasLoginForm ||
    hasRenderError
  ) {
    throw new Error("Startup login page did not complete server rendering");
  }

  writeFileSync(startupMarker, "", { mode: 0o600 });
  process.exit(0);
} catch (e) {
  console.error("Healthcheck failed:", e);
  process.exit(1);
}
