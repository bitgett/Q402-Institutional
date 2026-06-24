"use client";

/**
 * AgenticWalletStakeModal — gasless Q (QuackAI) staking into QuackAiStake on
 * BNB from one Agent Wallet, in the Command-deck modal system. Stake into a
 * lock tier (0-3, longer lock = higher APR) or unstake matured positions. Writes
 * are intent-bound: getActionAuth mints a single-use challenge over { walletId,
 * action, stakeType, amount, cap? }, the wallet signs it, and POST
 * /api/wallet/agentic/stake rebuilds + verifies it (Mode A/B). The wallet's live
 * positions are read from /api/wallet/agentic/stake/positions. BNB-only.
 */

import { useCallback, useEffect, useState } from "react";
import { getActionAuth, clearAuthCache, getAuthCreds } from "@/app/lib/auth-client";
import { ModalShell, Field, Segmented, PrimaryCTA, AlertBox, inputStyle } from "./modal-kit";

const TIERS = [
  { stakeType: 0, lockDays: 30, aprPct: 10 },
  { stakeType: 1, lockDays: 60, aprPct: 15 },
  { stakeType: 2, lockDays: 120, aprPct: 32 },
  { stakeType: 3, lockDays: 180, aprPct: 40 },
] as const;

// Shape of GET /stake/positions (kept inline so the server lib's ethers import
// never reaches the client bundle).
interface Position {
  id: number;
  stakeType: number;
  amount: string;
  aprPct: number;
  stakedAt: number;
  unlockAt: number;
  matured: boolean;
}
interface PositionsResp {
  positions: Position[];
  stakedTotal: string;
  withdrawable: string;
}

