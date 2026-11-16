import type { WithServiceConfig } from "@/lib/server/zitadel";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import en from "../../../../locales/en.json";
import Page from "./page";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  router: { push: vi.fn(), back: vi.fn() },
  setTheme: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));
vi.mock("next-themes", () => ({ useTheme: () => ({ setTheme: mocks.setTheme }) }));
vi.mock("@/lib/actions/loginname", () => ({ sendLoginname: vi.fn() }));
vi.mock("@/lib/actions/idp", () => ({ redirectToIdp: vi.fn() }));
vi.mock("@/lib/server/zitadel", () => {
  function requireStandaloneRouting({ serviceConfig }: WithServiceConfig) {
    if (
      serviceConfig.baseUrl !== "https://id.example" ||
      serviceConfig.instanceHost !== "id.example" ||
      "publicHost" in serviceConfig
    ) {
      throw new Error("InstanceNotFound: backend rejected instance/public host routing");
    }
  }

  return {
    getDefaultOrg: async (request: WithServiceConfig) => {
      requireStandaloneRouting(request);
      return { id: "default-org" };
    },
    getLoginSettings: async (request: WithServiceConfig) => {
      requireStandaloneRouting(request);
      return { allowLocalAuthentication: true, allowExternalIdp: false, allowRegister: false };
    },
    getActiveIdentityProviders: async (request: WithServiceConfig) => {
      requireStandaloneRouting(request);
      return { identityProviders: [] };
    },
    getBrandingSettings: async (request: WithServiceConfig) => {
      requireStandaloneRouting(request);
      return { hideLoginNameSuffix: false };
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ZITADEL_API_URL", "https://id.example");
  vi.stubEnv("ZITADEL_INSTANCE_HOST", undefined);
  vi.stubEnv("ZITADEL_PUBLIC_HOST", "entrar.example");
  vi.stubEnv("NEXT_PUBLIC_THEME_ROUNDNESS", undefined);
  vi.stubEnv("NEXT_PUBLIC_THEME_LAYOUT", undefined);
  vi.stubEnv("NEXT_PUBLIC_THEME_APPEARANCE", undefined);
  vi.stubEnv("NEXT_PUBLIC_THEME_SPACING", undefined);
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  );
  mocks.headers.mockResolvedValue(
    new Headers({
      host: "entrar.example",
      "x-forwarded-host": "entrar.example",
      "x-zitadel-forward-host": "entrar.example",
      "x-zitadel-instance-host": "entrar.example",
      "x-zitadel-public-host": "entrar.example",
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("standalone loginname page", () => {
  test("shows the real login name field when the UI and API use separate hosts", async () => {
    // Await the page's data loading; this is not a full React Server Component render.
    const page = await Page({ searchParams: Promise.resolve({}) });
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        {page}
      </NextIntlClientProvider>,
    );

    const loginName = screen.getByRole("textbox", { name: en.loginname.labels.loginname });
    expect(loginName).toBeVisible();
    expect(loginName).toHaveAttribute("autocomplete", "username");
    expect(screen.getByRole("button", { name: en.loginname.submit })).toBeDisabled();
  });
});
