import { constructUrl, getServiceConfig } from "@/lib/server/service-url";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("Service URL utilities", () => {
  beforeEach(() => {
    vi.stubEnv("ZITADEL_API_URL", undefined);
    vi.stubEnv("ZITADEL_INSTANCE_HOST", undefined);
    vi.stubEnv("ZITADEL_PUBLIC_HOST", undefined);
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("getServiceConfig", () => {
    test("requires ZITADEL_API_URL even when an instance override is configured", () => {
      vi.stubEnv("ZITADEL_INSTANCE_HOST", "tenant.example");

      expect(() => getServiceConfig(new Headers())).toThrow("ZITADEL_API_URL is not set");
    });

    test.each([
      {
        name: "the API host",
        headers: new Headers({ host: "id.example" }),
      },
      {
        name: "a separate login UI host",
        headers: new Headers({ host: "entrar.example", "x-forwarded-host": "entrar.example" }),
      },
      {
        name: "untrusted instance and public routing headers",
        headers: new Headers({
          host: "untrusted.example",
          "x-zitadel-instance-host": "untrusted-instance.example",
          "x-zitadel-public-host": "untrusted-public.example",
          "x-zitadel-forward-host": "untrusted-forward.example",
          "x-forwarded-host": "untrusted-proxy.example",
        }),
      },
    ])("pins API routing independently of $name", ({ headers }) => {
      vi.stubEnv("ZITADEL_API_URL", "https://id.example");

      expect(getServiceConfig(headers)).toEqual({
        serviceConfig: {
          baseUrl: "https://id.example",
          instanceHost: "id.example",
        },
      });
    });

    test("uses ZITADEL_INSTANCE_HOST ahead of the API URL and request headers", () => {
      vi.stubEnv("ZITADEL_API_URL", "https://api.example");
      vi.stubEnv("ZITADEL_INSTANCE_HOST", "tenant.example");
      const headers = new Headers({
        host: "entrar.example",
        "x-zitadel-instance-host": "untrusted.example",
        "x-zitadel-forward-host": "untrusted.example",
      });

      expect(getServiceConfig(headers)).toEqual({
        serviceConfig: {
          baseUrl: "https://api.example",
          instanceHost: "tenant.example",
        },
      });
    });

    test.each([
      {
        apiUrl: "https://id.example:8443/api/v2",
        instanceHost: undefined,
        expectedHost: "id.example:8443",
      },
      {
        apiUrl: "http://id.example:8080/api/v2",
        instanceHost: undefined,
        expectedHost: "id.example:8080",
      },
      {
        apiUrl: "https://api.example",
        instanceHost: "https://tenant.example:9443/instance/path",
        expectedHost: "tenant.example:9443",
      },
      {
        apiUrl: "https://api.example",
        instanceHost: "http://tenant.example:9000/instance/path",
        expectedHost: "tenant.example:9000",
      },
      {
        apiUrl: "https://api.example",
        instanceHost: "tenant.example:9443/instance/path",
        expectedHost: "tenant.example:9443",
      },
      {
        apiUrl: "https://id.example:8443/api/v2",
        instanceHost: "",
        expectedHost: "id.example:8443",
      },
    ])("normalizes $apiUrl with override '$instanceHost' without losing the port", ({ apiUrl, instanceHost, expectedHost }) => {
      vi.stubEnv("ZITADEL_API_URL", apiUrl);
      vi.stubEnv("ZITADEL_INSTANCE_HOST", instanceHost);

      expect(getServiceConfig(new Headers())).toEqual({
        serviceConfig: {
          baseUrl: apiUrl,
          instanceHost: expectedHost,
        },
      });
    });

    test("does not forward the public login host to the API", () => {
      vi.stubEnv("ZITADEL_API_URL", "https://id.example");
      vi.stubEnv("ZITADEL_PUBLIC_HOST", "entrar.example");
      const headers = new Headers({
        host: "entrar.example",
        "x-zitadel-public-host": "untrusted.example",
      });

      expect(getServiceConfig(headers)).toStrictEqual({
        serviceConfig: {
          baseUrl: "https://id.example",
          instanceHost: "id.example",
        },
      });
    });

    test("does not require request host headers in a standalone deployment", () => {
      vi.stubEnv("ZITADEL_API_URL", "https://id.example");

      expect(getServiceConfig(new Headers())).toEqual({
        serviceConfig: {
          baseUrl: "https://id.example",
          instanceHost: "id.example",
        },
      });
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
