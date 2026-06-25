"use client";

/**
 * ActivityView — settlement activity ledger (prototype id="activity",
 * .wide-view = 230px context rail + view-main table).
 *
 * REAL IMPLEMENTATION.
 *
 * ── Layout ──────────────────────────────────────────────────────────────
 *   .view-shell = grid 230px / 1fr
 *   Col 1  .context rail buttons: All settlements / Manual sends /
 *          Recurring fires / Bridge history / Trust Receipts
 *   Col 2  .view-main: title "Settlement activity", desc, .filters chips
 *          (All wallets / per-wallet, All networks / per-chain), then a
 *          .table of rows: Settlement (kind + receipt sub) · Wallet ·
 *          Network · Status · Amount.
 *
 * ── DATA (all REUSED, none reinvented) ──────────────────────────────────
 *   - Relayed tx history: GET /api/transactions?address&nonce&sig — the same
 *     auth'd endpoint the v1 dashboard's `relayedTxs` reads (page.tsx:1093).
 *     Shape mirrors app/lib/db.ts RelayedTx (chain/fromUser/toUser/
 *     tokenAmount/tokenSymbol/relayTxHash/relayedAt/receiptId?/source?/ruleId?).
 *   - Scope (trial|multichain): provisioned key sets from POST
 *     /api/keys/provision (page.tsx:986) build the trial vs paid key sets;
 *     txs are filtered by the apiKey used at relay time — identical logic to
 *     page.tsx:1503-1539 (trialKeySet / paidKeySet / scopedTxs).
 *   - Recurring fires: source === "recurring" rows (tagged by the recurring
 *     cron — AgenticWalletRecurringSection's data layer fires them).
 *   - Bridge history: GET /api/ccip/bridge-history?address&nonce&signature
 *     (BridgeHistoryRecord shape — app/lib/ccip-bridge-runner.ts:54).
 *   - Trust Receipts: rows with receiptId → /receipt/{id}.
 *   - Wallet filter: GET /api/wallet/agentic (AgenticWalletPublic list) — same
 *     fetch AgenticWalletTab uses; filters the table by the agent wallet that
 *     sent each settlement (fromUser === wallet.address).
 *   - Explorer links: explorerTxUrl/explorerLabel (app/lib/eip7702.ts).
 *   - Auth: getAuthCreds (app/lib/auth-client.ts).
 *
 * ── SCOPE semantics ─────────────────────────────────────────────────────
 *   `scope` filters which key's settlements are shown (trial vs multichain
 *   key) — same data shape, different key scope. Not a layout change.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getAuthCreds, clearAuthCache } from "@/app/lib/auth-client";
import { explorerTxUrl, explorerLabel } from "@/app/lib/eip7702";
import type { ChainKey } from "@/app/lib/relayer";
import { Surface, Eyebrow, V2AccentScope, displayFont, shortAddr } from "../primitives";
import { v2, fs, V2_ACCENT_SOFT, V2_ACCENT_LINE, V2_ACCENT_FILL } from "../theme";
import type { Scope } from "../theme";
import { RequestsList } from "./RequestsList";

export interface ActivityViewProps {
  /** Connected owner address (null until wallet connects). */
  ownerAddress: string | null;
  /** Wallet message signer — needed to auth the tx-history fetch. */
  signMessage: (message: string) => Promise<string | null>;
  /** Active scope — selects which API key's settlements to show. */
  scope: Scope;
}

// ── Reused data shapes (mirror the server / v1 dashboard) ────────────────────
/** Mirrors app/lib/db.ts RelayedTx (the subset the ledger renders). */
interface RelayedTx {
  apiKey: string;
  address: string;
  chain: string;
  fromUser: string;
  toUser: string;
  tokenAmount: number | string;
  tokenSymbol: string;
  gasCostNative: number;
  relayTxHash: string;
  relayedAt: string;
  receiptId?: string;
  source?: "recurring" | "send" | "batch" | "api" | "yield_deposit" | "yield_withdraw" | "request" | "stake" | "unstake";
  ruleId?: string;
  /** Settlement rail — only set to "x402" for Coinbase x402 (Base USDC
   *  EIP-3009) rows; q402 (default) is left undefined and shows no badge. */
  rail?: "q402" | "x402";
  /**
   * Demo-only presentation overrides (set only on DEMO rows; absent on real
   * relayed txs). Let the in-file preview data render richer kinds/sub-lines
   * and non-"Settled" statuses without touching the live data path.
   */
  _demoKind?: string;
  _demoSub?: string;
  _demoStatus?: { kind: "success" | "pending" | "failed"; label: string };
}

/** Mirrors app/lib/ccip-bridge-runner.ts BridgeHistoryRecord (render subset). */
interface BridgeRecord {
  messageId: string;
  txHash: string;
  owner: string;
  walletId: string;
  src: string;
  dst: string;
  amount: string; // raw 6-dec USDC
  feeToken: string;
  feeWhole: number;
  initiatedAt: number;
  status: "processing" | "success" | "failed";
}

/** Mirrors AgenticWalletPublic (the fields the wallet filter needs). */
interface WalletRow {
  address: string;
  walletId: string;
  label: string | null;
}

type RailTab = "all" | "manual" | "recurring" | "yield" | "staking" | "request" | "bridge" | "receipts";

const RAIL: { id: RailTab; label: string; hint: string }[] = [
  { id: "all", label: "All settlements", hint: "Every relayed payment" },
  { id: "manual", label: "Manual sends", hint: "Send · batch · API" },
  { id: "recurring", label: "Recurring fires", hint: "Scheduled payouts" },
  { id: "yield", label: "Yield", hint: "Aave + Morpho deposits · withdrawals" },
  { id: "staking", label: "Staking", hint: "Q stake · unstake" },
  { id: "request", label: "Requests", hint: "Inbound payment requests" },
  { id: "bridge", label: "Bridge history", hint: "CCIP cross-chain" },
  { id: "receipts", label: "Trust Receipts", hint: "Verifiable receipts" },
];

/**
 * URL persistence — the rail filter lives in `?source=` so a reload keeps the
 * active tab and the link is shareable. Mirrors the legacy Transactions tab's
 * `?source=` behaviour (page.tsx pre-v2), widened to the five v2 rail tabs.
 * "all" is the implicit default and is omitted from the URL (clean links).
 */
const RAIL_IDS = new Set<string>(RAIL.map((r) => r.id));
function parseSource(raw: string | null): RailTab {
  return raw && RAIL_IDS.has(raw) ? (raw as RailTab) : "all";
}
function parseScopeParam(raw: string | null): Scope | null {
  return raw === "trial" || raw === "multichain" ? raw : null;
}

