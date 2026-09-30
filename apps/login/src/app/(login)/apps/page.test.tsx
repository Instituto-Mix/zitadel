import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import Page from "./page";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  redirect: vi.fn(),
  loadMostRecentSession: vi.fn(),
  getServiceConfig: vi.fn(),
  getBrandingSettings: vi.fn(),
  listApplications: vi.fn(),
  listAuthorizations: vi.fn(),
  isEmailPending: vi.fn(),
  fetchSiteMeta: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));
vi.mock("@/lib/session", () => ({ loadMostRecentSession: mocks.loadMostRecentSession }));
vi.mock("@/lib/service-url", () => ({ getServiceConfig: mocks.getServiceConfig }));
vi.mock("@/lib/zitadel", () => ({
  getBrandingSettings: mocks.getBrandingSettings,
  listApplications: mocks.listApplications,
  listAuthorizations: mocks.listAuthorizations,
}));
vi.mock("@/lib/email-status", () => ({ isEmailPending: mocks.isEmailPending }));
vi.mock("@/lib/site-meta", () => ({ fetchSiteMeta: mocks.fetchSiteMeta }));
vi.mock("@/components/dynamic-theme", () => ({
  DynamicTheme: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/user-avatar", () => ({ UserAvatar: () => null }));
vi.mock("@/components/app-icon", () => ({ AppIcon: () => null }));
vi.mock("@/components/translated", () => ({
  Translated: ({ i18nKey, namespace }: { i18nKey: string; namespace?: string }) => {
    const labels: Record<string, Record<string, string>> = {
      accounts: { title: "Accounts" },
      email: { title: "Email" },
      logout: { title: "Logout" },
      apps: {
        title: "Applications",
        description: "Your applications",
        noResults: "No applications",
        setUpPasskey: "Set up passkey",
        setUpAuthenticatorOtp: "Set up authenticator (OTP)",
      },
    };
    return <span>{labels[namespace ?? ""]?.[i18nKey] ?? i18nKey}</span>;
  },
}));

const authenticatedSession = {
  factors: {
    user: {
      id: "session-user-id",
      loginName: "person-b@entrar.example",
      organizationId: "org-b",
      displayName: "Person B",
    },
  },
};

async function renderApplicationsPage(searchParams: Record<string, string | undefined> = {}) {
  const page = await Page({ searchParams: Promise.resolve(searchParams) });
  return render(page);
}

describe("Applications page credential links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(new Headers());
    mocks.redirect.mockImplementation((destination: string) => {
      throw new Error(`REDIRECT:${destination}`);
    });
    mocks.getServiceConfig.mockReturnValue({ serviceConfig: {} });
    mocks.loadMostRecentSession.mockResolvedValue(authenticatedSession);
    mocks.getBrandingSettings.mockResolvedValue(undefined);
    mocks.isEmailPending.mockResolvedValue(false);
    mocks.listAuthorizations.mockResolvedValue({ authorizations: [{ project: { id: "project-1", name: "Learning" } }] });
    mocks.listApplications.mockResolvedValue({
      applications: [
        {
          id: "app-1",
          name: "Learning Portal",
          config: { case: "oidcConfig", value: { redirectUris: ["https://learn.example/callback"] } },
        },
      ],
    });
    mocks.fetchSiteMeta.mockResolvedValue({ title: "Learning Portal", description: "Courses", favicon: undefined });
  });

  afterEach(() => {
    cleanup();
  });

  test("links to credential setup using the authenticated session's identity, not URL hints", async () => {
    await renderApplicationsPage({
      loginName: "attacker-a@entrar.example",
      organization: "org-a",
    });

    const expected = [
      { label: "Set up passkey", path: "/passkey/set" },
      { label: "Set up authenticator (OTP)", path: "/authenticator/set" },
    ];

    for (const { label, path } of expected) {
      const link = screen.getByRole("link", { name: label });
      const params = new URLSearchParams(new URL(link.getAttribute("href")!, "https://entrar.example").search);

      expect(new URL(link.getAttribute("href")!, "https://entrar.example").pathname).toBe(path);
      expect(params.get("loginName")).toBe("person-b@entrar.example");
      expect(params.get("organization")).toBe("org-b");
    }

    expect(screen.getByRole("link", { name: /Learning Portal/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Accounts" })).toHaveAttribute("href", "/accounts");
    expect(screen.getByRole("link", { name: "Email" })).toHaveAttribute("href", "/email");
    expect(screen.getByRole("link", { name: "Logout" })).toHaveAttribute("href", "/logout");
  });

  test("shows Email with credential setup actions instead of in footer navigation", async () => {
    await renderApplicationsPage();

    const accountSecurity = screen.getByRole("region", { name: "Account security" });
    expect(within(accountSecurity).getByRole("link", { name: "Email" })).toHaveAttribute("href", "/email");
    expect(within(accountSecurity).getByRole("link", { name: "Set up passkey" })).toBeInTheDocument();
    expect(within(accountSecurity).getByRole("link", { name: "Set up authenticator (OTP)" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Email" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Accounts" })).toHaveAttribute("href", "/accounts");
    expect(screen.getByRole("link", { name: "Logout" })).toHaveAttribute("href", "/logout");
  });

  test("omits credential setup links when the session lacks its canonical organization", async () => {
    mocks.loadMostRecentSession.mockResolvedValue({
      factors: { user: { ...authenticatedSession.factors.user, organizationId: undefined } },
    });

    await renderApplicationsPage({ loginName: "attacker-a@entrar.example", organization: "org-a" });

    expect(screen.queryByRole("link", { name: "Set up passkey" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Set up authenticator (OTP)" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Email" })).toHaveAttribute("href", "/email");
  });

  test("redirects to login when there is no authenticated session user", async () => {
    mocks.loadMostRecentSession.mockResolvedValue(undefined);

    await expect(renderApplicationsPage()).rejects.toThrow("REDIRECT:/loginname");
  });
});
