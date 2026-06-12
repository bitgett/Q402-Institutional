"use client";

/**
 * AgenticWalletArchiveModal — destructive confirmation for Archive.
 *
 * Replaces the native `window.confirm()` that previously gated the
 * archive flow. A funded Agent Wallet should not be archivable from a
 * single OS-default Yes/No popup, especially because:
 *
 *   - The action soft-deletes the keystore record on day 0
 *   - The hard-delete cron sweeps the AES-encrypted key on day 7
 *   - Restore stops working after the grace window
 *
 * So the modal surfaces the live balance, the exit-strategy reminder
 * (export first if you want to walk away with funds), and a typed
 * confirmation token before enabling the red "Archive" button.
 *
 * The actual archive HTTP call lives in `AgenticWalletCard` — this
 * modal just collects an informed yes-or-no.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useModalEscape } from "./useModalEscape";

interface Props {
  walletAddress: string;
  /** Current aggregate balance USD; null = unknown yet. */
  balanceUsd: number | null;
  /** Pending state from the parent; disables the button + swaps copy. */
  archiving: boolean;
  /** Last error message, surfaced inline. */
  error: string | null;
  /** Force the parent to refetch balance immediately. The card's
   *  polling cadence is 5 minutes, which is the wrong default for a
   *  destructive flow — we don't want to render a stale balance the
   *  user has to confirm against. The modal triggers this once on
   *  mount so the displayed number is at most a few seconds old. */
  onRequestBalanceRefresh: () => void;
  onClose: () => void;
  onConfirm: () => void;
}

const TYPED_CONFIRM = "ARCHIVE";

function formatUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  if (n < 0.01 && n > 0) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function AgenticWalletArchiveModal({
  walletAddress,
  balanceUsd,
  archiving,
  error,
  onRequestBalanceRefresh,
  onClose,
  onConfirm,
}: Props) {
  const [typed, setTyped] = useState("");
  const armed = typed.trim().toUpperCase() === TYPED_CONFIRM;
  const hasBalance = balanceUsd !== null && balanceUsd > 0;
  // Portal mount guard (SSR-safe) — see SendModal for rationale.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useModalEscape(onClose, archiving);

  // Force a fresh balance read on mount — the card's 5-min polling
  // cadence is the wrong default for a destructive confirm. We don't
  // want the user to type ARCHIVE against a stale "$0.00" when a
  // deposit just landed.
  useEffect(() => {
    onRequestBalanceRefresh();
    // Intentionally fire-once on mount; the parent's polling continues
    // independently after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compute the hard-delete date once at mount (today + 7 days,
  // matching SOFT_DELETE_GRACE_MS on the server). useState's lazy
  // initialiser runs exactly once and pins the value across re-
  // renders — satisfies react-hooks/purity which forbids `Date.now()`
  // during render.
  const [hardDeleteLabel] = useState(() =>
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
  );

  if (!mounted) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(2,6,15,0.78)" }}
      onClick={archiving ? undefined : onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border p-6 space-y-4"
        style={{ background: "#0F1929", borderColor: "rgba(248,113,113,0.30)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-red-300 font-semibold">
              Destructive
            </div>
            <div className="text-white font-semibold text-lg">Archive Agent Wallet</div>
            <div className="text-[11px] text-white/45 font-mono mt-0.5">
              {walletAddress.slice(0, 10)}…{walletAddress.slice(-6)}
            </div>
          </div>
          {!archiving && (
            <button onClick={onClose} className="text-white/40 hover:text-white text-lg leading-none">
              ×
            </button>
          )}
        </div>

        <div
          className="rounded-md border px-3 py-3 text-[12.5px] leading-relaxed space-y-2"
          style={{ background: "rgba(248,113,113,0.06)", borderColor: "rgba(248,113,113,0.22)", color: "#fecaca" }}
        >
          <div>
            <span className="font-semibold">Current balance: {formatUsd(balanceUsd)}</span>
            {hasBalance && (
              <span className="text-white/60"> — funds remain on-chain at this address.</span>
            )}
          </div>
          <ul className="list-disc list-inside text-white/65 space-y-1">
            <li>Day 0: the wallet is soft-deleted. Send / Receive / Export stop working.</li>
            <li>
              Day 1-6: you can still restore the wallet from this dashboard.
            </li>
            <li>
              <span className="text-red-200">Day 7 ({hardDeleteLabel}):</span>{" "}
              the hard-delete cron sweeps Q402&apos;s encrypted copy of the key. Restore
              fails after this point.
            </li>
          </ul>
        </div>

        {hasBalance && (
          <div
            className="rounded-md border px-3 py-2.5 text-[12px] leading-relaxed"
            style={{ background: "rgba(252,211,77,0.06)", borderColor: "rgba(252,211,77,0.25)", color: "#fde68a" }}
          >
            You still have funds in this wallet. If you want to keep them after archive,
            <strong> Export the private key first</strong> (Danger Zone → Export private key)
            — Q402&apos;s server copy will be hard-deleted in 7 days, but if you&apos;ve
            saved the key, you can import it into MetaMask anytime.
          </div>
        )}

        <div>
          <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">
            Type <span className="font-mono text-red-300">{TYPED_CONFIRM}</span> to confirm
          </div>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={TYPED_CONFIRM}
            autoComplete="off"
            spellCheck={false}
            disabled={archiving}
            className="w-full rounded-md border px-3 py-2 text-sm font-mono text-white placeholder-white/25 disabled:opacity-50"
            style={{
              background: "rgba(255,255,255,0.02)",
              borderColor: armed ? "rgba(248,113,113,0.45)" : "rgba(255,255,255,0.06)",
            }}
          />
        </div>

        {error && (
          <div className="text-[12px] text-red-300/85">{error}</div>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={archiving}
            className="flex-1 px-3 py-2 rounded-md text-sm font-medium border border-white/12 text-white/75 hover:text-white disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!armed || archiving}
            className="flex-1 px-3 py-2 rounded-md text-sm font-semibold bg-red-500/85 text-white hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {archiving ? "Archiving…" : "Archive wallet"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