// ── Chain meta — colour + display name (matches v1 CHAIN_META) ───────────────
const CHAIN_META: Record<string, { name: string; color: string }> = {
  bnb: { name: "BNB Chain", color: "#F0B90B" },
  eth: { name: "Ethereum", color: "#627EEA" },
  avax: { name: "Avalanche", color: "#E84142" },
  xlayer: { name: "X Layer", color: "#bcc6d6" },
  stable: { name: "Stable", color: v2.mint },
  mantle: { name: "Mantle", color: "#FFFFFF" },
  injective: { name: "Injective", color: "#0082FA" },
  monad: { name: "Monad", color: "#836EF9" },
  scroll: { name: "Scroll", color: "#EEB431" },
  arbitrum: { name: "Arbitrum", color: "#28A0F0" },
  base: { name: "Base", color: "#0052FF" },
};

function chainName(chain: string): string {
  return CHAIN_META[chain]?.name ?? chain.toUpperCase();
}
function chainColor(chain: string): string {
  return CHAIN_META[chain]?.color ?? v2.muted;
}

const SOURCE_LABEL: Record<NonNullable<RelayedTx["source"]>, string> = {
  recurring: "Recurring fire",
  send: "Manual send",
  batch: "Batch send",
  api: "API settlement",
  yield_deposit: "Yield deposit",
  yield_withdraw: "Yield withdrawal",
  request: "Payment request",
  stake: "Q stake",
  unstake: "Q unstake",
};

function settlementKind(tx: RelayedTx): string {
  return tx.source ? SOURCE_LABEL[tx.source] : "Settlement";
}

// Sources where value flows INTO the Agent Wallet rather than out of it. Used
// only for the in/out arrow — everything else reads as outbound.
const INBOUND_SOURCES = new Set<string>(["yield_withdraw", "unstake", "request"]);
function txInbound(tx: RelayedTx): boolean {
  return !!tx.source && INBOUND_SOURCES.has(tx.source);
}

