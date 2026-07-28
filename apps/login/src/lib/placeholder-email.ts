/**
 * Placeholder email addresses (Track B).
 *
 * Provisioning has to put *something* in the email field, so users with no usable
 * address in the ERP all share one placeholder. It is undeliverable by
 * construction — `.troque` is not a real TLD — so it must never be shown as an
 * address, nor used as a target for a verification code: rendering it reads as a
 * bug, and offering to send a code there silently does nothing.
 *
 * We match on the DOMAIN, not the full address, so this keeps working if the
 * local part ever changes.
 */
const PLACEHOLDER_EMAIL_DOMAIN = "invalido.troque";

/** True when the address is the undeliverable provisioning placeholder. */
export function isPlaceholderEmail(email: string | undefined): boolean {
  if (!email) {
    return false;
  }
  const at = email.lastIndexOf("@");
  if (at < 0) {
    return false;
  }
  return email.slice(at + 1).trim().toLowerCase() === PLACEHOLDER_EMAIL_DOMAIN;
}

/**
 * The address to treat as being on file: undefined for a missing address OR the
 * placeholder. Callers can then handle both as one "no email on file" case, which
 * is what the UI must read as ("add your email", not "verify this one").
 */
export function usableEmail(email: string | undefined): string | undefined {
  if (!email || isPlaceholderEmail(email)) {
    return undefined;
  }
  return email;
}
