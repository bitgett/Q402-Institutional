/**
 * receipt.test.ts — Trust Receipt module.
 *
 * Pins the cryptographic guarantees that the rest of the feature relies on:
 *
 *   1. Canonical JSON is deterministic — a receipt with the same logical
 *      content always serializes to the same bytes regardless of object
 *      key insertion order. The /receipt verify button reproduces this
 *      exact serialization client-side.
 *
 *   2. Signatures round-trip — sign with relayer key → verify with relayer
 *      address recovers true; verify with a different address recovers
 *      false; tampered fields recover false.
 *
 *   3. apiKeyTier is NOT part of the signed payload — stripping it for
 *      public view must keep verification valid.
 *
 *   4. publicView strips apiKeyTier when showTier is false, keeps it when
 *      true.
 *
 *   5. receiptId format is stable + unguessable enough that grep/iteration
 *      against the URL space is impractical.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Wallet } from "ethers";
import {
  newReceiptId,
  canonicalize,
  receiptDigest,
  apiKeyFingerprint,
  signReceiptFields,
  verifyReceiptSignature,
  publicView,
  type Receipt,
  type ReceiptSignedFields,
} from "@/app/lib/receipt";

// Stable test key — never used anywhere else in the codebase.
const TEST_RELAYER_KEY     = "0x" + "11".repeat(32);
const TEST_RELAYER_ADDRESS = new Wallet(TEST_RELAYER_KEY).address.toLowerCase();

const originalKey = process.env.RELAYER_PRIVATE_KEY;
beforeEach(() => { process.env.RELAYER_PRIVATE_KEY = TEST_RELAYER_KEY; });
afterEach(()  => {
  if (originalKey === undefined) delete process.env.RELAYER_PRIVATE_KEY;
  else process.env.RELAYER_PRIVATE_KEY = originalKey;
});

const SAMPLE_FIELDS: ReceiptSignedFields = {
  receiptId:      "rct_" + "ab".repeat(12),
  createdAt:      "2026-05-08T00:00:00.000Z",
  txHash:         "0x" + "cd".repeat(32),
  chain:          "bnb",
  payer:          "0xab12cd34ab12cd34ab12cd34ab12cd34ab12cd34",
  recipient:      "0xef56gh78ef56gh78ef56gh78ef56gh78ef56gh78".replace(/[gh]/g, "0"),
  token:          "USDT",
  tokenAmount:    "5.00",
  tokenAmountRaw: "5000000000000000000",
  method:         "eip7702",
  sandbox:        false,
};

// ── newReceiptId ─────────────────────────────────────────────────────────────

describe("newReceiptId", () => {
  it("returns 'rct_' prefix + 24 lowercase hex chars", () => {
    const id = newReceiptId();
    expect(id).toMatch(/^rct_[0-9a-f]{24}$/);
  });

  it("collision-resistant across many calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5_000; i++) ids.add(newReceiptId());
    expect(ids.size).toBe(5_000);
  });
});

// ── canonicalize ─────────────────────────────────────────────────────────────

describe("canonicalize", () => {
  it("is deterministic — same logical content → identical bytes", () => {
    // Same fields, different insertion order
    const a: ReceiptSignedFields = { ...SAMPLE_FIELDS };
    const b: ReceiptSignedFields = {
      sandbox:        SAMPLE_FIELDS.sandbox,
      method:         SAMPLE_FIELDS.method,
      tokenAmountRaw: SAMPLE_FIELDS.tokenAmountRaw,
      tokenAmount:    SAMPLE_FIELDS.tokenAmount,
      token:          SAMPLE_FIELDS.token,
      recipient:      SAMPLE_FIELDS.recipient,
      payer:          SAMPLE_FIELDS.payer,
      chain:          SAMPLE_FIELDS.chain,
      txHash:         SAMPLE_FIELDS.txHash,
      createdAt:      SAMPLE_FIELDS.createdAt,
      receiptId:      SAMPLE_FIELDS.receiptId,
    };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("does NOT include apiKeyId or apiKeyTier (privacy: external readers must not be able to correlate receipts to a project)", () => {
    const out = canonicalize(SAMPLE_FIELDS);
    expect(out).not.toContain("apiKeyId");
    expect(out).not.toContain("apiKeyTier");
  });

  it("changes when any signed field changes", () => {
    const base    = canonicalize(SAMPLE_FIELDS);
    const changed = canonicalize({ ...SAMPLE_FIELDS, tokenAmount: "5.01" });
    expect(base).not.toBe(changed);
  });
});

// ── digest ────────────────────────────────────────────────────────────────────

describe("receiptDigest", () => {
  it("returns a 32-byte hex hash", () => {
    const digest = receiptDigest(canonicalize(SAMPLE_FIELDS));
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const c = canonicalize(SAMPLE_FIELDS);
    expect(receiptDigest(c)).toBe(receiptDigest(c));
  });
});

// ── apiKeyFingerprint ─────────────────────────────────────────────────────────

describe("apiKeyFingerprint", () => {
  it("produces a 16-char hex prefix", () => {
    const fp = apiKeyFingerprint("q402_live_8046855aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("differs between distinct keys", () => {
    expect(apiKeyFingerprint("q402_live_aaa")).not.toBe(apiKeyFingerprint("q402_live_bbb"));
  });

  it("is deterministic", () => {
    expect(apiKeyFingerprint("q402_live_aaa")).toBe(apiKeyFingerprint("q402_live_aaa"));
  });
});

// ── signReceiptFields + verifyReceiptSignature ────────────────────────────────

describe("sign + verify round-trip", () => {
  it("a fresh signature verifies against the relayer's address", async () => {
    const { signature, signedBy } = await signReceiptFields(SAMPLE_FIELDS);
    expect(signedBy).toBe(TEST_RELAYER_ADDRESS);
    expect(verifyReceiptSignature(SAMPLE_FIELDS, signature, signedBy)).toBe(true);
  });

  it("verification fails against a different address", async () => {
    const { signature } = await signReceiptFields(SAMPLE_FIELDS);
    const wrong = new Wallet("0x" + "22".repeat(32)).address;
    expect(verifyReceiptSignature(SAMPLE_FIELDS, signature, wrong)).toBe(false);
  });

  it("verification fails when any signed field is tampered with", async () => {
    const { signature, signedBy } = await signReceiptFields(SAMPLE_FIELDS);
    const tampered: ReceiptSignedFields = { ...SAMPLE_FIELDS, tokenAmount: "5000.00" };
    expect(verifyReceiptSignature(tampered, signature, signedBy)).toBe(false);
  });

  it("verification ignores junk signature", () => {
    expect(verifyReceiptSignature(
      SAMPLE_FIELDS,
      "0x" + "00".repeat(65),
      TEST_RELAYER_ADDRESS,
    )).toBe(false);
  });

  it("throws when RELAYER_PRIVATE_KEY is missing", async () => {
    delete process.env.RELAYER_PRIVATE_KEY;
    await expect(signReceiptFields(SAMPLE_FIELDS)).rejects.toThrow(/RELAYER_PRIVATE_KEY/);
  });
});

// ── publicView ────────────────────────────────────────────────────────────────

describe("publicView", () => {
  function buildReceipt(showTier: boolean): Receipt {
    return {
      ...SAMPLE_FIELDS,
      apiKeyId:   "abcd1234ef567890",
      apiKeyTier: "growth",
      showTier,
      webhook: {
        configured:     false,
        event:          "relay.success",
        deliveryStatus: "not_configured",
      },
      signature: "0xstub",
      signedBy:  TEST_RELAYER_ADDRESS,
      signedAt:  "2026-05-08T00:00:01.000Z",
    };
  }

  it("ALWAYS strips apiKeyId (privacy — external readers must not correlate)", () => {
    expect("apiKeyId" in publicView(buildReceipt(false))).toBe(false);
    expect("apiKeyId" in publicView(buildReceipt(true))).toBe(false);
  });

  it("strips apiKeyTier when showTier is false (default privacy)", () => {
    const view = publicView(buildReceipt(false));
    expect("apiKeyTier" in view).toBe(false);
  });

  it("keeps apiKeyTier when showTier is true", () => {
    const view = publicView(buildReceipt(true));
    expect(view.apiKeyTier).toBe("growth");
  });

  it("public view still contains everything in the signed subset", () => {
    const view = publicView(buildReceipt(false));
    // Fields that go into the canonical hash — Verify needs them all so it
    // can recompute the digest client-side.
    expect(view.receiptId).toBe(SAMPLE_FIELDS.receiptId);
    expect(view.createdAt).toBe(SAMPLE_FIELDS.createdAt);
    expect(view.txHash).toBe(SAMPLE_FIELDS.txHash);
    expect(view.chain).toBe(SAMPLE_FIELDS.chain);
    expect(view.payer).toBe(SAMPLE_FIELDS.payer);
    expect(view.recipient).toBe(SAMPLE_FIELDS.recipient);
    expect(view.token).toBe(SAMPLE_FIELDS.token);
    expect(view.tokenAmount).toBe(SAMPLE_FIELDS.tokenAmount);
    expect(view.tokenAmountRaw).toBe(SAMPLE_FIELDS.tokenAmountRaw);
    expect(view.method).toBe(SAMPLE_FIELDS.method);
    expect(view.sandbox).toBe(SAMPLE_FIELDS.sandbox);
  });

  it("public view still verifies even with apiKeyId stripped (signed payload excludes apiKeyId/Tier)", async () => {
    const { signature, signedBy } = await signReceiptFields(SAMPLE_FIELDS);
    const view = publicView(buildReceipt(false));
    // Reconstruct the signed subset from the public view — should match.
    const reconstructed: ReceiptSignedFields = {
      receiptId:      view.receiptId,
      createdAt:      view.createdAt,
      txHash:         view.txHash,
      chain:          view.chain,
      payer:          view.payer,
      recipient:      view.recipient,
      token:          view.token,
      tokenAmount:    view.tokenAmount,
      tokenAmountRaw: view.tokenAmountRaw,
      method:         view.method,
      sandbox:        view.sandbox,
    };
    expect(verifyReceiptSignature(reconstructed, signature, signedBy)).toBe(true);
  });
});

// ── Surface — guard against accidental client export ─────────────────────────

describe("module surface", () => {
  it("does not export raw KV keys or the signing key", async () => {
    const mod = await import("@/app/lib/receipt");
    const exported = Object.keys(mod);
    // Block names that would suggest leaking server-only secrets through the
    // module surface.
    expect(exported).not.toContain("RELAYER_PRIVATE_KEY");
    expect(exported).not.toContain("kv");
    expect(exported).not.toContain("Wallet");
  });
});

// Suppress noisy "ReceiptSignedFields" import warnings in some test runners
void vi;
