"use client";

/**
 * AgenticWalletCard — hero "Available Balance" card for the Agent tab.
 *
 * Single balance surface up top with three pill-shaped primary actions
 * (Send / Receive / Add Funds) plus a secondary row for Withdraw,
 * Spending Limits, and Export. The address sits in the corner with a copy
 * chip and a per-chain explorer link picked from the Receive modal.
 * Archive opens a 7-day grace window during which the same surface
 * exposes a Restore action; after that the hard-delete cron sweeps the
 * record. Automated balance polling lands in a later phase.
 */

import { useState } from "react";
import { getAuthCreds } from "@/app/lib/auth-client";
import { AgenticWalletSendModal } from "./AgenticWalletSendModal";
import { AgenticWalletBatchModal } from "./AgenticWalletBatchModal";
import { AgenticWalletExportModal } from "./AgenticWalletExportModal";
import { AgenticWalletLimitsModal } from "./AgenticWalletLimitsModal";
import type { AgenticWalletPublic } from "./AgenticWalletTab";
import type { ChainKey } from "@/app/lib/relayer";
import { explorerAddressUrl, explorerLabel } from "@/app/lib/eip7702";

interface Props {
  wallet: AgenticWalletPublic;
  address: string;
  signMessage: (message: string) => Promise<string | null>;
  onChanged: () => void;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function AgenticWalletCard({ wallet, address, signMessage, onChanged }: Props) {
  const [sendOpen, setSendOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
    if (!confirm("Archive this Agent Wallet? You have 7 days to restore before hard-delete.")) return;
    setArchiving(true);
    setArchiveError(null);
    try {
      const auth = await getAuthCreds(address, signMessage);
      if (!auth) {
        setArchiveError("Sign the auth challenge to archive.");
        return;
      }
      const res = await fetch("/api/wallet/agentic", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, nonce: auth.nonce, signature: auth.signature }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setArchiveError(data.error ?? "Archive failed.");
        return;
      }
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
      <div
        className="rounded-2xl border p-7 relative overflow-hidden"
        style={{
          background: "linear-gradient(135deg, #0F1929 0%, #0A1521 100%)",
          borderColor: "rgba(74,222,128,0.18)",
        }}
      >
        <DotPattern />

        <div className="relative flex items-start justify-between gap-4 mb-6">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-white/45 font-medium mb-1">
              Available balance
            </div>
            <div className="flex items-baseline gap-2">
              <div className="text-4xl font-semibold text-white tracking-tight">
                $—
              </div>
              <div className="text-xs text-white/40">USDC + USDT · BNB</div>
            </div>
            {(wallet.dailyLimitUsd !== null || wallet.perTxMaxUsd !== null) && (
              <div className="text-[11px] text-white/35 mt-2">
                {wallet.perTxMaxUsd !== null && <>per-tx max ${wallet.perTxMaxUsd} · </>}
                {wallet.dailyLimitUsd !== null && <>daily cap ${wallet.dailyLimitUsd}</>}
              </div>
            )}
            {archived && (
              <div className="text-[11px] mt-2 inline-block px-2 py-0.5 rounded bg-red-500/12 text-red-300 font-medium">
                Archived · {graceLeftDays ?? 0} day{graceLeftDays === 1 ? "" : "s"} left to restore
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={copyAddress}
            className="rounded-full border px-3 py-1.5 flex items-center gap-2 text-[11px] font-mono text-white/65 hover:text-emerald-300 transition-colors"
            style={{ borderColor: "rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.02)" }}
            title="Copy address"
          >
            <span>{shortAddr(wallet.address)}</span>
            <span className="text-white/30">{copied ? "✓" : "⎘"}</span>
          </button>
        </div>

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
            label="Add Funds"
            disabled={archived}
            onClick={() => setReceiveOpen(true)}
            iconArrow="plus"
          />
          {archived ? (
            <button
              type="button"
              onClick={restore}
              disabled={restoring}
              className="ml-auto px-3 py-1.5 rounded-full text-[11px] font-medium text-emerald-300 hover:text-emerald-200 border border-emerald-400/30 hover:border-emerald-400/55 transition-colors disabled:opacity-40"
            >
              {restoring ? "restoring…" : "↺ Restore"}
            </button>
          ) : (
            <button
              type="button"
              onClick={archive}
              disabled={archiving}
              className="ml-auto px-3 py-1.5 rounded-full text-[11px] text-white/40 hover:text-red-300 transition-colors disabled:opacity-40"
            >
              {archiving ? "archiving…" : "archive"}
            </button>
          )}
        </div>

        {/* Secondary actions — subtler row underneath the primary pills. */}
        <div className="relative mt-4 pt-4 border-t flex flex-wrap items-center gap-4 text-[12px]"
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
            onClick={() => setBatchOpen(true)}
            className="text-white/55 hover:text-emerald-300 transition-colors disabled:opacity-40"
          >
            ⇉ Batch send
          </button>
          <button
            type="button"
            disabled={archived}
            onClick={() => setLimitsOpen(true)}
            className="text-white/55 hover:text-emerald-300 transition-colors disabled:opacity-40"
          >
            ⚙ Spending limits
          </button>
          <button
            type="button"
            disabled={archived}
            onClick={() => setExportOpen(true)}
            className="ml-auto text-white/45 hover:text-red-300 transition-colors disabled:opacity-40"
          >
            ⚠ Export private key
          </button>
        </div>

        {archiveError && (
          <div className="relative text-[12px] text-red-300/85 mt-3">{archiveError}</div>
        )}
        {restoreError && (
          <div className="relative text-[12px] text-red-300/85 mt-3">{restoreError}</div>
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
        <ReceiveModal walletAddress={wallet.address} onClose={() => setReceiveOpen(false)} />
      )}

      {withdrawOpen && (
        <AgenticWalletSendModal
          walletAddress={wallet.address}
          ownerAddress={address}
          signMessage={signMessage}
          onClose={() => setWithdrawOpen(false)}
          onSent={() => {
            setWithdrawOpen(false);
            onChanged();
          }}
          prefillTo={address}
          titleOverride="Withdraw to your wallet"
        />
      )}

      {exportOpen && (
        <AgenticWalletExportModal
          walletAddress={wallet.address}
          ownerAddress={address}
          signMessage={signMessage}
          onClose={() => setExportOpen(false)}
          onArchiveRequest={() => {
            void archive();
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
    </>
  );
}

// ── ActionPill ─────────────────────────────────────────────────────────────

function ActionPill({
  label,
  onClick,
  disabled,
  iconArrow,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  iconArrow: "up-right" | "down-left" | "plus";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
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

function ArrowIcon({ kind }: { kind: "up-right" | "down-left" | "plus" }) {
  if (kind === "plus") {
    return <span className="text-base leading-none">+</span>;
  }
  if (kind === "down-left") {
    return <span className="text-sm leading-none rotate-180 inline-block">↗</span>;
  }
  return <span className="text-sm leading-none inline-block">↗</span>;
}

// ── Receive / Add Funds modal ──────────────────────────────────────────────

const RECEIVE_CHAINS: ReadonlyArray<{ key: ChainKey; label: string }> = [
  { key: "bnb",       label: "BNB Chain" },
  { key: "eth",       label: "Ethereum" },
  { key: "avax",      label: "Avalanche" },
  { key: "xlayer",    label: "X Layer" },
  { key: "stable",    label: "Stable" },
  { key: "mantle",    label: "Mantle" },
  { key: "injective", label: "Injective" },
  { key: "monad",     label: "Monad" },
  { key: "scroll",    label: "Scroll" },
];

function ReceiveModal({ walletAddress, onClose }: { walletAddress: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [chain, setChain] = useState<ChainKey>("bnb");
  async function copy() {
    try {
      await navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(2,6,15,0.72)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border p-6 space-y-4"
        style={{ background: "#0F1929", borderColor: "rgba(74,222,128,0.20)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="text-white font-semibold text-lg">Receive USDC / USDT</div>
            <div className="text-[11px] text-white/45 mt-0.5">
              Same address across all supported EVM chains — pick the one you&apos;re depositing on.
            </div>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white text-lg leading-none">
            ×
          </button>
        </div>

        <div>
          <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">Network</div>
          <select
            value={chain}
            onChange={(e) => setChain(e.target.value as ChainKey)}
            className="w-full rounded-md border px-3 py-2 text-sm text-white"
            style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.05)" }}
          >
            {RECEIVE_CHAINS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div
          className="rounded-md border px-3 py-3 font-mono text-[12px] text-white/85 break-all leading-relaxed"
          style={{ background: "rgba(74,222,128,0.06)", borderColor: "rgba(74,222,128,0.18)" }}
        >
          {walletAddress}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={copy}
            className="flex-1 px-3 py-2 rounded-full text-sm font-medium"
            style={{
              background: "rgba(74,222,128,0.10)",
              color: "#86efac",
              border: "1px solid rgba(74,222,128,0.25)",
            }}
          >
            {copied ? "copied ✓" : "Copy address"}
          </button>
          <a
            href={explorerAddressUrl(chain, walletAddress)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 px-3 py-2 rounded-full text-sm font-medium text-center text-white/65 hover:text-white border border-white/10 hover:bg-white/[0.04]"
          >
            {explorerLabel(chain)} ↗
          </a>
        </div>
        <div className="text-[10px] text-white/35 text-center">
          Only send USDC or USDT on the selected network. Wrong-network deposits cannot be recovered.
        </div>
      </div>
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
