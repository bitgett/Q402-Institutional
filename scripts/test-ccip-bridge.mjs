#!/usr/bin/env node
/**
 * test-ccip-bridge.mjs — Smoke test for the CCIP bridge surface.
 *
 * Verifies the read-only paths (lanes, quote) on the running production
 * relay. Does NOT call /api/ccip/send — that needs intent-bound EIP-712
 * auth + an Agentic Wallet, which is dashboard-side.
 *
 * Usage:
 *   node scripts/test-ccip-bridge.mjs
 *   node scripts/test-ccip-bridge.mjs --base https://q402.quackai.ai
 */

const args = process.argv.slice(2);
function argVal(name) {
  const eq = args.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}
const BASE = argVal("base") ?? "https://q402.quackai.ai";

const Q402_CHAINS = ["eth", "avax", "arbitrum"];
const TEST_DEST = "0x000000000000000000000000000000000000dEaD";
const TEST_AMOUNT = "1000000"; // 1 USDC (6-dec)

const colors = {
  ok:   (s) => `\x1b[32m${s}\x1b[0m`,
  bad:  (s) => `\x1b[31m${s}\x1b[0m`,
  dim:  (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

async function getJson(path, init = {}) {
  const url = BASE.replace(/\/$/, "") + path;
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({ _parseError: true }));
  return { ok: res.ok, status: res.status, data };
}

let failed = 0;

function pass(label) { console.log("  " + colors.ok("✓") + " " + label); }
function fail(label, detail) {
  console.log("  " + colors.bad("✗") + " " + label);
  if (detail) console.log("    " + colors.dim(detail));
  failed++;
}

(async () => {
  console.log("\n" + colors.bold("Q402 × CCIP — smoke test") + " (base=" + BASE + ")\n");

  // ── 1. /api/ccip/lanes ──────────────────────────────────────────────────
  console.log(colors.bold("[1/3]") + " GET /api/ccip/lanes");
  {
    const { ok, status, data } = await getJson("/api/ccip/lanes");
    if (!ok) {
      fail("HTTP " + status, JSON.stringify(data).slice(0, 200));
    } else {
      if (data.chains?.length === 3) pass("3 chains returned");
      else fail("expected 3 chains, got " + data.chains?.length);
      if (data.lanes?.length === 6) pass("6 directed lanes returned");
      else fail("expected 6 lanes, got " + data.lanes?.length);
      if (data.version === "1.6.0") pass("CCIP version 1.6.0");
      else fail("version mismatch: " + data.version);
      if (data.feePolicy?.q402Markup === 0) pass("Q402 markup = 0 (free)");
      else fail("Q402 markup ≠ 0", JSON.stringify(data.feePolicy));
      const senderOk = data.lanes?.every(l => /^0x[0-9a-fA-F]{40}$/.test(l.senderContract));
      if (senderOk) pass("all senders deployed (no PENDING)");
      else fail("some senders still PENDING_DEPLOY");
    }
  }

  // ── 2. /api/ccip/quote — one valid lane ─────────────────────────────────
  console.log("\n" + colors.bold("[2/3]") + " POST /api/ccip/quote (arb → avax, 1 USDC)");
  {
    const { ok, status, data } = await getJson("/api/ccip/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        src: "arbitrum", dst: "avax",
        amount: TEST_AMOUNT,
        destReceiver: TEST_DEST,
      }),
    });
    if (!ok) {
      fail("HTTP " + status, JSON.stringify(data).slice(0, 200));
    } else {
      if (data.fee?.link?.raw) pass("LINK fee: " + data.fee.link.whole.toFixed(6) + " LINK (~$" + data.fee.link.usd.toFixed(3) + ")");
      else fail("missing LINK fee");
      if (data.fee?.native?.raw) pass("Native fee: " + data.fee.native.whole.toFixed(6) + " ETH (~$" + data.fee.native.usd.toFixed(3) + ")");
      else fail("missing native fee");
      if (["link", "native"].includes(data.recommended)) pass("Recommended: " + data.recommended);
      else fail("missing recommended field");
    }
  }

  // ── 3. /api/ccip/quote — reject invalid lane (self) ─────────────────────
  console.log("\n" + colors.bold("[3/3]") + " POST /api/ccip/quote (arb → arb, should reject)");
  {
    const { ok, status, data } = await getJson("/api/ccip/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ src: "arbitrum", dst: "arbitrum", amount: TEST_AMOUNT, destReceiver: TEST_DEST }),
    });
    if (status === 400) pass("400 returned for self-lane (anti-error)");
    else fail("expected 400, got HTTP " + status);
  }

  // ── 4. all 6 lanes — quote sanity ───────────────────────────────────────
  console.log("\n" + colors.bold("[bonus]") + " All 6 directed lanes — quote sanity");
  for (const src of Q402_CHAINS) {
    for (const dst of Q402_CHAINS) {
      if (src === dst) continue;
      const { ok, status, data } = await getJson("/api/ccip/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ src, dst, amount: TEST_AMOUNT, destReceiver: TEST_DEST }),
      });
      if (ok && data.fee?.native?.whole) {
        pass(`${src} → ${dst}: native ${data.fee.native.whole.toFixed(6)} (~$${data.fee.native.usd.toFixed(2)})`);
      } else {
        fail(`${src} → ${dst}: HTTP ${status}`, JSON.stringify(data).slice(0, 150));
      }
    }
  }

  console.log("\n" + colors.bold(failed === 0 ? colors.ok("All checks passed ✓") : colors.bad(failed + " failure(s) ✗")));
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
  console.error(colors.bad("Fatal:") + " " + (err.message ?? err));
  process.exit(2);
});
