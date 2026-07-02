"use client";

/**
 * AgenticWalletCard — Agent Wallet console for the dashboard.
 *
 * Layout philosophy: this is a *safe box for AI spending*, not a developer
 * panel. Information density is the enemy. The card unfolds in three
 * progressive bands so a non-technical owner can scan top-to-bottom and
 * understand what they're looking at:
 *
 *   1. Identity strip       — one-line explanation + address chip
 *   2. Four stat tiles      — Balance · Daily cap · Per-tx cap · Signer
 *   3. Action surfaces      — primary (Send/Receive/Batch), secondary
 *                             (Withdraw/Limits), then a *separated*
 *                             danger zone for Archive and Export
 *
 * The danger zone is intentionally walled off with a red border so an
 * accidental click on "Export private key" can't feel like the user just
 * hit another settings button. Same for Archive while the wallet is
 * active. When the wallet is archived, the danger zone flips to surface
 * Restore + the remaining grace window.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getAuthCreds, clearAuthCache } from "@/app/lib/auth-client";
import { AgenticWalletSendModal } from "./AgenticWalletSendModal";
import { AgenticWalletBatchModal } from "./AgenticWalletBatchModal";
import { AgenticWalletLimitsModal } from "./AgenticWalletLimitsModal";
import { AgenticWalletHooksModal } from "./AgenticWalletHooksModal";
import { AgenticWalletReceiveModal } from "./AgenticWalletReceiveModal";
import { AgenticWalletAgentModal } from "./AgenticWalletAgentModal";
import { AgenticWalletBridgeModal } from "./AgenticWalletBridgeModal";
import { AgenticWalletWithdrawModal, type WithdrawBucket } from "./AgenticWalletWithdrawModal";
import { AgenticWalletRecurringSection } from "./AgenticWalletRecurringSection";
import { AgenticWalletEarnSection } from "./AgenticWalletEarnSection";
import type { AgenticWalletPublic } from "./AgenticWalletTab";
import type { ChainKey } from "@/app/lib/relayer";
import { explorerAddressUrl, explorerLabel } from "@/app/lib/eip7702";
import { GearIcon, HexagonIcon, AgentBadgeIcon } from "../v2/logos";

interface TokenSlice {
  usd: number;
  raw: string;
  decimals: number;
}

interface ChainBucket {
  chain: ChainKey;
  usdc: TokenSlice | null;
  usdt: TokenSlice | null;
  /** Robinhood Chain USDG (Paxos); null on other chains. In totalUsd. */
  usdg?: TokenSlice | null;
  totalUsd: number | null;
  error?: string;
}

interface BalancePayload {
  asOf: number;
  totalUsd: number;
  perChain: ChainBucket[];
}

const CHAIN_LABEL: Partial<Record<ChainKey, string>> = {
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
  robinhood: "Robinhood Chain",
};

