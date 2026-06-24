"use client";

/**
 * WalletsView — the 3-column "Agent Wallets" workspace (the prototype's
 * default view, id="wallets").
 *
 * This is the centerpiece. It re-lays-out and re-skins the existing Agent
 * Wallet surface into the v2 prototype's 3-column .workspace
 * (230px rail · minmax(560,1fr) console · 338px right rail). ALL business
 * logic is reused from the shipped agentic-wallet stack — this file owns
 * ONLY presentation + the v2 chrome:
 *
 *   - Wallet list + create + per-wallet balances are fetched against the
 *     SAME endpoints AgenticWalletTab uses (GET/POST /api/wallet/agentic,
 *     GET /api/wallet/agentic/balance), with the SAME getAuthCreds session
 *     handshake and NONCE_EXPIRED → clearAuthCache recovery.
 *   - Every fund-moving / destructive action opens the EXISTING modal
 *     (Send / Receive / Batch / Bridge / Limits / Hooks / Agent / Withdraw),
 *     each of which self-auths via getActionAuth. We do not re-implement a
 *     single write path.
 *   - Yield (Earn) reuses <AgenticWalletEarnSection/>; recurring/automation
 *     reuses <AgenticWalletRecurringSection/> — both own their own data.
 *   - Payment policy toggles + guardrails read the wallet's real Hooks
 *     config (GET /api/wallet/agentic/hooks) + the wallet's native
 *     perTxMaxUsd / dailyLimitUsd; edits route through the real Hooks /
 *     Limits modals.
 *
 * Everything that renders emerald inside the reused components is re-skinned
 * to v2 yellow because the whole tree is wrapped in <V2AccentScope> (which
 * tags `.v2-accent-scope`; the re-map rules live in app/globals.css).
 *
 * SCOPE: `scope` ("trial" | "multichain") is threaded into the modals'
 * gating via `hasMultichainScope` (resolved server-side from the wallet
 * list response) AND surfaced as a badge. Trial = BNB-only / trial key;
 * multichain = 11 chains / live key. It does not change layout structure.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Surface,
  V2AccentScope,
  Eyebrow,
  SectionHead,
  LinkButton,
  displayFont,
  shortAddr,
} from "../primitives";
import { v2, subCard, fs, gasTankCoinGradient } from "../theme";
import type { Scope, V2ViewId } from "../theme";
import { ChainIcon, TokenIcon, StablePair, Q402Mark, SparkIcon, AgentBadgeIcon, GasTankIcon, GearIcon } from "../logos";
import { useDashboardIdentity } from "../identity-context";
import { getAuthCreds, clearAuthCache } from "@/app/lib/auth-client";
import { explorerTxUrl, explorerLabel, CHAIN_KEYS } from "@/app/lib/eip7702";
import type { ChainKey } from "@/app/lib/relayer";
import type { AgenticWalletPublic } from "@/app/dashboard/components/AgenticWalletTab";
import { AgenticWalletEarnSection } from "@/app/dashboard/components/AgenticWalletEarnSection";
import { AgenticWalletStakeModal } from "@/app/dashboard/components/AgenticWalletStakeModal";
import { SendGlyph, ReceiveGlyph, BatchGlyph, WithdrawGlyph } from "@/app/dashboard/components/action-icons";
import { AgenticWalletRecurringSection } from "@/app/dashboard/components/AgenticWalletRecurringSection";
import { RequestComposerModal } from "./RequestComposerModal";
import { AgenticWalletSendModal } from "@/app/dashboard/components/AgenticWalletSendModal";
import { AgenticWalletReceiveModal } from "@/app/dashboard/components/AgenticWalletReceiveModal";
import { AgenticWalletBatchModal } from "@/app/dashboard/components/AgenticWalletBatchModal";
import { AgenticWalletBridgeModal } from "@/app/dashboard/components/AgenticWalletBridgeModal";
import { AgenticWalletLimitsModal } from "@/app/dashboard/components/AgenticWalletLimitsModal";
import { AgenticWalletHooksModal } from "@/app/dashboard/components/AgenticWalletHooksModal";
import { AgenticWalletAgentModal } from "@/app/dashboard/components/AgenticWalletAgentModal";
import { AgenticWalletWithdrawModal, type WithdrawBucket } from "@/app/dashboard/components/AgenticWalletWithdrawModal";
import { AgenticWalletDangerZone } from "@/app/dashboard/components/AgenticWalletDangerZone";
import type { WalletHookConfig } from "@/app/lib/hooks/types";

export interface WalletsViewProps {
  /** Connected owner address (null until wallet connects). */
  ownerAddress: string | null;
  /** Wallet message signer from useWallet(). Required by the agentic data layer. */
  signMessage: (message: string) => Promise<string | null>;
  /** Active scope from the top-bar ScopeChip. Gates active key + chain set. */
  scope: Scope;
  /** Shell view switcher — lets in-view links (e.g. "View all") jump to
   *  another v2 view (the shell is state-driven, so a URL push alone wouldn't
   *  switch). Optional so the view still renders standalone. */
  onNavigate?: (view: V2ViewId) => void;
}

// ── Local mirrors of the shipped payloads (kept thin; no server imports) ────

/** /api/wallet/agentic/balance perChain bucket — mirrors AgenticWalletCard. */
interface ChainBucket {
  chain: string;
  usdc: { usd: number } | null;
  usdt: { usd: number } | null;
  totalUsd: number | null;
  error?: string;
}
interface BalancePayload {
  asOf: number;
  totalUsd: number;
  perChain: ChainBucket[];
  /** QuackAI Q token total in TOKEN UNITS (BNB-only). Separate from totalUsd
   *  by design — Q is not 1:1 USD-pegged. Undefined on older server payloads. */
  quackTotal?: number;
}

/** /api/transactions row — mirrors app/lib/db.ts RelayedTx (subset used here). */
interface RelayedTx {
  chain: string;
  fromUser: string;
  toUser: string;
  tokenAmount: number | string;
  tokenSymbol: string;
  relayTxHash: string;
  relayedAt: string;
  receiptId?: string;
  source?: "recurring" | "send" | "batch" | "api";
  /** "x402" only for Coinbase x402 (Base USDC EIP-3009) rows; q402 default = undefined. */
  rail?: "q402" | "x402";
}

const CHAIN_LABEL: Record<string, string> = {
  bnb: "BNB Chain",
  eth: "Ethereum",
  avax: "Avalanche",
  xlayer: "X Layer",
  stable: "Stable",
  mantle: "Mantle",
  injective: "Injective",
  monad: "Monad",
  scroll: "Scroll",
  arbitrum: "Arbitrum",
  base: "Base",
};

// Allocation-bar segment colours, in prototype order (yellow / cyan / violet …).
const SEG_COLORS = [v2.yellow, v2.cyan, v2.chartViolet, v2.mint, "#c98bff", "#ff9d6b"];

// Brand-logo primitives (chains + tokens) — shared with the other v2 views.

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "$—";
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Plan name for the hero badge — "enterprise_flex" reads as "Enterprise". */
function planLabel(plan: string): string {
  const key = plan === "enterprise_flex" ? "enterprise" : plan;
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : "";
}

function agentIdFromTag(tag: string | null | undefined): string | null {
  if (typeof tag !== "string" || tag.length === 0) return null;
  const candidate = tag.includes(":") ? tag.split(":").pop() ?? "" : tag;
  return /^\d+$/.test(candidate) ? candidate : null;
}

/** Narrow a free-form chain string from the tx feed to a known ChainKey
 *  (the explorer helpers are typed over the union). Falls back to "bnb",
 *  which carries the bulk of settlements and is the safe default. */
function asChainKey(chain: string): ChainKey {
  return (CHAIN_KEYS as readonly string[]).includes(chain) ? (chain as ChainKey) : "bnb";
}

// Lightweight inline-hover helper: subtle bg (and optional border) on enter,
// cleared on leave. Skips disabled/active elements via the `skip` guard so we
// don't fight the active-item styling. Returns event handlers to spread.
function hoverBg(
  bg = "rgba(255,255,255,.035)",
  border?: string,
  skip?: () => boolean,
) {
  return {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      if (skip?.()) return;
      e.currentTarget.style.backgroundColor = bg;
      if (border) e.currentTarget.style.borderColor = border;
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      if (skip?.()) return;
      e.currentTarget.style.backgroundColor = "";
      if (border) e.currentTarget.style.borderColor = "";
    },
  };
}

function relativeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(diff / 3_600_000);
  const d = Math.floor(diff / 86_400_000);
  if (d >= 2) return `${d}d ago`;
  if (h >= 1) return `${h}h ago`;
  if (m >= 1) return `${m}m ago`;
  return "just now";
}

// ── Hooks → policy view model ───────────────────────────────────────────────
//
// The right-rail "Payment policy" card surfaces the four programmable
// protections the Hooks modal edits. Each toggle reflects the wallet's
// real stored config; clicking opens the real Hooks modal (no inline
// write — toggling here would need an intent-bound signature anyway, and
// the modal is the audited write path).

interface PolicyRow {
  key: string;
  label: string;
  detail: string;
  on: boolean;
}

function policyRowsFromConfig(cfg: WalletHookConfig | null): PolicyRow[] {
  const sc = cfg?.spendCap;
  const rg = cfg?.reputationGate;
  const approval = sc?.perCallApprovalUsd;
  const allow = sc?.allowedRecipients;
  return [
    {
      key: "compliance",
      label: "Compliance gate",
      detail: "Sanction screening · always on",
      on: true, // ComplianceGate is global, never disableable.
    },
    {
      key: "spend-approval",
      label: "Spend approval",
      detail:
        approval != null
          ? `Holds payments at $${approval}+`
          : "No soft approval threshold",
      on: Boolean(sc?.enabled) && approval != null,
    },
    {
      key: "reputation",
      label: "Reputation Gate",
      detail:
        rg?.enabled && rg.minScore != null
          ? `Min ERC-8004 score ${rg.minScore}`
          : "No reputation requirement",
      on: Boolean(rg?.enabled),
    },
    {
      key: "allowlist",
      label: "Recipient allowlist",
      detail:
        allow && allow.length > 0
          ? `${allow.length} address${allow.length === 1 ? "" : "es"} allowed`
          : "No restriction",
      on: Boolean(sc?.enabled) && Boolean(allow && allow.length > 0),
    },
  ];
}

// ── DEMO data ───────────────────────────────────────────────────────────────
//
// When no wallet is connected (or live data hasn't resolved a real active
// wallet yet) the whole console renders against this sample set so the
// dashboard looks finished at first glance. Connecting a wallet swaps in live
// data at the data level — the layout below never branches on demo vs live.
// Values mirror the q402-agentic-wallet-concept/dashboard-v2.html mockup.