function fmtDate(iso: string | number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function shortHash(h: string): string {
  return h ? `${h.slice(0, 8)}…${h.slice(-6)}` : "—";
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

// Withdraw-all yield settlements record the "max" sentinel as the amount (the
// exact drawn balance isn't known until the on-chain event), so rendering it
// numerically would surface "NaN". Show "All" instead, and degrade any other
// non-finite value to a dash rather than NaN.
function fmtTxAmount(v: number | string): string {
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "max") return "All";
    if (t === "") return "—"; // unstake records no amount (variable principal+reward)
  }
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

// ── DEMO data ────────────────────────────────────────────────────────────────
/**
 * Preview rows shown when no wallet is connected (or before live data loads)
 * so the ledger reads as complete at first glance instead of an empty
 * "connect a wallet" state. Replaced wholesale the moment real settlements
 * arrive for a connected owner. The `apiKey` deliberately matches the demo
 * key set (DEMO_KEYS) so scope filtering keeps every preview row visible.
 */
const DEMO_KEY = "q402_demo_preview";
const DEMO_KEYS = new Set<string>([DEMO_KEY]);

const DEMO_WALLET_OPS = "0x662f9a3D0c1b4e5f8a7c2d9e0f1a2b3c4d5e623c";
const DEMO_WALLET_PAYOUTS = "0x4D9b21cFa07e3b18d54a09cE7b1F2a3C4d5E6f70";
const DEMO_WALLET_DEPOSITS = "0x8aE0c41Bf3D29a07C1b54e09ce7B1f2a3c4d5e6f";

const DEMO_TO = "0x1F0a3b9C2d7e4f5061728394a5b6c7d8e9f0a1b2";

const DEMO_WALLETS: WalletRow[] = [
  { address: DEMO_WALLET_OPS, walletId: "wal_ops", label: "Operations" },
  { address: DEMO_WALLET_PAYOUTS, walletId: "wal_payouts", label: "Creator payouts" },
  { address: DEMO_WALLET_DEPOSITS, walletId: "wal_deposits", label: "Treasury deposits" },
];

const DEMO_TXS: RelayedTx[] = [
  {
    apiKey: DEMO_KEY,
    address: DEMO_WALLET_OPS,
    chain: "bnb",
    fromUser: DEMO_WALLET_OPS,
    toUser: DEMO_TO,
    tokenAmount: "1.00",
    tokenSymbol: "USDT",
    gasCostNative: 0.00012,
    relayTxHash: "0x4f28a1c39b7e0d52f6a4c8b1e93d70a25c6f8b14e0d2a73591c4be07f2389a16",
    relayedAt: new Date().toISOString(),
    receiptId: "rct_4f28a1c3",
    source: "api",
    _demoKind: "Payment",
    _demoSub: "just now",
    _demoStatus: { kind: "success", label: "Settled" },
  },
  {
    apiKey: DEMO_KEY,
    address: DEMO_WALLET_PAYOUTS,
    chain: "bnb",
    fromUser: DEMO_WALLET_PAYOUTS,
    toUser: DEMO_TO,
    tokenAmount: "120.00",
    tokenSymbol: "USDT",
    gasCostNative: 0.0003,
    relayTxHash: "0x9c1d70b3e6a48f0259c7b1e83d04a96f2b5c8d71e0a23f6491cbe7052a8d39f4",
    relayedAt: new Date(Date.now() - 36 * 3600_000).toISOString(),
    source: "recurring",
    ruleId: "rule_payout_weekly",
    _demoKind: "Contributor payout",
    _demoSub: "Recurring · next Jul 7",
    _demoStatus: { kind: "pending", label: "Scheduled" },
  },
  {
    apiKey: DEMO_KEY,
    address: DEMO_WALLET_DEPOSITS,
    chain: "eth",
    fromUser: DEMO_WALLET_DEPOSITS,
    toUser: DEMO_TO,
    tokenAmount: "200.00",
    tokenSymbol: "USDC",
    gasCostNative: 0.0019,
    relayTxHash: "0x2a7f0c91d4b3e6058a1c7b2e94d35a07f6c8b21d3e0a49f7591cbe6048d2a73f",
    relayedAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
    receiptId: "rct_2a7f0c91",
    source: "api",
    _demoKind: "Deposit received",
    _demoSub: "Ethereum · USDC",
    _demoStatus: { kind: "success", label: "Confirmed" },
  },
  {
    apiKey: DEMO_KEY,
    address: DEMO_WALLET_OPS,
    chain: "bnb",
    fromUser: DEMO_WALLET_OPS,
    toUser: DEMO_TO,
    tokenAmount: "48.50",
    tokenSymbol: "USDT",
    gasCostNative: 0.00011,
    relayTxHash: "0x7b3e0a49f7591cbe6048d2a73f2a7f0c91d4b3e6058a1c7b2e94d35a07f6c8b2",
    relayedAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
    source: "send",
    _demoKind: "Vendor invoice",
    _demoSub: "Manual send",
    _demoStatus: { kind: "success", label: "Settled" },
  },
  {
    apiKey: DEMO_KEY,
    address: DEMO_WALLET_OPS,
    chain: "avax",
    fromUser: DEMO_WALLET_OPS,
    toUser: DEMO_TO,
    tokenAmount: "15.00",
    tokenSymbol: "USDC",
    gasCostNative: 0.004,
    relayTxHash: "0x1c4be07f2389a164f28a1c39b7e0d52f6a4c8b1e93d70a25c6f8b14e0d2a7359",
    relayedAt: new Date(Date.now() - 50 * 3600_000).toISOString(),
    source: "batch",
    _demoKind: "Batch payout",
    _demoSub: "Batch send · 6 recipients",
    _demoStatus: { kind: "success", label: "Settled" },
  },
  {
    apiKey: DEMO_KEY,
    address: DEMO_WALLET_PAYOUTS,
    chain: "stable",
    fromUser: DEMO_WALLET_PAYOUTS,
    toUser: DEMO_TO,
    tokenAmount: "75.00",
    tokenSymbol: "USDT0",
    gasCostNative: 0.0,
    relayTxHash: "0x39f4b5c8d71e0a23f6491cbe7052a8d9c1d70b3e6a48f0259c7b1e83d04a96f2",
    relayedAt: new Date(Date.now() - 72 * 3600_000).toISOString(),
    receiptId: "rct_39f4b5c8",
    source: "api",
    _demoKind: "Subscription charge",
    _demoSub: "Stable · USDT0",
    _demoStatus: { kind: "success", label: "Settled" },
  },
];

const DEMO_BRIDGES: BridgeRecord[] = [
  {
    messageId: "0xccip0001a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d5",
    txHash: "0x6d2a73591c4be07f2389a164f28a1c39b7e0d52f6a4c8b1e93d70a25c6f8b14e",
    owner: DEMO_WALLET_OPS,
    walletId: "wal_ops",
    src: "eth",
    dst: "avax",
    amount: "25000000", // 25 USDC (6-dec)
    feeToken: "LINK",
    feeWhole: 0.0421,
    initiatedAt: Date.now() - 4 * 3600_000,
    status: "success",
  },
  {
    messageId: "0xccip0002b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d5e6",
    txHash: "0x8b14e0d2a73591c4be07f2389a164f28a1c39b7e0d52f6a4c8b1e93d70a25c6f",
    owner: DEMO_WALLET_OPS,
    walletId: "wal_ops",
    src: "avax",
    dst: "bnb",
    amount: "60000000", // 60 USDC (6-dec)
    feeToken: "LINK",
    feeWhole: 0.0388,
    initiatedAt: Date.now() - 1 * 3600_000,
    status: "processing",
  },
];

// ── view ─────────────────────────────────────────────────────────────────────
/**
 * Public entry. `ActivityViewInner` reads `useSearchParams` (for the `?source=`
 * rail-filter persistence), which Next 16 requires to sit under a Suspense
 * boundary. We provide that boundary here so the requirement is fully contained
 * in this file (the /dashboard route itself adds none). The fallback never
 * actually paints — searchParams resolve synchronously on the client — but the
 * boundary keeps `next build` from flagging a missing-Suspense prerender error.
 */
export function ActivityView(props: ActivityViewProps) {
  return (
    <Suspense fallback={null}>
      <ActivityViewInner {...props} />
    </Suspense>
  );
}

function ActivityViewInner({ ownerAddress, signMessage, scope }: ActivityViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Seed the rail filter from `?source=` so deeplinks + reloads land on the
  // right tab. Read once on mount (initializer); subsequent URL writes go
  // through `selectTab` below.
  const [tab, setTab] = useState<RailTab>(() => parseSource(searchParams.get("source")));
  const [txs, setTxs] = useState<RelayedTx[]>([]);
  const [bridges, setBridges] = useState<BridgeRecord[]>([]);
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  // Scope key sets — built from the provision response (trial vs paid).
  const [trialKeys, setTrialKeys] = useState<Set<string>>(new Set());
  const [paidKeys, setPaidKeys] = useState<Set<string>>(new Set());
  // Scoped sponsored-TX credit counts from the provision response — the same
  // source of truth the legacy Overview's "Sponsored TXs Left" card used
  // (provision returns `trialCredits` / `paidCredits`). null until loaded so
  // the stat is shown ONLY when a real count is available (never fabricated).
  const [trialCredits, setTrialCredits] = useState<number | null>(null);
  const [paidCredits, setPaidCredits] = useState<number | null>(null);
  const [walletFilter, setWalletFilter] = useState<string>("all"); // walletId | "all"
  const [chainFilter, setChainFilter] = useState<string>("all"); // chain | "all"
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ── Provision → key sets (mirrors page.tsx:1503-1525 scoping logic) ──────
  const loadProvision = useCallback(async () => {
    if (!ownerAddress) return;
    const auth = await getAuthCreds(ownerAddress, signMessage);
    if (!auth) return;
    try {
      const res = await fetch("/api/keys/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: ownerAddress, nonce: auth.nonce, signature: auth.signature }),
      });
      const d = (await res.json()) as Record<string, unknown>;
      if (res.status === 401 && d.code === "NONCE_EXPIRED") {
        clearAuthCache(ownerAddress);
        return;
      }
      const isTrialOnly = d.plan === "trial";
      const hasPaid = d.hasPaid === true;
      const multichainKey = (d.multichainApiKey ?? d.apiKey) as string | undefined;
      const multichainSandbox = (d.multichainSandboxApiKey ?? d.sandboxApiKey) as string | undefined;
      const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

      setTrialKeys(
        new Set(
          [
            d.trialApiKey,
            d.trialSandboxApiKey,
            // legacy: trial activations wrote into apiKey/sandboxApiKey
            isTrialOnly ? d.apiKey : null,
            isTrialOnly ? d.sandboxApiKey : null,
          ].filter(str),
        ),
      );
      setPaidKeys(
        new Set([hasPaid ? multichainKey : null, hasPaid ? multichainSandbox : null].filter(str)),
      );

      // Scoped sponsored-TX credits — provision is the source of truth (same
      // fields the legacy Overview read). Only set when numeric so the stat
      // card stays hidden rather than rendering a fabricated 0.
      if (typeof d.trialCredits === "number") setTrialCredits(d.trialCredits);
      if (typeof d.paidCredits === "number") setPaidCredits(d.paidCredits);
    } catch {
      /* non-fatal — table simply shows nothing in scope */
    }
  }, [ownerAddress, signMessage]);

  // ── Transactions (mirrors page.tsx:1089-1098) ───────────────────────────
  const loadTxs = useCallback(async () => {
    if (!ownerAddress) return;
    const auth = await getAuthCreds(ownerAddress, signMessage);
    if (!auth) return;
    const res = await fetch(
      `/api/transactions?address=${ownerAddress}&nonce=${encodeURIComponent(auth.nonce)}&sig=${encodeURIComponent(auth.signature)}`,
    );
    if (res.status === 401) {
      const d = await res.json();
      if (d.code === "NONCE_EXPIRED") clearAuthCache(ownerAddress);
      return;
    }
    // Surface non-401 failures (5xx etc.) instead of silently rendering an
    // empty table — the outer load effect catches this and shows the error.
    if (!res.ok) throw new Error(`Activity failed to load (HTTP ${res.status}).`);
    const data = await res.json();
    if (Array.isArray(data.txs)) setTxs(data.txs as RelayedTx[]);
  }, [ownerAddress, signMessage]);

  // ── Bridge history (GET /api/ccip/bridge-history; param `signature`) ─────
  const loadBridges = useCallback(async () => {
    if (!ownerAddress) return;
    const auth = await getAuthCreds(ownerAddress, signMessage);
    if (!auth) return;
    const url = new URL("/api/ccip/bridge-history", window.location.origin);
    url.searchParams.set("address", ownerAddress);
    url.searchParams.set("nonce", auth.nonce);
    url.searchParams.set("signature", auth.signature);
    const res = await fetch(url.toString());
    if (res.status === 401) {
      const d = await res.json().catch(() => null);
      if (d?.code === "NONCE_EXPIRED") clearAuthCache(ownerAddress);
      return;
    }
    const data = await res.json().catch(() => null);
    if (data && Array.isArray(data.records)) setBridges(data.records as BridgeRecord[]);
  }, [ownerAddress, signMessage]);

  // ── Agent wallet list (for the wallet filter; same fetch as the Tab) ─────
  const loadWallets = useCallback(async () => {
    if (!ownerAddress) return;
    const auth = await getAuthCreds(ownerAddress, signMessage);
    if (!auth) return;
    const qs = new URLSearchParams({
      address: ownerAddress,
      nonce: auth.nonce,
      sig: auth.signature,
    }).toString();
    const res = await fetch(`/api/wallet/agentic?${qs}`);
    if (res.status === 401) {
      const d = await res.json().catch(() => null);
      if (d?.code === "NONCE_EXPIRED") clearAuthCache(ownerAddress);
      return;
    }
    const data = await res.json().catch(() => null);
    if (data && Array.isArray(data.wallets)) {
      setWallets(
        (data.wallets as WalletRow[]).map((w) => ({
          address: w.address,
          walletId: w.walletId,
          label: w.label,
        })),
      );
    }
  }, [ownerAddress, signMessage]);

  useEffect(() => {
    if (!ownerAddress) {
      setTxs([]);
      setBridges([]);
      setWallets([]);
      setTrialKeys(new Set());
      setPaidKeys(new Set());
      setTrialCredits(null);
      setPaidCredits(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    (async () => {
      try {
        await Promise.all([loadProvision(), loadTxs(), loadBridges(), loadWallets()]);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load activity.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerAddress, loadProvision, loadTxs, loadBridges, loadWallets]);

  // ── URL persistence (?source=…&scope=…) ──────────────────────────────────
  // Write the active rail filter to `?source=` (omitted when "all" for clean
  // links) and the active scope to `?scope=`, replacing — not pushing — so the
  // back button isn't polluted and the link is shareable + survives reload.
  // Scope is owned by the shell (prop), so this view only REFLECTS it into the
  // URL; it never drives the shell from the query.
  const writeUrl = useCallback(
    (nextTab: RailTab) => {
      const params = new URLSearchParams(searchParams.toString());
      if (nextTab === "all") params.delete("source");
      else params.set("source", nextTab);
      params.set("scope", scope);
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : window.location.pathname, { scroll: false });
    },
    [router, searchParams, scope],
  );

  // Tab selector — updates state + URL together so the rail click and the
  // address bar never drift.
  const selectTab = useCallback(
    (next: RailTab) => {
      setTab(next);
      writeUrl(next);
    },
    [writeUrl],
  );

  // Keep `?scope=` in sync when the shell flips scope while this view is open
  // (the rail tab is preserved). Runs on scope changes only.
  useEffect(() => {
    const current = parseScopeParam(searchParams.get("scope"));
    if (current === scope) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("scope", scope);
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : window.location.pathname, { scroll: false });
    // searchParams intentionally omitted: this effect reacts to scope flips,
    // not to its own URL writes (which would loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, router]);

  // ── Demo fallback ─────────────────────────────────────────────────────────
  // Demo fill is MARKETING fill — shown ONLY to a DISCONNECTED visitor so the
  // landing-style preview reads as populated instead of an empty placeholder.
  // A CONNECTED owner with zero settlements gets their REAL (empty) ledger and
  // an honest empty state — NOT six fabricated dollar-amount rows that read as
  // real movement on their account. (loading / err render their own states via
  // the !demoMode branches in the table below.)
  const demoMode = !ownerAddress;

  // Source the table inputs from demo or live data behind one switch so the
  // downstream scope/rail/filter pipeline is identical for both paths.
  const srcTxs = demoMode ? DEMO_TXS : txs;
  const srcBridges = demoMode ? DEMO_BRIDGES : bridges;
  const srcWallets = demoMode ? DEMO_WALLETS : wallets;

  // ── Derived: scope + rail-tab + filter chips ─────────────────────────────
  const scopeKeys = demoMode ? DEMO_KEYS : scope === "trial" ? trialKeys : paidKeys;

  // Scope-filtered settlements (trial vs multichain key set), mirroring
  // page.tsx scopedTxsAllSources. If the scope key set is empty (no
  // provisioned keys for this scope yet) nothing matches — same as v1.
  const scopedTxs = useMemo(
    () => srcTxs.filter((tx) => scopeKeys.has(tx.apiKey)),
    [srcTxs, scopeKeys],
  );

  // Chains present across the scoped settlements + bridges (for chips).
  const availableChains = useMemo(() => {
    const s = new Set<string>();
    for (const tx of scopedTxs) if (tx.chain) s.add(tx.chain);
    return [...s];
  }, [scopedTxs]);

  // ── 14-day daily-transactions chart (ported from legacy Overview) ─────────
  // Bucket the scope-filtered settlements by local calendar day across the
  // last 14 days. Same derivation the legacy Overview used (page.tsx) — built
  // from `scopedTxs` so trial vs multichain scope show independent activity.
  const { dailyData, dailyLabels } = useMemo(() => {
    const data: number[] = [];
    const labels: string[] = [];
    const today = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toDateString();
      labels.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
      data.push(scopedTxs.filter((tx) => new Date(tx.relayedAt).toDateString() === key).length);
    }
    return { dailyData: data, dailyLabels: labels };
  }, [scopedTxs]);

  // Headline stats. Total Relayed + Today's Txs derive from the loaded
  // settlements (always available). Sponsored-TXs-left comes from the
  // provision response and is shown ONLY when a real count is known for the
  // active scope (never in demo mode, never fabricated).
  const totalRelayed = scopedTxs.length;
  const todaysTxs = dailyData[13] ?? 0;
  const sponsoredLeft = demoMode ? null : scope === "trial" ? trialCredits : paidCredits;

  // Rail-tab settlement subset.
  const railTxs = useMemo(() => {
    if (tab === "manual")
      return scopedTxs.filter(
        (tx) => tx.source === "send" || tx.source === "batch" || tx.source === "api",
      );
    if (tab === "recurring") return scopedTxs.filter((tx) => tx.source === "recurring");
    if (tab === "yield") return scopedTxs.filter((tx) => tx.source === "yield_deposit" || tx.source === "yield_withdraw");
    if (tab === "staking") return scopedTxs.filter((tx) => tx.source === "stake" || tx.source === "unstake");
    if (tab === "request") return scopedTxs.filter((tx) => tx.source === "request");
    if (tab === "receipts") return scopedTxs.filter((tx) => !!tx.receiptId);
    return scopedTxs; // "all"
  }, [scopedTxs, tab]);

  // Apply wallet + chain filter chips, newest first.
  const visibleTxs = useMemo(() => {
    const selectedWalletAddr =
      walletFilter === "all"
        ? null
        : srcWallets.find((w) => w.walletId === walletFilter)?.address.toLowerCase() ?? null;
    return [...railTxs]
      .filter((tx) => {
        if (selectedWalletAddr && tx.fromUser.toLowerCase() !== selectedWalletAddr) return false;
        if (chainFilter !== "all" && tx.chain !== chainFilter) return false;
        return true;
      })
      .reverse();
  }, [railTxs, walletFilter, chainFilter, srcWallets]);

  // Bridge rows respect the wallet + chain filter (chain matches src or dst).
  const visibleBridges = useMemo(() => {
    if (walletFilter === "all" && chainFilter === "all") return srcBridges;
    return srcBridges.filter((b) => {
      if (walletFilter !== "all" && b.walletId.toLowerCase() !== walletFilter.toLowerCase())
        return false;
      if (chainFilter !== "all" && b.src !== chainFilter && b.dst !== chainFilter) return false;
      return true;
    });
  }, [srcBridges, walletFilter, chainFilter]);

  const showBridge = tab === "bridge";
  const totalInView = showBridge ? visibleBridges.length : visibleTxs.length;

  return (
    <V2AccentScope style={{ paddingTop: 17 }}>
      <div
        className="v2-view-shell"
        style={{
          display: "grid",
          gridTemplateColumns: "230px 1fr",
          gap: 18,
          alignItems: "start",
        }}
      >
        {/* ── Col 1 · context rail ─────────────────────────────────── */}
        <Surface className="v2-context" style={{ padding: 14, position: "sticky", top: 84 }}>
          <Eyebrow style={{ marginBottom: 10 }}>Activity</Eyebrow>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {RAIL.map((r) => {
              const active = r.id === tab;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => selectTab(r.id)}
                  style={{
                    textAlign: "left",
                    border: active ? `1px solid ${v2.line}` : "1px solid transparent",
                    background: active ? V2_ACCENT_FILL : "transparent",
                    borderRadius: 10,
                    padding: "11px 13px",
                    cursor: "pointer",
                  }}
                >
                  <div
                    style={{
                      fontSize: fs.body,
                      fontWeight: active ? 700 : 500,
                      color: active ? v2.yellow : v2.text,
                    }}
                  >
                    {r.label}
                  </div>
                  <div style={{ fontSize: fs.label, color: v2.muted2, marginTop: 2 }}>{r.hint}</div>
                </button>
              );
            })}
          </div>

          <div
            style={{
              marginTop: 14,
              paddingTop: 12,
              borderTop: `1px solid ${v2.line}`,
              fontSize: fs.label,
              color: v2.muted2,
              lineHeight: 1.6,
            }}
          >
            Scope <span style={{ color: v2.yellow }}>{demoMode ? "preview" : scope}</span> ·{" "}
            <span style={{ color: v2.muted }}>{scopedTxs.length}</span> settlements
            {srcBridges.length > 0 && (
              <>
                {" "}· <span style={{ color: v2.muted }}>{srcBridges.length}</span> bridges
              </>
            )}
          </div>
        </Surface>

        {/* ── Col 2 · stats strip + view-main ──────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
          <ActivityStatsStrip
            totalRelayed={totalRelayed}
            todaysTxs={todaysTxs}
            sponsoredLeft={sponsoredLeft}
            scope={scope}
            demoMode={demoMode}
            dailyData={dailyData}
            dailyLabels={dailyLabels}
          />

          <Surface style={{ padding: 21 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ font: `600 ${fs.h2}px ${displayFont}`, letterSpacing: "-.04em" }}>
                  {tab === "request" ? "Payment requests" : "Settlement activity"}
                </div>
                {demoMode && <PreviewChip connected={!!ownerAddress} />}
                {demoMode && <ScopeChip label={scope === "trial" ? "Trial · BNB" : "Multichain · 11 chains"} />}
              </div>
              <div style={{ color: v2.muted, fontSize: fs.body, marginTop: 6, maxWidth: 460, lineHeight: 1.5 }}>
                {tab === "request" ? (
                  <>Invoices you&apos;ve issued. Create new ones from Wallets → Payment requests.</>
                ) : demoMode ? (
                  <>Manual, scheduled, and cross-chain execution. Showing example settlements.</>
                ) : (
                  <>
                    Manual, scheduled, and cross-chain execution. Filtered to the{" "}
                    <span style={{ color: v2.yellow }}>{scope}</span> key scope.
                  </>
                )}
              </div>
            </div>
            {tab !== "request" && (
              <div style={{ color: v2.muted, fontSize: fs.label, fontFamily: displayFont }}>
                {totalInView} in view
              </div>
            )}
          </div>

          {/* Filter chips — wallet + chain. Hidden for the requests tab (the
              invoice list isn't filtered by wallet/network). */}
          {tab !== "request" && (
          <div
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              marginTop: 14,
              marginBottom: 4,
            }}
          >
            <FilterChip
              label="All wallets"
              active={walletFilter === "all"}
              onClick={() => setWalletFilter("all")}
            />
            {srcWallets.map((w) => (
              <FilterChip
                key={w.walletId}
                label={w.label?.trim() || shortAddr(w.address)}
                active={walletFilter === w.walletId}
                onClick={() => setWalletFilter(w.walletId)}
              />
            ))}
            {(availableChains.length > 0 || chainFilter !== "all") && (
              <span style={{ width: 1, background: v2.line, margin: "2px 4px" }} aria-hidden />
            )}
            {availableChains.length > 0 && (
              <FilterChip
                label="All networks"
                active={chainFilter === "all"}
                onClick={() => setChainFilter("all")}
              />
            )}
            {availableChains.map((c) => (
              <FilterChip
                key={c}
                label={chainName(c)}
                dot={chainColor(c)}
                active={chainFilter === c}
                onClick={() => setChainFilter(c)}
              />
            ))}
          </div>
          )}

          {/* ── Table ─────────────────────────────────────────────── */}
          {/* Demo mode renders the populated table directly (no connect/empty
              placeholder). Live errors still surface; live loading only shows a
              spinner when there is no demo fallback to display (i.e. never,
              since demoMode covers the !ownerAddress and empty cases). */}
          <div style={{ marginTop: 12 }}>
            {tab === "request" ? (
              <RequestsList ownerAddress={ownerAddress} signMessage={signMessage} />
            ) : !demoMode && err ? (
              <Empty text={err} tone="red" />
            ) : !demoMode && loading ? (
              <Empty text="Loading activity…" />
            ) : showBridge ? (
              <BridgeTable bridges={visibleBridges} />
            ) : (
              <SettlementTable txs={visibleTxs} emptyFor={tab} />
            )}
          </div>
          </Surface>
        </div>
      </div>
    </V2AccentScope>
  );
}

