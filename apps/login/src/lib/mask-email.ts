import "server-only";

import { usableEmail } from "./placeholder-email";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const localPartCharacters = /^[\p{L}\p{N}\p{M}.!#$%&'*+/=?^_`{|}~-]+$/u;
const domainName = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Server-side display policy, not RFC mailbox validation: omit missing and
 * provisioning-placeholder addresses, whitespace/control/format characters,
 * quoted or otherwise ambiguous local parts, and non-DNS-style domains.
 * The supported subset is a Unicode letter/number/mark dot-atom local part
 * (plus ASCII mailbox punctuation) and an ASCII, dotted domain (including
 * punycode). Unsupported addresses use the caller's generic confirmation.
 *
 * Preserve the domain and reveal min(3, floor(local grapheme count / 2)) leading
 * graphemes, followed by exactly five asterisks. Never normalize the address,
 * split a grapheme, reveal the whole local part, or expose its exact length.
 */
export function maskEmail(email: string | undefined): string | undefined {
  const address = usableEmail(email);
  if (!address || /[\s\p{C}]/u.test(address)) {
    return undefined;
  }

  const at = address.indexOf("@");
  if (at <= 0) {
    return undefined;
  }

  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (
    !localPartCharacters.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !domainName.test(domain)
  ) {
    return undefined;
  }

  // Six graphemes suffice to select the prefix; do not collect a long address.
  const graphemes: string[] = [];
  for (const { segment } of segmenter.segment(local)) {
    graphemes.push(segment);
    if (graphemes.length === 6) {
      break;
    }
  }

  const prefix = graphemes.slice(0, Math.floor(graphemes.length / 2)).join("");
  return `${prefix}*****@${domain}`;
}
