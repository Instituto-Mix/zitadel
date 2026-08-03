import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_ACCESS_MAX_ATTEMPTS,
  FIRST_ACCESS_TTL_MS,
  discardFirstAccessTicket,
  firstAccessStoreSizes,
  peekFirstAccessTicket,
  storeFirstAccessTicket,
  takeFirstAccessTicket,
} from "./first-access-ticket";

const TICKET = { userId: "user123", resetCode: "IBJMUC", loginName: "eder.heisler" };

afterEach(() => {
  vi.useRealTimers();
});

describe("first-access ticket store", () => {
  it("hands back an opaque handle that does not encode the reset code", () => {
    const handle = storeFirstAccessTicket(TICKET);

    expect(handle).not.toContain(TICKET.resetCode);
    expect(handle).not.toContain(TICKET.userId);
    // base64url of 32 random bytes — nothing derived from the ticket
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(handle, "base64url").toString("utf8")).not.toContain(TICKET.resetCode);
  });

  it("gives a different handle to every flow", () => {
    expect(storeFirstAccessTicket(TICKET)).not.toBe(storeFirstAccessTicket(TICKET));
  });

  it("returns nothing for an unknown or absent handle", () => {
    expect(peekFirstAccessTicket(undefined)).toBeUndefined();
    expect(takeFirstAccessTicket("not-a-real-handle")).toBeUndefined();
  });

  it("keeps the ticket usable across rejected password attempts", () => {
    const handle = storeFirstAccessTicket(TICKET);

    expect(takeFirstAccessTicket(handle)?.resetCode).toBe("IBJMUC");
    expect(takeFirstAccessTicket(handle)?.resetCode).toBe("IBJMUC");
  });

  it("stops handing out the code once the attempt budget is spent", () => {
    const handle = storeFirstAccessTicket(TICKET);

    for (let i = 0; i < FIRST_ACCESS_MAX_ATTEMPTS; i++) {
      expect(takeFirstAccessTicket(handle)).toBeDefined();
    }

    expect(takeFirstAccessTicket(handle)).toBeUndefined();
    // and the ticket is gone, not merely refused
    expect(peekFirstAccessTicket(handle)).toBeUndefined();
  });

  /**
   * Zitadel keeps ONE outstanding reset code per user: issuing a new one kills
   * the previous ("Codigo e invalido", CODE-woT0xc). A surviving older ticket
   * would hold a dead code and silently burn the holder's attempts, so storing a
   * new ticket must replace the old one rather than sit alongside it.
   */
  it("supersedes an earlier ticket for the same user", () => {
    const first = storeFirstAccessTicket(TICKET);
    const second = storeFirstAccessTicket({ ...TICKET, resetCode: "NEWCODE" });

    expect(first).not.toBe(second);
    expect(peekFirstAccessTicket(first)).toBeUndefined();
    expect(takeFirstAccessTicket(first)).toBeUndefined();
    expect(peekFirstAccessTicket(second)?.resetCode).toBe("NEWCODE");
  });

  it("gives the superseding ticket a fresh attempt budget", () => {
    const first = storeFirstAccessTicket(TICKET);
    for (let i = 0; i < FIRST_ACCESS_MAX_ATTEMPTS; i++) {
      takeFirstAccessTicket(first);
    }

    const second = storeFirstAccessTicket({ ...TICKET, resetCode: "NEWCODE" });

    for (let i = 0; i < FIRST_ACCESS_MAX_ATTEMPTS; i++) {
      expect(takeFirstAccessTicket(second)).toBeDefined();
    }
  });

  it("leaves other users' tickets alone", () => {
    const mine = storeFirstAccessTicket(TICKET);
    const theirs = storeFirstAccessTicket({ ...TICKET, userId: "user999", resetCode: "OTHER" });

    expect(peekFirstAccessTicket(mine)?.resetCode).toBe("IBJMUC");
    expect(peekFirstAccessTicket(theirs)?.resetCode).toBe("OTHER");
  });

  /**
   * Cleaning up a dead ticket must not unindex the live one that replaced it,
   * or the next store would fail to supersede and two live tickets could exist.
   */
  it("still supersedes after the superseded handle is discarded again", () => {
    const first = storeFirstAccessTicket(TICKET);
    const second = storeFirstAccessTicket({ ...TICKET, resetCode: "SECOND" });
    discardFirstAccessTicket(first);

    const third = storeFirstAccessTicket({ ...TICKET, resetCode: "THIRD" });

    expect(peekFirstAccessTicket(second)).toBeUndefined();
    expect(peekFirstAccessTicket(third)?.resetCode).toBe("THIRD");
  });

  /**
   * The LRU bounds the tickets; the userId index has no bound of its own, so
   * whatever removes a ticket must prune it — including eviction, which no
   * explicit cleanup path can observe. Measured at 10,500 users: tickets capped
   * at 10,000 while the index kept every entry.
   */
  it("prunes the index when the LRU evicts, so it cannot outgrow the cache", () => {
    for (let i = 0; i < 10_500; i++) {
      storeFirstAccessTicket({ ...TICKET, userId: `user${i}` });
    }

    const { tickets, index } = firstAccessStoreSizes();
    expect(tickets).toBe(10_000);
    expect(index).toBe(tickets);
  });

  /**
   * Rewriting a ticket's attempt counter is a `set` on the SAME key, which also
   * fires the cache's dispose hook. Treating that as a removal would unindex a
   * live ticket and silently break supersede after the first retry.
   */
  it("still supersedes after an attempt has been spent", () => {
    const first = storeFirstAccessTicket(TICKET);
    expect(takeFirstAccessTicket(first)).toBeDefined();
    expect(firstAccessStoreSizes().index).toBeGreaterThan(0);

    const second = storeFirstAccessTicket({ ...TICKET, resetCode: "SECOND" });

    expect(peekFirstAccessTicket(first)).toBeUndefined();
    expect(peekFirstAccessTicket(second)?.resetCode).toBe("SECOND");
  });

  it("drops the ticket on discard, so a spent reset code cannot be replayed", () => {
    const handle = storeFirstAccessTicket(TICKET);
    discardFirstAccessTicket(handle);

    expect(peekFirstAccessTicket(handle)).toBeUndefined();
    expect(takeFirstAccessTicket(handle)).toBeUndefined();
  });

  it("expires the ticket, so the reset code does not outlive the flow", () => {
    // lru-cache reads performance.now() for TTLs, so that clock has to be faked too.
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const handle = storeFirstAccessTicket(TICKET);

    vi.advanceTimersByTime(FIRST_ACCESS_TTL_MS - 1000);
    expect(peekFirstAccessTicket(handle)).toBeDefined();

    vi.advanceTimersByTime(2000);
    expect(peekFirstAccessTicket(handle)).toBeUndefined();
  });

  it("does not let a retry extend the lifetime", () => {
    // lru-cache reads performance.now() for TTLs, so that clock has to be faked too.
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const handle = storeFirstAccessTicket(TICKET);

    vi.advanceTimersByTime(FIRST_ACCESS_TTL_MS - 1000);
    expect(takeFirstAccessTicket(handle)).toBeDefined();

    vi.advanceTimersByTime(2000);
    expect(peekFirstAccessTicket(handle)).toBeUndefined();
  });
});