// ── Activity stats strip + 14-day chart (ported from legacy Overview) ─────────
/**
 * Headline stats + a 14-day daily-transactions bar chart, ported from the
 * legacy Overview (page.tsx — "Total Relayed" / "Today's Txs" / "Sponsored
 * TXs Left" cards + the `<BarChart/>`). v2 re-skin: glass mini-cards, yellow
 * bars, Space Grotesk numerals, muted axis/labels. No emoji, no green —
 * "today" reads as a brighter yellow bar instead of the legacy green accent.
 *
 * `sponsoredLeft` is null whenever the count isn't known for the active scope
 * (demo mode, or provision hasn't returned a numeric credit count) — that card
 * is then omitted rather than showing a fabricated value.
 */
function ActivityStatsStrip({
  totalRelayed,
  todaysTxs,
  sponsoredLeft,
  scope,
  demoMode,
  dailyData,
  dailyLabels,
}: {
  totalRelayed: number;
  todaysTxs: number;
  sponsoredLeft: number | null;
  scope: Scope;
  demoMode: boolean;
  dailyData: number[];
  dailyLabels: string[];
}) {
  const scopeSub = scope === "trial" ? "trial · all time" : "multichain · all time";
  const stats: { label: string; value: string; sub: string }[] = [
    { label: "Total Relayed", value: fmtNum(totalRelayed), sub: demoMode ? "preview" : scopeSub },
    { label: "Today's Txs", value: fmtNum(todaysTxs), sub: "today" },
  ];
  if (sponsoredLeft !== null) {
    stats.push({
      label: "Sponsored TXs Left",
      value: fmtNum(sponsoredLeft),
      sub: scope === "trial" ? "trial · BNB only" : `${scope} plan`,
    });
  }

  return (
    <Surface style={{ padding: 21 }}>
      {/* Headline stat mini-cards. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 10,
        }}
      >
        {stats.map((s) => (
          <div
            key={s.label}
            style={{
              border: `1px solid ${v2.line}`,
              background: "rgba(255,255,255,.02)",
              borderRadius: 13,
              padding: "13px 15px",
            }}
          >
            <div
              style={{
                fontSize: fs.label,
                letterSpacing: ".1em",
                textTransform: "uppercase",
                fontWeight: 700,
                color: v2.muted2,
              }}
            >
              {s.label}
            </div>
            <div
              style={{
                font: `600 ${fs.hero}px ${displayFont}`,
                letterSpacing: "-.03em",
                color: v2.text,
                marginTop: 6,
                lineHeight: 1.05,
              }}
            >
              {s.value}
            </div>
            <div style={{ fontSize: fs.label, color: v2.muted2, marginTop: 3 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* 14-day daily-transactions bar chart. */}
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${v2.line}` }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontSize: fs.cardTitle, fontWeight: 600, color: v2.text }}>
              Daily transactions
            </div>
            <div style={{ fontSize: fs.label, color: v2.muted2, marginTop: 2 }}>Last 14 days</div>
          </div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 14,
              fontSize: fs.label,
              color: v2.muted2,
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span
                style={{ width: 8, height: 8, borderRadius: 2, background: V2_ACCENT_LINE }}
                aria-hidden
              />
              Previous
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span
                style={{ width: 8, height: 8, borderRadius: 2, background: v2.yellow }}
                aria-hidden
              />
              Today
            </span>
          </div>
        </div>
        <DailyLineChart data={dailyData} labels={dailyLabels} />
      </div>
    </Surface>
  );
}

// ── 14-day line chart ────────────────────────────────────────────────────────
/**
 * Yellow-on-glass daily LINE chart: a gold polyline over a faded area fill.
 * Today's point is a larger glowing dot; earlier days are small muted markers,
 * each carrying an accessible title with its exact count. Every 3rd day prints a
 * muted axis label (day-of-month). The line uses a non-scaling stroke so it
 * stays crisp under the non-uniform SVG stretch to the container width.
 */
function DailyLineChart({ data, labels }: { data: number[]; labels: string[] }) {
  const max = Math.max(...data, 1);
  const n = data.length;
  const xPad = 2;
  const yTop = 10;
  const yBot = 94;
  const px = (i: number) => (n <= 1 ? 50 : xPad + (i / (n - 1)) * (100 - 2 * xPad));
  const py = (v: number) => yBot - (v / max) * (yBot - yTop);
  const pts = data.map((v, i) => [px(i), py(v)] as const);
  const linePath = "M " + pts.map(([x, y]) => `${x} ${y}`).join(" L ");
  const areaPath =
    `M ${px(0)} ${yBot} L ` + pts.map(([x, y]) => `${x} ${y}`).join(" L ") + ` L ${px(n - 1)} ${yBot} Z`;
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ position: "relative", height: 108 }}>
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          width="100%"
          height="100%"
          style={{ display: "block" }}
          aria-hidden
        >
          <defs>
            <linearGradient id="dailyLineFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={v2.yellow} stopOpacity={0.16} />
              <stop offset="100%" stopColor={v2.yellow} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={areaPath} fill="url(#dailyLineFill)" />
          <path
            d={linePath}
            fill="none"
            stroke={v2.yellow}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {pts.map(([x, y], i) => {
          const isToday = i === n - 1;
          return (
            <span
              key={i}
              title={`${labels[i]}: ${fmtNum(data[i] ?? 0)} tx`}
              style={{
                position: "absolute",
                left: `${x}%`,
                top: `${y}%`,
                width: isToday ? 8 : 4,
                height: isToday ? 8 : 4,
                marginLeft: isToday ? -4 : -2,
                marginTop: isToday ? -4 : -2,
                borderRadius: "50%",
                background: isToday ? v2.yellow : V2_ACCENT_LINE,
                boxShadow: isToday ? `0 0 6px ${v2.yellow}` : "none",
              }}
            />
          );
        })}
        {/* Invisible per-day hover columns so the exact count shows when hovering
            anywhere over a day's slice (the line/dots alone are hard to hit). */}
        <div style={{ position: "absolute", inset: 0, display: "flex" }} aria-hidden>
          {data.map((v, i) => (
            <div key={i} style={{ flex: 1, minWidth: 0 }} title={`${labels[i]}: ${fmtNum(v ?? 0)} tx`} />
          ))}
        </div>
      </div>
      <div style={{ display: "flex", marginTop: 6 }}>
        {labels.map((lab, i) => (
          <span
            key={i}
            style={{
              flex: 1,
              minWidth: 0,
              textAlign: "center",
              fontSize: fs.micro,
              fontFamily: displayFont,
              color: v2.muted2,
              whiteSpace: "nowrap",
              visibility: i % 3 === 0 ? "visible" : "hidden",
            }}
            aria-hidden={i % 3 !== 0}
          >
            {lab?.split(" ")[1]}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Filter chip ──────────────────────────────────────────────────────────────
function FilterChip({
  label,
  active,
  onClick,
  dot,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  dot?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        border: `1px solid ${active ? V2_ACCENT_LINE : v2.line}`,
        background: active ? V2_ACCENT_SOFT : "rgba(255,255,255,.02)",
        color: active ? v2.yellow : v2.muted,
        fontSize: fs.label,
        fontWeight: active ? 700 : 500,
        padding: "7px 11px",
        borderRadius: 8,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {dot && (
        <span
          style={{ width: 6, height: 6, borderRadius: 999, background: dot, flexShrink: 0 }}
        />
      )}
      {label}
    </button>
  );
}

// ── Settlement table (relayed txs) ───────────────────────────────────────────
function SettlementTable({ txs, emptyFor }: { txs: RelayedTx[]; emptyFor: RailTab }) {
  if (txs.length === 0) {
    const msg =
      emptyFor === "recurring"
        ? "No recurring fires in this scope yet. Scheduled payouts appear here once the cron fires them."
        : emptyFor === "manual"
          ? "No manual sends (send / batch / API) in this scope yet."
          : emptyFor === "yield"
            ? "No yield settlements in this scope yet. Aave deposits and withdrawals appear here once you supply or redeem."
            : emptyFor === "staking"
              ? "No Q staking activity in this scope yet. Stake and unstake settlements appear here once you stake Q."
              : emptyFor === "request"
                ? "No payment-request settlements in this scope yet. A paid invoice shows here once a payer or agent settles it."
                : emptyFor === "receipts"
                  ? "No Trust Receipts yet. Settlements with a verifiable receipt show a View link."
                  : "No settlements in this scope yet.";
    return <Empty text={msg} />;
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", minWidth: 620, borderCollapse: "collapse" }}>
        <thead>
          <Tr head>
            <Th>Settlement</Th>
            <Th>From → To</Th>
            <Th>Network</Th>
            <Th>Status</Th>
            <Th align="right">Amount</Th>
          </Tr>
        </thead>
        <tbody>
          {txs.map((tx, i) => {
            // tx.chain is a freeform string; explorerTxUrl returns "" for
            // unknown chains, so we gate the link on a real http URL.
            const txUrl = explorerTxUrl(tx.chain as ChainKey, tx.relayTxHash);
            const hasExplorer = txUrl.startsWith("http");
            return (
              <Tr key={`${tx.relayTxHash}-${i}`}>
                <Td>
                  <div style={{ fontSize: fs.cardTitle, color: v2.text, fontWeight: 500, display: "flex", alignItems: "center", gap: 7 }}>
                    <span
                      title={txInbound(tx) ? "Inbound" : "Outbound"}
                      aria-hidden
                      style={{ color: txInbound(tx) ? v2.mint : v2.muted2, fontFamily: displayFont }}
                    >
                      {txInbound(tx) ? "↓" : "↑"}
                    </span>
                    {tx._demoKind ?? settlementKind(tx)}
                    {tx.rail === "x402" && (
                      <span
                        title="Settled on the Coinbase x402 rail (USDC EIP-3009)"
                        style={{
                          fontSize: fs.micro,
                          fontWeight: 600,
                          color: v2.cyan,
                          border: "1px solid rgba(88,199,244,.32)",
                          background: "rgba(88,199,244,.10)",
                          borderRadius: 5,
                          padding: "1px 6px",
                          lineHeight: 1.5,
                        }}
                      >
                        x402
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: fs.body, color: v2.muted2, marginTop: 3 }}>
                    {tx._demoSub ?? fmtDate(tx.relayedAt)} ·{" "}
                    {hasExplorer ? (
                      <a
                        href={txUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Open on ${explorerLabel(tx.chain as ChainKey)}`}
                        style={{
                          color: v2.yellow,
                          fontFamily: displayFont,
                          textDecoration: "none",
                        }}
                      >
                        {shortHash(tx.relayTxHash)} ↗
                      </a>
                    ) : (
                      <span style={{ fontFamily: displayFont }}>{shortHash(tx.relayTxHash)}</span>
                    )}
                    {tx.receiptId && (
                      <>
                        {" · "}
                        <a
                          href={`/receipt/${tx.receiptId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: v2.mint, textDecoration: "none" }}
                        >
                          Receipt ↗
                        </a>
                      </>
                    )}
                  </div>
                </Td>
                <Td>
                  <span
                    style={{ fontSize: fs.base, color: v2.muted, fontFamily: displayFont, whiteSpace: "nowrap" }}
                    title={`${tx.fromUser} → ${tx.toUser}`}
                  >
                    {shortAddr(tx.fromUser)} <span style={{ color: v2.muted2 }}>→</span> {shortAddr(tx.toUser)}
                  </span>
                </Td>
                <Td>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: fs.base,
                      color: v2.muted,
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 999,
                        background: chainColor(tx.chain),
                        flexShrink: 0,
                      }}
                    />
                    {chainName(tx.chain)}
                  </span>
                </Td>
                <Td>
                  <StatusPill
                    kind={tx._demoStatus?.kind ?? "success"}
                    label={tx._demoStatus?.label ?? "Settled"}
                  />
                </Td>
                <Td align="right">
                  <span style={{ fontSize: fs.base, fontWeight: 600, fontFamily: displayFont }}>
                    {fmtTxAmount(tx.tokenAmount)}{" "}
                    <span style={{ color: v2.muted2, fontWeight: 400 }}>{tx.tokenSymbol}</span>
                  </span>
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Bridge table (CCIP records) ──────────────────────────────────────────────
function BridgeTable({ bridges }: { bridges: BridgeRecord[] }) {
  if (bridges.length === 0) {
    return <Empty text="No CCIP bridges yet. Cross-chain transfers appear here once initiated." />;
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", minWidth: 620, borderCollapse: "collapse" }}>
        <thead>
          <Tr head>
            <Th>Bridge</Th>
            <Th>Lane</Th>
            <Th>Fee</Th>
            <Th>Status</Th>
            <Th align="right">Amount</Th>
          </Tr>
        </thead>
        <tbody>
          {bridges.map((b, i) => {
            const usdc = Number(b.amount) / 1e6; // raw 6-dec USDC
            const txUrl = explorerTxUrl(b.src as ChainKey, b.txHash);
            const hasExplorer = txUrl.startsWith("http");
            return (
              <Tr key={`${b.messageId}-${i}`}>
                <Td>
                  <div style={{ fontSize: fs.cardTitle, color: v2.text, fontWeight: 500 }}>CCIP bridge</div>
                  <div style={{ fontSize: fs.body, color: v2.muted2, marginTop: 3 }}>
                    {fmtDate(b.initiatedAt)} ·{" "}
                    {hasExplorer ? (
                      <a
                        href={txUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Open on ${explorerLabel(b.src as ChainKey)}`}
                        style={{
                          color: v2.yellow,
                          fontFamily: displayFont,
                          textDecoration: "none",
                        }}
                      >
                        {shortHash(b.txHash)} ↗
                      </a>
                    ) : (
                      <span style={{ fontFamily: displayFont }}>{shortHash(b.txHash)}</span>
                    )}
                  </div>
                </Td>
                <Td>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: fs.base,
                      color: v2.muted,
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 999,
                        background: chainColor(b.src),
                        flexShrink: 0,
                      }}
                    />
                    {chainName(b.src)} <span style={{ color: v2.muted2 }}>→</span>{" "}
                    {chainName(b.dst)}
                  </span>
                </Td>
                <Td>
                  <span style={{ fontSize: fs.base, color: v2.muted, fontFamily: displayFont }}>
                    {b.feeWhole.toFixed(4)} {b.feeToken}
                  </span>
                </Td>
                <Td>
                  <StatusPill
                    kind={b.status === "success" ? "success" : b.status === "failed" ? "failed" : "pending"}
                    label={b.status === "success" ? "Delivered" : b.status === "failed" ? "Failed" : "In flight"}
                  />
                </Td>
                <Td align="right">
                  <span style={{ fontSize: fs.base, fontWeight: 600, fontFamily: displayFont }}>
                    {usdc.toFixed(2)} <span style={{ color: v2.muted2, fontWeight: 400 }}>USDC</span>
                  </span>
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Table primitives ─────────────────────────────────────────────────────────
function Tr({ children, head }: { children: React.ReactNode; head?: boolean }) {
  return (
    <tr style={{ borderBottom: `1px solid ${head ? v2.line : "rgba(255,255,255,.05)"}` }}>
      {children}
    </tr>
  );
}
function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      style={{
        textAlign: align,
        fontSize: fs.label,
        letterSpacing: ".12em",
        textTransform: "uppercase",
        fontWeight: 700,
        color: v2.muted2,
        padding: "0 13px 12px",
      }}
    >
      {children}
    </th>
  );
}
function Td({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return <td style={{ textAlign: align, padding: "14px 13px", verticalAlign: "middle" }}>{children}</td>;
}

function StatusPill({ kind, label }: { kind: "success" | "pending" | "failed"; label: string }) {
  const color = kind === "success" ? v2.mint : kind === "failed" ? v2.red : v2.yellow;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: fs.label,
        fontWeight: 700,
        color,
        background: `${color}14`,
        border: `1px solid ${color}33`,
        padding: "5px 10px",
        borderRadius: 999,
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: 999, background: color }} />
      {label}
    </span>
  );
}

