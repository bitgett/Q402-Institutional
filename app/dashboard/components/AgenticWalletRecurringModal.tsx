"use client";

/**
 * AgenticWalletRecurringModal — create a new recurring rule.
 *
 * Mirrors AgenticWalletSendModal's shape (chain × token × recipient ×
 * amount) and adds a frequency picker + cancel-window slider. Intent
 * is bound to the full spend shape so a leaked session sig can't
 * author a different rule.
 *
 * Per-tx cap is checked client-side BEFORE signing — if the amount
 * exceeds it, the modal shows a hard error instead of letting the
 * user sign a doomed rule.
 */

import { useEffect, useRef, useState } from "react";
import { getActionAuth } from "@/app/lib/auth-client";
import { useModalEscape } from "./useModalEscape";

interface Props {
  walletId: string;
  ownerAddress: string;
  signMessage: (message: string) => Promise<string | null>;
  onClose: () => void;
  onCreated: () => void;
  perTxMaxUsd?: number | null;
  hasMultichainScope: boolean;
}

type Token = "USDC" | "USDT";

type ChainKey =
  | "bnb"
  | "eth"
  | "avax"
  | "xlayer"
  | "stable"
  | "mantle"
  | "injective"
  | "monad"
  | "scroll";

interface ChainMeta {
  key: ChainKey;
  label: string;
  multichainOnly?: boolean;
  tokens: readonly Token[];
}

const CHAIN_META: ChainMeta[] = [
  { key: "bnb",       label: "BNB Chain", tokens: ["USDT", "USDC"] },
  { key: "eth",       label: "Ethereum",   multichainOnly: true, tokens: ["USDT", "USDC"] },
  { key: "avax",      label: "Avalanche",  multichainOnly: true, tokens: ["USDT", "USDC"] },
  { key: "xlayer",    label: "X Layer",    multichainOnly: true, tokens: ["USDT", "USDC"] },
  { key: "stable",    label: "Stable",     multichainOnly: true, tokens: ["USDT", "USDC"] },
  { key: "mantle",    label: "Mantle",     multichainOnly: true, tokens: ["USDT", "USDC"] },
  { key: "injective", label: "Injective",  multichainOnly: true, tokens: ["USDT"] },
  { key: "monad",     label: "Monad",      multichainOnly: true, tokens: ["USDT", "USDC"] },
  { key: "scroll",    label: "Scroll",     multichainOnly: true, tokens: ["USDT", "USDC"] },
];

type FrequencyKind = "daily" | "weekly" | "monthly" | "monthly-last";
type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

const WEEKDAY_LABEL: Record<Weekday, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday",
};

function buildFrequencyString(kind: FrequencyKind, weekday: Weekday, monthDay: number): string {
  if (kind === "daily") return "daily";
  if (kind === "weekly") return `weekly:${weekday}`;
  if (kind === "monthly-last") return "monthly:last";
  return `monthly:${monthDay}`;
}

function isAddress(s: string) { return /^0x[0-9a-fA-F]{40}$/.test(s.trim()); }
function isDecimalAmount(s: string) { return /^\d+(\.\d+)?$/.test(s.trim()) && Number(s) > 0; }

