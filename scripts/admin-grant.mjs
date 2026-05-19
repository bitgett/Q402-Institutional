#!/usr/bin/env node
/**
 * admin-grant.mjs — One-shot admin credit grant for a wallet.
 *
 * Issues paid (Multichain) or trial credits to an EVM address WITHOUT going
 * through the on-chain payment activate flow. Designed for low-frequency
 * operational grants:
 *   - Partnership credits (Monad, Injective, …)
 *   - Hackathon prizes
 *   - Demo / beta tester allotments
 *   - Recovery of credits that didn't activate properly
 *
 * Three wallet states handled
 *   (a) Brand-new (no sub:{addr})   — creates sub + mints paid apiKey +
 *                                     mints sandbox key + seeds credits
 *   (b) Trial-only (plan=trial)     — preserves trial key/credits, mints
 *                                     paid apiKey + sandbox key, sets
 *                                     plan/paidAt/amountUSD, seeds credits.
 *                                     Pre-Phase-1 shape (trial key in
 *                                     `apiKey` slot) is promoted to
 *                                     `trialApiKey` first.
 *   (c) Already paid (apiKey set)   — `--force` required. Just adds credits.
 *                                     Equivalent to /api/keys/topup but in
 *                                     script form so you don't need the
 *                                     production ADMIN_SECRET on hand.
 *
 * Audit trail
 *   - txHash field is set to `admin_grant:{timestamp}` so reconcile /
 *     dashboard / receipts can spot it later.
 *   - amountUSD stays 0 — the wallet did NOT pay; misrepresenting it
 *     would corrupt the hasPaidSignal heuristic and the tier-upgrade
 *     math in payment/activate. The paid apiKey + plan are what unlock
 *     credit usage, not amountUSD.
 *   - Console output prints the full mutation plan before --execute.
 *
 * Usage
 *   node --env-file=.env.local scripts/admin-grant.mjs \
 *     --address=0x... --amount=100000 --dry-run
 *
 *   node --env-file=.env.local scripts/admin-grant.mjs \
 *     --address=0x... --amount=100000 --execute
 *
 * Flags
 *   --address=0x...      (required) EVM address (0x + 40 hex)
 *   --amount=N           (required) Positive integer credits to grant
 *   --scope=paid|trial   (default: paid)
 *   --plan=PLAN          (default: starter, paid grants only)
 *   --dry-run            (default) Print plan, no writes
 *   --execute            Apply changes
 *   --force              Allow grant even if wallet already has paid sub
 *   --json               Machine-parsable output
 *
 * Environment
 *   KV_REST_API_URL + KV_REST_API_TOKEN (from .env.local — same as the app)
 */

import { kv } from "@vercel/kv";
import { randomBytes } from "node:crypto";

// ── argv ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {
  dryRun:  !args.includes("--execute"),
  execute:  args.includes("--execute"),
  force:    args.includes("--force"),
  json:     args.includes("--json"),
  address:  null,
  amount:   null,
  scope:    "paid",
  plan:     "starter",
};
for (const a of args) {
  if (a.startsWith("--address=")) flags.address = a.slice("--address=".length).toLowerCase();
  else if (a.startsWith("--amount="))  flags.amount = parseInt(a.slice("--amount=".length), 10);
  else if (a.startsWith("--scope="))   flags.scope  = a.slice("--scope=".length);
  else if (a.startsWith("--plan="))    flags.plan   = a.slice("--plan=".length);
}

if (flags.dryRun && flags.execute) {
  console.error("--dry-run and --execute are mutually exclusive (default is --dry-run).");
  process.exit(1);
}
if (!flags.address || !/^0x[0-9a-f]{40}$/i.test(flags.address)) {
  console.error("--address=0x... (40 hex chars) is required.");
  process.exit(1);
}
if (!Number.isInteger(flags.amount) || flags.amount <= 0 || flags.amount > 10_000_000) {
  console.error("--amount=N (positive integer, max 10M) is required.");
  process.exit(1);
}
if (flags.scope !== "paid" && flags.scope !== "trial") {
  console.error(`--scope must be "paid" or "trial" (got "${flags.scope}").`);
  process.exit(1);
}

const ADDR = flags.address.toLowerCase();
const NOW  = new Date();
const NOW_ISO = NOW.toISOString();

// ── KV helpers (mirrors app/lib/db.ts) ───────────────────────────────────
const subKey         = (addr) => `sub:${addr.toLowerCase()}`;
const apiKeyRecKey   = (key)  => `apikey:${key}`;
const scopedQuotaKey = (addr, scope) => `quota:${scope}:${addr.toLowerCase()}`;