const DEMO = {
  wallets: [
    {
      walletId: "0x3c528161f34ddeab0b71aede21ae42535e140abe",
      address: "0x3C528161f34ddEAB0b71Aede21ae42535E140abE",
      label: "Operations",
      balanceUsd: 300.0,
      erc8004: "114376",
      note: "Default wallet",
    },
    {
      walletId: "0x662f210e81ebee1d96b8b49256b9ddd9d5a7623c",
      address: "0x662f210e81ebee1d96b8b49256b9ddd9d5a7623c",
      label: "Creator payouts",
      balanceUsd: 84.2,
      erc8004: null as string | null,
      note: "2 recurring rules",
    },
  ],
  /** Active = Operations. Capital allocation 62/23/15. */
  allocation: [
    { chain: "bnb", pct: 62 },
    { chain: "eth", pct: 23 },
    { chain: "arbitrum", pct: 15 },
  ],
  activity: [
    {
      id: "demo-1",
      direction: "out" as const,
      chain: "bnb",
      title: "Payment to 0x662f…623c",
      meta: "BNB · USDT · Trust Receipt ready",
      amount: "−$1.00",
      status: "Settled",
    },
    {
      id: "demo-2",
      direction: "out" as const,
      chain: "bnb",
      title: "Monthly contributor payout",
      meta: "Next Jul 7 09:00 UTC",
      amount: "$120.00",
      status: "Scheduled",
    },
    {
      id: "demo-3",
      direction: "in" as const,
      chain: "eth",
      title: "Deposit received",
      meta: "Ethereum · USDC",
      amount: "+$200.00",
      status: "Confirmed",
    },
    {
      id: "demo-4",
      direction: "out" as const,
      chain: "avax",
      title: "Ethereum → Avalanche",
      meta: "CCIP",
      amount: "$25.00",
      status: "Delivered",
    },
  ],
  policy: {
    score: 82,
    rows: [
      { key: "compliance", label: "Compliance gate", detail: "Sanction screening · always on", on: true },
      { key: "spend-approval", label: "Spend approval", detail: "Human review at $50+", on: true },
      { key: "reputation", label: "Reputation Gate", detail: "Min ERC-8004 score 1", on: true },
      { key: "allowlist", label: "Recipient allowlist", detail: "No restriction", on: false },
    ] as PolicyRow[],
  },
  automation: [
    {
      id: "demo-auto-1",
      label: "Contributor payout",
      detail: "Monthly · day 7 · $120 USDT · 3 recipients · BNB",
      status: "ACTIVE" as const,
    },
    {
      id: "demo-auto-2",
      label: "Treasury rebalance",
      detail: "Bridge when Ethereum > $500",
      status: "READY" as const,
    },
  ],
  guardrails: { perTxMaxUsd: 200, dailyLimitUsd: 500 },
} as const;

