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
import { v2, subCard } from "../theme";
import type { Scope } from "../theme";
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
  const agentNum = agentIdFromTag(activeWallet?.erc8004AgentId);

  return (
    <V2AccentScope style={{ paddingTop: 17 }}>
      <div className="v2-workspace" style={styles.workspace}>
        {/* ── Col 1 · Wallet rail ─────────────────────────────────────── */}
        <Surface className="v2-wallet-rail" style={styles.rail}>
          <Eyebrow>Agent wallets</Eyebrow>

          {wallets === undefined ? (
            <div style={{ color: v2.muted, fontSize: 10, marginTop: 14 }}>
              {addr ? "Loading wallets…" : "Connect a wallet to load."}
            </div>
          ) : wallets.length === 0 ? (
            <div style={{ color: v2.muted, fontSize: 10, marginTop: 14, lineHeight: 1.5 }}>
              No Agent Wallets yet. Create your first sandboxed AI spending
              wallet — your MetaMask stays untouched.
            </div>
          ) : (
            wallets.map((w) => {
              const isActive = w.walletId === (activeWallet?.walletId ?? activeId);
              const bal = balances[w.walletId];
              const isArchived = w.deletedAt != null;
              return (
                <button
                  key={w.walletId}
                  type="button"
                  onClick={() => setActiveId(w.walletId)}
                  style={{ ...styles.walletItem, ...(isActive ? styles.walletItemActive : null) }}
                  title={w.address}
                >
                  <div style={styles.walletName}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {w.label ?? "Agent wallet"}
                    </span>
                    {!isArchived && <span style={styles.dot} />}
                  </div>
                  <div style={styles.addr}>{shortAddr(w.address)}</div>
                  <div style={styles.walletBal}>
                    {bal ? fmtUsd(bal.totalUsd) : "$—"}
                  </div>
                  <div style={styles.walletNote}>
                    {isArchived
                      ? "Archived"
                      : w.erc8004AgentId
                        ? `ERC-8004 · #${agentIdFromTag(w.erc8004AgentId) ?? "?"}`
                        : w.walletId === (wallets[0]?.walletId)
                          ? "Default wallet"
                          : "Managed wallet"}
                  </div>
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
              capReached
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
              <strong style={{ display: "block", color: v2.mint, fontSize: 11 }}>
                Mode C · Managed
              </strong>
              <span style={{ display: "block", color: v2.muted, fontSize: 9, lineHeight: 1.45, marginTop: 4 }}>
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

          {activeWallet ? (
            <>
              {/* Hero */}
              <div style={styles.hero}>
                <div style={styles.heroGlow} aria-hidden />
                <div style={styles.identity}>
                  <div style={{ minWidth: 0 }}>
                    <Eyebrow>Agent Wallet</Eyebrow>
                    <h1 style={styles.heroH1}>{activeWallet.label ?? "Agent wallet"}</h1>
                    <button
                      type="button"
                      onClick={copyActiveAddress}
                      style={styles.address}
                      title="Copy address"
                    >
                      <span style={{ overflowWrap: "anywhere" }}>{activeWallet.address}</span>
                      <span style={{ color: v2.yellow, marginLeft: 6 }}>{copied ? "copied ✓" : "copy"}</span>
                    </button>
                    <div style={styles.badges}>
                      <span style={{ ...styles.badge, ...styles.badgeGreen }}>
                        {archived ? "Archived" : "Ready to spend"}
                      </span>
                      <span style={styles.badge}>
                        {multichainActive ? "Multichain · 10 chains" : "Trial · BNB"}
                      </span>
                      {agentNum && <span style={styles.badge}>ERC-8004 #{agentNum}</span>}
                    </div>
                  </div>
                  <div style={styles.heroBal}>
                    <span style={styles.heroBalLabel}>Total portfolio</span>
                    <strong style={styles.heroBalValue}>
                      {activeBalanceLoading && !activeBalance ? "…" : fmtUsd(activeBalance?.totalUsd)}
                    </strong>
                    <button
                      type="button"
                      onClick={() => fetchBalance(activeWallet, { active: true, force: true })}
                      disabled={activeBalanceLoading}
                      style={styles.refreshLink}
                    >
                      {activeBalanceLoading ? "Refreshing…" : "Updated · refresh ↻"}
                    </button>
                  </div>
                </div>

                {/* Actions — each opens the EXISTING modal */}
                <div style={styles.actions}>
                  <button
                    type="button"
                    disabled={archived}
                    onClick={() => setSendOpen(true)}
                    style={{ ...styles.action, ...styles.actionPrimary, ...(archived ? styles.actionDisabled : null) }}
                  >
                    Send payment
                    <small style={styles.actionSmall}>USDC / USDT</small>
                  </button>
                  <button
                    type="button"
                    disabled={archived}
                    onClick={() => setReceiveOpen(true)}
                    style={{ ...styles.action, ...(archived ? styles.actionDisabled : null) }}
                  >
                    Receive
                    <small style={styles.actionSmall}>Show address</small>
                  </button>
                  <button
                    type="button"
                    disabled={archived || !multichainActive}
                    onClick={() => setBatchOpen(true)}
                    title={
                      multichainActive
                        ? undefined
                        : hasMultichainScope
                          ? "Switch the top-bar scope to Multichain to batch across chains."
                          : "Batch sends require an active Multichain subscription."
                    }
                    style={{ ...styles.action, ...(archived || !multichainActive ? styles.actionDisabled : null) }}
                  >
                    Batch{!multichainActive && " (Paid)"}
                    <small style={styles.actionSmall}>Up to 20</small>
                  </button>
                  <button
                    type="button"
                    disabled={archived || !multichainActive}
                    onClick={() => setBridgeOpen(true)}
                    title={
                      multichainActive
                        ? "Cross-chain USDC via Chainlink CCIP."
                        : hasMultichainScope
                          ? "Switch the top-bar scope to Multichain to bridge across chains."
                          : "Bridging requires an active Multichain subscription."
                    }
                    style={{ ...styles.action, ...(archived || !multichainActive ? styles.actionDisabled : null) }}
                  >
                    Bridge{!multichainActive && " (Paid)"}
                    <small style={styles.actionSmall}>CCIP</small>
                  </button>
                </div>

                {/* MCP command bar */}
                <div style={styles.command}>
                  <div style={{ color: v2.yellow, fontSize: 15 }}>✦</div>
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ display: "block", fontSize: 9 }}>Tell this wallet what to do</strong>
                    <span style={{ display: "block", color: v2.muted, fontSize: 9, marginTop: 2 }}>
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
                {/* Capital allocation + Yield */}
                <section>
                  <SectionHead title="Capital allocation" meta="10 networks monitored" />
                  <div style={styles.allocation}>
                    <div style={{ ...subCard(13), padding: 14 }}>
                      <div style={styles.assetTop}>
                        <div style={styles.token}>
                          <span style={styles.coin}>₮</span>
                          <div>
                            Stablecoins
                            <div style={styles.sub}>Available to agents</div>
                          </div>
                        </div>
                        <div style={{ font: `600 16px ${displayFont}` }}>{fmtUsd(allocation.total)}</div>
                      </div>
                      <div style={styles.chainbar}>
                        {allocation.segs.length > 0 ? (
                          allocation.segs.map((s, i) => (
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
                        {allocation.segs.length > 0 ? (
                          allocation.segs.map((s) => (
                            <span key={s.chain}>
                              <b style={{ color: "#d6dce5" }}>{Math.round(s.pct)}%</b>{" "}
                              {CHAIN_LABEL[s.chain] ?? s.chain}
                            </span>
                          ))
                        ) : (
                          <span>No stablecoin balance yet — Receive to fund this wallet.</span>
                        )}
                      </div>
                    </div>

                    {/* Yield — reuse the shipped Earn section (real Aave data +
                        its own deposit/withdraw modal). It carries its own
                        bordered card + a `mt-4` top margin; neutralise that
                        margin so it top-aligns with the allocation card. The
                        surrounding V2AccentScope re-skins its emerald → yellow. */}
                    <div style={{ marginTop: -16 }}>
                      <AgenticWalletEarnSection
                        ownerAddress={addr ?? activeWallet.ownerAddr}
                        walletId={activeWallet.walletId}
                        signMessage={signMessage}
                      />
                    </div>
                  </div>
                </section>

                {/* Recent activity — real settlements scoped to this wallet */}
                <section>
                  <SectionHead
                    title="Recent activity"
                    action={<LinkButton>View all</LinkButton>}
                  />
                  <div style={styles.rows}>
                    {recentForActive.length === 0 ? (
                      <div style={{ color: v2.muted, fontSize: 10, padding: "12px 0" }}>
                        No settlements yet for this wallet.
                      </div>
                    ) : (
                      recentForActive.map((t) => {
                        const out = t.fromUser?.toLowerCase() === activeWallet.address.toLowerCase();
                        const amt = Number(t.tokenAmount);
                        const counter = out ? t.toUser : t.fromUser;
                        return (
                          <div key={t.relayTxHash} style={styles.row}>
                            <div style={styles.rowIcon}>{out ? "↗" : "↓"}</div>
                            <div style={{ minWidth: 0 }}>
                              <strong style={{ fontSize: 10 }}>
                                {out ? "Payment to" : "Received from"} {shortAddr(counter ?? "")}
                              </strong>
                              <span style={styles.rowSpan}>
                                {(CHAIN_LABEL[t.chain] ?? t.chain)} · {t.tokenSymbol}
                                {t.source === "recurring" ? " · recurring" : ""}
                                {t.receiptId ? " · Trust Receipt ready" : ""}
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
            </>
          ) : wallets && wallets.length === 0 ? (
            <div style={{ padding: 40, color: v2.muted, fontSize: 12, textAlign: "center" }}>
              Create your first Agent Wallet from the rail to begin. A
              sandboxed wallet your AI can spend from — bounded by the caps
              and policies you set on the right.
            </div>
          ) : (
            <div style={{ padding: 40, color: v2.muted, fontSize: 12, textAlign: "center" }}>
              {addr ? "Loading wallet console…" : "Connect a wallet to view the console."}
            </div>
          )}
        </Surface>

        {/* ── Col 3 · Right rail ──────────────────────────────────────── */}
        <aside className="v2-right" style={styles.right}>
          {/* Payment policy — real Hooks config */}
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
                  background: `conic-gradient(${v2.mint} 0 ${policyScore}%, ${v2.ringTrack} ${policyScore}%)`,
                }}
              >
                <span style={styles.ringInner} aria-hidden />
                <b style={styles.ringNum}>{activeWallet ? policyScore : "—"}</b>
              </div>
              <div>
                <strong style={{ fontSize: 12 }}>
                  {protectionsActive >= 3 ? "Strong guardrails" : protectionsActive >= 1 ? "Some guardrails" : "Minimal guardrails"}
                </strong>
                <span style={{ display: "block", color: v2.muted, fontSize: 9, marginTop: 3 }}>
                  {protectionsActive} protection{protectionsActive === 1 ? "" : "s"} active
                </span>
              </div>
            </div>
            {policyRows.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => activeWallet && !archived && setHooksOpen(true)}
                style={styles.policy}
                title="Edit policies in Hooks"
              >
                <div style={{ textAlign: "left" }}>
                  {p.label}
                  <span style={{ display: "block", color: v2.muted, fontSize: 8, marginTop: 2 }}>{p.detail}</span>
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
            <div style={{ padding: "0 12px 12px", marginTop: -20 }}>
              {activeWallet ? (
                <AgenticWalletRecurringSection
                  walletId={activeWallet.walletId}
                  ownerAddress={addr ?? activeWallet.ownerAddr}
                  signMessage={signMessage}
                  perTxMaxUsd={activeWallet.perTxMaxUsd}
                  hasMultichainScope={multichainActive}
                  walletArchived={archived}
                />
              ) : (
                <div style={{ color: v2.muted, fontSize: 9, padding: "8px 4px" }}>
                  Select a wallet to manage schedules.
                </div>
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
                <span style={{ display: "block", color: v2.muted, fontSize: 8 }}>Per payment</span>
                <b style={styles.limitVal}>
                  {activeWallet?.perTxMaxUsd != null ? `$${activeWallet.perTxMaxUsd}` : "No cap"}
                </b>
              </div>
              <div style={styles.limit}>
                <span style={{ display: "block", color: v2.muted, fontSize: 8 }}>Daily limit</span>
                <b style={styles.limitVal}>
                  {activeWallet?.dailyLimitUsd != null ? `$${activeWallet.dailyLimitUsd}` : "No cap"}
                </b>
              </div>
            </div>
            {!agentNum && activeWallet && !archived && (
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
    fontSize: 12,
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
  addr: { font: `500 9px ${displayFont}`, color: v2.muted, marginTop: 4 },
  walletBal: { font: `600 21px ${displayFont}`, letterSpacing: "-.04em", marginTop: 12 },
  walletNote: { color: v2.muted2, fontSize: 9, marginTop: 2 },
  newWallet: {
    marginTop: 10,
    border: "1px dashed rgba(255,255,255,.14)",
    background: "none",
    color: v2.muted,
    padding: 11,
    borderRadius: 11,
    cursor: "pointer",
    fontSize: 10,
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
    fontSize: 10,
  },
  hero: {
    padding: "24px 25px 21px",
    borderBottom: `1px solid ${v2.line}`,
    position: "relative",
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
  heroH1: { font: `650 25px ${displayFont}`, letterSpacing: "-.045em", margin: "5px 0 2px" },
  address: {
    color: v2.muted,
    font: `500 10px ${displayFont}`,
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
    padding: "5px 8px",
    border: `1px solid ${v2.line}`,
    borderRadius: 99,
    color: "#adb7c7",
    fontSize: 8,
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
    fontSize: 9,
    letterSpacing: ".13em",
    textTransform: "uppercase",
  },
  heroBalValue: { display: "block", font: `650 34px ${displayFont}`, letterSpacing: "-.06em", marginTop: 4 },
  refreshLink: {
    border: 0,
    background: "none",
    color: v2.muted,
    fontSize: 9,
    cursor: "pointer",
    marginTop: 4,
    padding: 0,
  },
  actions: {
    display: "grid",
    gridTemplateColumns: "1.45fr 1fr 1fr 1fr",
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
    padding: 11,
    textAlign: "left",
    cursor: "pointer",
  },
  actionPrimary: {
    background: v2.yellow,
    borderColor: v2.yellow,
    color: v2.actionText,
    fontWeight: 700,
  },
  actionDisabled: { opacity: 0.4, cursor: "not-allowed" },
  actionSmall: { display: "block", fontSize: 8, opacity: 0.55, marginTop: 2 },
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
    fontSize: 9,
    fontWeight: 700,
    borderRadius: 8,
    padding: "7px 10px",
    cursor: "pointer",
    textDecoration: "none",
    whiteSpace: "nowrap",
  },
  content: { padding: "19px 25px 23px", display: "grid", gap: 18 },
  allocation: { display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 11, alignItems: "start" },
  assetTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  token: { display: "flex", gap: 8, alignItems: "center", fontSize: 11, fontWeight: 600 },
  coin: {
    width: 23,
    height: 23,
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    background: v2.coinUsdt,
    color: "white",
    fontSize: 8,
    flexShrink: 0,
  },
  sub: { color: v2.muted, fontSize: 8, marginTop: 2 },
  chainbar: {
    display: "flex",
    height: 5,
    borderRadius: 8,
    overflow: "hidden",
    background: "#172438",
    marginTop: 13,
  },
  chains: { display: "flex", gap: 10, color: v2.muted, fontSize: 8, marginTop: 8, flexWrap: "wrap" },
  rows: { borderTop: `1px solid ${v2.line}` },
  row: {
    display: "grid",
    gridTemplateColumns: "30px minmax(0,1fr) auto",
    gap: 10,
    alignItems: "center",
    padding: "10px 0",
    borderBottom: "1px solid rgba(255,255,255,.05)",
  },
  rowIcon: {
    width: 29,
    height: 29,
    borderRadius: 9,
    background: "rgba(255,255,255,.04)",
    display: "grid",
    placeItems: "center",
    color: v2.mint,
    fontSize: 12,
  },
  rowSpan: { display: "block", color: v2.muted, fontSize: 8, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rowValue: { textAlign: "right", font: `600 10px ${displayFont}` },
  rowStatus: { fontSize: 8, marginTop: 2, textDecoration: "none", display: "inline-block" },

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
  ringNum: { position: "relative", font: `600 11px ${displayFont}` },
  policy: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "9px 0",
    fontSize: 10,
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
  limitsCard: { borderColor: "rgba(247,202,22,.18)", background: "rgba(247,202,22,.03)" },
  limitGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginTop: 11 },
  limit: { padding: 9, borderRadius: 9, background: "rgba(0,0,0,.14)" },
  limitVal: { display: "block", font: `600 12px ${displayFont}`, marginTop: 3 },
  agentLink: {
    marginTop: 13,
    border: 0,
    background: "none",
    color: v2.yellow,
    fontSize: 9,
    cursor: "pointer",
    padding: 0,
    textAlign: "left",
  },
};