export function AgenticWalletRecurringModal({
  walletId,
  ownerAddress,
  signMessage,
  onClose,
  onCreated,
  perTxMaxUsd,
  hasMultichainScope,
}: Props) {
  const [chain, setChain] = useState<ChainKey>("bnb");
  const chainMeta = CHAIN_META.find((c) => c.key === chain) ?? CHAIN_META[0];
  const [token, setToken] = useState<Token>("USDT");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<FrequencyKind>("weekly");
  const [weekday, setWeekday] = useState<Weekday>("fri");
  const [monthDay, setMonthDay] = useState<number>(1);
  const [cancelWindowHours, setCancelWindowHours] = useState<number>(24);

  useEffect(() => {
    if (!chainMeta.tokens.includes(token)) setToken(chainMeta.tokens[0]);
  }, [chainMeta.tokens, token]);

  const [submitting, setSubmitting] = useState(false);
  useModalEscape(onClose, submitting);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const recipientValid = recipient === "" || isAddress(recipient);
  const amountValid = amount === "" || isDecimalAmount(amount);
  const amountNum = isDecimalAmount(amount) ? Number(amount) : 0;
  const overPerTxCap =
    typeof perTxMaxUsd === "number" && amountNum > perTxMaxUsd;

  const chainGated = chainMeta.multichainOnly && !hasMultichainScope;

  const canSubmit =
    !submitting &&
    !chainGated &&
    isAddress(recipient) &&
    isDecimalAmount(amount) &&
    !overPerTxCap &&
    cancelWindowHours >= 24;

  async function submit() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    if (!isAddress(recipient)) {
      setError("Recipient must be a 0x-prefixed 20-byte address.");
      inFlightRef.current = false;
      return;
    }
    if (!isDecimalAmount(amount)) {
      setError("Amount must be a positive decimal (e.g. 25 or 25.50).");
      inFlightRef.current = false;
      return;
    }
    if (overPerTxCap) {
      setError(`Amount exceeds this wallet's per-tx cap ($${perTxMaxUsd}). Lower the amount or raise the cap first.`);
      inFlightRef.current = false;
      return;
    }
    if (cancelWindowHours < 24) {
      setError("Cancel window must be at least 24 hours so you always have time to skip or cancel a pending fire.");
      inFlightRef.current = false;
      return;
    }

    setSubmitting(true);
    try {
      const frequency = buildFrequencyString(kind, weekday, monthDay);
      const recipientLower = recipient.trim().toLowerCase();
      const intent: Record<string, string | number> = {
        walletId,
        frequency,
        chain,
        token,
        recipient: recipientLower,
        amount: amount.trim(),
        cancelWindowHours,
      };
      const auth = await getActionAuth(ownerAddress, "agentic.recurring.create", intent, signMessage);
      if (!auth) {
        setError(
          "Sign the rule challenge in your wallet to authorise the recurring payment. " +
          "The signature is bound to this exact recipient + amount + frequency.",
        );
        return;
      }
      const res = await fetch(
        `/api/wallet/agentic/${walletId}/recurring`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address: ownerAddress,
            nonce: auth.challenge,
            signature: auth.signature,
            label: label.trim() || null,
            frequency,
            chain,
            token,
            recipient: recipientLower,
            amount: amount.trim(),
            cancelWindowHours,
          }),
        },
      );
      const data = (await res.json().catch(() => null)) as { rule?: unknown; error?: string; message?: string } | null;
      if (!res.ok) {
        setError(data?.message ?? data?.error ?? `Request failed (${res.status}).`);
        return;
      }
      onCreated();
    } catch (e) {
      console.error("[recurring/create] failed:", e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
      inFlightRef.current = false;
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-2xl border bg-[#0F1929] p-5"
        style={{ borderColor: "rgba(255,255,255,0.08)" }}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="text-base font-semibold text-white">New recurring payment</div>
          <button onClick={onClose} className="text-white/40 hover:text-white text-sm" disabled={submitting}>✕</button>
        </div>

        {/* Label (optional) */}
        <Field label="Label (optional)">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value.slice(0, 64))}
            placeholder="e.g. Contractor payouts"
            className="w-full bg-[#0B1626] border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-emerald-400/40"
            disabled={submitting}
          />
        </Field>

        {/* Frequency */}
        <Field label="Frequency">
          <div className="flex gap-2 mb-2">
            <KindButton active={kind === "daily"} onClick={() => setKind("daily")} disabled={submitting}>Daily</KindButton>
            <KindButton active={kind === "weekly"} onClick={() => setKind("weekly")} disabled={submitting}>Weekly</KindButton>
            <KindButton active={kind === "monthly"} onClick={() => setKind("monthly")} disabled={submitting}>Monthly</KindButton>
            <KindButton active={kind === "monthly-last"} onClick={() => setKind("monthly-last")} disabled={submitting}>Last of month</KindButton>
          </div>
          {kind === "weekly" && (
            <select
              value={weekday}
              onChange={(e) => setWeekday(e.target.value as Weekday)}
              className="w-full bg-[#0B1626] border border-white/10 rounded-md px-3 py-2 text-sm text-white"
              disabled={submitting}
            >
              {Object.entries(WEEKDAY_LABEL).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          )}
          {kind === "monthly" && (
            <input
              type="number"
              min={1}
              max={31}
              value={monthDay}
              onChange={(e) => setMonthDay(Math.max(1, Math.min(31, Number(e.target.value))))}
              className="w-full bg-[#0B1626] border border-white/10 rounded-md px-3 py-2 text-sm text-white"
              disabled={submitting}
            />
          )}
          {kind === "monthly" && monthDay > 28 && (
            <div className="mt-1 text-[11px] text-amber-300/70">
              Day {monthDay} doesn&apos;t exist in every month — those months will fire on the last day.
            </div>
          )}
        </Field>

        {/* Chain × Token */}
        <Field label="Chain">
          <select
            value={chain}
            onChange={(e) => setChain(e.target.value as ChainKey)}
            className="w-full bg-[#0B1626] border border-white/10 rounded-md px-3 py-2 text-sm text-white"
            disabled={submitting}
          >
            {CHAIN_META.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}{c.multichainOnly && !hasMultichainScope ? " (multichain only)" : ""}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Token">
          <div className="flex gap-2">
            {chainMeta.tokens.map((t) => (
              <KindButton key={t} active={token === t} onClick={() => setToken(t)} disabled={submitting}>{t}</KindButton>
            ))}
          </div>
        </Field>

        {/* Recipient + amount */}
        <Field label="Recipient">
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x…"
            className={`w-full bg-[#0B1626] border rounded-md px-3 py-2 text-sm font-mono text-white placeholder:text-white/30 focus:outline-none ${
              recipientValid ? "border-white/10 focus:border-emerald-400/40" : "border-rose-400/50"
            }`}
            disabled={submitting}
          />
        </Field>

        <Field label={`Amount (${token})`}>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="25"
            className={`w-full bg-[#0B1626] border rounded-md px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none ${
              amountValid ? "border-white/10 focus:border-emerald-400/40" : "border-rose-400/50"
            }`}
            disabled={submitting}
          />
          {overPerTxCap && (
            <div className="mt-1 text-[11px] text-rose-300/85">
              Above this wallet&apos;s per-tx cap (${perTxMaxUsd}). Raise the cap or lower the amount.
            </div>
          )}
        </Field>

        {/* Cancel window */}
        <Field label="Cancel window (hours)">
          <input
            type="number"
            min={24}
            max={336}
            step={1}
            value={cancelWindowHours}
            onChange={(e) => setCancelWindowHours(Math.max(24, Math.min(336, Number(e.target.value))))}
            className="w-full bg-[#0B1626] border border-white/10 rounded-md px-3 py-2 text-sm text-white"
            disabled={submitting}
          />
          <div className="mt-1 text-[11px] text-white/40">
            How long before each fire you can still cancel or skip it. Minimum 24h, max 14 days.
          </div>
        </Field>

        {chainGated && (
          <div className="mt-2 mb-3 rounded-md border border-amber-400/30 bg-amber-400/[0.05] p-3 text-[12px] text-amber-200/85">
            {chainMeta.label} requires the paid Multichain subscription. Stay on BNB Chain or upgrade to use the full 9-chain range.
          </div>
        )}

        {error && (
          <div className="mt-2 mb-3 rounded-md border border-rose-400/40 bg-rose-400/[0.05] p-3 text-[12px] text-rose-200/85">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-white/8">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-2 text-sm text-white/70 hover:text-white transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="px-4 py-2 text-sm font-semibold rounded-md bg-emerald-500 text-emerald-950 hover:bg-emerald-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "Creating…" : "Create rule"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="block text-[10px] uppercase tracking-widest text-white/40 font-semibold mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

function KindButton({ active, onClick, disabled, children }: { active: boolean; onClick: () => void; disabled: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors disabled:opacity-40 ${
        active
          ? "bg-emerald-500/20 border-emerald-400/50 text-emerald-200"
          : "border-white/10 text-white/55 hover:border-white/25"
      }`}
    >
      {children}
    </button>
  );
}
