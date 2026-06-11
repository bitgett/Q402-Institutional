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
 * multichain = 10 chains / live key. It does not change layout structure.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Surface,
  V2AccentScope,
  Eyebrow,
  SectionHead,
  LinkButton,
  displayFont,
  shortAddr,
} from "../primitives";
import { v2, subCard, fs } from "../theme";
import type { Scope } from "../theme";
import { ChainIcon, TokenIcon, StablePair } from "../logos";
import { getAuthCreds, clearAuthCache } from "@/app/lib/auth-client";
import { explorerTxUrl, explorerLabel, CHAIN_KEYS } from "@/app/lib/eip7702";
import type { ChainKey } from "@/app/lib/relayer";
import type { AgenticWalletPublic } from "@/app/dashboard/components/AgenticWalletTab";
import { AgenticWalletEarnSection } from "@/app/dashboard/components/AgenticWalletEarnSection";
import { AgenticWalletRecurringSection } from "@/app/dashboard/components/AgenticWalletRecurringSection";
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
  const yp = cfg?.yieldPolicy;
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
          ? `Human review at $${approval}+`
          : "No soft approval threshold",
      on: Boolean(sc?.enabled) && approval != null,
    },
    {
      key: "yield-alloc",
      label: "Yield allocation",
      detail:
        yp?.maxAllocationPct != null
          ? `Max ${yp.maxAllocationPct}% in yield`
          : "No allocation cap",
      on: Boolean(yp?.enabled),
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
      { key: "yield-alloc", label: "Yield allocation", detail: "Max 35% in yield", on: true },
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

export function WalletsView({ ownerAddress, signMessage, scope }: WalletsViewProps) {
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
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [hooksOpen, setHooksOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  // Withdraw / sweep — the picker opens, then a chosen bucket hands off
  // to the reused SendModal (the exact old-Card sweep flow).
  const [withdrawOpen, setWithdrawOpen] = useState(false);
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

  // ── Derived view models ──────────────────────────────────────────────────
  const activeBalance = activeWallet ? balances[activeWallet.walletId] ?? null : null;

  // Capital allocation: per-chain stablecoin share of the active wallet's
  // total, biggest first, top 3 → bar segments (prototype shows 3).
  const allocation = useMemo(() => {
    if (!activeBalance) return { total: 0, segs: [] as { chain: string; usd: number; pct: number }[] };
    const total = activeBalance.totalUsd;
    const segs = activeBalance.perChain
      .map((c) => ({ chain: c.chain, usd: c.totalUsd ?? 0 }))
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
  useEffect(() => {
    if (!addr) {
      setGasTank(null);
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
      } catch {
        /* leave null — card shows $0 / top-up hint */
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
    return txs
      .filter((t) => t.fromUser?.toLowerCase() === w || t.toUser?.toLowerCase() === w)
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

  // ── Demo fallback ─────────────────────────────────────────────────────────
  //
  // The console must look complete before any wallet connects. Demo mode is
  // ON whenever we don't yet have a real active wallet to drive the view:
  //   - no connected owner (ownerAddress === null), OR
  //   - connected but the wallet list / active wallet hasn't resolved yet.
  // The MOMENT a real active wallet exists, every variable below resolves to
  // live data and the connected path is 100% intact (demoMode === false).
  const demoMode = activeWallet == null;

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
  const agentNum = demoMode ? DEMO.wallets[0].erc8004 : agentIdFromTag(activeWallet?.erc8004AgentId);

  // Capital allocation segments.
  const vmAlloc = demoMode
    ? {
        total: DEMO.wallets[0].balanceUsd,
        segs: DEMO.allocation.map((a) => ({ chain: a.chain, usd: 0, pct: a.pct })),
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
            <div style={{ color: v2.muted, fontSize: fs.body, marginTop: 14, lineHeight: 1.6 }}>
              No Agent Wallets yet. Create your first sandboxed AI spending
              wallet — your MetaMask stays untouched.
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
                  style={{ ...styles.walletItem, ...(isActive ? styles.walletItemActive : null) }}
                  title={w.address}
                >
                  <div style={styles.walletName}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {w.label ?? "Agent wallet"}
                    </span>
                    {!w.archived && <span style={styles.dot} />}
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
              <strong style={{ display: "block", color: v2.mint, fontSize: fs.body }}>
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
                        <span style={{ color: v2.yellow, marginLeft: 6 }}>{copied ? "copied ✓" : "copy"}</span>
                      )}
                    </button>
                    <div style={styles.badges}>
                      <span style={{ ...styles.badge, ...styles.badgeGreen }}>
                        {archived ? "Archived" : "Ready to spend"}
                      </span>
                      <span style={styles.badge}>
                        {demoMode || multichainActive ? "Multichain · 10 chains" : "Trial · BNB"}
                      </span>
                      {agentNum && <span style={styles.badge}>ERC-8004 #{agentNum}</span>}
                    </div>
                  </div>
                  <div style={styles.heroBal}>
                    <span style={styles.heroBalLabel}>Total portfolio</span>
                    <strong style={styles.heroBalValue}>
                      {!demoMode && activeBalanceLoading && !activeBalance ? "…" : fmtUsd(vmTotalUsd)}
                    </strong>
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

                {/* Actions — each opens the EXISTING modal. In demo mode there
                    is no wallet to act on, so they are disabled with a
                    "Connect your wallet" hint rather than opening a modal that
                    would dereference a null wallet. */}
                <div className="v2-actions" style={styles.actions}>
                  <button
                    type="button"
                    disabled={demoMode || archived}
                    onClick={() => setSendOpen(true)}
                    title={demoMode ? "Connect your wallet" : undefined}
                    style={{ ...styles.action, ...styles.actionPrimary, ...(demoMode || archived ? styles.actionDisabled : null) }}
                  >
                    Send payment
                    <small style={styles.actionSmall}>USDC / USDT</small>
                  </button>
                  <button
                    type="button"
                    disabled={demoMode || archived}
                    onClick={() => setReceiveOpen(true)}
                    title={demoMode ? "Connect your wallet" : undefined}
                    style={{ ...styles.action, ...(demoMode || archived ? styles.actionDisabled : null) }}
                  >
                    Receive
                    <small style={styles.actionSmall}>Show address</small>
                  </button>
                  <button
                    type="button"
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
                    style={{ ...styles.action, ...(demoMode || archived || !multichainActive ? styles.actionDisabled : null) }}
                  >
                    Batch{!demoMode && !multichainActive && " (Paid)"}
                    <small style={styles.actionSmall}>Up to 20</small>
                  </button>
                  <button
                    type="button"
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
                    style={{ ...styles.action, ...(demoMode || archived || !multichainActive ? styles.actionDisabled : null) }}
                  >
                    Bridge{!demoMode && !multichainActive && " (Paid)"}
                    <small style={styles.actionSmall}>CCIP</small>
                  </button>
                  <button
                    type="button"
                    disabled={demoMode || archived}
                    onClick={() => setWithdrawOpen(true)}
                    title={demoMode ? "Connect your wallet" : "Sweep a chain/token bucket back to your wallet"}
                    style={{ ...styles.action, ...(demoMode || archived ? styles.actionDisabled : null) }}
                  >
                    Withdraw
                    <small style={styles.actionSmall}>Sweep out</small>
                  </button>
                </div>

                {/* MCP command bar */}
                <div style={styles.command}>
                  <div style={{ color: v2.yellow, fontSize: 19 }}>✦</div>
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
                {/* Capital overview — Stablecoins + Gas Tank on one row, Yield below */}
                <section>
                  <SectionHead title="Capital overview" meta="10 networks monitored" />
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
                      <div style={styles.chains}>
                        {vmAlloc.segs.length > 0 ? (
                          vmAlloc.segs.map((s) => (
                            <span key={s.chain} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                              <ChainIcon chain={s.chain} size={15} />
                              <b style={{ color: "#d6dce5" }}>{Math.round(s.pct)}%</b>
                              {CHAIN_LABEL[s.chain] ?? s.chain}
                            </span>
                          ))
                        ) : (
                          <span>No stablecoin balance yet — Receive to fund this wallet.</span>
                        )}
                      </div>
                    </div>

                    {/* Gas Tank — surfaced on page 1 next to capital so the
                        operator sees relayer-gas headroom without leaving the
                        Wallets view. Full management lives in the Treasury tab. */}
                    <div style={{ ...subCard(13), padding: 14 }}>
                      <div style={styles.assetTop}>
                        <div style={styles.token}>
                          <span style={{ ...styles.coin, background: "linear-gradient(135deg,#2c3c57,#172234)", color: "#cfe0ff", fontSize: 14 }}>⛽</span>
                          <div>
                            Gas Tank
                            <div style={styles.sub}>Relayer gas · pre-funded</div>
                          </div>
                        </div>
                        <div style={{ font: `600 19px ${displayFont}` }}>{fmtUsd(vmGasTank.usd)}</div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 16, flexWrap: "wrap" }}>
                        {vmGasTank.funded.length > 0 ? (
                          <>
                            {vmGasTank.funded.slice(0, 7).map((c) => (
                              <ChainIcon key={c} chain={c} size={18} />
                            ))}
                            <span style={{ color: v2.muted, fontSize: fs.label, marginLeft: 3 }}>
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
                  </div>

                  {/* Yield — reuse the shipped Earn section (real Aave data +
                      its own deposit/withdraw modal), full-width below the
                      Stablecoins / Gas-Tank row. The surrounding V2AccentScope
                      re-skins its emerald → yellow. In demo mode there is no
                      wallet/owner to authenticate its reads, so render a static
                      demo card instead of mounting it (would 401 / sign-prompt). */}
                  <div style={{ marginTop: 11 }}>
                    {demoMode || !activeWallet ? (
                      <div style={{ ...subCard(13), padding: 14 }}>
                        <div style={styles.assetTop}>
                          <div style={styles.token}>
                            <TokenIcon src="/aave.svg" size={27} />
                            <div>
                              Q402 Yield
                              <div style={styles.sub}>Aave V3 · ~2.33% APY · paid plans</div>
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
                      <div style={{ marginTop: -16 }}>
                        <AgenticWalletEarnSection
                          ownerAddress={addr ?? activeWallet.ownerAddr}
                          walletId={activeWallet.walletId}
                          signMessage={signMessage}
                        />
                      </div>
                    )}
                  </div>
                </section>

                {/* Recent activity — real settlements scoped to this wallet
                    (or DEMO.activity in demo mode). */}
                <section>
                  <SectionHead
                    title="Recent activity"
                    action={<LinkButton>View all</LinkButton>}
                  />
                  <div style={styles.rows}>
                    {demoMode ? (
                      DEMO.activity.map((t) => (
                        <div key={t.id} style={styles.row}>
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
                          <div key={t.relayTxHash} style={styles.row}>
                            <div style={styles.rowIcon}>{out ? "↗" : "↓"}</div>
                            <div style={{ minWidth: 0 }}>
                              <strong style={{ fontSize: fs.base }}>
                                {out ? "Payment to" : "Received from"} {shortAddr(counter ?? "")}
                              </strong>
                              <span style={{ ...styles.rowSpan, display: "flex", alignItems: "center", gap: 5 }}>
                                <ChainIcon chain={asChainKey(t.chain)} size={13} />
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {(CHAIN_LABEL[t.chain] ?? t.chain)} · {t.tokenSymbol}
                                  {t.source === "recurring" ? " · recurring" : ""}
                                  {t.receiptId ? " · Trust Receipt ready" : ""}
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
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span aria-hidden>⚙</span> Wallet management
                    </span>
                    <span style={{ color: v2.muted2, fontSize: fs.label }}>
                      Export key · Archive · Restore
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
          <Surface style={{ ...styles.sideCard, padding: 0, overflow: "hidden" }}>
            <div style={{ padding: 16, paddingBottom: 0 }}>
              <SectionHead title="Automation" meta="Recurring & conditional" />
            </div>
            {/* The Recurring section carries its own bordered card + a `mt-5`
                top margin; pull it up so it sits flush under the head. The
                Automation card respects the user's scope view for new-schedule
                gating (recurring is a paid Multichain feature). */}
            <div style={{ padding: "0 12px 12px", marginTop: demoMode ? 12 : -20 }}>
              {demoMode || !activeWallet ? (
                // Demo: render sample automation rules (no auth/data fetch).
                <div style={{ display: "grid", gap: 8 }}>
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
                <AgenticWalletRecurringSection
                  walletId={activeWallet.walletId}
                  ownerAddress={addr ?? activeWallet.ownerAddr}
                  signMessage={signMessage}
                  perTxMaxUsd={activeWallet.perTxMaxUsd}
                  hasMultichainScope={multichainActive}
                  walletArchived={archived}
                />
              )}
            </div>
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
            {!demoMode && !agentNum && activeWallet && !archived && (
              <button type="button" onClick={() => setAgentOpen(true)} style={styles.agentLink}>
                ◉ Register this wallet on ERC-8004 →
              </button>
            )}
          </Surface>
        </aside>
      </div>

      {/* ── Reused action modals (each self-auths via getActionAuth) ────── */}
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
  },
  walletItemActive: {
    borderColor: "rgba(247,202,22,.27)",
    background: "linear-gradient(135deg, rgba(247,202,22,.09), rgba(247,202,22,.018))",
  },
  walletName: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 6,
    fontSize: fs.cardTitle,
    fontWeight: 650,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: v2.mint,
    boxShadow: `0 0 10px ${v2.mint}`,
    flexShrink: 0,
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
    border: "1px solid rgba(85,230,165,.15)",
    background: "rgba(85,230,165,.05)",
    padding: 12,
    borderRadius: 13,
  },

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
  badges: { display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" },
  badge: {
    padding: "5px 9px",
    border: `1px solid ${v2.line}`,
    borderRadius: 99,
    color: "#adb7c7",
    fontSize: fs.micro,
  },
  badgeGreen: {
    color: v2.mint,
    borderColor: "rgba(85,230,165,.2)",
    background: "rgba(85,230,165,.05)",
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
  actions: {
    display: "grid",
    gridTemplateColumns: "1.45fr 1fr 1fr 1fr 1fr",
    gap: 8,
    marginTop: 20,
    position: "relative",
    zIndex: 1,
  },
  action: {
    border: `1px solid ${v2.line}`,
    background: "rgba(255,255,255,.025)",
    color: v2.text,
    borderRadius: 10,
    padding: 12,
    textAlign: "left",
    cursor: "pointer",
    fontSize: fs.base,
  },
  actionPrimary: {
    background: v2.yellow,
    borderColor: v2.yellow,
    color: v2.actionText,
    fontWeight: 700,
  },
  actionDisabled: { opacity: 0.4, cursor: "not-allowed" },
  actionSmall: { display: "block", fontSize: fs.micro, opacity: 0.55, marginTop: 3 },
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
  allocation: { display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 11, alignItems: "start" },
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
  rows: { borderTop: `1px solid ${v2.line}` },
  row: {
    display: "grid",
    gridTemplateColumns: "31px minmax(0,1fr) auto",
    gap: 11,
    alignItems: "center",
    padding: "11px 0",
    borderBottom: "1px solid rgba(255,255,255,.05)",
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
  toggleOn: { background: "rgba(85,230,165,.27)" },
  toggleKnob: {
    display: "block",
    width: 11,
    height: 11,
    borderRadius: "50%",
    background: v2.toggleKnob,
    transition: ".2s",
  },
  toggleKnobOn: { transform: "translateX(13px)", background: v2.mint },
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
    color: v2.mint,
    borderColor: "rgba(85,230,165,.25)",
    background: "rgba(85,230,165,.06)",
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
  },
  // Collapsed "Wallet management" disclosure — keeps the destructive
  // DangerZone tucked at the foot of the console, opened on demand.
  manageDetails: {
    margin: "2px 25px 20px",
    borderTop: `1px solid ${v2.line}`,
    paddingTop: 12,
  },
  manageSummary: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    cursor: "pointer",
    listStyle: "none",
    userSelect: "none",
    color: v2.muted,
    fontSize: fs.body,
    fontWeight: 600,
    padding: "5px 0",
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
