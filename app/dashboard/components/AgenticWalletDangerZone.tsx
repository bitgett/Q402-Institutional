"use client";

/**
 * AgenticWalletDangerZone — the "Wallet management" surface at the foot of the
 * Agent console. Two stacked sections, styled with the v2 design tokens so the
 * typography matches the cards above it:
 *
 *   1. Delegation — per-chain EIP-7702 status (read-only, on-chain) with a
 *      gasless "Clear" per delegated chain. SAFE/reversible (a chain
 *      re-delegates on its next payment), so it is NOT in the red zone.
 *   2. Danger zone — Archive (or Restore) + Export private key. Destructive /
 *      sensitive, tinted red.
 *
 * Auth: every write is an owner-signed intent challenge (getActionAuth):
 *   - agentic.clear_delegation { walletId, chain } -> /api/wallet/agentic/clear-delegation
 *   - agentic.archive / agentic.restore { walletId } -> /api/wallet/agentic(.../restore)
 * Export / Archive go through dedicated modals (typed confirm / step-up auth).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getActionAuth } from "@/app/lib/auth-client";
import { AgenticWalletExportModal } from "./AgenticWalletExportModal";
import { AgenticWalletArchiveModal } from "./AgenticWalletArchiveModal";
import type { AgenticWalletPublic } from "./AgenticWalletTab";
import { v2, fs, subCard } from "@/app/dashboard/v2/theme";

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

// Display label + stable display order for the delegation list. Keyed by the
// Q402 chain key returned in /api/wallet/delegation-status.chains.
const CHAIN_LABEL: Record<string, string> = {
  bnb: "BNB Chain",
  eth: "Ethereum",
  base: "Base",
  arbitrum: "Arbitrum",
  avax: "Avalanche",
  scroll: "Scroll",
  mantle: "Mantle",
  xlayer: "X Layer",
  monad: "Monad",
  injective: "Injective",
  stable: "Stable",
};
const CHAIN_ORDER = Object.keys(CHAIN_LABEL);

interface DelegState {
  delegated: boolean;
  impl?: string;
  error?: string;
}

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
  const archiveInFlightRef = useRef(false);
  const restoreInFlightRef = useRef(false);

  // ── Delegation status ─────────────────────────────────────────────────
  const [deleg, setDeleg] = useState<Record<string, DelegState> | null>(null);
  const [delegLoading, setDelegLoading] = useState(true);
  const [clearingChain, setClearingChain] = useState<string | null>(null);
  const [delegError, setDelegError] = useState<string | null>(null);
  const clearInFlightRef = useRef(false);

  const refreshDeleg = useCallback(async () => {
    setDelegLoading(true);
    try {
      const r = await fetch(`/api/wallet/delegation-status?address=${wallet.address}`, { cache: "no-store" });
      const j = (await r.json()) as { chains?: Record<string, DelegState> };
      setDeleg(j.chains ?? {});
    } catch {
      setDeleg(null); // read failed — surface as "couldn't check"
    } finally {
      setDelegLoading(false);
    }
  }, [wallet.address]);

  useEffect(() => {
    void refreshDeleg();
  }, [refreshDeleg]);

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

  const delegatedChains = deleg
    ? CHAIN_ORDER.filter((c) => deleg[c]?.delegated)
    : [];

  async function clearChain(chain: string) {
    if (clearInFlightRef.current) return;
    clearInFlightRef.current = true;
    setClearingChain(chain);
    setDelegError(null);
    try {
      // Intent-bound: the signed message is scoped to (walletId, chain) so a
      // leaked sig can't clear another wallet/chain. Matches the server's
      // requireIntentAuth("agentic.clear_delegation", { walletId, chain }).
      const auth = await getActionAuth(address, "agentic.clear_delegation", { walletId, chain }, signMessage);
      if (!auth) {
        setDelegError("Sign the clear-delegation challenge in your wallet to confirm.");
        return;
      }
      const res = await fetch("/api/wallet/agentic/clear-delegation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, walletId, chain, nonce: auth.challenge, signature: auth.signature }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDelegError(data.message ?? data.error ?? "Clear failed.");
        return;
      }
      await refreshDeleg();
      onChanged();
    } catch (e) {
      setDelegError(e instanceof Error ? e.message : String(e));
    } finally {
      clearInFlightRef.current = false;
      setClearingChain(null);
    }
  }

  async function archive() {
    if (archiveInFlightRef.current) return;
    archiveInFlightRef.current = true;
    setArchiving(true);
    setArchiveError(null);
    try {
      const auth = await getActionAuth(address, "agentic.archive", { walletId }, signMessage);
      if (!auth) {
        setArchiveError("Sign the archive challenge in your wallet to confirm.");
        return;
      }
      const res = await fetch("/api/wallet/agentic", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, walletId, nonce: auth.challenge, signature: auth.signature }),
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
      const auth = await getActionAuth(address, "agentic.restore", { walletId }, signMessage);
      if (!auth) {
        setRestoreError("Sign the restore challenge in your wallet.");
        return;
      }
      const res = await fetch("/api/wallet/agentic/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, walletId, nonce: auth.challenge, signature: auth.signature }),
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
      {/* ── Delegation (safe / reversible) ─────────────────────────────── */}
      <div style={{ ...subCard(13), padding: 14, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ fontSize: fs.cardTitle, fontWeight: 600, color: v2.text }}>Delegation</span>
          <span style={{ fontSize: fs.label, color: v2.muted2 }}>EIP-7702 · gasless to clear</span>
        </div>

        {delegLoading ? (
          <div style={{ fontSize: fs.body, color: v2.muted }}>Checking delegation across chains…</div>
        ) : deleg === null ? (
          <div style={{ fontSize: fs.body, color: v2.muted }}>
            Couldn&apos;t read delegation status.{" "}
            <button type="button" onClick={() => void refreshDeleg()} style={linkBtn}>Retry</button>
          </div>
        ) : delegatedChains.length === 0 ? (
          <div style={{ fontSize: fs.body, color: v2.muted }}>
            No active delegations. This wallet is a clean EOA on every chain.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {delegatedChains.map((chain) => (
              <div key={chain} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: v2.yellow, flex: "none", boxShadow: `0 0 6px ${v2.yellow}` }} />
                  <span style={{ fontSize: fs.base, color: v2.text }}>{CHAIN_LABEL[chain] ?? chain}</span>
                  <span style={{ fontSize: fs.label, color: v2.muted2 }}>delegated</span>
                </div>
                <button
                  type="button"
                  onClick={() => void clearChain(chain)}
                  disabled={clearingChain !== null}
                  style={{ ...clearBtn, ...(clearingChain !== null ? disabledBtn : {}) }}
                >
                  {clearingChain === chain ? "Clearing…" : "Clear"}
                </button>
              </div>
            ))}
          </div>
        )}

        {delegError && (
          <div style={{ fontSize: fs.label, color: v2.red, marginTop: 9 }}>{delegError}</div>
        )}

        <div style={{ fontSize: fs.label, color: v2.muted, marginTop: 11, lineHeight: 1.6 }}>
          Clearing is gasless (Q402 sponsors it). A chain re-delegates automatically on its next
          payment, so clear it only right before sending on the x402 rail, which needs a non-delegated wallet.
        </div>
      </div>

      {/* ── Danger zone (destructive / sensitive) ──────────────────────── */}
      <div
        style={{
          borderRadius: 13,
          border: `1px solid ${withAlpha(v2.red, 0.18)}`,
          background: withAlpha(v2.red, 0.025),
          padding: "12px 14px",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ fontSize: fs.label, fontWeight: 600, letterSpacing: "0.16em", textTransform: "uppercase", color: withAlpha(v2.red, 0.9) }}>
            Danger zone
          </span>
          <span style={{ fontSize: fs.label, color: v2.muted2 }}>irreversible after the 7-day grace</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {archived ? (
            <ManageRow
              title="Restore wallet"
              hint={`Cancels the pending hard-delete. ${graceLeftDays ?? 0} day${graceLeftDays === 1 ? "" : "s"} of grace remaining.`}
              cta={restoring ? "Restoring…" : "Restore"}
              tone="safe"
              onClick={restore}
              disabled={restoring}
            />
          ) : (
            <ManageRow
              title="Archive wallet"
              hint="Soft-delete, then a 7-day grace window, then a hard-delete cron sweeps the keystore record."
              cta={archiving ? "Archiving…" : "Archive…"}
              tone="danger"
              onClick={() => setArchiveModalOpen(true)}
              disabled={archiving}
            />
          )}

          <ManageRow
            title="Export private key"
            hint="One-time reveal · step-up signature · audit-logged."
            cta="Export"
            tone="danger"
            onClick={() => setExportOpen(true)}
            disabled={archived}
          />
        </div>

        {(archiveError || restoreError) && (
          <div style={{ fontSize: fs.label, color: v2.red, marginTop: 9 }}>
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

/** Tint a hex color with an alpha (v2.red is a #rrggbb literal). */
function withAlpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

const clearBtn: React.CSSProperties = {
  flex: "none",
  padding: "5px 12px",
  borderRadius: 8,
  fontSize: fs.label,
  fontWeight: 600,
  cursor: "pointer",
  color: v2.cyan,
  background: "transparent",
  border: `1px solid ${withAlpha(v2.cyan, 0.4)}`,
};
const disabledBtn: React.CSSProperties = { opacity: 0.4, cursor: "not-allowed" };
const linkBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  color: v2.cyan,
  cursor: "pointer",
  fontSize: fs.body,
  textDecoration: "underline",
};

function ManageRow({
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
  const btn: React.CSSProperties = danger
    ? { color: "#fff", background: withAlpha(v2.red, 0.7), border: `1px solid ${withAlpha(v2.red, 0.5)}` }
    : { color: v2.actionText, background: v2.yellow, border: `1px solid ${v2.yellow}` };
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: fs.base, color: v2.text, fontWeight: 500 }}>{title}</div>
        <div style={{ fontSize: fs.label, color: v2.muted, lineHeight: 1.5 }}>{hint}</div>
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        style={{
          flex: "none",
          padding: "5px 12px",
          borderRadius: 8,
          fontSize: fs.label,
          fontWeight: 600,
          cursor: "pointer",
          ...btn,
          ...(disabled ? disabledBtn : {}),
        }}
      >
        {cta}
      </button>
    </div>
  );
}
