import { describe, expect, it } from "vitest";
import { DiscoverableApp, deriveLaunchUrl, toDiscoveredApps } from "./apps-discovery";

const oidc = (redirectUris: string[], name = "App"): DiscoverableApp => ({
  id: "1",
  name,
  kind: "oidc",
  redirectUris,
});

describe("deriveLaunchUrl", () => {
  it("derives the origin from the first https redirect URI", () => {
    expect(deriveLaunchUrl(oidc(["https://lms.example.com/api/auth/callback"]))).toBe("https://lms.example.com");
  });

  it("skips localhost/dev redirect URIs and uses the first real one", () => {
    expect(
      deriveLaunchUrl(oidc(["http://localhost:3000/cb", "https://127.0.0.1/cb", "https://portal.example.com/cb"])),
    ).toBe("https://portal.example.com");
  });

  it("returns null when only dev/localhost URIs exist", () => {
    expect(deriveLaunchUrl(oidc(["http://localhost:4321/cb"]))).toBeNull();
  });

  it("returns null for API (machine) apps", () => {
    expect(deriveLaunchUrl({ id: "1", name: "m2m", kind: "api", redirectUris: [] })).toBeNull();
  });

  it("ignores malformed URIs", () => {
    expect(deriveLaunchUrl(oidc(["not a url", "https://ok.example.com/cb"]))).toBe("https://ok.example.com");
  });

  it("skips custom-scheme (native) redirect URIs", () => {
    expect(deriveLaunchUrl(oidc(["com.example.app://callback"]))).toBeNull();
  });
});

describe("toDiscoveredApps", () => {
  it("drops non-launchable apps and keeps launchable ones", () => {
    const apps: DiscoverableApp[] = [
      oidc(["https://lms.example.com/cb"], "LMS Web"),
      { id: "2", name: "backend", kind: "api", redirectUris: [] },
      oidc(["http://localhost:3000/cb"], "dev-only"),
    ];
    const result = toDiscoveredApps(apps);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: "LMS Web", url: "https://lms.example.com" });
  });
});