function mintKey(prefix, plan, isSandbox = false) {
  const rand = randomBytes(24).toString("hex");
  const key  = `${prefix}${rand}`;
  const record = {
    address:   ADDR,
    createdAt: NOW_ISO,
    active:    true,
    plan,
    ...(isSandbox ? { isSandbox: true } : {}),
  };
  return { key, record };
}

// ── Read current state ───────────────────────────────────────────────────
const existing = await kv.get(subKey(ADDR));
const scopedBefore = await kv.get(scopedQuotaKey(ADDR, flags.scope));

// Classify state
let stateClass;
if (!existing) {
  stateClass = "brand-new";
} else if (existing.plan === "trial" && (existing.amountUSD ?? 0) === 0) {
  stateClass = "trial-only";
} else if ((existing.amountUSD ?? 0) > 0 || existing.apiKey) {
  stateClass = "already-paid";
} else {
  stateClass = "unknown";
}

// ── Build mutation plan ──────────────────────────────────────────────────
const plan = {
  address: ADDR,
  scope:   flags.scope,
  amount:  flags.amount,
  state:   stateClass,
  actions: [],
  newSub:  null,
  mintedKeys: [],
  scopedKeyBefore: scopedBefore,
};

const txHashSentinel = `admin_grant:${NOW.getTime()}`;

if (flags.scope === "paid") {
  // ── Paid grant ────────────────────────────────────────────────────────
  if (stateClass === "brand-new") {
    const live    = mintKey("q402_live_", flags.plan);
    const sandbox = mintKey("q402_test_", flags.plan, true);
    plan.newSub = {
      apiKey:          live.key,
      sandboxApiKey:   sandbox.key,
      plan:            flags.plan,
      paidAt:          NOW_ISO,
      amountUSD:       0,
      txHash:          txHashSentinel,
      trialQuotaBonus: 0,
      paidQuotaBonus:  flags.amount,
      quotaBonus:      flags.amount,
    };
    plan.mintedKeys.push({ key: live.key,    record: live.record });
    plan.mintedKeys.push({ key: sandbox.key, record: sandbox.record });
    plan.actions.push(`mint paid apiKey (plan="${flags.plan}")`);
    plan.actions.push(`mint sandbox key`);
    plan.actions.push(`create sub:{addr} with plan="${flags.plan}"`);
    plan.actions.push(`addScopedCredits(addr, "paid", ${flags.amount})`);
  } else if (stateClass === "trial-only") {
    // Preserve trial key/credits. If pre-Phase-1 shape (trial key in
    // apiKey slot), promote first.
    const hasLegacyTrialKey =
      !!existing.apiKey && !existing.trialApiKey;
    let trialApiKey        = existing.trialApiKey;
    let trialSandboxApiKey = existing.trialSandboxApiKey;
    if (hasLegacyTrialKey) {
      trialApiKey        = existing.apiKey;
      trialSandboxApiKey = existing.sandboxApiKey ?? undefined;
      plan.actions.push(`promote legacy apiKey → trialApiKey`);
      if (existing.sandboxApiKey) {
        plan.actions.push(`promote legacy sandboxApiKey → trialSandboxApiKey`);
      }
    }
    const live    = mintKey("q402_live_", flags.plan);
    const sandbox = mintKey("q402_test_", flags.plan, true);
    plan.newSub = {
      ...existing,
      apiKey:             live.key,
      sandboxApiKey:      sandbox.key,
      trialApiKey,
      ...(trialSandboxApiKey ? { trialSandboxApiKey } : {}),
      plan:               flags.plan,
      paidAt:             NOW_ISO,
      amountUSD:          0,
      txHash:             txHashSentinel,
      paidQuotaBonus:     flags.amount,
      quotaBonus:         (existing.trialQuotaBonus ?? 0) + flags.amount,
    };
    plan.mintedKeys.push({ key: live.key,    record: live.record });
    plan.mintedKeys.push({ key: sandbox.key, record: sandbox.record });
    plan.actions.push(`mint paid apiKey (plan="${flags.plan}")`);
    plan.actions.push(`mint sandbox key`);
    plan.actions.push(`upgrade sub plan trial → "${flags.plan}"`);
    plan.actions.push(`preserve trialApiKey + trialQuotaBonus=${existing.trialQuotaBonus ?? 0}`);
    plan.actions.push(`addScopedCredits(addr, "paid", ${flags.amount})`);
  } else if (stateClass === "already-paid") {
    if (!flags.force) {
      console.error(
        `\nWallet ${ADDR} already has a paid sub (plan=${existing.plan}, amountUSD=${existing.amountUSD}).\n` +
        `Use /api/keys/topup endpoint OR re-run with --force.\n`,
      );
      process.exit(1);
    }
    plan.newSub = {
      ...existing,
      paidQuotaBonus: (existing.paidQuotaBonus ?? 0) + flags.amount,
      quotaBonus:     (existing.quotaBonus ?? 0) + flags.amount,
    };
    plan.actions.push(`addScopedCredits(addr, "paid", ${flags.amount}) — TOPUP existing paid sub`);
  } else {
    console.error(`Unknown wallet state. Existing sub:\n${JSON.stringify(existing, null, 2)}`);
    process.exit(1);
  }
} else {
  // ── Trial grant ──────────────────────────────────────────────────────
  // Rare — usually trial grants go through trial/activate route. This
  // path exists for unusual ops cases.
  if (stateClass === "brand-new") {
    console.error(
      `\nTrial grant to brand-new wallet ${ADDR} — use /api/trial/activate or sign in via /event instead.\n` +
      `That path mints the proper trial keys + sets trialExpiresAt + Sybil guards.\n`,
    );
    process.exit(1);
  }
  if (stateClass === "already-paid" && !flags.force) {
    console.error(`Wallet has paid plan — trial grant unusual. Use --force if intentional.`);
    process.exit(1);
  }
  // Just add credits to trial pool; don't touch keys.
  plan.newSub = {
    ...existing,
    trialQuotaBonus: (existing?.trialQuotaBonus ?? 0) + flags.amount,
    quotaBonus:      (existing?.quotaBonus ?? 0) + flags.amount,
  };
  plan.actions.push(`addScopedCredits(addr, "trial", ${flags.amount}) — pool only, no key changes`);
}

