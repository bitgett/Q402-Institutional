"use client";

/**
 * AgenticWalletLimitsModal — set / clear per-wallet spending caps.
 *
 * Maps `dailyLimitUsd` + `perTxMaxUsd` on the wallet record. Empty
 * input clears the cap (sent as null). The server validates that each
 * value is finite, non-negative, and below the LIMIT_MAX_USD ceiling.
 *
 * Multi-wallet Phase 3: takes walletId so a leaked session signature
 * can't raise caps on a different wallet. PATCH is now intent-bound
 * (`agentic.limits`) and embeds the new values in the canonical
 * message so the signature is provably tied to *this* exact change.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getActionAuth } from "@/app/lib/auth-client";
import { useModalEscape } from "./useModalEscape";

interface Props {
  ownerAddress: string;
  walletId: string;
  signMessage: (message: string) => Promise<string | null>;
  initial: { dailyLimitUsd: number | null; perTxMaxUsd: number | null };
  onClose: () => void;
  onSaved: () => void;
}

export function AgenticWalletLimitsModal({
  ownerAddress,
  walletId,
  signMessage,
  initial,
  onClose,
  onSaved,
}: Props) {
  const [daily, setDaily] = useState<string>(initial.dailyLimitUsd?.toString() ?? "");
  const [perTx, setPerTx] = useState<string>(initial.perTxMaxUsd?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Portal mount guard (SSR-safe) — see SendModal for rationale.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const inFlightRef = useRef(false);
  useModalEscape(onClose, saving);

  function parseField(raw: string): number | null | "invalid" {
    const t = raw.trim();
    if (t === "") return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return "invalid";
    return n;
  }

  async function submit() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    const d = parseField(daily);
    const p = parseField(perTx);
    if (d === "invalid") {
      setError("Daily cap must be a non-negative number or empty.");
      inFlightRef.current = false;
      return;
    }
    if (p === "invalid") {
      setError("Per-tx max must be a non-negative number or empty.");
      inFlightRef.current = false;
      return;
    }
    setSaving(true);
    try {
      // Intent-bound. The canonical message includes both new values
      // (or "null" / "unchanged" sentinels matching what we send) so
      // the server's rebuild + verify catches any tampering. Action
      // names tie the signature to this exact PATCH — replaying as a
      // delete or send fails the action check.
      const intent: Record<string, string> = {
        walletId,
        dailyLimitUsd: d === null ? "null" : String(d),
        perTxMaxUsd: p === null ? "null" : String(p),
        label: "unchanged",
      };
      const auth = await getActionAuth(ownerAddress, "agentic.limits", intent, signMessage);
      if (!auth) {
        setError("Sign the limits challenge in your wallet to save.");
        return;
      }
      const res = await fetch("/api/wallet/agentic", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: ownerAddress,
          walletId,
          nonce: auth.challenge,
          signature: auth.signature,
          dailyLimitUsd: d,
          perTxMaxUsd: p,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? data.message ?? `Save failed (HTTP ${res.status}).`);
        return;
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
      inFlightRef.current = false;
    }
  }

  if (!mounted) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(2,6,15,0.72)" }}
      onClick={saving ? undefined : onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="limits-modal-title"
    >
      <div
        className="w-full max-w-md rounded-2xl border p-6 space-y-4"
        style={{ background: "#0F1929", borderColor: "rgba(247,202,22,.30)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div id="limits-modal-title" className="text-white font-semibold text-lg">
              Spending limits
            </div>
            <div className="text-[11px] text-white/45 mt-0.5">USD-equivalent. Leave blank to clear.</div>
          </div>
          <button
            type="button"
            onClick={saving ? undefined : onClose}
            disabled={saving}
            className="text-white/40 hover:text-white text-lg leading-none disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">Daily cap</div>
            <input
              type="text"
              value={daily}
              onChange={(e) => setDaily(e.target.value)}
              placeholder="e.g. 250"
              inputMode="decimal"
              className="w-full rounded-md border px-3 py-2 text-sm font-mono text-white placeholder-white/25"
              style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}
            />
          </div>
          <div>
            <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">Per-tx max</div>
            <input
              type="text"
              value={perTx}
              onChange={(e) => setPerTx(e.target.value)}
              placeholder="e.g. 50"
              inputMode="decimal"
              className="w-full rounded-md border px-3 py-2 text-sm font-mono text-white placeholder-white/25"
              style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}
            />
          </div>
        </div>

        {error && <div className="text-[12px] text-red-300/85">{error}</div>}

        <button
          type="button"
          onClick={submit}
          disabled={saving}
          className="w-full px-3 py-2 rounded-md text-sm font-semibold bg-emerald-400 text-slate-900 hover:bg-emerald-300 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save limits"}
        </button>
        <div className="text-[10px] text-white/35 text-center leading-relaxed">
          Daily cap totals every USDC + USDT amount sent UTC-day. Per-tx max gates
          individual sends + every row in a batch.
        </div>
      </div>
    </div>,
    document.body,
  );
}
