/**
 * verify-contracts.mjs
 *
 * Deploy / launch gate for every Q402 EIP-7702 impl. Two layers:
 *
 *   STATIC (metadata):
 *     1. eth_getCode      → contract deployed, bytecode non-empty
 *     2. NAME()           → EIP-712 domain name matches manifest
 *     3. TRANSFER_AUTHORIZATION_TYPEHASH() → witness typehash matches
 *
 *   EXECUTION INVARIANT (added 2026-06-14):
 *     4. OWNER-BINDING — calling transferWithAuthorization with
 *        `owner != address(this)` MUST revert with OwnerMismatch().
 *
 *   Why #4 exists: the metadata checks only prove a contract with the right
 *   name + typehash is deployed; they say nothing about behaviour. This probe
 *   exercises the owner-binding check directly so the gate verifies the impl
 *   actually enforces it. An impl without the check reverts with
 *   InvalidSignature() (it reached signature recovery) instead of
 *   OwnerMismatch(), or does not revert at all.
 *
 * The probe needs NO private key and moves NO funds — it sends a throwaway
 * signature and only inspects which custom error the revert carries.
 *
 * Run: node scripts/verify-contracts.mjs
 */
import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "..", "contracts.manifest.json"), "utf8")
);

const RPCS = {
  avax:   "https://api.avax.network/ext/bc/C/rpc",
  bnb:    "https://bsc-dataseed1.binance.org/",
  eth:    "https://ethereum.publicnode.com",
  xlayer: "https://rpc.xlayer.tech",
  stable: "https://rpc.stable.xyz",
  mantle: "https://rpc.mantle.xyz",
  injective: "https://sentry.evm-rpc.injective.network/",
  monad:  "https://rpc.monad.xyz",
  scroll: "https://rpc.scroll.io",
  arbitrum: "https://arb1.arbitrum.io/rpc",
};

// Keep in sync with app/lib/chain-status.ts — chains held until their impl is
// refreshed. The probe still runs on them; this list only changes the message
// (expected-hold vs unexpected).
const DISABLED_CHAINS = new Set(["mantle", "injective", "monad", "scroll", "arbitrum"]);

// Human-readable TransferAuthorization typehash (matches local source)
const TRANSFER_AUTH_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes(
  "TransferAuthorization(address owner,address facilitator,address token,address recipient,uint256 amount,uint256 nonce,uint256 deadline)"
));

// Custom-error selectors used to classify the owner-guard probe revert.
const SEL_OWNER_MISMATCH = ethers.id("OwnerMismatch()").slice(0, 10).toLowerCase();
const SEL_UNAUTH_FACILITATOR = ethers.id("UnauthorizedFacilitator()").slice(0, 10).toLowerCase();
const SEL_INVALID_SIGNATURE = ethers.id("InvalidSignature()").slice(0, 10).toLowerCase();
const SEL_INVALID_SIG_LENGTH = ethers.id("InvalidSignatureLength()").slice(0, 10).toLowerCase();

const ABI = [
  "function NAME() view returns (string)",
  "function VERSION() view returns (string)",
  "function TRANSFER_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
  "function DOMAIN_TYPEHASH() view returns (bytes32)",
  "function domainSeparator() view returns (bytes32)",
];

const TRANSFER_IFACE = new ethers.Interface([
  "function transferWithAuthorization(address owner,address facilitator,address token,address recipient,uint256 amount,uint256 nonce,uint256 deadline,bytes witnessSignature)",
]);

// A throwaway probe address that is NOT any impl address. We set it as BOTH the
// `owner` and the `facilitator` (and the eth_call `from`), so the facilitator
// guard (msg.sender == facilitator) passes and the NEXT check — owner-binding —
// is the one under test.
const PROBE = "0x000000000000000000000000000000000000dEaD";

function extractRevertSelector(err) {
  // Revert data shows up in different places depending on the RPC + ethers path.
  const candidates = [
    err?.data,
    err?.error?.data,
    err?.info?.error?.data,
    err?.value?.data,
    err?.revert?.data,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("0x") && c.length >= 10) {
      return c.slice(0, 10).toLowerCase();
    }
    // Some providers nest { data: { data: "0x.." } } or stringify the payload.
    if (c && typeof c === "object" && typeof c.data === "string" && c.data.startsWith("0x")) {
      return c.data.slice(0, 10).toLowerCase();
    }
  }
  const msg = String(err?.message ?? "");
  const m = msg.match(/0x[0-9a-fA-F]{8,}/);
  return m ? m[0].slice(0, 10).toLowerCase() : null;
}

/**
 * Owner-binding probe. Returns one of:
 *   { state: "safe" }          — reverted with OwnerMismatch / UnauthorizedFacilitator
 *   { state: "unsafe", … }     — reverted past the owner check (InvalidSignature*) or did not revert
 *   { state: "inconclusive" }  — RPC stripped the revert data; can't classify
 */
