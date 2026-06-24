"use client";

/**
 * AgenticWalletStakeModal — gasless Q (QuackAI) staking into QuackAiStake on
 * BNB from one Agent Wallet, in the Command-deck modal system. Stake into a
 * lock tier (0-3, longer lock = higher APR) or unstake. Writes are intent-
 * bound: getActionAuth mints a single-use challenge over { walletId, action,
 * stakeType, amount }, the wallet signs it, and POST /api/wallet/agentic/stake
 * rebuilds + verifies it (Mode A/B). BNB-only.
 */

import { useState } from "react";
import { getActionAuth, clearAuthCache } from "@/app/lib/auth-client";
import { ModalShell, Field, Segmented, PrimaryCTA, AlertBox, inputStyle } from "./modal-kit";

const TIERS = [
  { stakeType: 0, lockDays: 30, aprPct: 10 },
  { stakeType: 1, lockDays: 60, aprPct: 15 },
  { stakeType: 2, lockDays: 120, aprPct: 32 },
  { stakeType: 3, lockDays: 180, aprPct: 40 },
] as const;

export function AgenticWalletStakeModal({
  ownerAddress,
  walletId,
  signMessage,
  onClose,
}: {
  ownerAddress: string;
  walletId: string;
  signMessage: (message: string) => Promise<string | null>;
  onClose: () => void;
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

  // eslint-disable-next-line @next/next/no-img-element
  const quackIcon = <img src="/logos/quack.svg" alt="" width={20} height={20} />;

  return (
    <ModalShell
      icon={quackIcon}
      title="Stake Q"
      subtitle="QuackAiStake · BNB Chain · gasless"
      size="sm"
      onClose={onClose}
      closeDisabled={busy}
      footer={
        <PrimaryCTA onClick={submit} disabled={!amountValid} busy={busy}>
          {mode === "stake" ? `Stake${amountValid ? ` ${amount.trim()} Q` : " Q"}` : `Unstake${amountValid ? ` ${amount.trim()} Q` : " Q"}`}
        </PrimaryCTA>
      }
    >
      <Field label="Action">
        <Segmented
          cols={2}
          value={mode}
          onChange={(m) => { setMode(m); setErr(null); setOkMsg(null); }}
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

      <Field label={mode === "stake" ? "Amount to stake" : "Amount to unstake"} htmlFor="stake-amount">
        <input
          id="stake-amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
          style={inputStyle()}
        />
      </Field>

      {mode === "stake" && (
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.42)", lineHeight: 1.5 }}>
          Locks {amount.trim() || "—"} Q for {tier.lockDays} days at ~{tier.aprPct}% APR. Gasless — the relayer pays.
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
    </ModalShell>
  );
}