// ── Preview chip ─────────────────────────────────────────────────────────────
/** Shown only in demo mode, beside the view title — signals example data.
 *  Copy depends on whether a wallet is connected: a connected wallet with no
 *  settlements yet is in demo mode too, so telling them to "connect your
 *  wallet" would be wrong — they already did. */
function PreviewChip({ connected }: { connected: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: fs.label,
        fontWeight: 700,
        letterSpacing: ".02em",
        color: v2.yellow,
        background: V2_ACCENT_SOFT,
        border: `1px solid ${V2_ACCENT_LINE}`,
        padding: "5px 10px",
        borderRadius: 999,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: 999, background: v2.yellow }} />
      {connected
        ? "Preview · example data until your first settlement"
        : "Preview · connect your wallet for live data"}
    </span>
  );
}

// ── Scope chip ───────────────────────────────────────────────────────────────
/**
 * Shown only in demo mode beside the PreviewChip — a neutral glass badge that
 * surfaces the active key scope (mirrors the hero scope badge in WalletsView).
 * Stays neutral (not yellow/mint): scope is informational status, and yellow is
 * already claimed by the adjacent Preview action chip.
 */
function ScopeChip({ label }: { label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: fs.label,
        fontWeight: 600,
        letterSpacing: ".01em",
        color: "#adb7c7",
        background: "rgba(255,255,255,.02)",
        border: `1px solid ${v2.line}`,
        padding: "5px 10px",
        borderRadius: 999,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function Empty({ text, tone }: { text: string; tone?: "red" }) {
  return (
    <div
      style={{
        padding: "44px 16px",
        textAlign: "center",
        fontSize: fs.body,
        color: tone === "red" ? v2.red : v2.muted,
        border: `1px dashed ${v2.line}`,
        borderRadius: 12,
        marginTop: 6,
        lineHeight: 1.5,
      }}
    >
      {text}
    </div>
  );
}
