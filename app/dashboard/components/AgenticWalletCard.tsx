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
import { getAuthCreds, getActionAuth } from "@/app/lib/auth-client";
import { AgenticWalletSendModal } from "./AgenticWalletSendModal";
import { AgenticWalletBatchModal } from "./AgenticWalletBatchModal";
import { AgenticWalletExportModal } from "./AgenticWalletExportModal";
import { AgenticWalletLimitsModal } from "./AgenticWalletLimitsModal";
import { AgenticWalletReceiveModal } from "./AgenticWalletReceiveModal";
import { AgenticWalletAgentModal } from "./AgenticWalletAgentModal";
import { AgenticWalletWithdrawModal, type WithdrawBucket } from "./AgenticWalletWithdrawModal";
import { AgenticWalletArchiveModal } from "./AgenticWalletArchiveModal";
import type { AgenticWalletPublic } from "./AgenticWalletTab";

interface BalancePayload {
  asOf: number;
  totalUsd: number;
}

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
  onChanged: () => void;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function AgenticWalletCard({
  wallet,
  address,
  signMessage,
  hasMultichainScope,
  onChanged,
}: Props) {
  const [sendOpen, setSendOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawBucket, setWithdrawBucket] = useState<WithdrawBucket | null>(null);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
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
        ...(force ? { force: "1" } : {}),
      }).toString();
      const res = await fetch(`/api/wallet/agentic/balance?${qs}`);
      if (!res.ok) return;
      const data = (await res.json()) as { balances?: BalancePayload };
      if (data.balances) {
        setBalance({ asOf: data.balances.asOf, totalUsd: data.balances.totalUsd });
        lastFetchRef.current = Date.now();
      }
    } catch {
      /* swallow — keep showing the last known balance */
    } finally {
      setBalanceLoading(false);
    }
  }, [address, signMessage, wallet.deletedAt]);

  useEffect(() => {
    void fetchBalance();
    const interval = setInterval(() => {
      void fetchBalance();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchBalance]);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  async function archive() {
    setArchiving(true);
    setArchiveError(null);
    try {
      // Action-scoped challenge so a leaked session signature can't fire
      // the 7-day destructive deletion path.
      const auth = await getActionAuth(
        address,
        "agentic.archive",
        { target: address.toLowerCase() },
        signMessage,
      );
      if (!auth) {
        setArchiveError("Sign the archive challenge in your wallet to confirm.");
        return;
      }
      const res = await fetch("/api/wallet/agentic", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          nonce: auth.challenge,
          signature: auth.signature,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setArchiveError(data.error ?? "Archive failed.");
        return;
      }
      setArchiveModalOpen(false);
      onChanged();
    } catch (e) {
      setArchiveError(e instanceof Error ? e.message : String(e));
    } finally {
      setArchiving(false);
    }
  }

  async function restore() {
    setRestoring(true);
    setRestoreError(null);
    try {
      const auth = await getAuthCreds(address, signMessage);
      if (!auth) {
        setRestoreError("Sign the auth challenge to restore.");
        return;
      }
      const res = await fetch("/api/wallet/agentic/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, nonce: auth.nonce, signature: auth.signature }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRestoreError(data.message ?? data.error ?? "Restore failed.");
        return;
      }
      onChanged();
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(false);
    }
  }

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
            <div className="text-white/65 text-sm leading-relaxed max-w-md">
              A separate wallet your AI signs through. Your MetaMask stays
              untouched — funds here are bounded by the caps below.
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
            className="rounded-full border px-3 py-1.5 flex items-center gap-2 text-[11px] font-mono text-white/65 hover:text-emerald-300 transition-colors shrink-0"
            style={{ borderColor: "rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.02)" }}
            title="Copy address"
          >
            <span>{shortAddr(wallet.address)}</span>
            <span className="text-white/30">{copied ? "✓" : "⎘"}</span>
          </button>
        </div>

        {/* Four stat tiles. Balance is the hero (wider). */}
        <div className="relative grid grid-cols-2 md:grid-cols-4 gap-2 mb-5">
          <StatTile
            label="Balance"
            value={balance ? formatBalance(balance.totalUsd) : balanceLoading ? "…" : "$—"}
            sub="USDC + USDT across 9 chains"
            tone="hero"
            action={
              <button
                type="button"
                onClick={() => { void fetchBalance(true); }}
                disabled={balanceLoading}
                title="Refresh balance"
                className="text-[10px] text-white/35 hover:text-emerald-300 transition-colors disabled:opacity-40"
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
                ? `ERC-8004 · agent #${wallet.erc8004AgentId.split(":")[1]}`
                : "encrypted key in keystore"
            }
          />
        </div>

        {/* Primary actions — Send / Receive / Batch sit here as equals. */}
        <div className="relative flex flex-wrap gap-2">
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
        </div>

        {/* Secondary utility row — wallet maintenance, low risk. */}
        <div className="relative mt-4 pt-4 border-t flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]"
          style={{ borderColor: "rgba(255,255,255,0.06)" }}
        >
          <button
            type="button"
            disabled={archived}
            onClick={() => setWithdrawOpen(true)}
            className="text-white/55 hover:text-emerald-300 transition-colors disabled:opacity-40"
          >
            ↩ Withdraw to your wallet
          </button>
          <button
            type="button"
            disabled={archived}
            onClick={() => setLimitsOpen(true)}
            className="text-white/55 hover:text-emerald-300 transition-colors disabled:opacity-40"
          >
            ⚙ Spending limits
          </button>
          {wallet.erc8004AgentId ? (
            <a
              href={`https://8004scan.io/eip155:${wallet.erc8004AgentId.split(":")[0] === "bsc" ? "56" : "1"}/agent/${wallet.erc8004AgentId.split(":")[1]}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-300/85 hover:text-emerald-200 transition-colors"
              title="View on 8004scan"
            >
              ◉ Agent #{wallet.erc8004AgentId.split(":")[1]} ↗
            </a>
          ) : (
            <button
              type="button"
              disabled={archived}
              onClick={() => setAgentOpen(true)}
              className="text-white/55 hover:text-emerald-300 transition-colors disabled:opacity-40"
            >
              ◉ Register on 8004scan
            </button>
          )}
        </div>
      </div>

      {/* ── Danger zone — visually walled off from the safe panel above. ─── */}
      <div
        className="mt-4 rounded-2xl border p-5 space-y-3"
        style={{
          background: "rgba(248,113,113,0.03)",
          borderColor: "rgba(248,113,113,0.25)",
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-red-300 text-[11px] uppercase tracking-[0.22em] font-semibold">
            Danger zone
          </span>
          <span className="text-white/35 text-[11px]">— irreversible once the 7-day grace expires</span>
        </div>

        {archived ? (
          <DangerRow
            title="Restore wallet"
            body={`Cancels the pending hard-delete. You have ${graceLeftDays ?? 0} day${graceLeftDays === 1 ? "" : "s"} of grace remaining.`}
            cta={restoring ? "Restoring…" : "Restore"}
            tone="safe"
            onClick={restore}
            disabled={restoring}
          />
        ) : (
          <DangerRow
            title="Archive wallet"
            body="Soft-deletes the wallet. You have 7 days to restore before Q402 hard-deletes the keystore record on schedule."
            cta={archiving ? "Archiving…" : "Archive…"}
            tone="danger"
            onClick={() => setArchiveModalOpen(true)}
            disabled={archiving}
          />
        )}

        <DangerRow
          title="Export private key"
          body="Reveals the raw signing key. Anyone who has it can spend the wallet's USDC / USDT immediately, on any chain. Step-up signature required."
          cta="Export"
          tone="danger"
          onClick={() => setExportOpen(true)}
          disabled={archived}
        />

        {(archiveError || restoreError) && (
          <div className="text-[12px] text-red-300/85">
            {archiveError ?? restoreError}
          </div>
        )}
      </div>

      {sendOpen && (
        <AgenticWalletSendModal
          walletAddress={wallet.address}
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

      {exportOpen && (
        <AgenticWalletExportModal
          walletAddress={wallet.address}
          ownerAddress={address}
          signMessage={signMessage}
          onClose={() => setExportOpen(false)}
          onArchiveRequest={() => {
            // Route through the typed-confirm modal — the export
            // modal must not bypass the destructive-confirm UX. The
            // export modal will close itself first; we open the
            // archive modal after a tick so the focus transitions
            // cleanly.
            setExportOpen(false);
            setArchiveModalOpen(true);
          }}
        />
      )}

      {limitsOpen && (
        <AgenticWalletLimitsModal
          ownerAddress={address}
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

      {agentOpen && (
        <AgenticWalletAgentModal
          walletAddress={wallet.address}
          ownerAddress={address}
          signMessage={signMessage}
          onClose={() => setAgentOpen(false)}
          onRegistered={() => {
            setAgentOpen(false);
            onChanged();
          }}
        />
      )}

      {archiveModalOpen && (
        <AgenticWalletArchiveModal
          walletAddress={wallet.address}
          balanceUsd={balance?.totalUsd ?? null}
          archiving={archiving}
          error={archiveError}
          onRequestBalanceRefresh={() => { void fetchBalance(true); }}
          onClose={() => {
            if (!archiving) setArchiveModalOpen(false);
          }}
          onConfirm={() => {
            void archive();
          }}
        />
      )}
    </>
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
        <div className="text-[10px] text-white/45 uppercase tracking-widest font-medium">
          {label}
        </div>
        {action}
      </div>
      <div className={`text-white tracking-tight ${hero ? "text-2xl font-semibold" : "text-base font-medium"}`}>
        {value}
      </div>
      <div className="text-[11px] text-white/35 mt-0.5">{sub}</div>
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
  iconArrow: "up-right" | "down-left" | "grid";
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

function ArrowIcon({ kind }: { kind: "up-right" | "down-left" | "grid" }) {
  if (kind === "grid") {
    return <span className="text-sm leading-none">⇉</span>;
  }
  if (kind === "down-left") {
    return <span className="text-sm leading-none rotate-180 inline-block">↗</span>;
  }
  return <span className="text-sm leading-none inline-block">↗</span>;
}

// ── DangerRow ──────────────────────────────────────────────────────────────

function DangerRow({
  title,
  body,
  cta,
  tone,
  onClick,
  disabled,
}: {
  title: string;
  body: string;
  cta: string;
  tone: "danger" | "safe";
  onClick: () => void;
  disabled?: boolean;
}) {
  const danger = tone === "danger";
  return (
    <div
      className="rounded-md border px-3 py-3 flex items-center justify-between gap-4"
      style={{
        background: "rgba(8,17,30,0.45)",
        borderColor: "rgba(255,255,255,0.06)",
      }}
    >
      <div className="min-w-0">
        <div className="text-[13px] text-white/90 font-medium">{title}</div>
        <div className="text-[11.5px] text-white/50 leading-relaxed mt-0.5">{body}</div>
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`shrink-0 px-3 py-1.5 rounded-md text-[12px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
          danger
            ? "bg-red-500/80 text-white hover:bg-red-500"
            : "bg-emerald-400 text-slate-900 hover:bg-emerald-300"
        }`}
      >
        {cta}
      </button>
    </div>
  );
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
