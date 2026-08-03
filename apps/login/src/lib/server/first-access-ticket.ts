// Holds bearer-grade reset codes. `server-only` makes an accidental import from
// a client component a build error rather than a leak.
import "server-only";

import { LRUCache } from "lru-cache";
import { randomBytes } from "node:crypto";

/**
 * Short-lived, server-side hand-off between the two halves of first access.
 *
 * The legacy bridge returns a password-reset code that authorizes setting that
 * user's password. The user then has to be shown a form and come back in a
 * second request, so something must carry the code across that gap. It must not
 * be the browser: the code is bearer-grade, so it never leaves the server, not
 * even encrypted in a cookie. The browser only ever holds an opaque handle
 * (`first_access` cookie) that means nothing outside this process.
 *
 * Deliberately in-memory and TTL-bounded — the code must not outlive the flow,
 * and nothing about it may be persisted. Consequences worth knowing:
 *   - a restart of the login app drops in-flight tickets; the user retypes their
 *     ERP password and gets a fresh code. Cheap, and the right failure mode.
 *   - with more than one login-app replica and no sticky sessions, the second
 *     request can land on an instance that never saw the ticket, which reads to
 *     the user as an expired flow. Run the login app single-instance, or with
 *     session affinity, while first access is enabled.
 */
export type FirstAccessTicket = {
  /** Zitadel user id the reset code belongs to. */
  userId: string;
  /** Bearer-grade, single-use. Never log, never serialize towards the client. */
  resetCode: string;
  loginName: string;
  organization?: string;
  requestId?: string;
  /** Password attempts made against this ticket; see takeFirstAccessTicket. */
  attempts: number;
};

/** Cookie holding the opaque handle. Value is meaningless outside this process. */
export const FIRST_ACCESS_COOKIE_NAME = "first_access";

/**
 * Deliberately short: the backend's reset code has its own TTL and the flow is
 * "choose a password on the next screen", not "come back tomorrow".
 */
export const FIRST_ACCESS_TTL_MS = 10 * 60 * 1000;

/**
 * Bounded retries. Zitadel rejects a password that fails the complexity policy
 * without spending the reset code, and the whole point of this screen is to let
 * the user try again — but the ticket must not become an unbounded oracle.
 */
export const FIRST_ACCESS_MAX_ATTEMPTS = 5;

/**
 * The LRU bounds memory; expiry is enforced by the explicit `expiresAt` below
 * rather than by lru-cache's own TTL, so that the deadline is set once at issue
 * time and no later read can move it.
 */
/**
 * Three variants of the same hazard have already been fixed here; the next
 * change to this module will probably be a fourth, so they are named:
 *   1. two live tickets for one user — the older holds a code Zitadel already
 *      invalidated, and its holder burns attempts on something unsatisfiable;
 *   2. cleanup order — unindexing on behalf of an OLD handle silently removes
 *      the NEWER ticket that replaced it;
 *   3. dispose reason — treating an update as a removal, below.
 * All three are invisible to a reader who only checks "is the index pruned?".
 * The question is always *which* handle the index points at, and *why* the
 * entry is going away.
 */
const tickets = new LRUCache<string, FirstAccessTicket & { expiresAt: number }>({
  max: 10_000,
  // The index must be pruned by whatever removes a ticket, including LRU
  // eviction, which no explicit cleanup path can observe. Without this the index
  // outlives the cache and grows without bound.
  dispose: (ticket, handle, reason) => {
    // `set` means this key is being rewritten with a new value (the attempt
    // counter), not removed — the index still legitimately points at it.
    if (reason === "set") {
      return;
    }
    // Same guarded comparison as forget(): only clear the index if it still
    // points at THIS handle, so removing a superseded ticket cannot unindex the
    // newer one that replaced it.
    if (handleByUser.get(ticket.userId) === handle) {
      handleByUser.delete(ticket.userId);
    }
  },
});

/**
 * userId → the one live handle for that user. Zitadel keeps a single outstanding
 * password-reset code per user: issuing a new one INVALIDATES the previous
 * ("Codigo e invalido", CODE-woT0xc). So a second first-access attempt while an
 * earlier ticket is still alive leaves that earlier ticket holding a code that
 * can never succeed — and its holder would burn attempts on it, seeing a "wrong
 * code" failure rather than "superseded".
 *
 * Keeping this index means at most one ticket per user exists by construction:
 * storing a new one drops the old, which also resets the attempt budget.
 */
const handleByUser = new Map<string, string>();

/** Remove a ticket; the cache's dispose hook prunes the index for us. */
function forget(handle: string): void {
  tickets.delete(handle);
}

/**
 * Diagnostics for tests: the two structures must stay in step, since an index
 * entry that outlives its ticket is a leak and a missing one breaks supersede.
 */
export function firstAccessStoreSizes(): { tickets: number; index: number } {
  return { tickets: tickets.size, index: handleByUser.size };
}

function readTicket(handle: string | undefined): (FirstAccessTicket & { expiresAt: number }) | undefined {
  if (!handle) {
    return undefined;
  }
  const ticket = tickets.get(handle);
  if (!ticket) {
    return undefined;
  }
  if (ticket.expiresAt <= Date.now()) {
    forget(handle);
    return undefined;
  }
  return ticket;
}

/**
 * Store a ticket and return the opaque handle to put in the cookie. Any earlier
 * ticket for the same user is dropped: its reset code was just invalidated by
 * the one being stored.
 */
export function storeFirstAccessTicket(ticket: Omit<FirstAccessTicket, "attempts">): string {
  const superseded = handleByUser.get(ticket.userId);
  if (superseded) {
    tickets.delete(superseded);
  }

  const handle = randomBytes(32).toString("base64url");
  tickets.set(handle, { ...ticket, attempts: 0, expiresAt: Date.now() + FIRST_ACCESS_TTL_MS });
  handleByUser.set(ticket.userId, handle);
  return handle;
}

/** Read a ticket without spending it — for rendering the form. */
export function peekFirstAccessTicket(handle: string | undefined): FirstAccessTicket | undefined {
  return readTicket(handle);
}

/**
 * Read a ticket for one password attempt. The ticket survives a rejected
 * password so the user can fix it and retry, but only up to
 * FIRST_ACCESS_MAX_ATTEMPTS; the caller must discard it once the password is
 * actually set.
 */
export function takeFirstAccessTicket(handle: string | undefined): FirstAccessTicket | undefined {
  const ticket = readTicket(handle);
  if (!ticket) {
    return undefined;
  }

  const attempts = ticket.attempts + 1;
  if (attempts > FIRST_ACCESS_MAX_ATTEMPTS) {
    forget(handle!);
    return undefined;
  }

  // expiresAt is carried over untouched: retrying never extends the deadline.
  tickets.set(handle!, { ...ticket, attempts });
  return { ...ticket, attempts };
}

/** Drop a ticket, e.g. when the user abandons or restarts the flow. */
export function discardFirstAccessTicket(handle: string | undefined): void {
  if (handle) {
    forget(handle);
  }
}