export function AgenticWalletStakeModal({
  ownerAddress,
  walletId,
  signMessage,
  onClose,
  quackBalance,
}: {
  ownerAddress: string;
  walletId: string;
  signMessage: (message: string) => Promise<string | null>;
  onClose: () => void;
  /** Wallet's available Q balance (token units) — powers the stake Max button. */
  quackBalance?: number;
}) {
  const [mode, setMode] = useState<"stake" | "unstake">("stake");
  const [stakeType, setStakeType] = useState(0);
  const [amount, setAmount] = useState("");
  const [useMax, setUseMax] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<{ action: string; txHash: string } | null>(null);
  const [pos, setPos] = useState<PositionsResp | null>(null);

  // Max source is mode-aware: stake -> wallet Q balance; unstake -> withdrawable
  // (matured) staked total.
  const withdrawable = pos ? Number(pos.withdrawable) : 0;
  const maxAvail = mode === "stake" ? quackBalance ?? 0 : withdrawable;
  const amountValid = useMax ? maxAvail > 0 : /^\d+(\.\d+)?$/.test(amount.trim()) && Number(amount.trim()) > 0;
  const tier = TIERS.find((t) => t.stakeType === stakeType)!;
  const fmtQ = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  const fmtDate = (s: number) => new Date(s * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  // Simple-interest estimate over the lock period: amount * APR * (days/365).
  const stakeAmt = useMax ? maxAvail : Number(amount.trim()) || 0;
  const estReward = stakeAmt * (tier.aprPct / 100) * (tier.lockDays / 365);

  const loadPositions = useCallback(async () => {
    try {
      const auth = await getAuthCreds(ownerAddress, signMessage);
      if (!auth) return;
      const qs = new URLSearchParams({ address: ownerAddress, nonce: auth.nonce, sig: auth.signature, walletId }).toString();
      const res = await fetch(`/api/wallet/agentic/stake/positions?${qs}`);
      if (res.ok) setPos((await res.json()) as PositionsResp);
    } catch {
      /* positions are best-effort; the form still works without them */
    }
  }, [ownerAddress, signMessage, walletId]);

  useEffect(() => { void loadPositions(); }, [loadPositions]);

  async function submit() {
    if (busy) return;
    setErr(null);
    setOkMsg(null);
    if (!amountValid) {
      setErr(mode === "stake" ? "Enter a positive Q amount." : "Enter an amount, or use Max if a position has matured.");
      return;
    }
    setBusy(true);
    // "max": the user signs "max" PLUS a numeric cap = the balance/withdrawable
    // they see now. The server resolves min(on-chain available, cap), so a
    // deposit (stake) or a just-matured position (unstake) arriving after
    // sign-time can never move more than was consented.
    const sendAmount = useMax ? "max" : amount.trim();
    const cap = useMax ? String(maxAvail) : null;
    try {
      const intent: Record<string, string> = {
        walletId,
        action: mode,
        stakeType: String(mode === "stake" ? stakeType : 0),
        amount: sendAmount,
        ...(cap ? { cap } : {}),
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
          amount: sendAmount,
          ...(cap ? { cap } : {}),
        }),
      });
      if (res.status === 401) {
        clearAuthCache(ownerAddress);
        setErr("Session expired. Refresh and retry.");
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
      setUseMax(false);
      void loadPositions();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // eslint-disable-next-line @next/next/no-img-element
  const quackIcon = <img src="/logos/quack.svg" alt="" width={36} height={36} style={{ display: "block" }} />;

  return (
    <ModalShell
      icon={quackIcon}
      iconBare
      title="Stake Q"
      subtitle="Quack AI · BNB Chain · gasless"
      size="sm"
      onClose={onClose}
      closeDisabled={busy}
      footer={
        <PrimaryCTA onClick={submit} disabled={!amountValid} busy={busy}>
          {useMax
            ? `${mode === "stake" ? "Stake" : "Unstake"} all${maxAvail > 0 ? ` (${fmtQ(maxAvail)} Q)` : ""}`
            : `${mode === "stake" ? "Stake" : "Unstake"}${amountValid ? ` ${amount.trim()} Q` : " Q"}`}
        </PrimaryCTA>
      }
    >
      <Field label="Action">
        <Segmented
          cols={2}
          value={mode}
          onChange={(m) => { setMode(m); setUseMax(false); setAmount(""); setErr(null); setOkMsg(null); }}
          options={[
            { value: "stake", label: "Stake" },
            { value: "unstake", label: "Unstake" },
          ]}
        />
      </Field>

      {mode === "stake" && (
        <Field label="Lock tier">
          <Segmented
            cols={2}
            value={stakeType}
            onChange={setStakeType}
            options={TIERS.map((t) => ({ value: t.stakeType, label: `${t.aprPct}% APR`, sub: `${t.lockDays}d lock` }))}
          />
        </Field>
      )}

      <Field
        label={mode === "stake" ? "Amount to stake" : "Amount to unstake"}
        htmlFor="stake-amount"
        hint={mode === "stake" ? (quackBalance != null ? `Balance ${fmtQ(maxAvail)} Q` : undefined) : `Withdrawable ${fmtQ(withdrawable)} Q`}
      >
        <div style={{ display: "flex", gap: 8 }}>
          <input
            id="stake-amount"
            value={useMax ? fmtQ(maxAvail) : amount}
            onChange={(e) => { setAmount(e.target.value); setUseMax(false); }}
            placeholder="0.00"
            inputMode="decimal"
            disabled={useMax}
            style={{ ...inputStyle(), flex: 1, ...(useMax ? { opacity: 0.65 } : {}) }}
          />
          <button
            type="button"
            onClick={() => { setUseMax((v) => !v); setErr(null); }}
            disabled={maxAvail <= 0}
            className="transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
            style={{
              flexShrink: 0,
              padding: "0 14px",
              borderRadius: 10,
              fontSize: 12,
              fontWeight: 700,
              cursor: maxAvail > 0 ? "pointer" : "not-allowed",
              color: useMax ? "#101722" : "#f9d64a",
              background: useMax ? "#F5C518" : "rgba(247,202,22,.12)",
              border: `1px solid ${useMax ? "#F5C518" : "rgba(247,202,22,.34)"}`,
            }}
          >
            Max
          </button>
        </div>
      </Field>

      {mode === "stake" && stakeAmt > 0 && (
        <div style={{ borderRadius: 11, border: "1px solid rgba(247,202,22,.22)", background: "linear-gradient(135deg, rgba(247,202,22,.07), rgba(88,199,244,.04))", padding: "11px 13px", display: "grid", gap: 7 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <span style={{ fontSize: 12, color: "rgba(255,255,255,.6)" }}>Estimated reward</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#8fd6f7" }}>+{fmtQ(estReward)} Q</span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", paddingTop: 6, borderTop: "1px solid rgba(255,255,255,.07)" }}>
            <span style={{ fontSize: 12, color: "rgba(255,255,255,.6)" }}>Total at maturity ({tier.lockDays}d)</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#f9d64a" }}>{fmtQ(stakeAmt + estReward)} Q</span>
          </div>
        </div>
      )}
      {mode === "stake" && (
        <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.4)", lineHeight: 1.5 }}>
          {tier.lockDays}-day lock at ~{tier.aprPct}% APR. Gasless. The relayer pays the gas.
        </div>
      )}
      {mode === "unstake" && (
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.42)", lineHeight: 1.5 }}>
          Only matured (unlocked) positions can be unstaked. Locked Q stays until its unlock date.
        </div>
      )}

      {err && <AlertBox variant="error">{err}</AlertBox>}
      {okMsg && (
        <AlertBox variant="success">
          {okMsg.action}.{" "}
          {okMsg.txHash && (
            <a href={`https://bscscan.com/tx/${okMsg.txHash}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>
              {okMsg.txHash.slice(0, 12)}…
            </a>
          )}
        </AlertBox>
      )}

      {/* ── Your positions (this Agent Wallet) ── */}
      {pos && (
        <div>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 7 }}>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.09em", textTransform: "uppercase", color: "rgba(255,255,255,.5)" }}>Your stakes</span>
            {pos.positions.length > 0 && <span style={{ fontSize: 11, color: "rgba(255,255,255,.45)" }}>Total {fmtQ(Number(pos.stakedTotal))} Q</span>}
          </div>
          {pos.positions.length === 0 ? (
            <div style={{ fontSize: 12, color: "rgba(255,255,255,.4)", lineHeight: 1.5, borderRadius: 9, border: "1px dashed rgba(255,255,255,.1)", background: "rgba(255,255,255,.015)", padding: "10px 12px" }}>
              No stakes in this Agent Wallet yet. Stake above and your positions (with unlock dates) appear here.
            </div>
          ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {pos.positions.map((p) => {
              const t = TIERS.find((x) => x.stakeType === p.stakeType);
              return (
                <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, borderRadius: 9, border: "1px solid rgba(255,255,255,.07)", background: "rgba(255,255,255,.02)", padding: "7px 10px" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: "rgba(255,255,255,.9)" }}>
                    {fmtQ(Number(p.amount))} Q
                    <span style={{ fontWeight: 400, color: "rgba(255,255,255,.5)" }}> · {t?.lockDays ?? "?"}d · {p.aprPct}%</span>
                  </span>
                  <span style={{ fontSize: 11, color: p.matured ? "#8fd6f7" : "rgba(255,255,255,.5)" }}>
                    {p.matured ? "Unlocked" : `Unlocks ${fmtDate(p.unlockAt)}`}
                  </span>
                </div>
              );
            })}
          </div>
          )}
        </div>
      )}
    </ModalShell>
  );
}
