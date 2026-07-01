/**
 * escrow.test.ts — covers app/lib/escrow.ts (the off-chain escrow index).
 *
 * Lifecycle: createEscrow (pending) -> markEscrowLocked (open) ->
 *   release/refund | dispute -> resolve. Plus the guards that matter:
 *  - illegal transitions are no-ops (a stale/duplicate on-chain callback can
 *    NEVER flip a terminal escrow, e.g. release cannot revive a refund)
 *  - lazy expiry only touches a never-locked `pending` record, never `open`
 *    (on-chain funds are governed by the vault, not this index)
 *  - acquireEscrowActionLock serializes state-changing actions
 *  - toPublicEscrow never leaks creatorOwner
 *  - onchainEscrowId is a deterministic bytes32 from the record id
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = new Map<string, unknown>();

vi.mock("@vercel/kv", () => ({
  kv: {
    get: vi.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
    set: vi.fn(async (k: string, v: unknown, opts?: { nx?: boolean }) => {
      if (opts?.nx && store.has(k)) return null;
      store.set(k, v);
      return "OK";
    }),
    del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
    rpush: vi.fn(async (k: string, ...vals: unknown[]) => {
      const arr = (store.get(k) as unknown[]) ?? [];
      arr.push(...vals); store.set(k, arr); return arr.length;
    }),
    lrange: vi.fn(async (k: string, start: number, stop: number) => {
      const arr = (store.get(k) as unknown[]) ?? [];
      const n = arr.length;
      const s = start < 0 ? Math.max(n + start, 0) : start;
      const e = stop < 0 ? n + stop : stop;
      return arr.slice(s, e + 1);
    }),
    ltrim: vi.fn(async () => "OK"),
  },
}));

import {
  createEscrow, getEscrow, listEscrowsPage,
  markEscrowLocked, markEscrowDisputed, markEscrowSettled, cancelEscrow,
  acquireEscrowActionLock, toPublicEscrow, deriveEscrowId, escrowKey,
  isValidEscrowId, type EscrowRecord,
} from "@/app/lib/escrow";

const OWNER  = "0x00000000000000000000000000000000000000A1";
const BUYER  = "0x00000000000000000000000000000000000000B2";
const SELLER = "0x00000000000000000000000000000000000000C3";
const ARB    = "0x00000000000000000000000000000000000000D4";

function base(): CreateArgs { return { creatorOwner: OWNER, buyer: BUYER, seller: SELLER, chain: "bnb", token: "USDC" as const, amount: "100", sandbox: false }; }
type CreateArgs = Parameters<typeof createEscrow>[0];

async function seed(status: EscrowRecord["status"], extra: Partial<EscrowRecord> = {}): Promise<EscrowRecord> {
  const rec = await createEscrow(base());
  const next = { ...rec, status, ...extra };
  store.set(escrowKey(rec.id), next);
  return next;
}

beforeEach(() => store.clear());

describe("createEscrow", () => {
  it("stores a pending record with a deterministic bytes32 onchainEscrowId", async () => {
    const rec = await createEscrow({ ...base(), arbiter: ARB, memo: "logo job" });
    expect(isValidEscrowId(rec.id)).toBe(true);
    expect(rec.status).toBe("pending");
    expect(rec.buyer).toBe(BUYER.toLowerCase());
    expect(rec.seller).toBe(SELLER.toLowerCase());
    expect(rec.arbiter).toBe(ARB.toLowerCase());
    expect(rec.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(rec.onchainEscrowId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(rec.onchainEscrowId).toBe(deriveEscrowId(rec.buyer, rec.salt)); // bound to buyer + salt
    expect(store.has(escrowKey(rec.id))).toBe(true);
    const list = await listEscrowsPage(OWNER);
    expect(list.records.map((r) => r.id)).toContain(rec.id);
  });
});

describe("getEscrow — lazy expiry", () => {
  it("flips a pending record past its deadline to expired", async () => {
    const id = `esc_${"a".repeat(24)}`;
    const salt = `0x${"1".repeat(64)}`;
    const past: EscrowRecord = {
      id, salt, onchainEscrowId: deriveEscrowId(BUYER.toLowerCase(), salt), creatorOwner: OWNER.toLowerCase(),
      buyer: BUYER.toLowerCase(), seller: SELLER.toLowerCase(), chain: "bnb", token: "USDC",
      amount: "100", releaseDeadline: new Date(Date.now() - 1000).toISOString(),
      status: "pending", createdAt: new Date(Date.now() - 2000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(), sandbox: false,
    };
    store.set(escrowKey(id), past);
    expect((await getEscrow(id))!.status).toBe("expired");
  });

  it("does NOT expire an OPEN record past the deadline (on-chain truth wins)", async () => {
    const rec = await seed("open", {
      lockTxHash: "0xlock",
      releaseDeadline: new Date(Date.now() - 1000).toISOString(),
    });
    expect((await getEscrow(rec.id))!.status).toBe("open");
  });
});

describe("legal transitions", () => {
  it("pending -> open -> released (release)", async () => {
    const rec = await createEscrow(base());
    expect((await markEscrowLocked(rec.id, "0xlock"))!.status).toBe("open");
    const settled = await markEscrowSettled(rec.id, { outcome: "release", txHash: "0xrel" });
    expect(settled!.status).toBe("released");
    expect(settled!.outcome).toBe("release");
  });

  it("open -> disputed -> released (resolve-seller)", async () => {
    const rec = await seed("open", { lockTxHash: "0xlock" });
    expect((await markEscrowDisputed(rec.id, "0xdis"))!.status).toBe("disputed");
    expect((await markEscrowSettled(rec.id, { outcome: "resolve-seller", txHash: "0xres" }))!.status).toBe("released");
  });

  it("open -> refunded (timeout refund)", async () => {
    const rec = await seed("open", { lockTxHash: "0xlock" });
    expect((await markEscrowSettled(rec.id, { outcome: "refund", txHash: "0xref" }))!.status).toBe("refunded");
  });

  it("disputed -> refunded (bounded arbiter window timeout refund)", async () => {
    const rec = await seed("disputed", { lockTxHash: "0xlock", disputeTxHash: "0xdis" });
    const settled = await markEscrowSettled(rec.id, { outcome: "refund", txHash: "0xref" });
    expect(settled!.status).toBe("refunded");
    expect(settled!.outcome).toBe("refund");
  });

  it("pending -> cancelled", async () => {
    const rec = await createEscrow(base());
    expect((await cancelEscrow(rec.id))!.status).toBe("cancelled");
  });
});

describe("illegal transitions are no-ops (stale/duplicate callback guard)", () => {
  it("release CANNOT revive a refunded escrow", async () => {
    const rec = await seed("refunded", { outcome: "refund", settleTxHash: "0xref" });
    const r = await markEscrowSettled(rec.id, { outcome: "release", txHash: "0xevil" });
    expect(r!.status).toBe("refunded");      // unchanged
    expect(r!.settleTxHash).toBe("0xref");    // not overwritten
  });

  it("cannot lock an already-open escrow twice", async () => {
    const rec = await seed("open", { lockTxHash: "0xlock1" });
    const r = await markEscrowLocked(rec.id, "0xlock2");
    expect(r!.lockTxHash).toBe("0xlock1");
  });

  it("cannot dispute a pending (unlocked) escrow", async () => {
    const rec = await createEscrow(base());
    expect((await markEscrowDisputed(rec.id, "0xdis"))!.status).toBe("pending");
  });

  it("cannot cancel an open escrow", async () => {
    const rec = await seed("open", { lockTxHash: "0xlock" });
    expect((await cancelEscrow(rec.id))!.status).toBe("open");
  });

  it("resolve-seller cannot settle an open (undisputed) escrow", async () => {
    const rec = await seed("open", { lockTxHash: "0xlock" });
    expect((await markEscrowSettled(rec.id, { outcome: "resolve-seller", txHash: "0xres" }))!.status).toBe("open");
  });

  it("release cannot settle a disputed escrow (only resolve can)", async () => {
    const rec = await seed("disputed", { lockTxHash: "0xlock", disputeTxHash: "0xdis" });
    expect((await markEscrowSettled(rec.id, { outcome: "release", txHash: "0xrel" }))!.status).toBe("disputed");
  });

  it("transitions on an unknown id return null", async () => {
    expect(await markEscrowLocked("esc_" + "f".repeat(24), "0x")).toBeNull();
  });
});

describe("action lock + projection", () => {
  it("acquireEscrowActionLock serializes (second caller loses)", async () => {
    const rec = await createEscrow(base());
    expect(await acquireEscrowActionLock(rec.id)).toBe(true);
    expect(await acquireEscrowActionLock(rec.id)).toBe(false);
  });

  it("toPublicEscrow never leaks creatorOwner", async () => {
    const rec = await createEscrow(base());
    const pub = toPublicEscrow(rec) as unknown as Record<string, unknown>;
    expect(pub.creatorOwner).toBeUndefined();
    expect(pub.buyer).toBe(BUYER.toLowerCase());
  });
});