export function WalletsView({ ownerAddress, signMessage, scope, onNavigate }: WalletsViewProps) {
  // ── Wallet list (same contract as AgenticWalletTab) ──────────────────────
  const [wallets, setWallets] = useState<AgenticWalletPublic[] | undefined>(undefined);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hasMultichainScope, setHasMultichainScope] = useState(false);
  const [meta, setMeta] = useState<{ cap: number; max: number; trialCap: number }>({
    cap: 1,
    max: 10,
    trialCap: 1,
  });
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Per-wallet balance cache (walletId → payload). Lazily filled; the
  // active wallet drives the hero + allocation. Rail balances come from
  // here too once fetched.
  const [balances, setBalances] = useState<Record<string, BalancePayload>>({});
  const [activeBalanceLoading, setActiveBalanceLoading] = useState(false);

  // Recent settlements (shared /api/transactions feed, filtered to the
  // active wallet's address for the "Recent activity" rows).
  const [txs, setTxs] = useState<RelayedTx[]>([]);

  // Active wallet's real Hooks config → policy toggles + score.
  const [hookConfig, setHookConfig] = useState<WalletHookConfig | null>(null);

  // Modal open flags — each opens an EXISTING self-authing modal.
  const [sendOpen, setSendOpen] = useState(false);
  const [stakeOpen, setStakeOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [hooksOpen, setHooksOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  // Withdraw / sweep — the picker opens, then a chosen bucket hands off
  // to the reused SendModal (the exact old-Card sweep flow).
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [withdrawBucket, setWithdrawBucket] = useState<WithdrawBucket | null>(null);
  const [copied, setCopied] = useState(false);

  const addr = ownerAddress;

  // ── List fetch — verbatim auth flow from AgenticWalletTab.reload ─────────
  const reload = useCallback(async () => {
    if (!addr) return;
    setError(null);
    const auth = await getAuthCreds(addr, signMessage);
    if (!auth) {
      setError("Sign the auth challenge to load your Agent Wallets.");
      setWallets([]);
      return;
    }
    const qs = new URLSearchParams({ address: addr, nonce: auth.nonce, sig: auth.signature }).toString();
    try {
      const res = await fetch(`/api/wallet/agentic?${qs}`);
      const data = await res.json();
      if (res.status === 401 && data.code === "NONCE_EXPIRED") {
        clearAuthCache(addr);
        setError("Session expired — sign in again to refresh.");
        setWallets([]);
        return;
      }
      if (!res.ok) {
        setError(data.error ?? "Failed to load Agent Wallets.");
        setWallets([]);
        return;
      }
      const list = (data.wallets ?? []) as AgenticWalletPublic[];
      setWallets(list);
      setHasMultichainScope(Boolean(data.hasMultichainScope));
      setMeta({
        cap: typeof data.cap === "number" ? data.cap : 1,
        max: typeof data.max === "number" ? data.max : 10,
        trialCap: typeof data.trialCap === "number" ? data.trialCap : 1,
      });
      setActiveId((prev) => {
        if (prev && list.some((w) => w.walletId === prev)) return prev;
        const firstActive = list.find((w) => !w.deletedAt);
        return firstActive?.walletId ?? list[0]?.walletId ?? null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWallets([]);
    }
  }, [addr, signMessage]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // ── Create — verbatim from AgenticWalletTab.create ───────────────────────
  const create = useCallback(async () => {
    if (!addr) return;
    setCreating(true);
    setError(null);
    try {
      const auth = await getAuthCreds(addr, signMessage);
      if (!auth) {
        setError("Sign the auth challenge to create a wallet.");
        return;
      }
      const res = await fetch("/api/wallet/agentic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: addr, nonce: auth.nonce, signature: auth.signature }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? "Failed to create wallet.");
        return;
      }
      const fresh = data.wallet as AgenticWalletPublic;
      setWallets((prev) => (prev ? [...prev, fresh] : [fresh]));
      setActiveId(fresh.walletId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [addr, signMessage]);

  const activeWallet = useMemo(() => {
    if (!wallets || wallets.length === 0) return null;
    return wallets.find((w) => w.walletId === activeId) ?? wallets[0];
  }, [wallets, activeId]);

  // ── Balance fetch for one wallet — mirrors AgenticWalletCard.fetchBalance ─
  const fetchBalance = useCallback(
    async (wallet: AgenticWalletPublic, opts?: { active?: boolean; force?: boolean }) => {
      if (!addr || wallet.deletedAt !== null) return;
      if (opts?.active) setActiveBalanceLoading(true);
      try {
        const auth = await getAuthCreds(addr, signMessage);
        if (!auth) return;
        const qs = new URLSearchParams({
          address: addr,
          nonce: auth.nonce,
          sig: auth.signature,
          walletId: wallet.walletId,
          ...(opts?.force ? { force: "1" } : {}),
        }).toString();
        const res = await fetch(`/api/wallet/agentic/balance?${qs}`);
        if (res.status === 401) {
          clearAuthCache(addr);
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as { balances?: BalancePayload };
        if (data.balances) {
          const next: BalancePayload = {
            asOf: data.balances.asOf,
            totalUsd: data.balances.totalUsd,
            perChain: data.balances.perChain ?? [],
            quackTotal: data.balances.quackTotal ?? 0,
          };
          setBalances((prev) => ({ ...prev, [wallet.walletId]: next }));
        }
      } catch {
        /* keep last known */
      } finally {
        if (opts?.active) setActiveBalanceLoading(false);
      }
    },
    [addr, signMessage],
  );

  // Fetch balances for every (non-archived) wallet once the list lands, so
  // the rail shows real $ per wallet. Cheap: same authed read the Tab does.
  const balancesPrimedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!wallets || wallets.length === 0) return;
    const sig = wallets.map((w) => w.walletId).join(",");
    if (balancesPrimedRef.current === sig) return;
    balancesPrimedRef.current = sig;
    for (const w of wallets) {
      if (w.deletedAt === null) void fetchBalance(w, { active: w.walletId === activeId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallets, fetchBalance]);

  // ── Recent settlements (active-wallet scoped) ────────────────────────────
  useEffect(() => {
    if (!addr) return;
    let cancelled = false;
    (async () => {
      const auth = await getAuthCreds(addr, signMessage);
      if (!auth) return;
      const res = await fetch(
        `/api/transactions?address=${addr}&nonce=${encodeURIComponent(auth.nonce)}&sig=${encodeURIComponent(auth.signature)}`,
      );
      if (res.status === 401) {
        const d = await res.json().catch(() => ({}));
        if (d?.code === "NONCE_EXPIRED") clearAuthCache(addr);
        return;
      }
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      if (!cancelled && Array.isArray(data.txs)) setTxs(data.txs as RelayedTx[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [addr, signMessage]);

  // ── Active wallet's Hooks config (policy toggles + score) ────────────────
  const loadHooks = useCallback(async () => {
    if (!addr || !activeWallet || activeWallet.deletedAt !== null) {
      setHookConfig(null);
      return;
    }
    const auth = await getAuthCreds(addr, signMessage);
    if (!auth) return;
    const qs = new URLSearchParams({
      walletId: activeWallet.walletId,
      address: addr,
      nonce: auth.nonce,
      signature: auth.signature,
    }).toString();
    try {
      const res = await fetch(`/api/wallet/agentic/hooks?${qs}`);
      if (res.status === 401) {
        clearAuthCache(addr);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) setHookConfig((data.config ?? null) as WalletHookConfig | null);
    } catch {
      /* leave policy at last known */
    }
  }, [addr, activeWallet, signMessage]);

  useEffect(() => {
    void loadHooks();
  }, [loadHooks]);

  // Switching the active wallet must not leave a modal open over the wrong
  // wallet — every open modal / picker / bucket resets when activeId changes.
  useEffect(() => {
    setSendOpen(false);
    setStakeOpen(false);
    setReceiveOpen(false);
    setBatchOpen(false);
    setBridgeOpen(false);
    setWithdrawOpen(false);
    setWithdrawBucket(null);
    setLimitsOpen(false);
    setHooksOpen(false);
    setAgentOpen(false);
  }, [activeId]);

  // ── Derived view models ──────────────────────────────────────────────────
  const activeBalance = activeWallet ? balances[activeWallet.walletId] ?? null : null;

  // Capital allocation: per-chain stablecoin share of the active wallet's
  // total, biggest first, top 3 → bar segments (prototype shows 3).
  const allocation = useMemo(() => {
    if (!activeBalance) return { total: 0, segs: [] as { chain: string; usd: number; usdc: number; usdt: number; pct: number }[] };
    const total = activeBalance.totalUsd;
    const segs = activeBalance.perChain
      .map((c) => ({ chain: c.chain, usd: c.totalUsd ?? 0, usdc: c.usdc?.usd ?? 0, usdt: c.usdt?.usd ?? 0 }))
      .filter((s) => s.usd > 0)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 6)
      .map((s) => ({ ...s, pct: total > 0 ? (s.usd / total) * 100 : 0 }));
    return { total, segs };
  }, [activeBalance]);

  // Gas Tank summary surfaced on the Wallets page (same reads TreasuryView
  // uses): relayer-gas balance per chain × price → total USD + funded chains.
  // Reuses the cached owner-auth (no extra sign prompt).
  const [gasTank, setGasTank] = useState<{ usd: number; funded: string[] } | null>(null);
  // Distinct from "loaded $0": true when the gas-tank fetch FAILED, so the card
  // shows "Unavailable" instead of a misleading $0.00 that reads as "empty".
  const [gasTankError, setGasTankError] = useState(false);
  useEffect(() => {
    if (!addr) {
      setGasTank(null);
      setGasTankError(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const auth = await getAuthCreds(addr, signMessage);
        if (!auth || cancelled) return;
        const qs = new URLSearchParams({ address: addr, nonce: auth.nonce, sig: auth.signature }).toString();
        const [balRes, priceRes] = await Promise.all([
          fetch(`/api/gas-tank/user-balance?${qs}`),
          fetch(`/api/gas-tank`),
        ]);
        const balData = (await balRes.json().catch(() => ({}))) as { balances?: Record<string, number> };
        const priceData = (await priceRes.json().catch(() => ({}))) as { tanks?: Array<{ key: string; price: number }> };
        if (cancelled) return;
        const balances = balData.balances ?? {};
        const prices: Record<string, number> = {};
        for (const t of priceData.tanks ?? []) prices[t.key] = t.price;
        const usd = Object.entries(balances).reduce((s, [c, a]) => s + a * (prices[c] ?? 0), 0);
        const funded = Object.entries(balances).filter(([, a]) => a > 0).map(([c]) => c);
        setGasTank({ usd, funded });
        setGasTankError(false);
      } catch {
        // Fetch failed — flag it so the card renders "Unavailable" rather than
        // a misleading $0.00 (which reads as "your tank is empty").
        if (!cancelled) setGasTankError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addr]);

  const policyRows = useMemo(() => policyRowsFromConfig(hookConfig), [hookConfig]);
  const protectionsActive = policyRows.filter((r) => r.on).length;
  // Score: 1 always-on compliance gate + each active programmable protection,
  // out of 4. Mirrors the prototype's "82 · 3 protections active" ring.
  const policyScore = Math.round((protectionsActive / policyRows.length) * 100);

  const recentForActive = useMemo(() => {
    if (!activeWallet) return [];
    const w = activeWallet.address.toLowerCase();
    // /api/transactions returns oldest-first (ActivityView reverses it for its
    // newest-first ledger). "Recent activity" wants the 4 MOST RECENT, newest
    // first — so sort by relayedAt desc BEFORE slicing, or a stale tx pins the
    // top and newer ones get cut off entirely.
    return txs
      .filter((t) => t.fromUser?.toLowerCase() === w || t.toUser?.toLowerCase() === w)
      .slice()
      .sort((a, b) => new Date(b.relayedAt).getTime() - new Date(a.relayedAt).getTime())
      .slice(0, 4);
  }, [txs, activeWallet]);

  const activeCount = (wallets ?? []).filter((w) => !w.deletedAt).length;
  const capReached = activeCount >= meta.cap;

  // Scope honoured: the top-bar ScopeChip is the user's *view* intent. In
  // "trial" scope we present (and gate to) BNB-only behaviour even when the
  // owner's subscription carries multichain scope server-side — so the
  // multichain-only actions (Batch / Bridge) only light up when BOTH the
  // server grants scope AND the user is viewing in multichain. This is the
  // only place layout reads `scope`; everything else is structure-invariant.
  const multichainActive = hasMultichainScope && scope === "multichain";

  async function copyActiveAddress() {
    if (!activeWallet) return;
    try {
      await navigator.clipboard.writeText(activeWallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  // Re-pull list + active balance after any modal write commits.
  const afterWrite = useCallback(() => {
    void reload();
    if (activeWallet) void fetchBalance(activeWallet, { active: true, force: true });
    void loadHooks();
  }, [reload, fetchBalance, activeWallet, loadHooks]);

  const archived = activeWallet?.deletedAt != null;

  // ── First-run (connected · zero wallets) ──────────────────────────────────
  //
  // A connected owner whose list has RESOLVED to zero wallets is not in demo —
  // they're a brand-new user who should be sold on creating their first Agent
  // Wallet, not shown the marketing sample. `firstRun` is true ONLY when: a
  // wallet is connected (addr set), the list fetch has landed (`wallets !==
  // undefined`, so we don't flash first-run while loading), the list is empty,
  // and no active wallet resolved. The empty-list guard keeps us out of the
  // archived-only case (where `activeWallet` resolves to an archived wallet and
  // the live console — not first-run — must render). The disconnected DEMO path
  // (addr === null) is unaffected.
  const firstRun =
    Boolean(addr) &&
    wallets !== undefined &&
    wallets.length === 0 &&
    activeWallet == null;

  // ── Demo fallback ─────────────────────────────────────────────────────────
  //
  // The console must look complete before any wallet connects. Demo mode is
  // ON whenever we don't yet have a real active wallet to drive the view:
  //   - no connected owner (ownerAddress === null), OR
  //   - connected but the wallet list / active wallet hasn't resolved yet.
  // It excludes `firstRun` (connected + resolved-empty), which renders its own
  // first-run surface instead of the sample data.
  // The MOMENT a real active wallet exists, every variable below resolves to
  // live data and the connected path is 100% intact (demoMode === false).
  const demoMode = activeWallet == null && !firstRun;

  // ── Free-trial CTA eligibility ────────────────────────────────────────────
  //
  // Surface the always-available "activate free trial" entry only when it makes
  // sense: a connected owner who is NOT already on an active trial and has NO
  // active paid subscription. Mirrors the legacy auto-pop eligibility
  // (app/dashboard/page.tsx) which skips paid users and existing trials. Reads
  // the canonical subscription facts published by the legacy page through the
  // identity context (no extra fetch).
  const identity = useDashboardIdentity();
  const onActiveTrial =
    identity.subscription?.isTrialActive === true ||
    identity.subscription?.plan === "trial";
  // Canonical paid signal: hasMultichainScope-derived (admin-granted /
  // sponsored accounts carry amountUSD === 0 but ARE paid-scoped). Keying
  // off amountUSD would wrongly offer them the free-trial CTA.
  const onActivePaid =
    identity.hasPaid === true &&
    !identity.isExpired;
  const trialCtaEligible = Boolean(addr) && !onActiveTrial && !onActivePaid;

  // View variables the layout reads. In live mode they are the real values;
  // in demo mode they are substituted from DEMO so the SAME layout renders
  // fully populated. No layout branch depends on demoMode.
  const railWallets: Array<{
    walletId: string;
    address: string;
    label: string | null;
    balanceUsd: number | null;
    note: string;
    archived: boolean;
    isDefault: boolean;
  }> = demoMode
    ? DEMO.wallets.map((w, i) => ({
        walletId: w.walletId,
        address: w.address,
        label: w.label,
        balanceUsd: w.balanceUsd,
        note: w.note,
        archived: false,
        isDefault: i === 0,
      }))
    : (wallets ?? []).map((w, i) => ({
        walletId: w.walletId,
        address: w.address,
        label: w.label,
        balanceUsd: balances[w.walletId]?.totalUsd ?? null,
        note: w.deletedAt != null
          ? "Archived"
          : w.erc8004AgentId
            ? `ERC-8004 · #${agentIdFromTag(w.erc8004AgentId) ?? "?"}`
            : i === 0
              ? "Default wallet"
              : "Managed wallet",
        archived: w.deletedAt != null,
        isDefault: w.walletId === wallets?.[0]?.walletId,
      }));

  // Active-wallet view model (identity + balance).
  const vmLabel = demoMode ? DEMO.wallets[0].label : (activeWallet?.label ?? "Agent wallet");
  const vmAddress = demoMode ? DEMO.wallets[0].address : (activeWallet?.address ?? "");
  const vmTotalUsd = demoMode ? DEMO.wallets[0].balanceUsd : activeBalance?.totalUsd;
  // Q is token-unit (not USD) so it rides next to the total as its own chip,
  // never folded into the portfolio $ figure.
  const vmQuack = demoMode ? 0 : activeBalance?.quackTotal ?? 0;
  const agentNum = demoMode ? DEMO.wallets[0].erc8004 : agentIdFromTag(activeWallet?.erc8004AgentId);

  // Capital allocation segments.
  const vmAlloc = demoMode
    ? {
        total: DEMO.wallets[0].balanceUsd,
        segs: DEMO.allocation.map((a) => ({ chain: a.chain, usd: 0, usdc: 0, usdt: 0, pct: a.pct })),
      }
    : allocation;

  // Gas Tank view model — demo shows the same figures as the Treasury demo.
  const vmGasTank = demoMode
    ? { usd: 18.42, funded: ["bnb", "eth", "arbitrum"] }
    : { usd: gasTank?.usd ?? 0, funded: gasTank?.funded ?? [] };

  // Policy view model.
  const vmPolicyRows = demoMode ? DEMO.policy.rows : policyRows;
  const vmProtectionsActive = vmPolicyRows.filter((r) => r.on).length;
  const vmPolicyScore = demoMode ? DEMO.policy.score : policyScore;

  // Guardrails.
  const vmPerTx = demoMode ? DEMO.guardrails.perTxMaxUsd : activeWallet?.perTxMaxUsd ?? null;
  const vmDaily = demoMode ? DEMO.guardrails.dailyLimitUsd : activeWallet?.dailyLimitUsd ?? null;

  return (
    <V2AccentScope style={{ paddingTop: 17 }}>
      <div className="v2-workspace" style={styles.workspace}>
        {/* ── Col 1 · Wallet rail ─────────────────────────────────────── */}
        <Surface className="v2-wallet-rail" style={styles.rail}>
          <Eyebrow>Agent wallets</Eyebrow>

          {railWallets.length === 0 ? (
            <div style={styles.railFirstRun}>
              <div style={styles.railFirstRunMark}>
                <Q402Mark size={22} />
              </div>
              <strong style={{ display: "block", fontSize: fs.body, color: v2.text }}>
                No Agent Wallets yet
              </strong>
              <span style={{ display: "block", color: v2.muted, fontSize: fs.label, lineHeight: 1.6, marginTop: 6 }}>
                Create your first sandboxed AI spending wallet — your MetaMask
                stays untouched. Set it up in the console.
              </span>
            </div>
          ) : (
            railWallets.map((w) => {
              const isActive = demoMode
                ? w.isDefault
                : w.walletId === (activeWallet?.walletId ?? activeId);
              return (
                <button
                  key={w.walletId}
                  type="button"
                  onClick={() => !demoMode && setActiveId(w.walletId)}
                  {...hoverBg("rgba(255,255,255,.03)", "rgba(255,255,255,.10)", () => isActive)}
                  style={{ ...styles.walletItem, ...(isActive ? styles.walletItemActive : null) }}
                  title={w.address}
                >
                  <div style={styles.walletName}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: isActive ? v2.text : "#9aa4b2" }}>
                      {w.label ?? "Agent wallet"}
                    </span>
                    {isActive ? (
                      <span style={styles.viewingBadge}>
                        <span style={styles.viewDot} /> Viewing
                      </span>
                    ) : w.archived ? (
                      <span style={styles.archBadge}>Archived</span>
                    ) : null}
                  </div>
                  <div style={styles.addr}>{shortAddr(w.address)}</div>
                  <div style={styles.walletBal}>
                    {w.balanceUsd != null ? fmtUsd(w.balanceUsd) : "$—"}
                  </div>
                  <div style={styles.walletNote}>{w.note}</div>
                </button>
              );
            })
          )}

          <button
            type="button"
            onClick={create}
            disabled={creating || capReached || !addr}
            style={{ ...styles.newWallet, opacity: creating || capReached || !addr ? 0.4 : 1 }}
            title={
              !addr
                ? "Connect your wallet"
                : capReached
                  ? hasMultichainScope
                    ? `Cap reached (${activeCount}/${meta.max}). Archive one to create a new wallet.`
                    : `Trial cap (${meta.trialCap}). Upgrade to Multichain for up to ${meta.max}.`
                  : "Create a new Agent Wallet"
            }
          >
            {creating ? "Creating…" : "＋ New wallet"}
          </button>

          <div style={styles.railFoot}>
            <div style={styles.mode}>
              <strong style={{ display: "block", color: v2.yellow, fontSize: fs.body }}>
                Mode C · Managed
              </strong>
              <span style={{ display: "block", color: v2.muted, fontSize: fs.label, lineHeight: 1.5, marginTop: 5 }}>
                Q402 signs for this dedicated wallet. Your personal wallet
                stays separate.
              </span>
            </div>
          </div>
        </Surface>

        {/* ── Col 2 · Console ─────────────────────────────────────────── */}
        <Surface className="v2-console" style={styles.console}>
          {error && (
            <div style={styles.errorBanner}>{error}</div>
          )}

          {/* ── First-run (connected · no wallets) ──────────────────────────
              Ports the spirit of AgenticWalletPreview into the v2 console:
              explains what an Agent Wallet is, sells the key benefits, and
              gives a prominent create CTA wired to the EXISTING create flow.
              Glass + yellow; no demo data, no emoji, no green. */}
          {firstRun && (
            <div style={styles.firstRun}>
              <div style={styles.heroGlow} aria-hidden />

              <div style={styles.firstRunHead}>
                <Q402Mark size={30} />
                <div style={{ minWidth: 0 }}>
                  <Eyebrow>Agent Wallet · not created yet</Eyebrow>
                  <h1 style={styles.firstRunH1}>Create your first Agent Wallet</h1>
                </div>
              </div>

              <p style={styles.firstRunLede}>
                A dedicated, sandboxed wallet your AI spends from — bounded by the
                caps you set. Your MetaMask stays untouched: one signature creates
                it, and Q402 signs every settlement for this wallet alone.
              </p>

              {/* Key benefits */}
              <div style={styles.firstRunBenefits}>
                {[
                  {
                    icon: <AgentBadgeIcon size={16} />,
                    title: "Your MetaMask stays separate",
                    body: "Q402 holds an encrypted key for this wallet only. Your personal funds are never exposed to the agent.",
                  },
                  {
                    icon: <GearIcon size={16} />,
                    title: "Hard spending caps",
                    body: "Per-payment and daily limits are enforced server-side on every send — the agent cannot exceed them.",
                  },
                  {
                    icon: <SparkIcon size={16} />,
                    title: "Plain-English control",
                    body: "Tell it what to do in your AI client. “Pay contributors on the 7th, but ask me above $50.”",
                  },
                  {
                    icon: <GasTankIcon size={16} />,
                    title: "Gas sponsored",
                    body: "Our relayer covers gas on 11 EVM chains — only the stablecoin moves from your Agent Wallet balance.",
                  },
                ].map((b) => (
                  <div key={b.title} style={{ ...subCard(13), padding: 13 }}>
                    <div style={styles.firstRunBenefitTop}>
                      <span style={styles.firstRunBenefitIcon}>{b.icon}</span>
                      <strong style={{ fontSize: fs.base }}>{b.title}</strong>
                    </div>
                    <span style={styles.firstRunBenefitBody}>{b.body}</span>
                  </div>
                ))}
              </div>

              {/* Create CTA — wired to the EXISTING create() flow */}
              <div style={styles.firstRunCtaRow}>
                <button
                  type="button"
                  onClick={create}
                  disabled={creating || capReached || !addr}
                  style={{
                    ...styles.firstRunCta,
                    opacity: creating || capReached || !addr ? 0.5 : 1,
                    cursor: creating || capReached || !addr ? "not-allowed" : "pointer",
                  }}
                  title={
                    capReached
                      ? hasMultichainScope
                        ? `Cap reached (${activeCount}/${meta.max}).`
                        : `Trial cap (${meta.trialCap}). Upgrade to Multichain for up to ${meta.max}.`
                      : "Create a new Agent Wallet"
                  }
                >
                  {creating ? "Creating…" : "＋ New wallet"}
                </button>
                <span style={styles.firstRunCtaNote}>
                  One signature from your MetaMask. Free to create. BNB Chain is
                  included on the trial; other chains need a Multichain key.
                </span>
              </div>

              {/* Activate free trial — subtle, always-available in-page entry */}
              {trialCtaEligible && (
                <button
                  type="button"
                  onClick={identity.openTrialActivation}
                  {...hoverBg("rgba(247,202,22,.07)", "rgba(247,202,22,.34)")}
                  style={styles.trialCta}
                >
                  <SparkIcon size={17} />
                  <span style={{ minWidth: 0, textAlign: "left" }}>
                    <strong style={{ display: "block", fontSize: fs.body, color: v2.text }}>
                      Activate your free trial
                    </strong>
                    <span style={{ display: "block", color: v2.muted, fontSize: fs.label, marginTop: 2 }}>
                      2,000 sponsored TX on BNB — no card required.
                    </span>
                  </span>
                  <span style={styles.trialCtaArrow}>Activate →</span>
                </button>
              )}
            </div>
          )}

          {(demoMode || activeWallet) && (
            <>
              {/* Hero */}
              <div style={styles.hero}>
                <div style={styles.heroGlow} aria-hidden />

                {demoMode && (
                  <div style={styles.previewChip} title="Sample data — connect your wallet to load live balances and activity">
                    <span style={styles.previewDot} />
                    Preview · connect your wallet for live data
                  </div>
                )}

                <div style={styles.identity}>
                  <div style={{ minWidth: 0 }}>
                    <Eyebrow>Agent Wallet</Eyebrow>
                    <h1 style={styles.heroH1}>{vmLabel}</h1>
                    <button
                      type="button"
                      onClick={demoMode ? undefined : copyActiveAddress}
                      style={{ ...styles.address, ...(demoMode ? { cursor: "default" } : null) }}
                      title={demoMode ? "Sample address" : "Copy address"}
                    >
                      <span style={{ overflowWrap: "anywhere" }}>{vmAddress}</span>
                      {!demoMode && (
                        <span style={{ color: copied ? v2.mint : v2.yellow, marginLeft: 6 }}>{copied ? "Copied!" : "copy"}</span>
                      )}
                    </button>
                    {/* Owner EOA — the connected personal wallet that controls this
                        Agent Wallet, surfaced distinctly from the agent address. */}
                    <div style={styles.ownerEoa}>
                      Owner EOA ·{" "}
                      <span style={{ fontFamily: displayFont, color: v2.muted }}>
                        {shortAddr(demoMode ? "0x7a3f29b8C1ea4D6f5B0c2E91aA73D4f8e2C5b9c21" : (addr ?? ""))}
                      </span>
                    </div>
                    <div style={styles.badges}>
                      <span style={{ ...styles.badge, ...styles.badgeGreen }}>
                        {archived ? "Archived" : "Ready to spend"}
                      </span>
                      <span style={styles.badge}>
                        {(demoMode ? scope === "multichain" : multichainActive)
                          ? "Multichain · 11 chains"
                          : "Trial · BNB"}
                      </span>
                      {agentNum && <span style={styles.badge}>ERC-8004 #{agentNum}</span>}
                      {/* ERC-8004 registration CTA — a clickable pill in the badge
                          row, right next to "Trial · BNB"; once registered the
                          "ERC-8004 #{agentNum}" badge above takes its place. */}
                      {!demoMode && !agentNum && activeWallet && !archived && (
                        <button
                          type="button"
                          onClick={() => setAgentOpen(true)}
                          title="Register this Agent Wallet as an ERC-8004 identity"
                          style={{
                            ...styles.badge,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            border: `1px solid ${v2.yellow}`,
                            color: v2.yellow,
                            background: "transparent",
                            cursor: "pointer",
                            fontFamily: "inherit",
                            lineHeight: 1,
                          }}
                        >
                          <AgentBadgeIcon size={12} />
                          Register on ERC-8004
                        </button>
                      )}
                      {(identity.subscription?.amountUSD ?? 0) > 0 && (
                        <span style={{ ...styles.badge, ...styles.badgePlan }}>
                          {planLabel(identity.plan)} Plan · ${identity.subscription?.amountUSD} paid
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={styles.heroBal}>
                    <span style={styles.heroBalLabel}>Total portfolio</span>
                    <strong style={styles.heroBalValue}>
                      {!demoMode && activeBalanceLoading && !activeBalance ? "…" : fmtUsd(vmTotalUsd)}
                    </strong>
                    {vmQuack > 0 && (
                      <span
                        title="QuackAI Q token balance on BNB. Held in token units (not USD-valued)."
                        style={{
                          marginTop: 4,
                          alignSelf: "flex-start",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          fontSize: 12,
                          fontWeight: 600,
                          color: "#8fd6f7",
                          background: "rgba(88,199,244,.10)",
                          border: "1px solid rgba(88,199,244,.28)",
                          borderRadius: 6,
                          padding: "2px 8px",
                        }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src="/logos/quack.svg" alt="" width={13} height={13} style={{ display: "block", flexShrink: 0 }} />
                        {vmQuack.toLocaleString(undefined, { maximumFractionDigits: 2 })} Q
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => activeWallet && fetchBalance(activeWallet, { active: true, force: true })}
                      disabled={demoMode || activeBalanceLoading}
                      style={styles.refreshLink}
                    >
                      {demoMode ? "Sample data" : activeBalanceLoading ? "Refreshing…" : "Updated · refresh ↻"}
                    </button>
                  </div>
                </div>

                {/* Actions — Send is the gold hero; the five utilities sit in a
                    compact tile cluster to its right. Each opens the EXISTING
                    modal; demo mode disables them (no wallet to act on). */}
                <div className="v2-actions" style={styles.actionsWrap}>
                  <button
                    type="button"
                    className="v2-hero"
                    disabled={demoMode || archived}
                    onClick={() => setSendOpen(true)}
                    title={demoMode ? "Connect your wallet" : undefined}
                    style={{ ...styles.actionHero, ...(demoMode || archived ? styles.heroDisabled : null) }}
                  >
                    <span style={styles.heroIcon}><SendGlyph size={18} color={v2.actionText} /></span>
                    <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                      <span style={styles.heroTitle}>Send payment</span>
                      <span style={styles.heroSub}>USDC / USDT</span>
                    </span>
                  </button>

                  <div style={styles.utilGrid}>
                    <button
                      type="button"
                      className="v2-tile"
                      disabled={demoMode || archived}
                      onClick={() => setReceiveOpen(true)}
                      title={demoMode ? "Connect your wallet" : undefined}
                      style={{ ...styles.actionTile, ...(demoMode || archived ? styles.tileDisabled : null) }}
                    >
                      <span style={styles.tileIcon}><ReceiveGlyph size={16} color={v2.cyan} /></span>
                      <span style={styles.tileLabel}>Receive</span>
                      <span style={styles.tileSub}>Show address</span>
                    </button>

                    <button
                      type="button"
                      className="v2-tile"
                      disabled={demoMode || archived || !multichainActive}
                      onClick={() => setBatchOpen(true)}
                      title={
                        demoMode
                          ? "Connect your wallet"
                          : multichainActive
                            ? undefined
                            : hasMultichainScope
                              ? "Switch the top-bar scope to Multichain to batch across chains."
                              : "Batch sends require an active Multichain subscription."
                      }
                      style={{ ...styles.actionTile, ...(demoMode || archived || !multichainActive ? styles.tileDisabled : null) }}
                    >
                      {!demoMode && !multichainActive && <span style={styles.paidChip}>Paid</span>}
                      <span style={styles.tileIcon}><BatchGlyph size={16} color={v2.cyan} /></span>
                      <span style={styles.tileLabel}>Batch</span>
                      <span style={styles.tileSub}>Up to 20</span>
                    </button>

                    <button
                      type="button"
                      className="v2-tile"
                      disabled={demoMode || archived || !multichainActive}
                      onClick={() => setBridgeOpen(true)}
                      title={
                        demoMode
                          ? "Connect your wallet"
                          : multichainActive
                            ? "Cross-chain USDC via Chainlink CCIP."
                            : hasMultichainScope
                              ? "Switch the top-bar scope to Multichain to bridge across chains."
                              : "Bridging requires an active Multichain subscription."
                      }
                      style={{ ...styles.actionTile, ...(demoMode || archived || !multichainActive ? styles.tileDisabled : null) }}
                    >
                      {!demoMode && !multichainActive && <span style={styles.paidChip}>Paid</span>}
                      <span style={styles.tileIcon}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src="/link.jpg" alt="" width={16} height={16} style={{ borderRadius: 4, flexShrink: 0 }} />
                      </span>
                      <span style={styles.tileLabel}>Bridge</span>
                      <span style={styles.tileSub}>CCIP</span>
                    </button>

                    <button
                      type="button"
                      className="v2-tile"
                      disabled={demoMode || archived}
                      onClick={() => setWithdrawOpen(true)}
                      title={demoMode ? "Connect your wallet" : "Sweep a chain/token bucket back to your wallet"}
                      style={{ ...styles.actionTile, ...(demoMode || archived ? styles.tileDisabled : null) }}
                    >
                      <span style={styles.tileIcon}><WithdrawGlyph size={16} color={v2.cyan} /></span>
                      <span style={styles.tileLabel}>Withdraw</span>
                      <span style={styles.tileSub}>Sweep out</span>
                    </button>

                    <button
                      type="button"
                      className="v2-tile"
                      disabled={demoMode || archived}
                      onClick={() => setStakeOpen(true)}
                      title={demoMode ? "Connect your wallet" : "Lock Q into QuackAiStake on BNB, gasless"}
                      style={{ ...styles.actionTile, ...(demoMode || archived ? styles.tileDisabled : null) }}
                    >
                      <span style={styles.tileIcon}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src="/logos/quack.svg" alt="" width={16} height={16} style={{ flexShrink: 0 }} />
                      </span>
                      <span style={styles.tileLabel}>Stake</span>
                      <span style={styles.tileSub}>Earn Q</span>
                    </button>
                  </div>
                </div>

                {/* MCP command bar */}
                <div
                  style={styles.command}
                  {...hoverBg("rgba(247,202,22,.04)", "rgba(247,202,22,.34)")}
                >
                  <div style={{ color: v2.yellow, display: "grid", placeItems: "center" }}>
                    <SparkIcon size={19} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ display: "block", fontSize: fs.body }}>Tell this wallet what to do</strong>
                    <span style={{ display: "block", color: v2.muted, fontSize: fs.label, marginTop: 3 }}>
                      &ldquo;Pay contributors on the 7th, but ask me above $50.&rdquo;
                    </span>
                  </div>
                  <a href="/docs#claude-mcp" style={styles.commandBtn}>
                    Open in MCP ↗
                  </a>
                </div>
              </div>

              {/* Content */}
              <div style={styles.content}>
                {/* Activate free trial — subtle, always-available in-console
                    entry for a connected user with no active sub / trial. The
                    page also auto-pops the modal; this is the persistent entry.
                    (firstRun renders its own copy above; demo is excluded.) */}
                {!demoMode && trialCtaEligible && (
                  <button
                    type="button"
                    onClick={identity.openTrialActivation}
                    {...hoverBg("rgba(247,202,22,.07)", "rgba(247,202,22,.34)")}
                    style={styles.trialCta}
                  >
                    <SparkIcon size={17} />
                    <span style={{ minWidth: 0, textAlign: "left" }}>
                      <strong style={{ display: "block", fontSize: fs.body, color: v2.text }}>
                        Activate your free trial
                      </strong>
                      <span style={{ display: "block", color: v2.muted, fontSize: fs.label, marginTop: 2 }}>
                        2,000 sponsored TX on BNB — no card required.
                      </span>
                    </span>
                    <span style={styles.trialCtaArrow}>Activate →</span>
                  </button>
                )}

                {/* Capital overview — Stablecoins + Gas Tank on one row, Yield below */}
                <section>
                  <SectionHead title="Capital overview" meta="11 networks monitored" />
                  <div style={styles.allocation}>
                    <div style={{ ...subCard(13), padding: 14 }}>
                      <div style={styles.assetTop}>
                        <div style={styles.token}>
                          <StablePair size={26} />
                          <div>
                            Stablecoins
                            <div style={styles.sub}>USDT · USDC · available to agents</div>
                          </div>
                        </div>
                        <div style={{ font: `600 19px ${displayFont}` }}>{fmtUsd(vmAlloc.total)}</div>
                      </div>
                      <div style={styles.chainbar}>
                        {vmAlloc.segs.length > 0 ? (
                          vmAlloc.segs.map((s, i) => (
                            <i
                              key={s.chain}
                              style={{
                                display: "block",
                                width: `${s.pct}%`,
                                background: SEG_COLORS[i % SEG_COLORS.length],
                              }}
                            />
                          ))
                        ) : (
                          <i style={{ display: "block", width: "100%", background: v2.toggleOff }} />
                        )}
                      </div>
                      <div style={styles.breakdown}>
                        {vmAlloc.segs.length > 0 ? (
                          vmAlloc.segs.flatMap((s) => {
                            // One row per (chain, token) holding so the token and
                            // amount land in their own aligned grid columns. The
                            // chain label/% only renders on the chain's first row.
                            const toks = [
                              s.usdc > 0 ? { sym: "USDC", usd: s.usdc } : null,
                              s.usdt > 0 ? { sym: "USDT", usd: s.usdt } : null,
                            ].filter(Boolean) as { sym: string; usd: number }[];
                            const rows = toks.length > 0 ? toks : [{ sym: "", usd: 0 }];
                            return rows.map((t, ti) => (
                              <Fragment key={`${s.chain}-${t.sym || "_"}-${ti}`}>
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                                  {ti === 0 && (
                                    <>
                                      <ChainIcon chain={s.chain} size={15} />
                                      <span style={{ color: "#d6dce5", fontWeight: 600 }}>{CHAIN_LABEL[s.chain] ?? s.chain}</span>
                                      <span style={{ color: v2.muted }}>{Math.round(s.pct)}%</span>
                                    </>
                                  )}
                                </span>
                                <span style={{ color: v2.muted }}>{t.sym}</span>
                                <b style={{ color: v2.text, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                                  {t.usd > 0 ? fmtUsd(t.usd) : ""}
                                </b>
                              </Fragment>
                            ));
                          })
                        ) : (
                          <span style={{ color: v2.muted, fontSize: fs.label, gridColumn: "1 / -1" }}>
                            No stablecoin balance yet — Receive to fund this wallet.
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Yield — restored to the top row beside Stablecoins.
                        Reuses the shipped Earn section (real Aave data +
                        deposit/withdraw). Demo mode renders a static card
                        (mounting the real one would 401 / sign-prompt). */}
                    {demoMode || !activeWallet ? (
                      <div style={{ ...subCard(13), padding: 14 }}>
                        <div style={styles.assetTop}>
                          <div style={styles.token}>
                            <Q402Mark size={27} />
                            <div>
                              Q402 Yield
                              <div style={{ ...styles.sub, display: "inline-flex", alignItems: "center", gap: 5 }}>
                                <TokenIcon src="/aave.svg" size={13} /> <TokenIcon src="/logos/morpho.png" size={13} /> Aave V3 · Morpho · paid plans
                              </div>
                            </div>
                          </div>
                          <div style={{ font: `600 19px ${displayFont}` }}>$0.00</div>
                        </div>
                        <div style={{ color: v2.muted, fontSize: fs.label, marginTop: 14, lineHeight: 1.6 }}>
                          Idle stablecoins can earn ~2.33% APY in Aave V3 (up to your 35%
                          yield cap). Available on paid plans — connect + upgrade to enable Earn.
                        </div>
                      </div>
                    ) : (
                      <div style={{ ...subCard(13), padding: 14 }}>
                        <AgenticWalletEarnSection
                          ownerAddress={addr ?? activeWallet.ownerAddr}
                          walletId={activeWallet.walletId}
                          signMessage={signMessage}
                          canDeposit={identity.hasPaid === true}
                        />
                      </div>
                    )}
                  </div>

                  {/* Gas Tank — full-width strip at the FOOT of the capital
                      overview (per request). Surfaced on page 1 so the operator
                      sees relayer-gas headroom; full management is in Treasury. */}
                  <div style={{ ...subCard(13), padding: 14, marginTop: 11 }}>
                    <div style={styles.assetTop}>
                      <div style={styles.token}>
                        <span style={{ ...styles.coin, background: gasTankCoinGradient, color: v2.yellow }}>
                          <GasTankIcon size={16} />
                        </span>
                        <div>
                          Gas Tank
                          <div style={styles.sub}>Relayer gas · pre-funded · sponsors every settlement</div>
                        </div>
                      </div>
                      <div style={{ font: `600 19px ${displayFont}` }}>{!demoMode && gasTankError ? "—" : fmtUsd(vmGasTank.usd)}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 14, flexWrap: "wrap" }}>
                      {!demoMode && gasTankError ? (
                        <span style={{ color: v2.muted, fontSize: fs.label }}>
                          Balance unavailable — couldn&apos;t reach the gas-tank service. Retry shortly.
                        </span>
                      ) : vmGasTank.funded.length > 0 ? (
                        <>
                          {vmGasTank.funded.slice(0, 10).map((c) => (
                            <ChainIcon key={c} chain={c} size={20} />
                          ))}
                          <span style={{ color: v2.muted, fontSize: fs.label, marginLeft: 4 }}>
                            {vmGasTank.funded.length} chain{vmGasTank.funded.length > 1 ? "s" : ""} funded
                          </span>
                        </>
                      ) : (
                        <span style={{ color: v2.muted, fontSize: fs.label }}>
                          Empty — top up in Treasury to sponsor gas.
                        </span>
                      )}
                    </div>
                  </div>
                </section>

                {/* Recent activity — real settlements scoped to this wallet
                    (or DEMO.activity in demo mode). */}
                <section>
                  <SectionHead
                    title="Recent activity"
                    action={<LinkButton onClick={() => onNavigate?.("activity")}>View all</LinkButton>}
                  />
                  <div style={styles.rows}>
                    {demoMode ? (
                      DEMO.activity.map((t) => (
                        <div key={t.id} style={styles.row} {...hoverBg("rgba(255,255,255,.03)")}>
                          <div style={styles.rowIcon}>{t.direction === "out" ? "↗" : "↓"}</div>
                          <div style={{ minWidth: 0 }}>
                            <strong style={{ fontSize: fs.base }}>{t.title}</strong>
                            <span style={{ ...styles.rowSpan, display: "flex", alignItems: "center", gap: 5 }}>
                              <ChainIcon chain={t.chain} size={13} />
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.meta}</span>
                            </span>
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <div style={styles.rowValue}>{t.amount}</div>
                            <span style={{ ...styles.rowStatus, color: v2.mint }}>{t.status}</span>
                          </div>
                        </div>
                      ))
                    ) : recentForActive.length === 0 ? (
                      <div style={{ color: v2.muted, fontSize: fs.body, padding: "14px 0" }}>
                        No settlements yet for this wallet.
                      </div>
                    ) : (
                      recentForActive.map((t) => {
                        const out = t.fromUser?.toLowerCase() === activeWallet!.address.toLowerCase();
                        const amt = Number(t.tokenAmount);
                        const counter = out ? t.toUser : t.fromUser;
                        return (
                          <div key={t.relayTxHash} style={styles.row} {...hoverBg("rgba(255,255,255,.03)")}>
                            <div style={styles.rowIcon}>{out ? "↗" : "↓"}</div>
                            <div style={{ minWidth: 0 }}>
                              <strong style={{ fontSize: fs.base }}>
                                {out ? "Payment to" : "Received from"} {shortAddr(counter ?? "")}
                              </strong>
                              <span style={{ ...styles.rowSpan, display: "flex", alignItems: "center", gap: 5 }}>
                                <ChainIcon chain={asChainKey(t.chain)} size={13} />
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {(CHAIN_LABEL[t.chain] ?? t.chain)} · {t.tokenSymbol}
                                  {t.rail === "x402" ? <span style={{ color: v2.cyan }}> · x402</span> : ""}
                                  {t.source === "recurring" ? " · recurring" : ""}
                                  {t.receiptId ? (
                                    <>
                                      {" · "}
                                      <a
                                        href={`/receipt/${t.receiptId}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        style={{ color: v2.mint, textDecoration: "none" }}
                                      >
                                        Trust Receipt ↗
                                      </a>
                                    </>
                                  ) : ""}
                                </span>
                              </span>
                            </div>
                            <div style={{ textAlign: "right" }}>
                              <div style={styles.rowValue}>
                                {out ? "−" : "+"} {Number.isFinite(amt) ? `$${amt.toFixed(2)}` : `${t.tokenAmount}`}
                              </div>
                              <a
                                href={explorerTxUrl(asChainKey(t.chain), t.relayTxHash)}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ ...styles.rowStatus, color: v2.mint }}
                                title={`View on ${explorerLabel(asChainKey(t.chain))}`}
                              >
                                {relativeTime(t.relayedAt)} ↗
                              </a>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </section>
              </div>

              {/* Wallet management (export key / archive / restore) — tucked
                  into a collapsed disclosure at the foot of the console so the
                  destructive actions don't crowd the everyday surface. Only
                  ever acts on a REAL connected wallet; the DangerZone keeps its
                  own red styling once expanded. */}
              {!demoMode && activeWallet && (
                <details className="v2-manage" style={styles.manageDetails}>
                  <summary className="v2-manage-summary" style={styles.manageSummary}>
                    <span style={{ display: "flex", alignItems: "center", gap: 11, flex: 1, minWidth: 0 }}>
                      <span style={styles.manageIcon} aria-hidden>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6l-8-4Z" />
                          <path d="m9 12 2 2 4-4" />
                        </svg>
                      </span>
                      Wallet management
                    </span>
                    <span style={{ color: v2.muted2, fontSize: fs.label }}>
                      Delegation · Export key · Archive
                    </span>
                  </summary>
                  <div style={styles.dangerZone}>
                    <AgenticWalletDangerZone
                      wallet={activeWallet}
                      address={addr!}
                      signMessage={signMessage}
                      onChanged={afterWrite}
                      balanceUsd={balances[activeWallet.walletId]?.totalUsd ?? null}
                      onRequestBalanceRefresh={() => afterWrite()}
                    />
                  </div>
                </details>
              )}
            </>
          )}

          {demoMode && (
            <div style={styles.dangerHint}>
              Connect your wallet to manage / export / archive this wallet.
            </div>
          )}
        </Surface>

        {/* ── Col 3 · Right rail ──────────────────────────────────────── */}
        <aside className="v2-right" style={styles.right}>
          {/* Payment requests — compact create card. The invoice list lives in
              Activity → Requests; this card is just the "bill someone" action. */}
          <Surface style={styles.sideCard}>
            <Eyebrow>Receive · invoices</Eyebrow>
            <div style={{ font: `600 ${fs.cardTitle}px ${displayFont}`, color: v2.text, marginTop: 6 }}>
              Payment requests
            </div>
            <div style={{ color: v2.muted, fontSize: fs.label, lineHeight: 1.5, marginTop: 6 }}>
              Bill anyone with a shareable link. Track them in Activity → Requests.
            </div>
            <button
              onClick={() => setComposeOpen(true)}
              style={{
                marginTop: 13,
                width: "100%",
                background: `${v2.yellow}14`,
                border: `1px solid ${v2.yellow}40`,
                color: v2.yellow,
                borderRadius: 9,
                padding: "9px 14px",
                fontSize: fs.body,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              New request
            </button>
          </Surface>
          {firstRun ? (
            // First-run: no wallet to configure yet — surface what the rail
            // will hold once a wallet exists, no demo data.
            <Surface style={styles.sideCard}>
              <Eyebrow>After you create</Eyebrow>
              <div style={styles.firstRunRailList}>
                {[
                  "Payment policy — compliance, spend approval & allowlists",
                  "Automation — recurring & conditional payouts",
                  "Spending guardrails — per-payment & daily caps",
                ].map((line) => (
                  <div key={line} style={styles.firstRunRailItem}>
                    <span style={styles.firstRunRailDot} />
                    <span>{line}</span>
                  </div>
                ))}
              </div>
              <span style={{ display: "block", color: v2.muted2, fontSize: fs.label, lineHeight: 1.6, marginTop: 13 }}>
                These unlock the moment your first Agent Wallet exists.
              </span>
            </Surface>
          ) : (
          <>
          {/* Payment policy — real Hooks config (or DEMO.policy in demo mode) */}
          <Surface style={styles.sideCard}>
            <SectionHead
              title="Payment policy"
              action={
                <LinkButton onClick={() => activeWallet && !archived && setHooksOpen(true)}>
                  Edit
                </LinkButton>
              }
            />
            <div style={styles.policyScore}>
              <div
                style={{
                  ...styles.ring,
                  background: `conic-gradient(${v2.mint} 0 ${vmPolicyScore}%, ${v2.ringTrack} ${vmPolicyScore}%)`,
                }}
              >
                <span style={styles.ringInner} aria-hidden />
                <b style={styles.ringNum}>{vmPolicyScore}</b>
              </div>
              <div>
                <strong style={{ fontSize: fs.base }}>
                  {vmProtectionsActive >= 3 ? "Strong guardrails" : vmProtectionsActive >= 1 ? "Some guardrails" : "Minimal guardrails"}
                </strong>
                <span style={{ display: "block", color: v2.muted, fontSize: fs.label, marginTop: 4 }}>
                  {vmProtectionsActive} protection{vmProtectionsActive === 1 ? "" : "s"} active
                </span>
              </div>
            </div>
            {vmPolicyRows.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => activeWallet && !archived && setHooksOpen(true)}
                {...hoverBg("rgba(255,255,255,.03)")}
                style={styles.policy}
                title={demoMode ? "Connect your wallet" : "Edit policies in Hooks"}
              >
                <div style={{ textAlign: "left" }}>
                  {p.label}
                  <span style={{ display: "block", color: v2.muted, fontSize: fs.micro, marginTop: 3 }}>{p.detail}</span>
                </div>
                <span style={{ ...styles.toggle, ...(p.on ? styles.toggleOn : null) }}>
                  <span style={{ ...styles.toggleKnob, ...(p.on ? styles.toggleKnobOn : null) }} />
                </span>
              </button>
            ))}
          </Surface>

          {/* Automation — reuse the shipped Recurring section (real rules +
              its own create / pause / cancel modal). Wrapped in a side card. */}
          <Surface style={styles.sideCard}>
            <SectionHead title="Automation" meta="Recurring & conditional" />
            {/* V2 owns the section chrome: the reused Recurring section renders
                content-only (no outer card / top-margin), so the parent wraps
                it in a subCard(13) box that owns the border / bg / padding.
                The Automation card respects the user's scope view for
                new-schedule gating (recurring is a paid Multichain feature). */}
            {demoMode || !activeWallet ? (
              // Demo: render sample automation rules (no auth/data fetch).
              <div style={{ display: "grid", gap: 8, marginTop: 13 }}>
                {DEMO.automation.map((a) => (
                  <div key={a.id} style={{ ...subCard(11), padding: "10px 12px" }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <strong style={{ fontSize: fs.base }}>{a.label}</strong>
                      <span
                        style={{
                          ...styles.autoBadge,
                          ...(a.status === "ACTIVE" ? styles.autoBadgeActive : null),
                        }}
                      >
                        {a.status}
                      </span>
                    </div>
                    <span style={{ display: "block", color: v2.muted, fontSize: fs.label, marginTop: 5 }}>
                      {a.detail}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ ...subCard(13), padding: 14, marginTop: 13 }}>
                <AgenticWalletRecurringSection
                  walletId={activeWallet.walletId}
                  ownerAddress={addr ?? activeWallet.ownerAddr}
                  signMessage={signMessage}
                  perTxMaxUsd={activeWallet.perTxMaxUsd}
                  hasMultichainScope={multichainActive}
                  walletArchived={archived}
                />
              </div>
            )}
          </Surface>

          {/* Spending guardrails — native per-tx / daily caps → Limits modal */}
          <Surface style={{ ...styles.sideCard, ...styles.limitsCard }}>
            <SectionHead
              title="Spending guardrails"
              action={
                <LinkButton onClick={() => activeWallet && !archived && setLimitsOpen(true)}>
                  Edit limits
                </LinkButton>
              }
            />
            <div style={styles.limitGrid}>
              <div style={styles.limit}>
                <span style={{ display: "block", color: v2.muted, fontSize: fs.label }}>Per payment</span>
                <b style={styles.limitVal}>
                  {vmPerTx != null ? `$${vmPerTx}` : "No cap"}
                </b>
              </div>
              <div style={styles.limit}>
                <span style={{ display: "block", color: v2.muted, fontSize: fs.label }}>Daily limit</span>
                <b style={styles.limitVal}>
                  {vmDaily != null ? `$${vmDaily}` : "No cap"}
                </b>
              </div>
            </div>
          </Surface>
          </>
          )}
        </aside>
      </div>

      {/* ── Reused action modals (each self-auths via getActionAuth) ────── */}
      {composeOpen && (
        <RequestComposerModal
          ownerAddress={ownerAddress}
          signMessage={signMessage}
          scope={scope}
          agentWallet={activeWallet ? { address: activeWallet.address, label: activeWallet.label } : undefined}
          onClose={() => setComposeOpen(false)}
        />
      )}
      {activeWallet && stakeOpen && (
        <AgenticWalletStakeModal
          ownerAddress={addr ?? activeWallet.ownerAddr}
          walletId={activeWallet.walletId}
          signMessage={signMessage}
          onClose={() => setStakeOpen(false)}
        />
      )}
      {activeWallet && sendOpen && (
        <AgenticWalletSendModal
          walletAddress={activeWallet.address}
          walletId={activeWallet.walletId}
          ownerAddress={addr ?? activeWallet.ownerAddr}
          signMessage={signMessage}
          perTxMaxUsd={activeWallet.perTxMaxUsd}
          dailyLimitUsd={activeWallet.dailyLimitUsd}
          allowedChains={multichainActive ? undefined : ["bnb"]}
          onClose={() => setSendOpen(false)}
          onSent={() => {
            setSendOpen(false);
            afterWrite();
          }}
          onOpenHooks={() => {
            setSendOpen(false);
            setHooksOpen(true);
          }}
        />
      )}
      {activeWallet && receiveOpen && (
        <AgenticWalletReceiveModal
          walletAddress={activeWallet.address}
          onClose={() => setReceiveOpen(false)}
        />
      )}
      {activeWallet && batchOpen && (
        <AgenticWalletBatchModal
          walletAddress={activeWallet.address}
          walletId={activeWallet.walletId}
          ownerAddress={addr ?? activeWallet.ownerAddr}
          signMessage={signMessage}
          onClose={() => setBatchOpen(false)}
          onSent={() => {
            setBatchOpen(false);
            afterWrite();
          }}
        />
      )}
      {activeWallet && bridgeOpen && (
        <AgenticWalletBridgeModal
          walletAddress={activeWallet.address}
          walletId={activeWallet.walletId}
          ownerAddress={addr ?? activeWallet.ownerAddr}
          signMessage={signMessage}
          hasMultichainScope={multichainActive}
          onClose={() => setBridgeOpen(false)}
          onSent={() => {
            setBridgeOpen(false);
            afterWrite();
          }}
        />
      )}
      {activeWallet && limitsOpen && (
        <AgenticWalletLimitsModal
          ownerAddress={addr ?? activeWallet.ownerAddr}
          walletId={activeWallet.walletId}
          signMessage={signMessage}
          initial={{
            dailyLimitUsd: activeWallet.dailyLimitUsd,
            perTxMaxUsd: activeWallet.perTxMaxUsd,
          }}
          onClose={() => setLimitsOpen(false)}
          onSaved={() => {
            setLimitsOpen(false);
            afterWrite();
          }}
        />
      )}
      {activeWallet && hooksOpen && (
        <AgenticWalletHooksModal
          ownerAddress={addr ?? activeWallet.ownerAddr}
          walletId={activeWallet.walletId}
          signMessage={signMessage}
          onClose={() => setHooksOpen(false)}
          onSaved={() => {
            setHooksOpen(false);
            afterWrite();
          }}
        />
      )}
      {activeWallet && agentOpen && (
        <AgenticWalletAgentModal
          walletAddress={activeWallet.address}
          walletId={activeWallet.walletId}
          ownerAddress={addr ?? activeWallet.ownerAddr}
          signMessage={signMessage}
          onClose={() => setAgentOpen(false)}
          onRegistered={() => {
            setAgentOpen(false);
            afterWrite();
          }}
        />
      )}
      {activeWallet && withdrawOpen && (
        <AgenticWalletWithdrawModal
          walletAddress={activeWallet.address}
          walletId={activeWallet.walletId}
          ownerAddress={addr ?? activeWallet.ownerAddr}
          signMessage={signMessage}
          perTxMaxUsd={activeWallet.perTxMaxUsd}
          onClose={() => setWithdrawOpen(false)}
          onPickBucket={(bucket) => {
            setWithdrawOpen(false);
            setWithdrawBucket(bucket);
          }}
        />
      )}
      {activeWallet && withdrawBucket && (
        <AgenticWalletSendModal
          walletAddress={activeWallet.address}
          walletId={activeWallet.walletId}
          ownerAddress={addr ?? activeWallet.ownerAddr}
          signMessage={signMessage}
          prefillTo={addr ?? activeWallet.ownerAddr}
          prefillChain={withdrawBucket.chain}
          prefillToken={withdrawBucket.token}
          prefillAmount={withdrawBucket.amount}
          titleOverride={`Withdraw ${withdrawBucket.token} on ${withdrawBucket.chain}`}
          perTxMaxUsd={activeWallet.perTxMaxUsd}
          dailyLimitUsd={activeWallet.dailyLimitUsd}
          onSent={() => {
            setWithdrawBucket(null);
            afterWrite();
          }}
          onClose={() => setWithdrawBucket(null)}
          onOpenHooks={() => {
            setWithdrawBucket(null);
            setHooksOpen(true);
          }}
        />
      )}
    </V2AccentScope>
  );
}

// ── Inline style bag (direct ports of the prototype CSS) ─────────────────────

const styles: Record<string, React.CSSProperties> = {
  workspace: {
    display: "grid",
    gridTemplateColumns: "230px minmax(0, 1fr) 338px",
    gap: 16,
    alignItems: "start",
  },
  // Col 1 — rail
  rail: { padding: 14, display: "flex", flexDirection: "column" },
  walletItem: {
    marginTop: 11,
    padding: 13,
    border: "1px solid transparent",
    borderRadius: 14,
    cursor: "pointer",
    textAlign: "left",
    background: "none",
    color: v2.text,
    width: "100%",
    display: "block",
    transition: "background-color .15s ease, border-color .16s ease",
  },
  walletItemActive: {
    borderColor: "rgba(247,202,22,.45)",
    background: "linear-gradient(135deg, rgba(247,202,22,.13), rgba(247,202,22,.03))",
  },
  walletName: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 6,
    fontSize: fs.cardTitle,
    fontWeight: 650,
  },
  viewingBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: ".07em",
    textTransform: "uppercase",
    color: v2.yellow,
  },
  viewDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: v2.yellow,
    boxShadow: `0 0 8px ${v2.yellow}`,
    flexShrink: 0,
  },
  archBadge: {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 600,
    color: v2.muted2,
    textTransform: "uppercase",
    letterSpacing: ".06em",
  },
  addr: { font: `500 ${fs.body}px ${displayFont}`, color: v2.muted, marginTop: 5 },
  walletBal: { font: `600 22px ${displayFont}`, letterSpacing: "-.04em", marginTop: 12 },
  walletNote: { color: v2.muted2, fontSize: fs.label, marginTop: 3 },
  newWallet: {
    marginTop: 10,
    border: "1px dashed rgba(255,255,255,.14)",
    background: "none",
    color: v2.muted,
    padding: 12,
    borderRadius: 11,
    cursor: "pointer",
    fontSize: fs.body,
  },
  railFoot: { marginTop: "auto", paddingTop: 18 },
  mode: {
    border: "1px solid rgba(247,202,22,.30)",
    background: "rgba(247,202,22,.08)",
    padding: 12,
    borderRadius: 13,
  },
  // First-run rail nudge (connected · zero wallets).
  railFirstRun: {
    marginTop: 14,
    padding: 13,
    border: "1px solid rgba(247,202,22,.22)",
    background: "rgba(247,202,22,.05)",
    borderRadius: 13,
  },
  railFirstRunMark: { marginBottom: 9 },

  // Col 2 — console
  console: { overflow: "hidden", minWidth: 0 },
  errorBanner: {
    margin: 14,
    padding: "10px 12px",
    borderRadius: 11,
    border: "1px solid rgba(255,119,119,.3)",
    background: "rgba(255,119,119,.06)",
    color: "#ffb4b4",
    fontSize: fs.body,
  },
  // ── First-run console (connected · zero wallets) ─────────────────────────
  firstRun: { padding: "26px 25px 24px", position: "relative" },
  firstRunHead: {
    display: "flex",
    gap: 12,
    alignItems: "center",
    position: "relative",
    zIndex: 1,
  },
  firstRunH1: { font: `650 24px ${displayFont}`, letterSpacing: "-.045em", margin: "5px 0 0" },
  firstRunLede: {
    position: "relative",
    zIndex: 1,
    color: v2.muted,
    fontSize: fs.base,
    lineHeight: 1.65,
    maxWidth: 560,
    margin: "16px 0 0",
  },
  firstRunBenefits: {
    position: "relative",
    zIndex: 1,
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 11,
    marginTop: 20,
  },
  firstRunBenefitTop: { display: "flex", alignItems: "center", gap: 9 },
  firstRunBenefitIcon: {
    width: 28,
    height: 28,
    borderRadius: 9,
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    color: v2.yellow,
    border: "1px solid rgba(247,202,22,.28)",
    background: "rgba(247,202,22,.07)",
  },
  firstRunBenefitBody: {
    display: "block",
    color: v2.muted,
    fontSize: fs.label,
    lineHeight: 1.6,
    marginTop: 8,
  },
  firstRunCtaRow: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    gap: 14,
    flexWrap: "wrap",
    marginTop: 22,
  },
  firstRunCta: {
    border: 0,
    background: v2.yellow,
    color: v2.actionText,
    fontWeight: 700,
    fontSize: fs.base,
    borderRadius: 10,
    padding: "11px 20px",
    whiteSpace: "nowrap",
  },
  firstRunCtaNote: {
    flex: 1,
    minWidth: 220,
    color: v2.muted,
    fontSize: fs.label,
    lineHeight: 1.6,
  },
  trialCta: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    gap: 11,
    width: "100%",
    marginTop: 18,
    padding: "12px 14px",
    borderRadius: 12,
    border: "1px solid rgba(247,202,22,.19)",
    background: "linear-gradient(90deg, rgba(247,202,22,.05), rgba(255,255,255,.012))",
    color: v2.yellow,
    cursor: "pointer",
    textAlign: "left",
    transition: "background-color .15s ease, border-color .16s ease",
  },
  trialCtaArrow: {
    marginLeft: "auto",
    flexShrink: 0,
    color: v2.yellow,
    fontSize: fs.label,
    fontWeight: 700,
  },
  // First-run right rail (preview of what unlocks after creation).
  firstRunRailList: { display: "grid", gap: 10, marginTop: 13 },
  firstRunRailItem: {
    display: "flex",
    gap: 9,
    alignItems: "flex-start",
    color: v2.muted,
    fontSize: fs.body,
    lineHeight: 1.5,
  },
  firstRunRailDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: v2.yellow,
    flexShrink: 0,
    marginTop: 6,
  },
  hero: {
    padding: "24px 25px 21px",
    borderBottom: `1px solid ${v2.line}`,
    position: "relative",
  },
  previewChip: {
    position: "relative",
    zIndex: 1,
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    marginBottom: 14,
    padding: "5px 10px",
    borderRadius: 99,
    border: "1px solid rgba(247,202,22,.3)",
    background: "rgba(247,202,22,.08)",
    color: v2.yellow,
    fontSize: fs.label,
    fontWeight: 600,
    letterSpacing: ".01em",
  },
  previewDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: v2.yellow,
    boxShadow: `0 0 8px ${v2.yellow}`,
    flexShrink: 0,
  },
  heroGlow: {
    position: "absolute",
    width: 210,
    height: 210,
    right: -50,
    top: -95,
    borderRadius: "50%",
    background: "radial-gradient(circle, rgba(247,202,22,.12), transparent 67%)",
    pointerEvents: "none",
  },
  identity: {
    display: "flex",
    justifyContent: "space-between",
    gap: 18,
    alignItems: "flex-start",
    position: "relative",
    zIndex: 1,
  },
  heroH1: { font: `650 27px ${displayFont}`, letterSpacing: "-.045em", margin: "6px 0 3px" },
  address: {
    color: v2.muted,
    font: `500 ${fs.body}px ${displayFont}`,
    background: "none",
    border: 0,
    padding: 0,
    cursor: "pointer",
    textAlign: "left",
    display: "block",
    maxWidth: 420,
  },
  ownerEoa: { color: v2.muted2, fontSize: fs.label, marginTop: 8, letterSpacing: ".01em" },
  badges: { display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" },
  badge: {
    padding: "5px 9px",
    border: `1px solid ${v2.line}`,
    borderRadius: 99,
    color: "#adb7c7",
    fontSize: fs.micro,
  },
  badgeGreen: {
    color: v2.yellow,
    borderColor: "rgba(247,202,22,.30)",
    background: "rgba(247,202,22,.08)",
  },
  badgePlan: {
    color: v2.yellow,
    fontWeight: 700,
    borderColor: "rgba(247,202,22,.35)",
    background: "rgba(247,202,22,.10)",
  },
  heroBal: { textAlign: "right", zIndex: 1, flexShrink: 0 },
  heroBalLabel: {
    display: "block",
    color: v2.muted,
    fontSize: fs.label,
    letterSpacing: ".13em",
    textTransform: "uppercase",
  },
  heroBalValue: { display: "block", font: `650 ${fs.hero}px ${displayFont}`, letterSpacing: "-.06em", marginTop: 5 },
  refreshLink: {
    border: 0,
    background: "none",
    color: v2.muted,
    fontSize: fs.label,
    cursor: "pointer",
    marginTop: 5,
    padding: 0,
  },
  actionsWrap: {
    display: "grid",
    gridTemplateColumns: "minmax(168px, 1.35fr) minmax(0, 3fr)",
    gap: 10,
    marginTop: 20,
    position: "relative",
    zIndex: 1,
  },
  // Send hero — gold, icon + label INLINE (horizontal); the primary action.
  actionHero: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    minHeight: 60,
    padding: "10px 16px",
    borderRadius: 13,
    border: `1px solid ${v2.yellow}`,
    background: "linear-gradient(135deg, #ffd941, #f5c518 62%)",
    color: v2.actionText,
    textAlign: "left",
    cursor: "pointer",
  },
  heroDisabled: { opacity: 0.45, cursor: "not-allowed" },
  heroIcon: {
    width: 36,
    height: 36,
    borderRadius: 999,
    flexShrink: 0,
    display: "grid",
    placeItems: "center",
    background: "rgba(7,16,31,.16)",
    color: v2.actionText,
  },
  heroTitle: { fontSize: fs.cardTitle, fontWeight: 700, letterSpacing: "-0.01em", lineHeight: 1.12, whiteSpace: "nowrap" },
  heroSub: { fontSize: fs.label, fontWeight: 600, opacity: 0.6, whiteSpace: "nowrap" },
  // Utility tile cluster — 5 compact dark tiles (icon top, label, sub).
  utilGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(5, minmax(0,1fr))",
    gap: 8,
  },
  actionTile: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    minHeight: 60,
    padding: "8px 10px 9px",
    borderRadius: 11,
    border: `1px solid ${v2.line}`,
    background: "rgba(255,255,255,.025)",
    color: v2.text,
    textAlign: "left",
    cursor: "pointer",
  },
  tileDisabled: { opacity: 0.45, cursor: "not-allowed", background: "rgba(255,255,255,.012)" },
  tileIcon: {
    width: 24,
    height: 24,
    borderRadius: 999,
    flexShrink: 0,
    display: "grid",
    placeItems: "center",
    background: "rgba(255,255,255,.05)",
  },
  tileLabel: { fontSize: fs.body, fontWeight: 600, color: v2.text, lineHeight: 1.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  tileSub: { fontSize: 10, color: v2.muted2, lineHeight: 1.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  paidChip: {
    position: "absolute",
    top: 8,
    right: 8,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: "#f4d98a",
    background: "rgba(247,202,22,.12)",
    border: "1px solid rgba(247,202,22,.3)",
    borderRadius: 5,
    padding: "1px 5px",
  },
  command: {
    marginTop: 11,
    padding: "10px 11px 10px 14px",
    display: "grid",
    gridTemplateColumns: "auto 1fr auto",
    gap: 10,
    alignItems: "center",
    border: "1px solid rgba(247,202,22,.19)",
    borderRadius: 11,
    background: "linear-gradient(90deg, rgba(247,202,22,.055), rgba(255,255,255,.015))",
    position: "relative",
    zIndex: 1,
    transition: "background-color .15s ease, border-color .16s ease",
  },
  commandBtn: {
    border: "1px solid rgba(247,202,22,.3)",
    background: "rgba(247,202,22,.06)",
    color: v2.yellow,
    fontSize: fs.label,
    fontWeight: 700,
    borderRadius: 8,
    padding: "8px 11px",
    cursor: "pointer",
    textDecoration: "none",
    whiteSpace: "nowrap",
  },
  content: { padding: "19px 25px 23px", display: "grid", gap: 18 },
  allocation: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "stretch" },
  assetTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  token: { display: "flex", gap: 9, alignItems: "center", fontSize: fs.cardTitle, fontWeight: 600 },
  coin: {
    width: 27,
    height: 27,
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    background: v2.coinUsdt,
    color: "white",
    fontSize: fs.micro,
    flexShrink: 0,
  },
  sub: { color: v2.muted, fontSize: fs.label, marginTop: 3 },
  chainbar: {
    display: "flex",
    height: 5,
    borderRadius: 8,
    overflow: "hidden",
    background: "#172438",
    marginTop: 13,
  },
  chains: { display: "flex", gap: 10, color: v2.muted, fontSize: fs.label, marginTop: 10, flexWrap: "wrap" },
  breakdown: { display: "grid", gridTemplateColumns: "1fr auto auto", columnGap: 14, rowGap: 8, marginTop: 11, fontSize: fs.label, color: v2.muted, alignItems: "center" },
  rows: { borderTop: `1px solid ${v2.line}` },
  row: {
    display: "grid",
    gridTemplateColumns: "31px minmax(0,1fr) auto",
    gap: 11,
    alignItems: "center",
    padding: "11px 8px",
    margin: "0 -8px",
    borderBottom: "1px solid rgba(255,255,255,.05)",
    borderRadius: 8,
    transition: "background-color .15s ease",
  },
  rowIcon: {
    width: 31,
    height: 31,
    borderRadius: 9,
    background: "rgba(255,255,255,.04)",
    display: "grid",
    placeItems: "center",
    color: v2.mint,
    fontSize: fs.base,
  },
  rowSpan: { display: "block", color: v2.muted, fontSize: fs.label, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rowValue: { textAlign: "right", font: `600 ${fs.cardTitle}px ${displayFont}` },
  rowStatus: { fontSize: fs.label, marginTop: 3, textDecoration: "none", display: "inline-block" },

  // Col 3 — right rail
  right: { display: "flex", flexDirection: "column", gap: 15 },
  sideCard: { padding: 16 },
  policyScore: { display: "flex", gap: 12, alignItems: "center", margin: "13px 0 15px" },
  ring: {
    width: 48,
    height: 48,
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    position: "relative",
    flexShrink: 0,
  },
  ringInner: {
    position: "absolute",
    inset: 5,
    borderRadius: "50%",
    background: v2.ringInner,
  },
  ringNum: { position: "relative", font: `600 ${fs.body}px ${displayFont}` },
  policy: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 0",
    fontSize: fs.body,
    width: "100%",
    background: "none",
    // Reset the button's default border, then re-draw only the top rule
    // (longhand after the `border` reset so it isn't cleared).
    border: 0,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: "rgba(255,255,255,.055)",
    color: v2.text,
    cursor: "pointer",
    transition: "background-color .15s ease",
    borderRadius: 8,
  },
  toggle: {
    width: 30,
    height: 17,
    padding: 3,
    borderRadius: 99,
    background: v2.toggleOff,
    flexShrink: 0,
    display: "block",
  },
  toggleOn: { background: "rgba(247,202,22,.27)" },
  toggleKnob: {
    display: "block",
    width: 11,
    height: 11,
    borderRadius: "50%",
    background: v2.toggleKnob,
    transition: "transform .2s ease",
  },
  toggleKnobOn: { transform: "translateX(13px)", background: v2.yellow },
  autoBadge: {
    padding: "4px 8px",
    borderRadius: 99,
    border: `1px solid ${v2.line}`,
    color: v2.muted,
    fontSize: fs.micro,
    fontWeight: 700,
    letterSpacing: ".06em",
    flexShrink: 0,
  },
  autoBadgeActive: {
    color: v2.yellow,
    borderColor: "rgba(247,202,22,.30)",
    background: "rgba(247,202,22,.08)",
  },
  limitsCard: { borderColor: "rgba(247,202,22,.18)", background: "rgba(247,202,22,.03)" },
  limitGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginTop: 11 },
  limit: { padding: 9, borderRadius: 9, background: "rgba(0,0,0,.14)" },
  limitVal: { display: "block", font: `600 ${fs.cardTitle}px ${displayFont}`, marginTop: 4 },
  agentLink: {
    marginTop: 14,
    border: 0,
    background: "none",
    color: v2.yellow,
    fontSize: fs.label,
    cursor: "pointer",
    padding: 0,
    textAlign: "left",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  },
  // Collapsed "Wallet management" disclosure — keeps the destructive
  // DangerZone tucked at the foot of the console, opened on demand.
  manageDetails: {
    margin: "12px 25px 22px",
  },
  // Box visual (padding/border/radius/bg + hover) lives in .v2-manage-summary
  // (globals.css) so the hover state can override; inline keeps layout + type.
  manageSummary: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    cursor: "pointer",
    listStyle: "none",
    userSelect: "none",
    color: v2.text,
    fontSize: fs.cardTitle,
    fontWeight: 600,
  },
  manageIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    flex: "none",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: v2.yellow,
    background: "rgba(245,197,24,.10)",
    border: "1px solid rgba(245,197,24,.28)",
  },
  // Danger zone wrapper — small top margin so the reused (red) DangerZone
  // sits inside the disclosure without bleeding into the summary above.
  dangerZone: { marginTop: 12 },
  dangerHint: {
    margin: "0 25px 23px",
    color: v2.muted,
    fontSize: fs.label,
    lineHeight: 1.6,
  },
};
