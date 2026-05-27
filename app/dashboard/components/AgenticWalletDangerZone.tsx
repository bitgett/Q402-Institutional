"use client";

/**
 * AgenticWalletDangerZone — compact destructive-action surface.
 *
 * Sits at the bottom of the Agent tab. Visually small + tinted red so
 * it doesn't compete with the primary actions in the main card, but
 * still reachable in one click. Two rows:
 *
 *   • Archive (or Restore when wallet.deletedAt is set)
 *   • Export private key
 *
 * Both routes go through dedicated modals that gather typed confirms /
 * step-up auth / canonical intent challenges — this component is just
 * the trigger surface.
 *
 * Owns:
 *   - archive / restore POST flow (action-bound challenge)
 *   - Export modal mount
 *   - Archive destructive modal mount (typed "ARCHIVE")
 *
 * The Card no longer renders these — pulling them out keeps the main
 * card focused on identity + spending actions and pushes the
 * destructive surface to where users expect it: at the bottom of the
 * page, small.
 */

import { useRef, useState } from "react";
import { getActionAuth } from "@/app/lib/auth-client";
import { AgenticWalletExportModal } from "./AgenticWalletExportModal";
import { AgenticWalletArchiveModal } from "./AgenticWalletArchiveModal";
import type { AgenticWalletPublic } from "./AgenticWalletTab";

interface Props {
  wallet: AgenticWalletPublic;
  /** Owner EOA — the address used for action-challenge signing. */
  address: string;
  signMessage: (message: string) => Promise<string | null>;
  /** Tab-level callback so post-action state propagates back up. */
  onChanged: () => void;
  /** Latest known aggregate USD balance, threaded through to the
   *  Archive modal's destructive-confirm preview. */
  balanceUsd: number | null;
  /** Force-refetch hook the Archive modal calls on mount. */
  onRequestBalanceRefresh: () => void;
}

const SOFT_DELETE_GRACE_DAYS = 7;

export function AgenticWalletDangerZone({
  wallet,
  address,
  signMessage,
  onChanged,
  balanceUsd,
  onRequestBalanceRefresh,
}: Props) {
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  // Synchronous guards — destructive actions must not double-fire.
  // setArchiving / setRestoring race the second click because state
  // updates batch; the ref check resolves synchronously at click time.
  const archiveInFlightRef = useRef(false);
  const restoreInFlightRef = useRef(false);

  const archived = wallet.deletedAt !== null;
  const graceLeftDays = archived && wallet.deletedAt !== null
    ? Math.max(
        0,
        Math.ceil(
          (wallet.deletedAt + SOFT_DELETE_GRACE_DAYS * 24 * 60 * 60 * 1000 - Date.now()) /
            (24 * 60 * 60 * 1000),
        ),
      )
    : null;

  const walletId = wallet.address.toLowerCase();

  async function archive() {
    if (archiveInFlightRef.current) return;
    archiveInFlightRef.current = true;
    setArchiving(true);
    setArchiveError(null);
    try {
      // walletId in the intent so the signed message is scoped to THIS
      // wallet. A leaked sig from one wallet can't archive another.
      const auth = await getActionAuth(
        address,
        "agentic.archive",
        { walletId },
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
          walletId,
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
      archiveInFlightRef.current = false;
      setArchiving(false);
    }
  }

  async function restore() {
    if (restoreInFlightRef.current) return;
    restoreInFlightRef.current = true;
    setRestoring(true);
    setRestoreError(null);
    try {
      // Restore is now intent-bound (`agentic.restore`) and walletId-
      // scoped. Server's POST /restore expects the same shape as DELETE.
      const auth = await getActionAuth(
        address,
        "agentic.restore",
        { walletId },
        signMessage,
      );
      if (!auth) {
        setRestoreError("Sign the restore challenge in your wallet.");
        return;
      }
      const res = await fetch("/api/wallet/agentic/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          walletId,
          nonce: auth.challenge,
          signature: auth.signature,
        }),
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
      restoreInFlightRef.current = false;
      setRestoring(false);
    }
  }

  return (
    <>
      <div
        className="rounded-xl border px-4 py-3"
        style={{
          background: "rgba(248,113,113,0.025)",
          borderColor: "rgba(248,113,113,0.18)",
        }}
      >
        <div className="flex items-center justify-between mb-2.5">
          <div className="text-[10px] uppercase tracking-[0.22em] text-red-300/85 font-semibold">
            Danger zone
          </div>
          <div className="text-[10px] text-white/35">
            irreversible after the 7-day grace expires
          </div>
        </div>

        <div className="space-y-1.5">
          {archived ? (
            <CompactDangerRow
              title="Restore wallet"
              hint={`Cancels the pending hard-delete. ${graceLeftDays ?? 0} day${graceLeftDays === 1 ? "" : "s"} of grace remaining.`}
              cta={restoring ? "Restoring…" : "Restore"}
              tone="safe"
              onClick={restore}
              disabled={restoring}
            />
          ) : (
            <CompactDangerRow
              title="Archive wallet"
              hint="Soft-delete → 7-day grace window → hard-delete cron sweeps the keystore record."
              cta={archiving ? "Archiving…" : "Archive…"}
              tone="danger"
              onClick={() => setArchiveModalOpen(true)}
              disabled={archiving}
            />
          )}

          <CompactDangerRow
            title="Export private key"
            hint="One-time reveal · step-up signature · audit-logged."
            cta="Export"
            tone="danger"
            onClick={() => setExportOpen(true)}
            disabled={archived}
          />
        </div>

        {(archiveError || restoreError) && (
          <div className="text-[11px] text-red-300/85 mt-2">
            {archiveError ?? restoreError}
          </div>
        )}
      </div>

      {exportOpen && (
        <AgenticWalletExportModal
          walletAddress={wallet.address}
          walletId={walletId}
          ownerAddress={address}
          signMessage={signMessage}
          onClose={() => setExportOpen(false)}
          onArchiveRequest={() => {
            setExportOpen(false);
            setArchiveModalOpen(true);
          }}
        />
      )}

      {archiveModalOpen && (
        <AgenticWalletArchiveModal
          walletAddress={wallet.address}
          balanceUsd={balanceUsd}
          archiving={archiving}
          error={archiveError}
          onRequestBalanceRefresh={onRequestBalanceRefresh}
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

function CompactDangerRow({
  title,
  hint,
  cta,
  tone,
  onClick,
  disabled,
}: {
  title: string;
  hint: string;
  cta: string;
  tone: "danger" | "safe";
  onClick: () => void;
  disabled?: boolean;
}) {
  const danger = tone === "danger";
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-white/85 font-medium">{title}</div>
        <div className="text-[11px] text-white/45 leading-snug">{hint}</div>
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`shrink-0 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
          danger
            ? "bg-red-500/70 text-white hover:bg-red-500"
            : "bg-emerald-400 text-slate-900 hover:bg-emerald-300"
        }`}
      >
        {cta}
      </button>
    </div>
  );
}
