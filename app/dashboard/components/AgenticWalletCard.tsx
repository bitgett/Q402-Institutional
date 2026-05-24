"use client";

/**
 * AgenticWalletCard — hero "Available Balance" card for the Agent tab.
 *
 * Layout mirrors the Kite / Agent Passport pattern: a single balance
 * surface up top with three pill-shaped actions (Send / Receive / Add
 * Funds) and the wallet's address tucked into the corner. Balance polling
 * + multi-chain reads land in Phase 2 — this MVP surface tells the
 * caller where to verify on-chain in the meantime.
 */

import { useState } from "react";
import { getAuthCreds } from "@/app/lib/auth-client";
import { AgenticWalletSendModal } from "./AgenticWalletSendModal";
import type { AgenticWalletPublic } from "./AgenticWalletTab";

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
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
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

  const archived = wallet.deletedAt !== null;

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
                Archived · 7-day grace
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
          <button
            type="button"
            onClick={archive}
            disabled={archiving || archived}
            className="ml-auto px-3 py-1.5 rounded-full text-[11px] text-white/40 hover:text-red-300 transition-colors disabled:opacity-40"
          >
            {archiving ? "archiving…" : archived ? "archived" : "archive"}
          </button>
        </div>

        {archiveError && (
          <div className="relative text-[12px] text-red-300/85 mt-3">{archiveError}</div>
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

      {receiveOpen && (
        <ReceiveModal walletAddress={wallet.address} onClose={() => setReceiveOpen(false)} />
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

function ReceiveModal({ walletAddress, onClose }: { walletAddress: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
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
            <div className="text-[11px] text-white/45 mt-0.5">BNB Chain · auto-credited (verify on BscScan)</div>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white text-lg leading-none">
            ×
          </button>
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
            href={`https://bscscan.com/address/${walletAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 px-3 py-2 rounded-full text-sm font-medium text-center text-white/65 hover:text-white border border-white/10 hover:bg-white/[0.04]"
          >
            BscScan ↗
          </a>
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
