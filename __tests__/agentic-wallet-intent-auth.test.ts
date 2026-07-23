/**
 * agentic-wallet-intent-auth.test.ts
 *
 * Behavioural + source-grep guard for the intent-bound auth fixes:
 *
 *   Critical-1 — fund-moving routes (send / batch / export / archive)
 *     no longer accept reusable session signatures. They require a
 *     one-time action challenge whose canonical message embeds the
 *     exact intent (chain, token, recipient, amount, fp, …).
 *
 *   High-2 — Mode C in /send uses the presented apiKey AS the relay
 *     key (no silent substitution), and trial keys are rejected on
 *     non-BNB chains so a stale-but-fresh trial can't be redirected
 *     to drain the user's paid quota.
 *
 *   High-3 — Single-send idempotency comes for free from the one-time
 *     challenge consumption. Replaying the same signed body returns
 *     NONCE_EXPIRED; the client must re-mint to retry.
 *
 *   High-4 — Export challenge is bound to `Action: agentic.export`
 *     so a fresh signature for a different action can't be
 *     redirected to reveal a private key.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ethers } from "ethers";
import { buildIntentMessage } from "@/app/lib/auth";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── buildIntentMessage canonical shape ────────────────────────────────────

describe("buildIntentMessage canonical layout", () => {
  it("emits action + intent + address + challenge in a stable order", () => {
    const msg = buildIntentMessage(
      "0xAAaa00000000000000000000000000000000bbbb",
      "agentic.send",
      { chain: "bnb", token: "USDT", recipient: "0xCCcc", amount: "1.5" },
      "challenge-abc",
    );
    // Address must be lowercased.
    expect(msg).toContain("Address: 0xaaaa00000000000000000000000000000000bbbb");
    expect(msg).toContain("Action: agentic.send");
    expect(msg).toContain("Challenge: challenge-abc");
    // Intent keys sorted, so the bytes are stable regardless of caller order.
    expect(msg).toContain("amount: 1.5");
    expect(msg).toContain("chain: bnb");
    expect(msg).toContain("recipient: 0xCCcc");
    expect(msg).toContain("token: USDT");
    // Key-sort invariant: amount appears before chain appears before recipient.
    const aIdx = msg.indexOf("amount:");
    const cIdx = msg.indexOf("chain:");
    const rIdx = msg.indexOf("recipient:");
    const tIdx = msg.indexOf("token:");
    expect(aIdx).toBeLessThan(cIdx);
    expect(cIdx).toBeLessThan(rIdx);
    expect(rIdx).toBeLessThan(tIdx);
  });

  it("produces identical bytes for the same logical intent regardless of object order", () => {
    const m1 = buildIntentMessage("0xowner", "agentic.send",
      { chain: "bnb", token: "USDT", recipient: "0xabc", amount: "1" }, "c");
    const m2 = buildIntentMessage("0xowner", "agentic.send",
      { amount: "1", recipient: "0xabc", token: "USDT", chain: "bnb" }, "c");
    expect(m1).toBe(m2);
  });

  it("differs when ANY intent field differs", () => {
    const base = (intent: Record<string, string>) =>
      buildIntentMessage("0xowner", "agentic.send", intent, "c");
    const baseline = base({ chain: "bnb", token: "USDT", recipient: "0xa", amount: "1" });
    expect(base({ chain: "eth", token: "USDT", recipient: "0xa", amount: "1" })).not.toBe(baseline);
    expect(base({ chain: "bnb", token: "USDC", recipient: "0xa", amount: "1" })).not.toBe(baseline);
    expect(base({ chain: "bnb", token: "USDT", recipient: "0xb", amount: "1" })).not.toBe(baseline);
    expect(base({ chain: "bnb", token: "USDT", recipient: "0xa", amount: "2" })).not.toBe(baseline);
  });

  it("differs across actions — export signature cannot be replayed as send", () => {
    const exp = buildIntentMessage("0xo", "agentic.export", { target: "0xo" }, "c");
    const snd = buildIntentMessage("0xo", "agentic.send",
      { chain: "bnb", token: "USDT", recipient: "0xa", amount: "1" }, "c");
    expect(exp).not.toBe(snd);
  });

  it("signature over message verifies for the bound signer only", async () => {
    const wallet = ethers.Wallet.createRandom();
    const msg = buildIntentMessage(wallet.address, "agentic.send",
      { chain: "bnb", token: "USDT", recipient: "0xabc", amount: "1" }, "c");
    const sig = await wallet.signMessage(msg);
    const recovered = ethers.verifyMessage(msg, sig);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());

    // Tampering with intent invalidates the signature against the
    // rebuilt message.
    const tampered = buildIntentMessage(wallet.address, "agentic.send",
      { chain: "bnb", token: "USDT", recipient: "0xabc", amount: "999" }, "c");
    expect(ethers.verifyMessage(tampered, sig).toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });
});

// ── Route source-grep guards ─────────────────────────────────────────────

function loadRoute(...segments: string[]): string {
  return readFileSync(resolve(__dirname, "..", ...segments), "utf8");
}

describe("send route uses intent auth (Critical-1, High-3 via challenge replay block)", () => {
  const src = loadRoute("app", "api", "wallet", "agentic", "send", "route.ts");

  it("imports requireIntentAuth, not the old requireAuth", () => {
    expect(src).toMatch(/requireIntentAuth/);
    expect(src).not.toMatch(/from "@\/app\/lib\/auth";\s*\n.*requireAuth\s*\)/m);
  });

  it("binds action='agentic.send' with chain/token/recipient/amount intent fields", () => {
    expect(src).toMatch(/action:\s*"agentic\.send"/);
    expect(src).toMatch(/recipient:\s*body\.to\.toLowerCase\(\)/);
  });
});

describe("batch route uses intent auth", () => {
  const src = loadRoute("app", "api", "wallet", "agentic", "batch", "route.ts");

  it("binds action='agentic.batch' with chain/token/rows/fp intent fields", () => {
    expect(src).toMatch(/requireIntentAuth/);
    expect(src).toMatch(/action:\s*"agentic\.batch"/);
    // fp must be a computed recipient-set hash; variable name has churned
    // (`rowsHash` → `intentFp` after Mode C apiKey path landed). Either
    // identifier is acceptable so a future rename doesn't break this guard
    // — what matters is that the auth's bound `fp` ties to the recipient
    // set, not the literal identifier.
    expect(src).toMatch(/fp:\s*(rowsHash|intentFp)/);
  });
});

describe("export route uses action-scoped challenge (High-4)", () => {
  const src = loadRoute("app", "api", "wallet", "agentic", "export", "route.ts");

  it("binds action='agentic.export'", () => {
    expect(src).toMatch(/requireIntentAuth/);
    expect(src).toMatch(/action:\s*"agentic\.export"/);
  });
});

describe("archive (DELETE) route uses action-scoped challenge", () => {
  const src = loadRoute("app", "api", "wallet", "agentic", "route.ts");

  it("binds action='agentic.archive' on the DELETE handler", () => {
    expect(src).toMatch(/action:\s*"agentic\.archive"/);
  });
});

describe("Mode C scope enforcement (High-2)", () => {
  const src = loadRoute("app", "api", "wallet", "agentic", "send", "route.ts");

  it("rejects trial keys on non-BNB chains with TRIAL_BNB_ONLY", () => {
    expect(src).toMatch(/TRIAL_BNB_ONLY/);
    expect(src).toMatch(/isTrial && body\.chain !== "bnb"/);
  });

  it("uses the PRESENTED apiKey as the relay key (no silent auto-pick)", () => {
    expect(src).toMatch(/apiKey = presented/);
  });
});

describe("/api/auth/action-challenge route shape", () => {
  const src = loadRoute("app", "api", "auth", "action-challenge", "route.ts");

  it("validates address + action + intent shape", () => {
    expect(src).toMatch(/ALLOWED_ACTIONS/);
    expect(src).toMatch(/agentic\.send/);
    expect(src).toMatch(/agentic\.batch/);
    expect(src).toMatch(/agentic\.export/);
    expect(src).toMatch(/agentic\.archive/);
    // New actions added in multi-wallet Phase 3 — intent-bind PATCH
    // (limits), restore, and ERC-8004 register prepare + confirm.
    expect(src).toMatch(/agentic\.limits/);
    expect(src).toMatch(/agentic\.restore/);
    expect(src).toMatch(/agentic\.register/);
    expect(src).toMatch(/agentic\.register\.confirm/);
    // CCIP bridge — without this entry the challenge endpoint refuses
    // to mint and BridgeModal's getActionAuth returns null, leaving
    // every bridge attempt stuck on "Sign the bridge challenge…" with
    // no wallet popup. Regression guard for the FIX-36 incident.
    expect(src).toMatch(/ccip\.bridge/);
    // Agent Wallet EIP-7702 delegation clear — needed for the in-modal
    // "Clear delegation & retry" button on AGENT_WALLET_DELEGATED.
    expect(src).toMatch(/agentic\.clear_delegation/);
    // Q402 Hooks per-wallet policy write — SAME failure mode as the
    // FIX-36 bridge incident: a missing allowlist entry makes the Hooks
    // modal's getActionAuth return null, so "Save hook policy" shows a
    // sign hint with NO wallet popup. Regression guard.
    expect(src).toMatch(/agentic\.hooks_config/);
    // API key rotation — same missing-allowlist failure mode (no popup
    // on the dashboard Rotate Key button). Regression guard.
    expect(src).toMatch(/keys\.rotate/);
  });

  it("rate-limits per IP and returns the canonical message body", () => {
    expect(src).toMatch(/rateLimit\(ip,\s*"auth-action-challenge"/);
    expect(src).toMatch(/buildIntentMessage/);
  });
});

// MCP is a sibling repo (`quackai-org/q402-mcp`) and lives under
// `mcp-server/` in dev checkouts. In a fresh CI worktree without the
// MCP repo cloned alongside, the path doesn't exist. Skip the source-
// grep there instead of crashing the whole suite. The MCP repo has its
// own tests for this guard.
function readMcpConfigOrNull(): string | null {
  try {
    return readFileSync(resolve(__dirname, "..", "mcp-server", "src", "config.ts"), "utf8");
  } catch {
    return null;
  }
}

describe("MCP — Mode C visibility fix", () => {
  const src = readMcpConfigOrNull();
  it.skipIf(src === null)("Mode C is independent of A/B — no `!modeA && !modeB` gate", () => {
    // The guard wording specifically: previous bug was
    // `modeC = !modeA && !modeB && ...`. The fix removes the
    // negation chain so multi-key installs can pick Mode C.
    expect(src).not.toMatch(/modeC\s*=\s*!modeA\s*&&\s*!modeB/);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
