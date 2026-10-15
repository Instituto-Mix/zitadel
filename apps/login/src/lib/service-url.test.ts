import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { constructUrl, getServiceConfig } from "./service-url";

describe("Service URL utilities", () => {
  beforeEach(() => {
    vi.stubEnv("ZITADEL_PUBLIC_HOST", undefined);
    vi.stubEnv("ZITADEL_API_URL", undefined);
    vi.stubEnv("ZITADEL_INSTANCE_HOST", undefined);
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("getServiceConfig", () => {
    test("should throw when ZITADEL_API_URL is not set", () => {
      vi.stubEnv("ZITADEL_API_URL", undefined);

      const mockHeaders = {
        get: vi.fn(() => null),
      } as any;

      expect(() => getServiceConfig(mockHeaders)).toThrow("ZITADEL_API_URL is not set");
    });

    // Track B / standalone deploy: instanceHost is derived from ZITADEL_API_URL
    // (the instance's own domain), NOT the browser Host, and publicHost is omitted
    // so Zitadel skips its trusted-domain check. See getServiceConfig comments.
    test("derives instanceHost from ZITADEL_API_URL and omits publicHost", () => {
      vi.stubEnv("ZITADEL_API_URL", "https://id.institutomix.com.br");

      const mockHeaders = {
        get: vi.fn((key: string) => {
          // Browser host differs from the instance domain; it must be ignored.
          if (key === "x-zitadel-forward-host") return "entrar.institutomix.com.br";
          if (key === "host") return "entrar.institutomix.com.br";
          return null;
        }),
      } as any;

      const result = getServiceConfig(mockHeaders);

      expect(result.serviceConfig.baseUrl).toBe("https://id.institutomix.com.br");
      expect(result.serviceConfig.instanceHost).toBe("id.institutomix.com.br");
      expect(result.serviceConfig.publicHost).toBeUndefined();
    });

    test("strips protocol and any trailing path/slash from ZITADEL_API_URL", () => {
      vi.stubEnv("ZITADEL_API_URL", "https://api.zitadel.cloud/");

      const mockHeaders = { get: vi.fn(() => null) } as any;

      const result = getServiceConfig(mockHeaders);

      expect(result.serviceConfig.instanceHost).toBe("api.zitadel.cloud");
    });

    test("does not depend on the request Host header", () => {
      vi.stubEnv("ZITADEL_API_URL", "https://api.zitadel.cloud");

      // No host headers at all — must still resolve the instance from the API URL.
      const mockHeaders = { get: vi.fn(() => null) } as any;

      const result = getServiceConfig(mockHeaders);

      expect(result.serviceConfig.instanceHost).toBe("api.zitadel.cloud");
    });

    test("ZITADEL_INSTANCE_HOST overrides the instance host (parent domain for WebAuthn RP ID)", () => {
      vi.stubEnv("ZITADEL_API_URL", "https://id.institutomix.com.br");
      vi.stubEnv("ZITADEL_INSTANCE_HOST", "institutomix.com.br");

      const mockHeaders = { get: vi.fn(() => null) } as any;

      const result = getServiceConfig(mockHeaders);

      expect(result.serviceConfig.baseUrl).toBe("https://id.institutomix.com.br");
      expect(result.serviceConfig.instanceHost).toBe("institutomix.com.br");
    });

    test("keeps a port present in ZITADEL_API_URL", () => {
      vi.stubEnv("ZITADEL_API_URL", "http://localhost:8080");

      const mockHeaders = { get: vi.fn(() => null) } as any;

      const result = getServiceConfig(mockHeaders);

      expect(result.serviceConfig.instanceHost).toBe("localhost:8080");
    });
  });

  describe("constructUrl", () => {
    test("should construct a trusted redirect with a pinned host and base path despite poisoned headers", () => {
      vi.stubEnv("ZITADEL_PUBLIC_HOST", "entrar.institutomix.com.br");
      vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/ui/v2/login");
      const mockRequest = new NextRequest("https://host.attacker.example/ui/v2/login", {
        headers: {
          "x-zitadel-public-host": "public.attacker.example",
          "x-zitadel-forward-host": "forward.attacker.example",
          "x-forwarded-host": "proxy.attacker.example",
          host: "host.attacker.example",
        },
      });

      const result = constructUrl(mockRequest, "/password?requestId=request123");

      expect(result.href).toBe("https://entrar.institutomix.com.br/ui/v2/login/password?requestId=request123");
    });

    test("should construct URL with x-zitadel-forward-host when present", () => {
      vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
      const mockRequest = {
        headers: {
          get: vi.fn((key: string) => {
            if (key === "x-zitadel-forward-host") return "customer.zitadel.cloud";
            if (key === "host") return "customer.zitadel.cloud";
            return null;
          }),
        },
        nextUrl: {
          protocol: "https:",
        },
      } as any;

      const result = constructUrl(mockRequest as NextRequest, "/test");

      expect(result.hostname).toBe("customer.zitadel.cloud");
      expect(result.pathname).toBe("/test");
      expect(result.protocol).toBe("https:");
    });

    test("should fall back to x-forwarded-host when x-zitadel-forward-host is not present", () => {
      vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
      const mockRequest = {
        headers: {
          get: vi.fn((key: string) => {
            if (key === "x-zitadel-forward-host") return null;
            if (key === "x-forwarded-host") return "mycompany.com";
            return null;
          }),
        },
        nextUrl: {
          protocol: "https:",
        },
      } as any;

      const result = constructUrl(mockRequest as NextRequest, "/oauth/authorize");

      expect(result.hostname).toBe("mycompany.com");
      expect(result.pathname).toBe("/oauth/authorize");
    });

    test("should fall back to host header when no forwarded headers present", () => {
      const mockRequest = {
        headers: {
          get: vi.fn((key: string) => {
            if (key === "x-zitadel-forward-host") return null;
            if (key === "x-forwarded-host") return null;
            if (key === "host") return "localhost:3000";
            return null;
          }),
        },
        nextUrl: {
          protocol: "http:",
        },
      } as any;

      const result = constructUrl(mockRequest as NextRequest, "/test");

      expect(result.hostname).toBe("localhost");
      expect(result.port).toBe("3000");
    });

    test("should use protocol from nextUrl.protocol (not from headers)", () => {
      const mockRequest = {
        headers: {
          get: vi.fn((key: string) => {
            // Even if x-forwarded-proto is present, it should be ignored
            if (key === "x-forwarded-proto") return "http";
            if (key === "host") return "example.com";
            return null;
          }),
        },
        nextUrl: {
          protocol: "https:", // This should be used
        },
      } as any;

      const result = constructUrl(mockRequest as NextRequest, "/test");

      // Should use https: from nextUrl.protocol, not http from header
      expect(result.protocol).toBe("https:");
    });

    test("should include base path when NEXT_PUBLIC_BASE_PATH is set", () => {
      vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/login");

      const mockRequest = {
        headers: {
          get: vi.fn((key: string) => {
            if (key === "host") return "example.com";
            return null;
          }),
        },
        nextUrl: {
          protocol: "https:",
        },
      } as any;

      const result = constructUrl(mockRequest as NextRequest, "/test");

      expect(result.pathname).toBe("/login/test");
    });
  });
});