function formatBalance(n: number): string {
  if (!Number.isFinite(n)) return "$—";
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const POLL_INTERVAL_MS = 5 * 60 * 1000;

interface Props {
  wallet: AgenticWalletPublic;
  address: string;
  signMessage: (message: string) => Promise<string | null>;
  /** Server-resolved: owner has paid multichain scope. Gates the Batch
   *  button trigger so trial users see a paid-only hint instead of
   *  bouncing off a backend 402 mid-modal. */
  hasMultichainScope: boolean;
  /**
   * Increment this counter (from the Tab) to force a fresh on-chain
   * balance fetch even when the wallet record is unchanged. Audit P1
   * fix — previously the Tab's `onChanged` callback only reloaded the
   * wallet record, leaving Holdings stale until the 5-minute poll
   * tick.
   */
  balanceRefreshTick?: number;
  /** Tab-level callback so the latest aggregate USD balance can be
   *  lifted up for the DangerZone's ArchiveModal warning. Card pushes
   *  every successful refresh; Tab caches the most recent number. */
  onBalance?: (totalUsd: number | null) => void;
  onChanged: () => void;
}

/**
 * Build an 8004scan agent URL from the wallet record's stored
 * `${network}:${agentId}` tag. 8004scan uses chain-slug paths
 * (`/agents/bsc/{id}`); keep this in sync with `scanUrl()` in
 * `app/lib/erc8004.ts`. Only the live registration network ("bsc")
 * is reachable today via ALLOWED_NETWORKS — the fallback covers any
 * future expansion without breaking the link.
 */
/**
 * Extract the numeric agentId portion of an `erc8004AgentId` tag.
 *
 * Tag shape today is `{network}:{agentId}` (e.g. `"bsc:124025"`) but
 * legacy or partial inputs ("12345", malformed) should not produce
 * "Agent #undefined" in the UI. Mirrors `parseAgentIdTag` in
 * app/lib/erc8004-reputation.ts — kept local + thin because the
 * server-side helper imports server-only modules.
 */
function agentIdFromTag(tag: string | null | undefined): string | null {
  if (typeof tag !== "string" || tag.length === 0) return null;
  const candidate = tag.includes(":") ? tag.split(":").pop() ?? "" : tag;
  return /^\d+$/.test(candidate) ? candidate : null;
}

function agentScanUrl(tag: string): string {
  const [maybeNetwork] = tag.split(":");
  const slug =
    maybeNetwork === "bsc-testnet" ? "bsc-testnet"
    : maybeNetwork === "eth" ? "ethereum"
    : maybeNetwork === "base" ? "base"
    : maybeNetwork === "polygon" ? "polygon"
    : maybeNetwork === "arbitrum" ? "arbitrum"
    : maybeNetwork === "celo" ? "celo"
    : "bsc";
  const id = agentIdFromTag(tag);
  // If the tag failed to parse, fall back to the raw tag (link will 404
  // on 8004scan but that's the safe outcome — no silent corruption).
  return `https://8004scan.io/agents/${slug}/${id ?? tag}`;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function AgenticWalletCard({
  wallet,
  address,
  signMessage,
  hasMultichainScope,
  balanceRefreshTick = 0,
  onBalance,
  onChanged,
}: Props) {
  const [sendOpen, setSendOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawBucket, setWithdrawBucket] = useState<WithdrawBucket | null>(null);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [hooksOpen, setHooksOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [balance, setBalance] = useState<BalancePayload | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const lastFetchRef = useRef<number>(0);

  const fetchBalance = useCallback(async (force = false) => {
    if (wallet.deletedAt !== null) return;
    setBalanceLoading(true);
    try {
      const auth = await getAuthCreds(address, signMessage);
      if (!auth) return;
      const qs = new URLSearchParams({
        address,
        nonce: auth.nonce,
        sig: auth.signature,
        walletId: wallet.walletId,
        ...(force ? { force: "1" } : {}),
      }).toString();
      const res = await fetch(`/api/wallet/agentic/balance?${qs}`);
      if (res.status === 401) {
        // Session sig expired — wipe the cached nonce so the next call
        // mints a fresh one instead of silently re-using the stale
        // creds forever and showing the user a frozen balance.
        clearAuthCache(address);
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
        setBalance(next);
        onBalance?.(next.totalUsd);
        lastFetchRef.current = Date.now();
      }
    } catch {
      /* swallow — keep showing the last known balance */
    } finally {
      setBalanceLoading(false);
    }
  }, [address, signMessage, wallet.deletedAt, wallet.walletId, onBalance]);

  useEffect(() => {
    void fetchBalance();
    const interval = setInterval(() => {
      void fetchBalance();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchBalance]);

  // External refresh trigger from the Tab — bumping balanceRefreshTick
  // forces a fresh on-chain read past the 5-minute cache. Closes the
  // "send done but Holdings still shows pre-send total" audit gap.
  useEffect(() => {
    if (balanceRefreshTick > 0) {
      void fetchBalance(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balanceRefreshTick]);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  // Card-level destructive flows (archive / restore / export) live in
  // AgenticWalletDangerZone — surfaced at the bottom of the Agent tab
  // so this card stays focused on identity + spending. The grace
  // counter below is still needed for the inline "Archived · N days
  // left" badge in the identity header.
  const archived = wallet.deletedAt !== null;
  const graceMs = 7 * 24 * 60 * 60 * 1000;
  const graceLeftDays = archived && wallet.deletedAt !== null
    ? Math.max(0, Math.ceil((wallet.deletedAt + graceMs - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;

  return (
    <>
      {/* ── Identity + stats card ─────────────────────────────────────────── */}
      <div
        className="rounded-2xl border p-7 relative overflow-hidden"
        style={{
          background: "linear-gradient(135deg, #0F1929 0%, #0A1521 100%)",
          borderColor: "rgba(74,222,128,0.18)",
        }}
      >
        <DotPattern />

        {/* Header — what this is, plus the address chip */}
        <div className="relative flex items-start justify-between gap-4 mb-5">
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-[0.22em] text-emerald-400/85 font-semibold">
              Agent Wallet
            </div>
            <div className="text-white/80 text-sm leading-relaxed max-w-md">
              Your AI&apos;s wallet. MetaMask untouched. Bounded by caps below.
            </div>
            <div className="text-[11.5px] text-white/75 mt-1 leading-relaxed max-w-md">
              From an AI / MCP?{" "}
              <a
                href="/docs#wallet-modes"
                className="text-emerald-300 hover:text-emerald-200 font-medium"
              >
                Pick a wallet mode (A / B / C) →
              </a>
            </div>
            {archived && (
              <div className="text-[11px] mt-2 inline-block px-2 py-0.5 rounded bg-red-500/12 text-red-300 font-medium">
                Archived · {graceLeftDays ?? 0} day{graceLeftDays === 1 ? "" : "s"} left to restore
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={copyAddress}
            className="rounded-full border px-3 py-1.5 flex items-center gap-2 text-[11px] font-mono text-white/85 hover:text-emerald-300 transition-colors shrink-0"
            style={{ borderColor: "rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.035)" }}
            title="Copy address"
          >
            <span>{shortAddr(wallet.address)}</span>
            <span className="text-white/55">{copied ? "✓" : "⎘"}</span>
          </button>
        </div>

        {/* Four stat tiles. Balance is the hero (wider). */}
        <div className="relative grid grid-cols-2 md:grid-cols-4 gap-2 mb-5">
          <StatTile
            label="Balance"
            value={balance ? formatBalance(balance.totalUsd) : balanceLoading ? "…" : "$—"}
            sub="USDC + USDT across 12 chains"
            tone="hero"
            action={
              <button
                type="button"
                onClick={() => { void fetchBalance(true); }}
                disabled={balanceLoading}
                title="Refresh balance"
                className="text-[10px] text-white/60 hover:text-emerald-300 transition-colors disabled:opacity-40"
              >
                {balanceLoading ? "…" : "↻"}
              </button>
            }
          />
          <StatTile
            label="Daily cap"
            value={wallet.dailyLimitUsd !== null ? `$${wallet.dailyLimitUsd}` : "no cap"}
            sub={wallet.dailyLimitUsd !== null ? "resets at 00:00 UTC" : "set one in limits"}
          />
          <StatTile
            label="Per-tx cap"
            value={wallet.perTxMaxUsd !== null ? `$${wallet.perTxMaxUsd}` : "no cap"}
            sub={wallet.perTxMaxUsd !== null ? "per single send" : "set one in limits"}
          />
          <StatTile
            label="Signer"
            value="Q402 server"
            sub={
              wallet.erc8004AgentId
                ? `ERC-8004 · agent #${(agentIdFromTag(wallet.erc8004AgentId) ?? "?")}`
                : "encrypted key in keystore"
            }
          />
        </div>

        {/* 12-chain coverage grid — always visible. Surfaces both the
            full chain support footprint AND where the balance sits, so
            the user sees at a glance "I have $4 on BNB, $0 elsewhere"
            instead of "$4 total somewhere". */}
        <ChainCoverageGrid wallet={wallet.address} balance={balance} />

        {/* Earn (Q402 Yield) — read-only positions + available APY. Sits
            with the balance band so idle-stablecoin yield surfaces next
            to where the user reads their holdings. Phase 0: no actions. */}
        <AgenticWalletEarnSection
          ownerAddress={address}
          walletId={wallet.walletId}
          signMessage={signMessage}
        />

        {/* Primary actions — Send / Receive / Batch sit here as equals. */}
        <div className="relative flex flex-wrap gap-2 mt-5">
          <ActionPill
            label="Send"
            disabled={archived}
            onClick={() => setSendOpen(true)}
            iconArrow="up-right"
          />
          <ActionPill
            label="Receive"
            disabled={archived}
            onClick={() => setReceiveOpen(true)}
            iconArrow="down-left"
          />
          <ActionPill
            label={hasMultichainScope ? "Batch send" : "Batch send (Paid)"}
            disabled={archived || !hasMultichainScope}
            onClick={() => setBatchOpen(true)}
            iconArrow="grid"
            title={
              hasMultichainScope
                ? undefined
                : "Batch sends require an active multichain subscription. Open the Payment tab to activate one."
            }
          />
          <ActionPill
            label={hasMultichainScope ? "Bridge USDC" : "Bridge USDC (Paid)"}
            disabled={archived || !hasMultichainScope}
            onClick={() => setBridgeOpen(true)}
            iconArrow="bridge"
            title={
              hasMultichainScope
                ? "Cross-chain USDC via Chainlink CCIP — ETH / AVAX / Arbitrum triangle."
                : "Cross-chain bridging requires an active multichain subscription."
            }
          />
        </div>

        {/* Secondary utility row — wallet maintenance, low risk. */}
        <div className="relative mt-4 pt-4 border-t flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]"
          style={{ borderColor: "rgba(255,255,255,0.06)" }}
        >
          <button
            type="button"
            disabled={archived}
            onClick={() => setWithdrawOpen(true)}
            className="text-white/75 hover:text-emerald-300 transition-colors disabled:opacity-40"
          >
            ↩ Withdraw to your wallet
          </button>
          <button
            type="button"
            disabled={archived}
            onClick={() => setLimitsOpen(true)}
            className="inline-flex items-center gap-1.5 text-white/75 hover:text-emerald-300 transition-colors disabled:opacity-40"
          >
            <GearIcon size={13} /> Spending limits
          </button>
          <button
            type="button"
            disabled={archived}
            onClick={() => setHooksOpen(true)}
            className="inline-flex items-center gap-1.5 text-white/75 hover:text-emerald-300 transition-colors disabled:opacity-40"
          >
            <HexagonIcon size={13} /> Hooks
          </button>
          {wallet.erc8004AgentId ? (
            <a
              href={wallet.reputation?.scan8004Url ?? agentScanUrl(wallet.erc8004AgentId)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-emerald-300/85 hover:text-emerald-200 transition-colors"
              title="View on 8004scan"
            >
              <AgentBadgeIcon size={13} /> Agent #{(agentIdFromTag(wallet.erc8004AgentId) ?? "?")}
              {wallet.reputation && wallet.reputation.total.feedbackCount > 0 ? (
                <>
                  {" · "}
                  <span className="text-white/55">
                    {wallet.reputation.total.feedbackCount} feedback
                  </span>
                  {wallet.reputation.fromQ402.feedbackCount > 0 ? (
                    <span className="text-white/45">
                      {" ("}
                      {wallet.reputation.fromQ402.feedbackCount}{" "}
                      Q402-weekly{")"}
                    </span>
                  ) : null}
                </>
              ) : null}
              {" ↗"}
            </a>
          ) : (
            <button
              type="button"
              disabled={archived}
              onClick={() => setAgentOpen(true)}
              className="inline-flex items-center gap-1.5 text-white/80 hover:text-emerald-300 transition-colors disabled:opacity-40"
            >
              <AgentBadgeIcon size={13} /> Register on 8004scan
            </button>
          )}
        </div>

        {/* Cross-chain USDC bridge (Chainlink CCIP). The Bridge button up
            top is the primary entrypoint; this banner just surfaces the
            scope + a link to CCIP Explorer for anyone who wants to track
            a message that didn't open from this session. */}
        <div
          className="mt-3 px-3 py-2.5 rounded-xl border"
          style={{ borderColor: "rgba(245,197,24,0.25)", background: "rgba(245,197,24,0.04)" }}
        >
          <div className="flex items-center justify-between gap-2">
            <div>
              <div
                className="text-[10px] uppercase tracking-widest font-medium mb-0.5"
                style={{ color: "rgba(245,197,24,0.9)" }}
              >
                Cross-chain USDC bridge · NEW
              </div>
              <div className="text-xs text-white/65">
                ETH ↔ AVAX ↔ Arbitrum via Chainlink CCIP. Fee in LINK (~10% cheaper) or native.
                Zero Q402 markup — you pay only the actual CCIP cost.
              </div>
            </div>
            <a
              href="https://ccip.chain.link/status"
              target="_blank"
              rel="noopener noreferrer"
              className="flex-shrink-0 text-xs text-yellow hover:text-yellow-hover transition-colors"
            >
              CCIP Explorer ↗
            </a>
          </div>
          <div className="mt-2 text-[10px] text-white/45">
            Open the <span className="text-yellow">Bridge USDC</span> button above to
            run a real bridge from the dashboard, OR fire it from an MCP client (Claude /
            Cursor / Cline / Codex) with <code className="text-yellow">q402_bridge_quote</code>{" "}
            then <code className="text-yellow">q402_bridge_send</code> (sandbox: false +{" "}
            live Multichain key). Both paths target the same Agent Wallet on the
            destination chain.
          </div>
        </div>

        {/* Recurring payments — list + create. Lives inside the wallet
            card so pending fires surface in context with the rest of
            the wallet state instead of a top-of-page strip. */}
        <AgenticWalletRecurringSection
          walletId={wallet.walletId}
          ownerAddress={address}
          signMessage={signMessage}
          perTxMaxUsd={wallet.perTxMaxUsd}
          hasMultichainScope={hasMultichainScope}
          walletArchived={archived}
        />
      </div>

      {sendOpen && (
        <AgenticWalletSendModal
          walletAddress={wallet.address}
          walletId={wallet.walletId}
          ownerAddress={address}
          signMessage={signMessage}
          onClose={() => setSendOpen(false)}
          onSent={() => {
            setSendOpen(false);
            onChanged();
          }}
          perTxMaxUsd={wallet.perTxMaxUsd}
          dailyLimitUsd={wallet.dailyLimitUsd}
        />
      )}

      {batchOpen && (
        <AgenticWalletBatchModal
          walletAddress={wallet.address}
          walletId={wallet.walletId}
          ownerAddress={address}
          signMessage={signMessage}
          onClose={() => setBatchOpen(false)}
          onSent={() => {
            setBatchOpen(false);
            onChanged();
          }}
        />
      )}

      {receiveOpen && (
        <AgenticWalletReceiveModal walletAddress={wallet.address} onClose={() => setReceiveOpen(false)} />
      )}

      {withdrawOpen && (
        <AgenticWalletWithdrawModal
          walletAddress={wallet.address}
          walletId={wallet.walletId}
          ownerAddress={address}
          signMessage={signMessage}
          perTxMaxUsd={wallet.perTxMaxUsd}
          onClose={() => setWithdrawOpen(false)}
          onPickBucket={(bucket) => {
            setWithdrawOpen(false);
            setWithdrawBucket(bucket);
          }}
        />
      )}

      {withdrawBucket && (
        <AgenticWalletSendModal
          walletAddress={wallet.address}
          walletId={wallet.walletId}
          ownerAddress={address}
          signMessage={signMessage}
          onClose={() => setWithdrawBucket(null)}
          onSent={() => {
            setWithdrawBucket(null);
            onChanged();
          }}
          prefillTo={address}
          prefillChain={withdrawBucket.chain}
          prefillToken={withdrawBucket.token}
          prefillAmount={withdrawBucket.amount}
          titleOverride={`Withdraw ${withdrawBucket.token} on ${withdrawBucket.chain}`}
          perTxMaxUsd={wallet.perTxMaxUsd}
          dailyLimitUsd={wallet.dailyLimitUsd}
        />
      )}

      {limitsOpen && (
        <AgenticWalletLimitsModal
          ownerAddress={address}
          walletId={wallet.walletId}
          signMessage={signMessage}
          initial={{
            dailyLimitUsd: wallet.dailyLimitUsd,
            perTxMaxUsd: wallet.perTxMaxUsd,
          }}
          onClose={() => setLimitsOpen(false)}
          onSaved={() => {
            setLimitsOpen(false);
            onChanged();
          }}
        />
      )}

      {hooksOpen && (
        <AgenticWalletHooksModal
          ownerAddress={address}
          walletId={wallet.walletId}
          signMessage={signMessage}
          onClose={() => setHooksOpen(false)}
          onSaved={() => {
            setHooksOpen(false);
            onChanged();
          }}
        />
      )}

      {agentOpen && (
        <AgenticWalletAgentModal
          walletAddress={wallet.address}
          walletId={wallet.walletId}
          ownerAddress={address}
          signMessage={signMessage}
          onClose={() => setAgentOpen(false)}
          onRegistered={() => {
            setAgentOpen(false);
            onChanged();
          }}
        />
      )}

      {bridgeOpen && (
        <AgenticWalletBridgeModal
          walletAddress={wallet.address}
          walletId={wallet.walletId}
          ownerAddress={address}
          signMessage={signMessage}
          hasMultichainScope={hasMultichainScope}
          onClose={() => setBridgeOpen(false)}
          onSent={() => {
            setBridgeOpen(false);
            onChanged();
          }}
        />
      )}

    </>
  );
}

// ── ChainCoverageGrid ──────────────────────────────────────────────────────
//
// Always-visible 12-chain grid. Each cell = one chain, showing the chain
// logo + label + (USDC + USDT) sub-totals in USD. Cells with $0 render
// dimmed so the eye still walks past them; cells with balance get a
// subtle accent ring. Surfaces both "Q402 supports these 12 chains" AND
// "here's where my money actually sits" in one row, replacing the old
// conditional HoldingsBreakdown that only appeared when the wallet was
// non-empty.

const CHAIN_ICON: Partial<Record<ChainKey, { src: string; alt: string }>> = {
  bnb:       { src: "/bnb.png",       alt: "BNB Chain" },
  eth:       { src: "/eth.png",       alt: "Ethereum" },
  avax:      { src: "/avax.png",      alt: "Avalanche" },
  xlayer:    { src: "/xlayer.png",    alt: "X Layer" },
  stable:    { src: "/stable.jpg",    alt: "Stable" },
  mantle:    { src: "/mantle.png",    alt: "Mantle" },
  injective: { src: "/injective.png", alt: "Injective" },
  monad:     { src: "/monad.png",     alt: "Monad" },
  scroll:    { src: "/scroll.png",    alt: "Scroll" },
  arbitrum:  { src: "/arbitrum.png",  alt: "Arbitrum" },
  base:      { src: "/base.png",      alt: "Base" },
  robinhood: { src: "/robinhood.svg", alt: "Robinhood Chain" },
};
const CHAIN_ORDER: ChainKey[] = ["bnb", "eth", "avax", "xlayer", "stable", "mantle", "injective", "monad", "scroll", "arbitrum", "base", "robinhood"];

function ChainCoverageGrid({ wallet, balance }: { wallet: string; balance: BalancePayload | null }) {
  const byChain = new Map<ChainKey, { usdc: number; usdt: number; total: number; error?: string }>();
  if (balance) {
    for (const c of balance.perChain) {
      byChain.set(c.chain, {
        usdc: c.usdc?.usd ?? 0,
        usdt: c.usdt?.usd ?? 0,
        total: c.totalUsd ?? 0,
        error: c.error,
      });
    }
  }

  return (
    <div
      className="relative mt-4 rounded-xl border p-3"
      style={{ background: "rgba(255,255,255,0.015)", borderColor: "rgba(255,255,255,0.06)" }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-widest text-white/65 font-medium">
          Balance by chain · 12 chains
        </div>
        {balance && (
          <div className="text-[10px] text-white/55">
            USDC · USDT · USDG
          </div>
        )}
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-5 lg:grid-cols-10 gap-1.5">
        {CHAIN_ORDER.map((chain) => {
          const slice = byChain.get(chain);
          const total = slice?.total ?? 0;
          const hasFunds = total > 0;
          const icon = CHAIN_ICON[chain];
          return (
            <a
              key={chain}
              href={explorerAddressUrl(chain, wallet)}
              target="_blank"
              rel="noopener noreferrer"
              title={`View on ${explorerLabel(chain)}`}
              className="group relative rounded-lg border p-2 flex flex-col items-center gap-1 transition-colors"
              style={{
                background: hasFunds ? "rgba(74,222,128,0.05)" : "rgba(255,255,255,0.01)",
                borderColor: hasFunds ? "rgba(74,222,128,0.25)" : "rgba(255,255,255,0.05)",
              }}
            >
              {/* Chain logo. /public assets at 20px — Next/Image is overkill;
                  these are static and inline so no LCP optimisation buys anything. */}
              {icon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={icon.src}
                  alt={icon.alt}
                  width={20}
                  height={20}
                  className={`rounded-full ${hasFunds ? "" : "opacity-50"}`}
                />
              ) : (
                <div className="w-5 h-5 rounded-full bg-white/10" aria-hidden />
              )}
              <div className={`text-[10px] font-medium leading-none truncate w-full text-center ${hasFunds ? "text-white/95" : "text-white/65"}`}>
                {CHAIN_LABEL[chain] ?? chain}
              </div>
              <div className={`text-[10.5px] font-mono leading-none ${hasFunds ? "text-emerald-300" : "text-white/50"}`}>
                {slice?.error
                  ? <span className="text-amber-300/70">RPC</span>
                  : total < 0.01 && total > 0
                    ? "<$0.01"
                    : `$${total.toFixed(2)}`}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

// ── HoldingsBreakdown ──────────────────────────────────────────────────────
//
// (Retained for any caller that still wants the row-per-bucket view —
// the wallet card itself now uses ChainCoverageGrid above. Kept exported
// so other surfaces can opt in to the same data presentation.)
//
// Renders one row per (chain, token) bucket with usd > 0. Each row
// links to the wallet's explorer page on that chain so a user can
// verify the on-chain side independently. Empty chains are summarised
// in a single trailing line ("Empty on: …") so the surface stays
// compact when the wallet only holds value on 1–2 chains.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function HoldingsBreakdown({ wallet, balance }: { wallet: string; balance: BalancePayload }) {
  type Row = { chain: ChainKey; token: "USDT" | "USDC" | "USDG"; usd: number };
  const rows: Row[] = [];
  const emptyChains: ChainKey[] = [];
  const failedChains: ChainKey[] = [];
  for (const c of balance.perChain) {
    if (c.error) { failedChains.push(c.chain); continue; }
    const usdt = c.usdt?.usd ?? 0;
    const usdc = c.usdc?.usd ?? 0;
    const usdg = c.usdg?.usd ?? 0;
    if (usdt > 0) rows.push({ chain: c.chain, token: "USDT", usd: usdt });
    if (usdc > 0) rows.push({ chain: c.chain, token: "USDC", usd: usdc });
    if (usdg > 0) rows.push({ chain: c.chain, token: "USDG", usd: usdg });
    if (usdt === 0 && usdc === 0 && usdg === 0) emptyChains.push(c.chain);
  }
  rows.sort((a, b) => b.usd - a.usd);
  if (rows.length === 0) return null;

  return (
    <div
      className="relative mt-4 rounded-xl border p-3"
      style={{ background: "rgba(255,255,255,0.015)", borderColor: "rgba(255,255,255,0.06)" }}
    >
      <div className="text-[10px] uppercase tracking-widest text-white/45 font-medium mb-2">
        Holdings · {rows.length} bucket{rows.length === 1 ? "" : "s"}
      </div>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={`${r.chain}-${r.token}`} className="flex items-center justify-between text-[12.5px]">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-white/80 font-medium">{CHAIN_LABEL[r.chain] ?? r.chain}</span>
              <span className="text-white/45">·</span>
              <span className="text-white/65 font-mono text-[12px]">{r.token}</span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-emerald-300 font-mono text-[12px]">
                {r.usd < 0.01 ? "<$0.01" : `$${r.usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`}
              </span>
              <a
                href={explorerAddressUrl(r.chain, wallet)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/40 hover:text-emerald-300 transition-colors text-[11px]"
                title={`View on ${explorerLabel(r.chain)}`}
              >
                ↗
              </a>
            </div>
          </div>
        ))}
      </div>
      {(emptyChains.length > 0 || failedChains.length > 0) && (
        <div className="text-[10.5px] text-white/35 mt-2 pt-2 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
          {emptyChains.length > 0 && (
            <span>Empty on {emptyChains.map((c) => CHAIN_LABEL[c] ?? c).join(" · ")}</span>
          )}
          {emptyChains.length > 0 && failedChains.length > 0 && <span> · </span>}
          {failedChains.length > 0 && (
            <span className="text-amber-300/70">RPC failed: {failedChains.map((c) => CHAIN_LABEL[c] ?? c).join(", ")}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ── StatTile ───────────────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  sub,
  tone,
  action,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "hero";
  action?: ReactNode;
}) {
  const hero = tone === "hero";
  return (
    <div
      className={`rounded-xl border p-3 ${hero ? "md:col-span-1" : ""}`}
      style={{
        background: hero ? "rgba(74,222,128,0.06)" : "rgba(255,255,255,0.02)",
        borderColor: hero ? "rgba(74,222,128,0.22)" : "rgba(255,255,255,0.06)",
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] text-white/65 uppercase tracking-widest font-medium">
          {label}
        </div>
        {action}
      </div>
      <div className={`text-white tracking-tight ${hero ? "text-2xl font-semibold" : "text-base font-medium"}`}>
        {value}
      </div>
      <div className="text-[11px] text-white/55 mt-0.5">{sub}</div>
    </div>
  );
}

// ── ActionPill ─────────────────────────────────────────────────────────────

function ActionPill({
  label,
  onClick,
  disabled,
  iconArrow,
  title,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  iconArrow: "up-right" | "down-left" | "grid" | "bridge";
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      style={{
        background: "rgba(74,222,128,0.10)",
        color: "#86efac",
        border: "1px solid rgba(74,222,128,0.25)",
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = "rgba(74,222,128,0.16)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "rgba(74,222,128,0.10)";
      }}
    >
      <ArrowIcon kind={iconArrow} />
      <span>{label}</span>
    </button>
  );
}

function ArrowIcon({ kind }: { kind: "up-right" | "down-left" | "grid" | "bridge" }) {
  if (kind === "grid") {
    return <span className="text-sm leading-none">⇉</span>;
  }
  if (kind === "bridge") {
    return <span className="text-sm leading-none">⇌</span>;
  }
  if (kind === "down-left") {
    return <span className="text-sm leading-none rotate-180 inline-block">↗</span>;
  }
  return <span className="text-sm leading-none inline-block">↗</span>;
}

// ── Decorative dot pattern ────────────────────────────────────────────────

function DotPattern() {
  return (
    <div
      aria-hidden
      className="absolute top-0 right-0 h-full w-1/2 pointer-events-none opacity-40"
      style={{
        background:
          "radial-gradient(circle, rgba(74,222,128,0.25) 1px, transparent 1.5px) 0 0 / 14px 14px",
        maskImage: "linear-gradient(to left, black 0%, black 30%, transparent 80%)",
        WebkitMaskImage: "linear-gradient(to left, black 0%, black 30%, transparent 80%)",
      }}
    />
  );
}
