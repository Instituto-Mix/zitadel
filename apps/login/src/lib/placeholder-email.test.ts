import { describe, expect, it } from "vitest";
import { isPlaceholderEmail, usableEmail } from "./placeholder-email";

describe("isPlaceholderEmail", () => {
  it("matches the provisioning placeholder", () => {
    expect(isPlaceholderEmail("email@invalido.troque")).toBe(true);
  });

  // The whole point of matching on the domain: the local part is free to change.
  it("matches any local part on the placeholder domain", () => {
    expect(isPlaceholderEmail("sem-email@invalido.troque")).toBe(true);
    expect(isPlaceholderEmail("p12345@invalido.troque")).toBe(true);
  });

  it("is case- and whitespace-insensitive on the domain", () => {
    expect(isPlaceholderEmail("Email@INVALIDO.Troque")).toBe(true);
    expect(isPlaceholderEmail("email@invalido.troque ")).toBe(true);
  });

  it("does not match real addresses", () => {
    expect(isPlaceholderEmail("eder@institutomix.com.br")).toBe(false);
    expect(isPlaceholderEmail("user@example.com")).toBe(false);
  });

  // Guard against a substring match that would swallow real addresses.
  it("does not match lookalike domains", () => {
    expect(isPlaceholderEmail("user@invalido.troque.com.br")).toBe(false);
    expect(isPlaceholderEmail("user@notinvalido.troque")).toBe(false);
    expect(isPlaceholderEmail("invalido.troque@example.com")).toBe(false);
  });

  it("handles missing and malformed values", () => {
    expect(isPlaceholderEmail(undefined)).toBe(false);
    expect(isPlaceholderEmail("")).toBe(false);
    expect(isPlaceholderEmail("not-an-email")).toBe(false);
  });
});

describe("usableEmail", () => {
  it("passes real addresses through", () => {
    expect(usableEmail("eder@institutomix.com.br")).toBe("eder@institutomix.com.br");
  });

  it("treats the placeholder as no email on file", () => {
    expect(usableEmail("email@invalido.troque")).toBeUndefined();
  });

  it("treats a missing address as no email on file", () => {
    expect(usableEmail(undefined)).toBeUndefined();
    expect(usableEmail("")).toBeUndefined();
  });
});
