"use client";

/**
 * AgenticWalletCard — single-wallet display with quick actions.
 *
 * Phase 1 MVP scope: show the wallet's address with a copy + BscScan link,
 * a Send button that opens the send modal, and a placeholder for the
 * deposit flow (Phase 2 will add deposit detection + multichain balance).
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
  const [depositOpen, setDepositOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore — older browsers without permission */
    }
  }

  async function archive() {
    if (!confirm("Archive this Agentic Wallet? You have 7 days to restore it before hard-delete.")) return;
    setArchiving(true);
    setArchiveError(null);
    try {
      const auth = await getAuthCreds(address, signMessage);
      if (!auth) {
        setArchiveError("Please sign the auth challenge.");
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
    <div
      className="rounded-2xl border p-5 space-y-5"
      style={{ background: "#0F1929", borderColor: "rgba(255,255,255,0.07)" }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-white font-semibold">Agentic Wallet</span>
            {wallet.erc8004AgentId && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow/15 text-yellow font-mono">
                Agent #{wallet.erc8004AgentId.slice(-4)}
              </span>
            )}
            {archived && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-300">
                Archived
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-sm font-mono text-white/65">
            <span>{shortAddr(wallet.address)}</span>
            <button
              type="button"
              onClick={copyAddress}
              className="text-[11px] text-white/40 hover:text-yellow transition-colors"
              title="Copy address"
            >
              {copied ? "copied ✓" : "copy"}
            </button>
            <a
              href={`https://bscscan.com/address/${wallet.address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-white/40 hover:text-yellow transition-colors"
            >
              BscScan ↗
            </a>
          </div>
        </div>
      </div>

      {/* Balance section — Phase 2 will populate from a deposit-detection
          cron + Multicall3 read. For MVP we surface a placeholder so the
          UI doesn't lie about live numbers. */}
      <div className="grid grid-cols-2 gap-3">
        <div
          className="rounded-md border px-3 py-2 text-sm"
          style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.05)" }}
        >
          <div className="text-[10px] text-white/40 uppercase tracking-widest mb-0.5">BNB · USDC</div>
          <div className="text-white/85 font-mono">— check BscScan</div>
        </div>
        <div
          className="rounded-md border px-3 py-2 text-sm"
          style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.05)" }}
        >
          <div className="text-[10px] text-white/40 uppercase tracking-widest mb-0.5">BNB · USDT</div>
          <div className="text-white/85 font-mono">— check BscScan</div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={archived}
          onClick={() => setSendOpen(true)}
          className="px-3 py-1.5 rounded-md text-sm font-semibold bg-yellow text-navy hover:bg-yellow/90 disabled:opacity-40"
        >
          Send
        </button>
        <button
          type="button"
          onClick={() => setDepositOpen(o => !o)}
          className="px-3 py-1.5 rounded-md text-sm font-medium text-white/65 hover:text-white border border-white/10 hover:bg-white/[0.04]"
        >
          {depositOpen ? "Hide deposit" : "Deposit"}
        </button>
        <button
          type="button"
          disabled={archiving || archived}
          onClick={archive}
          className="ml-auto px-3 py-1.5 rounded-md text-sm font-medium text-white/45 hover:text-red-300 border border-white/10 hover:bg-white/[0.04] disabled:opacity-40"
        >
          {archiving ? "Archiving…" : archived ? "Archived" : "Archive"}
        </button>
      </div>

      {archiveError && (
        <div className="text-[12px] text-red-300/80">{archiveError}</div>
      )}

      {depositOpen && (
        <div
          className="rounded-md border px-4 py-3 space-y-2 text-sm"
          style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.05)" }}
        >
          <div className="text-white/75 font-semibold">Deposit to your Agentic Wallet</div>
          <div className="text-white/45 text-xs">
            Send USDC or USDT on BNB Chain to the address below. Phase 2 adds automatic
            balance polling — for now, verify the deposit on BscScan.
          </div>
          <div className="rounded bg-black/40 px-3 py-2 font-mono text-[11px] text-white/85 break-all">
            {wallet.address}
          </div>
        </div>
      )}

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
    </div>
  );
}