// ── Output plan ───────────────────────────────────────────────────────────
if (flags.json) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  console.log(`\n=== admin-grant — ${flags.execute ? "EXECUTE" : "DRY-RUN"} ===`);
  console.log(`Address       : ${ADDR}`);
  console.log(`Scope         : ${flags.scope}`);
  console.log(`Amount        : ${flags.amount.toLocaleString()}`);
  console.log(`State class   : ${stateClass}`);
  console.log(`scoped before : ${scopedBefore ?? "(none)"}`);
  console.log(`scoped after  : ${(scopedBefore ?? 0) + flags.amount}`);
  console.log(`\nActions:`);
  for (const a of plan.actions) console.log(`  - ${a}`);
  if (plan.mintedKeys.length > 0) {
    console.log(`\nMinted keys (full values printed ONLY in --execute output):`);
    for (const m of plan.mintedKeys) {
      const masked = m.key.slice(0, 12) + "…" + m.key.slice(-4);
      console.log(`  - ${m.record.isSandbox ? "sandbox " : "live    "} ${masked}`);
    }
  }
  console.log();
}

if (!flags.execute) {
  console.log("Re-run with --execute to apply.\n");
  process.exit(0);
}

// ── Apply ─────────────────────────────────────────────────────────────────
// Order:
//   1. Mint apiKey records first so the key exists if anything reads it
//      mid-flight (relay route, /api/keys/verify).
//   2. Increment the scoped credit pool (atomic INCRBY).
//   3. Write subscription LAST — once it's written, the dashboard /
//      provision API see the new state. Reading mid-write would just
//      see the old sub, harmless.
for (const m of plan.mintedKeys) {
  await kv.set(apiKeyRecKey(m.key), m.record);
}

// Seed scoped pool if missing (mirrors initScopedQuotaIfNeeded semantics).
if (scopedBefore === null) {
  await kv.set(scopedQuotaKey(ADDR, flags.scope), 0, { nx: true });
}
const newScopedTotal = await kv.incrby(scopedQuotaKey(ADDR, flags.scope), flags.amount);

await kv.set(subKey(ADDR), plan.newSub);

console.log(`✓ Granted ${flags.amount.toLocaleString()} ${flags.scope} credits to ${ADDR}`);
console.log(`  scoped pool now: ${newScopedTotal}`);
if (plan.mintedKeys.length > 0) {
  console.log(`\n⚠ Minted keys — copy and deliver securely to the recipient:`);
  for (const m of plan.mintedKeys) {
    const kind = m.record.isSandbox ? "sandbox" : "live   ";
    console.log(`  ${kind} : ${m.key}`);
  }
  console.log(`\nThe sub record now points at these keys. They WILL show up on the`);
  console.log(`recipient's dashboard once they connect this wallet.`);
}
console.log(`\nDone.\n`);
