import { describe, expect, it } from "vitest";
import { maskEmail } from "./mask-email";

describe("maskEmail", () => {
  it("shows a recognizable prefix and the registered domain", () => {
    expect(maskEmail("jefferson@gmail.com")).toBe("jef*****@gmail.com");
  });

  it("caps the prefix and does not disclose the remaining local-part length", () => {
    expect(maskEmail("averylongregisteredaddress@example.com")).toBe("ave*****@example.com");
  });

  it.each([
    ["a@example.com", "*****@example.com"],
    ["ab@example.com", "a*****@example.com"],
    ["abc@example.com", "a*****@example.com"],
    ["abcd@example.com", "ab*****@example.com"],
    ["abcde@example.com", "ab*****@example.com"],
    ["abcdef@example.com", "abc*****@example.com"],
  ])("never reveals more than half of a short local part: %s", (email, masked) => {
    expect(maskEmail(email)).toBe(masked);
  });

  it.each([
    ["éab@example.com", "é*****@example.com"],
    ["e\u0301ab@example.com", "e\u0301*****@example.com"],
    ["e\u0301@example.com", "*****@example.com"],
  ])("counts whole graphemes without normalizing the address: %s", (email, masked) => {
    expect(maskEmail(email)).toBe(masked);
  });

  it("keeps supported punctuation, tags, subdomains and domain case", () => {
    expect(maskEmail("a.b+tag@Mail.Example.COM")).toBe("a.b*****@Mail.Example.COM");
  });

  it("supports an internationalized domain in its ASCII representation", () => {
    expect(maskEmail("jose@xn--bcher-kva.example")).toBe("jo*****@xn--bcher-kva.example");
  });

  it.each(["email@invalido.troque", "other@INVALIDO.Troque", "email@invalido.troque "])(
    "never displays a provisioning placeholder: %s",
    (email) => {
      expect(maskEmail(email)).toBeUndefined();
    },
  );

  it("does not mistake a longer domain for the placeholder domain", () => {
    expect(maskEmail("email@invalido.troque.com.br")).toBe("em*****@invalido.troque.com.br");
  });

  it.each([
    undefined,
    "",
    "not-an-email",
    "@example.com",
    "local@",
    "local@@example.com",
    " local@example.com",
    "local@example.com ",
    "lo cal@example.com",
    "local@exam ple.com",
    "local\n@example.com",
    "local\u0000@example.com",
    "local\u202e@example.com",
    '"local"@example.com',
    "Name <local@example.com>",
    "local(comment)@example.com",
    ".local@example.com",
    "local.@example.com",
    "lo..cal@example.com",
    "local@localhost",
    "local@.example.com",
    "local@example..com",
    "local@-example.com",
    "local@example-.com",
    "local@[127.0.0.1]",
    "local@example.com/path",
    "local@bücher.example",
    "😀abc@example.com",
  ])("omits missing or ambiguous display addresses: %s", (email) => {
    expect(maskEmail(email)).toBeUndefined();
  });
});
