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
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
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
  base:   "https://mainnet.base.org",
  robinhood: process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
};

// Keep in sync with app/lib/chain-status.ts — chains held in the settlement
// allow-list. Empty now that all ten run the verified guarded build and the
// stale prod env overrides were removed; this set only softens the message for a
// held chain (expected-hold vs unexpected).
const DISABLED_CHAINS = new Set([]);

// Chains deployed from the BNB reference source via scripts/deploy-fixed-impl.mjs
// (same logic, only the NAME constant differs per chain). For these we hold the
// authoritative owner-binding proof: byte-compare the on-chain runtime to a local
// compile of the guarded source. This is RPC-independent — it does not depend on
// the chain's RPC returning eth_call revert data — and it also catches a wrong
// NAME (the deployed runtime would not match the per-chain variant). For these
// chains a bytecode match satisfies the owner-binding requirement even when the
// eth_call probe is inconclusive (e.g. Injective's RPC strips revert data).
const BNB_DERIVED = new Set(["mantle", "injective", "monad", "scroll", "arbitrum"]);
const BNB_REF_SRC = resolve(__dirname, "..", "contracts/deployed/bnb/Q402PaymentImplementationBNB.sol");
const NAME_DECL = 'constant NAME    = "Q402 BNB Chain"';
const _bytecodeCache = new Map();
function expectedGuardedRuntime(domainName) {
  if (_bytecodeCache.has(domainName)) return _bytecodeCache.get(domainName);
  const solc = require("solc");
  // Pin to the compiler that produced the deployed runtime — a different 0.8.x
  // patch yields different bytecode, which would flip bytecodeMatch to false and
  // fail the gate confusingly. Fail with a clear message instead.
  if (!solc.version().startsWith("0.8.20")) {
    throw new Error(`verify-contracts needs solc 0.8.20 (the deployed bytecode's compiler); got ${solc.version()} — run: npm i -D solc@0.8.20`);
  }
  let source = readFileSync(BNB_REF_SRC, "utf8").replace(NAME_DECL, `constant NAME    = "${domainName}"`);
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "Q402.sol": { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "london", outputSelection: { "*": { "*": ["evm.deployedBytecode.object"] } } },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  const rt = ("0x" + out.contracts["Q402.sol"]["Q402PaymentImplementationBNB"].evm.deployedBytecode.object).toLowerCase();
  _bytecodeCache.set(domainName, rt);
  return rt;
}
// Compare ignoring the trailing CBOR metadata (last 2 bytes = length).
function stripMetadata(hex) {
  const h = (hex.startsWith("0x") ? hex.slice(2) : hex).toLowerCase();
  if (h.length < 4) return h;
  const len = parseInt(h.slice(-4), 16);
  const cut = len * 2 + 4;
  return cut < h.length ? h.slice(0, h.length - cut) : h;
}

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

    // ── BNB-derived chains: byte-compare runtime to the guarded build. This is
    // the authoritative, RPC-independent owner-binding proof for these chains.
    if (BNB_DERIVED.has(chain)) {
      try {
        const expected = expectedGuardedRuntime(cfg.witness.domainName);
        row.checks.bytecodeMatch =
          code.toLowerCase() === expected || stripMetadata(code) === stripMetadata(expected);
      } catch (e) {
        row.checks.bytecodeError = e.shortMessage || e.message;
      }
    }
  } catch (e) {
    // Keep a non-empty message: a provider that cannot start (e.g. missing/unreachable
    // RPC) can surface with empty shortMessage AND message, which would otherwise be
    // misread downstream as a successful-but-empty read.
    row.error = e.shortMessage || e.message || "provider failed to start (RPC unreachable / network not detected)";
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
// Track which chains we ACTUALLY verified: a successful read (hasCode true)
// where at least one invariant was evaluated (NAME, typehash, or the BNB-derived
// bytecode compare), as opposed to a connectivity skip (row.error). The gate
// requires EVERY active (non-held) chain to verify — a release must not pass
// while some live chain went unchecked (one RPC down is not "verified").
const verifiedChains = new Set();
for (const row of results) {
  const c = row.checks ?? {};
  if (row.error || c.hasCode === undefined) {
    // A thrown RPC error (or a provider that never completed a getCode, so hasCode
    // was never set) is a connectivity issue, not an invariant violation. Gate on a
    // successful fetch: warn and re-run when the RPC is healthy. A genuinely missing
    // contract surfaces as hasCode === false (a successful getCode returning "0x"),
    // which stays a hard failure below.
    warnings.push(`${row.chain}: RPC read error (connectivity, not an invariant) — ${row.error || "provider returned no code read"}`);
    continue;
  }
  if (c.hasCode && (c.nameMatch !== undefined || c.typehashMatchesTransferAuth !== undefined || c.bytecodeMatch !== undefined)) {
    verifiedChains.add(row.chain);
  }
  if (c.hasCode === false) {
    failures.push(`${row.chain}: no bytecode at ${row.address}`);
  }
  if (c.nameMatch === false) {
    failures.push(`${row.chain}: NAME() = "${c.onChainName}" does not match manifest "${manifest.chains[row.chain].witness.domainName}"`);
  }
  // A thrown field read is connectivity, not an invariant — warn and re-run.
  // A WRONG value (nameMatch/typehash === false above) stays a hard failure, and
  // BNB-derived chains have bytecodeMatch as an independent backstop below.
  if (c.nameError) warnings.push(`${row.chain}: NAME() read error (connectivity, not an invariant) — ${c.nameError}`);
  if (c.typehashMatchesTransferAuth === false) {
    failures.push(`${row.chain}: TRANSFER_AUTHORIZATION_TYPEHASH() mismatch`);
  }
  if (c.typehashError) warnings.push(`${row.chain}: TRANSFER_AUTHORIZATION_TYPEHASH() read error (connectivity) — ${c.typehashError}`);

  // The one that matters: owner-binding guard.
  if (BNB_DERIVED.has(row.chain)) {
    // Authoritative, RPC-independent proof: the deployed runtime is byte-identical
    // to the locally-compiled guarded source (which carries the owner-binding
    // check + the correct NAME). This holds even when the eth_call probe is
    // inconclusive because the chain's RPC strips revert data (e.g. Injective).
    if (c.bytecodeError) {
      failures.push(`${row.chain}: could not compile/compare the guarded runtime — ${c.bytecodeError}`);
    } else if (c.bytecodeMatch !== true) {
      failures.push(`${row.chain}: deployed runtime does not match the guarded build — owner-binding/NAME unverified`);
    } else if (c.ownerGuard !== "safe") {
      // bytecode confirms it; note that the live probe couldn't (for visibility).
      warnings.push(`${row.chain}: owner-guard eth_call probe ${c.ownerGuard} (${c.ownerGuardDetail}); owner-binding confirmed instead by bytecode equivalence to the guarded build`);
    }
  } else if (c.ownerGuard === "unsafe") {
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
// Per-chain backstop: every ACTIVE (non-held) chain must have been verified.
// Connectivity warnings don't fail an individual invariant, but a release gate
// must not pass while any live chain went unchecked (e.g. its RPC was down).
// Held chains are exempt — they're already gated off in chain-status.ts.
const activeChains = Object.keys(manifest.chains).filter((ch) => !DISABLED_CHAINS.has(ch));
const unverifiedActive = activeChains.filter((ch) => !verifiedChains.has(ch));
if (unverifiedActive.length > 0) {
  console.error(`\n✖ verify-contracts: ${unverifiedActive.length} active chain(s) could not be verified (RPC read failed) — re-run when their RPCs are healthy: ${unverifiedActive.join(", ")}. The gate requires every active chain to verify.`);
  process.exit(1);
}
console.error("\n✓ verify-contracts: all required invariants pass (incl. owner-binding guard).");
