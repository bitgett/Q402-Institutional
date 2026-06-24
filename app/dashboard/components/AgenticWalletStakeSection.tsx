"use client";

/**
 * AgenticWalletStakeSection — gasless Q (QuackAI) token staking from one Agent
 * Wallet into QuackAiStake on BNB. Stake into a lock tier (0-5, higher lock =
 * higher APR) or unstake, all gasless. Writes are intent-bound: getActionAuth
 * mints a single-use challenge over { walletId, action, stakeType, amount }, the
 * wallet signs it, and POST /api/wallet/agentic/stake rebuilds + verifies it
 * (Mode A/B), mirroring the Earn section's write path. BNB-only.
 */

import { useState } from "react";
import { getActionAuth, clearAuthCache } from "@/app/lib/auth-client";

const TIERS = [
  { stakeType: 0, lockDays: 14, aprPct: 10 },
  { stakeType: 1, lockDays: 30, aprPct: 20 },
  { stakeType: 2, lockDays: 90, aprPct: 30 },
  { stakeType: 3, lockDays: 140, aprPct: 40 },
  { stakeType: 4, lockDays: 120, aprPct: 50 },
  { stakeType: 5, lockDays: 180, aprPct: 30 },
] as const;

export function AgenticWalletStakeSection({
  ownerAddress,
  walletId,
  signMessage,
}: {
  ownerAddress: string;
  walletId: string;
  signMessage: (message: string) => Promise<string | null>;
}) {
  const [mode, setMode] = useState<"stake" | "unstake">("stake");
  const [stakeType, setStakeType] = useState(0);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<{ action: string; txHash: string } | null>(null);

  const amountValid = /^\d+(\.\d+)?$/.test(amount.trim()) && Number(amount.trim()) > 0;
  const tier = TIERS.find((t) => t.stakeType === stakeType)!;

  async function submit() {
    if (busy) return;
    setErr(null);
    setOkMsg(null);
    if (!amountValid) {
      setErr("Enter a positive Q amount.");
      return;
    }
    setBusy(true);
    try {
      // Intent MUST equal the server's requireIntentAuth rebuild (string values).
      const intent: Record<string, string> = {
        walletId,
        action: mode,
        stakeType: String(mode === "stake" ? stakeType : 0),
        amount: amount.trim(),
      };
      const auth = await getActionAuth(ownerAddress, "agentic.stake", intent, signMessage);
      if (!auth) {
        setErr("Sign the staking challenge in your wallet to authorize.");
        return;
      }
      const res = await fetch("/api/wallet/agentic/stake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerAddress,
          nonce: auth.challenge,
          signature: auth.signature,
          walletId,
          action: mode,
          ...(mode === "stake" ? { stakeType } : {}),
          amount: amount.trim(),
        }),
      });
      if (res.status === 401) {
        clearAuthCache(ownerAddress);
        setErr("Session expired — refresh and retry.");
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 503 && data.error === "staking_not_enabled") {
        setErr("Q staking is not live yet (impl not wired). Try again later.");
        return;
      }
      if (!res.ok) {
        setErr(data.message ?? data.error ?? `Action failed (HTTP ${res.status}).`);
        return;
      }
      setOkMsg({ action: mode === "stake" ? "Staked" : "Unstaked", txHash: String(data.txHash ?? "") });
      setAmount("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const segSel = { background: "rgba(247,202,22,0.14)", color: "#f9d64a", border: "1px solid rgba(247,202,22,0.35)" } as const;
  const segUnsel = { background: "rgba(255,255,255,0.02)", color: "rgba(255,255,255,0.55)", border: "1px solid rgba(255,255,255,0.07)" } as const;
  const cyanSel = { background: "rgba(88,199,244,0.12)", color: "#8fd6f7", border: "1px solid rgba(88,199,244,0.34)" } as const;

  return (
    <div className="relative">
      <div className="flex items-center gap-2.5 mb-3">
        <span
          aria-hidden
          style={{ width: 26, height: 26, borderRadius: 8, display: "grid", placeItems: "center", flexShrink: 0, fontSize: 13, fontWeight: 700, color: "#8fd6f7", background: "rgba(88,199,244,.10)", border: "1px solid rgba(88,199,244,.28)" }}
        >
          Q
        </span>
        <div className="min-w-0 leading-tight">
          <div className="text-[15px] font-semibold text-white/90">Q Staking</div>
          <div className="text-[12px] text-white/55 mt-0.5">QuackAiStake · BNB · gasless</div>
        </div>
      </div>

      <div className="space-y-2">
        {/* Mode: Stake / Unstake */}
        <div className="flex items-center gap-1.5">
          {(["stake", "unstake"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setErr(null); setOkMsg(null); }}
              className="px-2.5 py-1 rounded-md text-[11px] font-medium capitalize transition-colors"
              style={mode === m ? segSel : segUnsel}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Tier picker (stake only) */}
        {mode === "stake" && (
          <div>
            <div className="text-[10px] text-white/45 uppercase tracking-widest mb-1">Lock tier</div>
            <div className="grid grid-cols-3 gap-1.5">
              {TIERS.map((t) => (
                <button
                  key={t.stakeType}
                  type="button"
                  onClick={() => setStakeType(t.stakeType)}
                  className="px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors text-center leading-tight"
                  style={stakeType === t.stakeType ? cyanSel : segUnsel}
                >
                  <div className="font-semibold">{t.aprPct}% APR</div>
                  <div className="text-[10px] opacity-70">{t.lockDays}d lock</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Amount + submit */}
        <div className="flex items-center gap-2 pt-1">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={mode === "stake" ? "Q amount to stake" : "Q amount to unstake"}
            inputMode="decimal"
            className="flex-1 rounded-md px-2.5 py-1.5 text-[13px] text-white outline-none border"
            style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.08)" }}
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy || !amountValid}
            className="px-3.5 py-1.5 rounded-md text-[12px] font-semibold transition-colors disabled:opacity-40"
            style={{ background: "#F5C518", color: "#0b1729" }}
          >
            {busy ? "…" : mode === "stake" ? "Stake" : "Unstake"}
          </button>
        </div>

        {mode === "stake" && (
          <div className="text-[11px] text-white/40">
            Locks {amount || "—"} Q for {tier.lockDays} days at ~{tier.aprPct}% APR. Gasless — the relayer pays.
          </div>
        )}

        {err && <div className="text-[12px]" style={{ color: "#f7a1a1" }}>{err}</div>}
        {okMsg && (
          <div className="text-[12px]" style={{ color: "#8fd6f7" }}>
            {okMsg.action} ✓{" "}
            {okMsg.txHash && (
              <a href={`https://bscscan.com/tx/${okMsg.txHash}`} target="_blank" rel="noopener noreferrer" className="underline">
                {okMsg.txHash.slice(0, 10)}…
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