async function probeOwnerGuard(provider, impl) {
  const data = TRANSFER_IFACE.encodeFunctionData("transferWithAuthorization", [
    PROBE, PROBE, PROBE, PROBE, 0n, 0n, 2n ** 48n, "0x" + "00".repeat(65),
  ]);
  try {
    await provider.send("eth_call", [{ to: impl, from: PROBE, data }, "latest"]);
    // A guarded impl reverts (OwnerMismatch) BEFORE signature recovery; a call
    // that returns with a garbage signature means neither the owner nor the
    // signature gate stopped it — unambiguously unsafe.
    return { state: "unsafe", reason: "call did NOT revert with a garbage signature" };
  } catch (err) {
    const sel = extractRevertSelector(err);
    if (sel === SEL_OWNER_MISMATCH) {
      // Probe sets from == facilitator, so the facilitator gate passes and the
      // owner-binding check is the one that fires. OwnerMismatch is the proof.
      return { state: "safe", selector: sel };
    }
    if (sel === SEL_UNAUTH_FACILITATOR) {
      // The facilitator gate fired first (e.g. the RPC dropped the eth_call
      // `from`), so this run did NOT exercise the owner-binding check — can't
      // conclude it's present. Inconclusive, not safe.
      return { state: "inconclusive", selector: sel, reason: "facilitator gate fired before owner check — owner-binding not exercised" };
    }
    if (sel === SEL_INVALID_SIGNATURE || sel === SEL_INVALID_SIG_LENGTH) {
      return {
        state: "unsafe",
        selector: sel,
        reason: "reached signature recovery — owner==address(this) guard is missing",
      };
    }
    if (!sel) return { state: "inconclusive", reason: "RPC returned no revert data" };
    return { state: "unsafe", selector: sel, reason: `unexpected revert selector ${sel}` };
  }
}

const results = [];

for (const [chain, cfg] of Object.entries(manifest.chains)) {
  const row = { chain, address: cfg.implContract, checks: {} };
  try {
    const provider = new ethers.JsonRpcProvider(RPCS[chain]);
    const code = await provider.getCode(cfg.implContract);
    row.checks.hasCode = code && code !== "0x";
    row.checks.codeSize = code.length;

    if (!row.checks.hasCode) {
      results.push(row);
      continue;
    }

    const c = new ethers.Contract(cfg.implContract, ABI, provider);

    try {
      row.checks.onChainName = await c.NAME();
      row.checks.nameMatch = row.checks.onChainName === cfg.witness.domainName;
    } catch (e) {
      row.checks.nameError = e.shortMessage || e.message;
    }

    try {
      row.checks.onChainVersion = await c.VERSION();
    } catch (e) {
      row.checks.versionError = e.shortMessage || e.message;
    }

    try {
      row.checks.onChainTypehash = await c.TRANSFER_AUTHORIZATION_TYPEHASH();
      row.checks.typehashMatchesTransferAuth =
        row.checks.onChainTypehash.toLowerCase() === TRANSFER_AUTH_TYPEHASH.toLowerCase();
    } catch (e) {
      row.checks.typehashError = e.shortMessage || e.message;
    }

    // ── EXECUTION INVARIANT: owner-binding guard ──────────────────────────
    const probe = await probeOwnerGuard(provider, cfg.implContract);
    row.checks.ownerGuard = probe.state;
    row.checks.ownerGuardDetail = probe.reason ?? probe.selector ?? null;
  } catch (e) {
    row.error = e.shortMessage || e.message;
  }
  results.push(row);
}

console.log(JSON.stringify({
  expectedTransferAuthTypehash: TRANSFER_AUTH_TYPEHASH,
  results,
}, null, 2));

// ── Required-invariant gate ─────────────────────────────────────────────────
const failures = [];
const warnings = [];
for (const row of results) {
  const c = row.checks ?? {};
  if (row.error) {
    failures.push(`${row.chain}: rpc/contract read error — ${row.error}`);
    continue;
  }
  if (!c.hasCode) {
    failures.push(`${row.chain}: no bytecode at ${row.address}`);
  }
  if (c.nameMatch === false) {
    failures.push(`${row.chain}: NAME() = "${c.onChainName}" does not match manifest "${manifest.chains[row.chain].witness.domainName}"`);
  }
  if (c.nameError) failures.push(`${row.chain}: NAME() read failed — ${c.nameError}`);
  if (c.typehashMatchesTransferAuth === false) {
    failures.push(`${row.chain}: TRANSFER_AUTHORIZATION_TYPEHASH() mismatch`);
  }
  if (c.typehashError) failures.push(`${row.chain}: TRANSFER_AUTHORIZATION_TYPEHASH() read failed — ${c.typehashError}`);

  // The one that matters: owner-binding guard.
  if (c.ownerGuard === "unsafe") {
    const tag = DISABLED_CHAINS.has(row.chain)
      ? "(held in chain-status.ts — refresh the impl + re-delegate before re-enabling)"
      : "(NOT in the chain-status.ts hold list — investigate before launch)";
    failures.push(`${row.chain}: owner-binding check not enforced ${tag} — ${c.ownerGuardDetail ?? ""}`);
  } else if (c.ownerGuard === "inconclusive") {
    // Fail-CLOSED for chains that are supposed to be live: a launch gate that
    // can't confirm the owner-binding check must not pass it. Held chains only
    // warn (they're already gated off in chain-status.ts).
    if (DISABLED_CHAINS.has(row.chain)) {
      warnings.push(`${row.chain}: owner-guard probe inconclusive (${c.ownerGuardDetail}) — chain already held`);
    } else {
      failures.push(`${row.chain}: owner-guard probe INCONCLUSIVE (${c.ownerGuardDetail}) — cannot confirm the owner-binding check; re-run against an RPC that returns revert data before treating this chain as launch-ready`);
    }
  }
}

if (warnings.length > 0) {
  console.error(`\n! verify-contracts: ${warnings.length} inconclusive probe(s):`);
  for (const msg of warnings) console.error(`  - ${msg}`);
}
if (failures.length > 0) {
  console.error(`\n✖ verify-contracts: ${failures.length} invariant failure${failures.length > 1 ? "s" : ""}:`);
  for (const msg of failures) console.error(`  - ${msg}`);
  process.exit(1);
}
console.error("\n✓ verify-contracts: all required invariants pass (incl. owner-binding guard).");
