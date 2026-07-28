import { beforeEach, describe, expect, it, vi } from "vitest";
import { isEmailPending } from "./email-status";

vi.mock("@/lib/zitadel", () => ({
  getUserByID: vi.fn(),
}));

const serviceConfig = { baseUrl: "https://api.example.com" } as any;

function humanWithEmail(email: string | undefined, isVerified: boolean) {
  return { user: { type: { case: "human", value: { email: email ? { email, isVerified } : undefined } } } };
}

describe("isEmailPending", () => {
  let mockGetUserByID: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { getUserByID } = await import("@/lib/zitadel");
    mockGetUserByID = vi.mocked(getUserByID);
  });

  it("is false for a verified real address", async () => {
    mockGetUserByID.mockResolvedValue(humanWithEmail("user@example.com", true));
    await expect(isEmailPending(serviceConfig, "user123")).resolves.toBe(false);
  });

  it("is true for an unverified real address", async () => {
    mockGetUserByID.mockResolvedValue(humanWithEmail("user@example.com", false));
    await expect(isEmailPending(serviceConfig, "user123")).resolves.toBe(true);
  });

  // These users need to ADD an address — the badge is what drives them there,
  // and it is their only route to a password recovery channel.
  it("is true for the undeliverable placeholder, even if marked verified", async () => {
    mockGetUserByID.mockResolvedValue(humanWithEmail("email@invalido.troque", true));
    await expect(isEmailPending(serviceConfig, "user123")).resolves.toBe(true);
  });

  it("is true when no address is on file", async () => {
    mockGetUserByID.mockResolvedValue(humanWithEmail(undefined, false));
    await expect(isEmailPending(serviceConfig, "user123")).resolves.toBe(true);
  });

  it("is false without a userId and never calls the API", async () => {
    await expect(isEmailPending(serviceConfig, undefined)).resolves.toBe(false);
    expect(mockGetUserByID).not.toHaveBeenCalled();
  });

  it("fails soft when the lookup errors", async () => {
    mockGetUserByID.mockRejectedValue(new Error("boom"));
    await expect(isEmailPending(serviceConfig, "user123")).resolves.toBe(false);
  });
});
