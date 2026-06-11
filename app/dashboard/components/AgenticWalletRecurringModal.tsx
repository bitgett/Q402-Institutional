"use client";

/**
 * AgenticWalletRecurringModal — create a new recurring rule.
 *
 * Multi-recipient: 1 to 20 rows per rule (trial subscriptions cap at
 * 5; paid Multichain reaches 20 — same envelope as batch send). Each
 * row carries its own amount so a payroll rule can pay each
 * contractor a different number under one schedule.
 *
 * Per-row per-tx cap is checked client-side BEFORE signing — if any
 * row's amount exceeds the cap, the modal shows a hard error instead
 * of letting the user sign a rule the cron would later freeze.
 *
 * Intent message hashes the recipients list with keccak256 over the
 * sorted, canonical (to, amount) tuples — matches the server-side
 * `recipientsCanonicalHash` exactly. Lets the canonical message stay
 * scalar-typed while still binding every row.
 */

import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { getActionAuth } from "@/app/lib/auth-client";
import { useModalEscape } from "./useModalEscape";
import { ThemedSelect } from "./ThemedSelect";

/** Trial cap (mirrors batch send + server-side enforcement). */
const MAX_RECIPIENTS_TRIAL = 5;
/** Paid Multichain cap (same as batch send). */
const MAX_RECIPIENTS_PAID = 20;

/** Recompute client-side what `recipientsCanonicalHash(...)` produces
 *  on the server. Sort by canonical `to=amount` string, join, keccak. */
function recipientsHashClient(rows: { to: string; amount: string }[]): string {
  const norm = rows
    .map((r) => `${r.to.toLowerCase()}=${r.amount}`)
    .sort()
    .join(",");
  return ethers.keccak256(ethers.toUtf8Bytes(norm)).slice(2, 18);
}

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
  | "scroll"
  | "arbitrum";

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
  { key: "arbitrum",  label: "Arbitrum",   multichainOnly: true, tokens: ["USDT", "USDC"] },
];

type FrequencyKind = "hourly" | "daily" | "weekly" | "monthly" | "monthly-last";
type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

const WEEKDAY_LABEL: Record<Weekday, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday",
};

function buildFrequencyString(kind: FrequencyKind, weekday: Weekday, monthDay: number, hourlyN: number): string {
  if (kind === "hourly") return `hourly:${Math.max(1, Math.min(23, Math.floor(hourlyN)))}`;
  if (kind === "daily") return "daily";
  if (kind === "weekly") return `weekly:${weekday}`;
  if (kind === "monthly-last") return "monthly:last";
  return `monthly:${monthDay}`;
}

/**
 * Hours within ONE frequency interval. The cancel-window must not
 * exceed this — otherwise subsequent fires would silently honour only
 * `interval` hours of notice, breaking the promise on the modal.
 */
function maxCancelWindowForKind(kind: FrequencyKind, hourlyN: number): number {
  // Hourly:N cycles every N hours; the cancel-window must fit strictly
  // inside that, capped at N − 0.5 with a 0.5h floor. A 1h cadence
  // leaves 30 min of cancel runway; a 6h cadence leaves up to 5.5h.
  // Anything ≥ N hours would push the next alert into the past on the
  // cycle boundary.
  if (kind === "hourly") return Math.max(0.5, hourlyN - 0.5);
  if (kind === "daily") return 24;
  if (kind === "weekly") return 24 * 7;
  return 24 * 28; // shortest possible month (February)
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
  const [rows, setRows] = useState<Array<{ to: string; amount: string }>>([
    { to: "", amount: "" },
  ]);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<FrequencyKind>("weekly");
  const [weekday, setWeekday] = useState<Weekday>("fri");
  const [monthDay, setMonthDay] = useState<number>(1);
  // Hours-per-cycle for the hourly cadence (1..23). Default 1 = every
  // hour; users can step up to less frequent intervals (every 2h, every
  // 6h, …) without exiting the hourly bucket.
  const [hourlyN, setHourlyN] = useState<number>(1);
  const [cancelWindowHours, setCancelWindowHours] = useState<number>(24);

  useEffect(() => {
    if (!chainMeta.tokens.includes(token)) setToken(chainMeta.tokens[0]);
  }, [chainMeta.tokens, token]);

  // Auto-shrink the cancel window when the user picks hourly: the default
  // 24h carried over from the weekly/monthly defaults would always exceed
  // the per-cycle cap and leave the user stuck behind a "cancel window too
  // long" error. Snap to the per-N max so the form is submittable out of
  // the box and the user can still nudge it down if they want.
  useEffect(() => {
    if (kind === "hourly") {
      const maxForN = Math.max(0.5, hourlyN - 0.5);
      setCancelWindowHours((prev) => (prev > maxForN ? maxForN : prev));
    }
  }, [kind, hourlyN]);

  const [submitting, setSubmitting] = useState(false);
  useModalEscape(onClose, submitting);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const recipientCap = hasMultichainScope ? MAX_RECIPIENTS_PAID : MAX_RECIPIENTS_TRIAL;

  // Per-row validation. Each row is independent — flag bad ones so the
  // user can fix them one by one rather than getting a single ambiguous
  // error after submit.
  const rowFlags = rows.map((row, idx) => {
    const addrOk = row.to === "" || isAddress(row.to);
    const amtOk = row.amount === "" || isDecimalAmount(row.amount);
    const amtNum = isDecimalAmount(row.amount) ? Number(row.amount) : 0;
    const overCap = typeof perTxMaxUsd === "number" && amtNum > perTxMaxUsd;
    const filled = row.to !== "" && row.amount !== "";
    return { idx, addrOk, amtOk, overCap, filled };
  });
  const allFilledValid = rowFlags.every((r) => r.filled && r.addrOk && r.amtOk && !r.overCap);
  const anyOverCap = rowFlags.some((r) => r.overCap);
  const totalAmountPerFire = rows.reduce(
    (acc, r) => acc + (isDecimalAmount(r.amount) ? Number(r.amount) : 0),
    0,
  );

  const chainGated = chainMeta.multichainOnly && !hasMultichainScope;
  const cancelWindowMax = maxCancelWindowForKind(kind, hourlyN);
  const cancelWindowTooLong = cancelWindowHours > cancelWindowMax;
  const overRecipientCap = rows.length > recipientCap;

  const canSubmit =
    !submitting &&
    !chainGated &&
    !overRecipientCap &&
    allFilledValid &&
    cancelWindowHours >= 0 &&
    !cancelWindowTooLong;

  function updateRow(idx: number, patch: Partial<{ to: string; amount: string }>) {
    setRows((cur) => cur.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function addRow() {
    if (rows.length >= recipientCap) return;
    setRows((cur) => [...cur, { to: "", amount: "" }]);
  }
  function removeRow(idx: number) {
    setRows((cur) => (cur.length === 1 ? cur : cur.filter((_, i) => i !== idx)));
  }

  async function submit() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    if (overRecipientCap) {
      setError(`Up to ${recipientCap} recipients per rule on this plan.`);
      inFlightRef.current = false;
      return;
    }
    if (!allFilledValid) {
      if (anyOverCap) {
        setError(`At least one row's amount exceeds this wallet's per-tx cap ($${perTxMaxUsd}).`);
      } else {
        setError("Every row needs a valid recipient address (0x...) and a positive amount.");
      }
      inFlightRef.current = false;
      return;
    }
    // No minimum cancel window — the rule itself can be cancelled or
    // deleted at any time from the dashboard, so forcing a 24h alert
    // window on top of that was redundant friction. The per-cadence
    // upper bound (cancelWindowMax) still applies so the alert for
    // the next fire can't land in the past on cycle boundaries.
    if (cancelWindowHours < 0) {
      setError("Cancel window cannot be negative.");
      inFlightRef.current = false;
      return;
    }
    if (cancelWindowTooLong) {
      setError(`Cancel window can't exceed one interval (${cancelWindowMax}h for ${kind}). Otherwise subsequent fires would silently lose notice time.`);
      inFlightRef.current = false;
      return;
    }

    setSubmitting(true);
    try {
      const frequency = buildFrequencyString(kind, weekday, monthDay, hourlyN);
      const normRows = rows.map((r) => ({
        to: r.to.trim().toLowerCase(),
        amount: r.amount.trim(),
      }));
      const recipientsHash = recipientsHashClient(normRows);
      const intent: Record<string, string | number> = {
        walletId,
        frequency,
        chain,
        token,
        recipientsHash,
        recipientCount: normRows.length,
        cancelWindowHours,
      };
      const auth = await getActionAuth(ownerAddress, "agentic.recurring.create", intent, signMessage);
      if (!auth) {
        setError(
          "Sign the rule challenge in your wallet to authorise the recurring payment. " +
          "The signature is bound to the exact recipients list + amounts + frequency.",
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
            recipients: normRows,
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

        {/* Daily-cap bypass disclosure. Users naturally assume that
            "this wallet's daily cap" applies to every outgoing transfer
            — including recurring ones. It doesn't: a recurring rule IS
            the ceiling the user authorised at create time, and the cron
            fires through a separate code path that doesn't decrement
            the daily-spend bucket. Surfacing this BEFORE create avoids
            the "I thought my $100/day cap would stop this" support
            ticket. */}
        <div
          className="mb-4 rounded-md border p-3 text-[12px]"
          style={{
            background: "rgba(247,202,22,0.05)",
            borderColor: "rgba(247,202,22,0.20)",
            color: "rgba(226,232,240,0.78)",
          }}
        >
          <strong className="text-emerald-300">Heads up:</strong>{" "}
          recurring fires don&apos;t count against this wallet&apos;s daily cap.
          The rule&apos;s amount × frequency is the spend ceiling you&apos;re
          authorising right now. Per-tx max still applies on every fire.
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
            <KindButton active={kind === "hourly"} onClick={() => setKind("hourly")} disabled={submitting}>Hourly</KindButton>
            <KindButton active={kind === "daily"} onClick={() => setKind("daily")} disabled={submitting}>Daily</KindButton>
            <KindButton active={kind === "weekly"} onClick={() => setKind("weekly")} disabled={submitting}>Weekly</KindButton>
            <KindButton active={kind === "monthly"} onClick={() => setKind("monthly")} disabled={submitting}>Monthly</KindButton>
            <KindButton active={kind === "monthly-last"} onClick={() => setKind("monthly-last")} disabled={submitting}>Last of month</KindButton>
          </div>
          {kind === "hourly" && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-sm text-white/80">
                <span>Every</span>
                <input
                  type="number"
                  min={1}
                  max={23}
                  value={hourlyN}
                  onChange={(e) => setHourlyN(Math.max(1, Math.min(23, Number(e.target.value) || 1)))}
                  className="w-16 bg-[#0B1626] border border-white/10 rounded-md px-2 py-1.5 text-sm text-white text-center"
                  disabled={submitting}
                />
                <span>{hourlyN === 1 ? "hour" : "hours"}</span>
              </div>
              <div className="text-[10.5px] text-white/55 leading-snug">
                Fires on the hour (xx:00 UTC). First fire lands on the next
                top-of-hour after the cancel window — typically up to one
                cycle later than the moment you create the rule.
              </div>
            </div>
          )}
          {kind === "weekly" && (
            <ThemedSelect<Weekday>
              value={weekday}
              onChange={setWeekday}
              options={Object.entries(WEEKDAY_LABEL).map(([key, label]) => ({
                value: key as Weekday,
                label,
              }))}
              disabled={submitting}
              ariaLabel="Day of the week"
            />
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
          <ThemedSelect<ChainKey>
            value={chain}
            onChange={setChain}
            options={CHAIN_META.map((c) => ({
              value: c.key,
              label: c.label,
              meta: c.multichainOnly
                ? hasMultichainScope ? "multichain" : "paid only"
                : undefined,
              disabled: c.multichainOnly && !hasMultichainScope,
            }))}
            disabled={submitting}
            ariaLabel="Chain"
          />
        </Field>

        <Field label="Token">
          <div className="flex gap-2">
            {chainMeta.tokens.map((t) => (
              <KindButton key={t} active={token === t} onClick={() => setToken(t)} disabled={submitting}>{t}</KindButton>
            ))}
          </div>
        </Field>

        {/* Recipients — multi-row list, up to recipientCap rows */}
        <Field
          label={`Recipients (${rows.length}/${recipientCap})`}
        >
          <div className="space-y-1.5">
            {rows.map((row, i) => {
              const flags = rowFlags[i];
              return (
                <div key={i} className="flex gap-1.5">
                  <input
                    type="text"
                    value={row.to}
                    onChange={(e) => updateRow(i, { to: e.target.value })}
                    placeholder="0x…"
                    className={`flex-[3] min-w-0 bg-[#0B1626] border rounded-md px-2.5 py-1.5 text-[12.5px] font-mono text-white placeholder:text-white/25 focus:outline-none ${
                      flags.addrOk ? "border-white/10 focus:border-emerald-400/40" : "border-rose-400/50"
                    }`}
                    disabled={submitting}
                    aria-label={`Recipient ${i + 1} address`}
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    value={row.amount}
                    onChange={(e) => updateRow(i, { amount: e.target.value })}
                    placeholder="25"
                    className={`flex-1 min-w-[5rem] bg-[#0B1626] border rounded-md px-2.5 py-1.5 text-[12.5px] text-white placeholder:text-white/25 focus:outline-none text-right ${
                      flags.amtOk && !flags.overCap ? "border-white/10 focus:border-emerald-400/40" : "border-rose-400/50"
                    }`}
                    disabled={submitting}
                    aria-label={`Recipient ${i + 1} amount`}
                  />
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    disabled={submitting || rows.length === 1}
                    title={rows.length === 1 ? "At least one recipient required" : "Remove this row"}
                    className="shrink-0 px-2 text-white/40 hover:text-rose-300 transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px]">
            <button
              type="button"
              onClick={addRow}
              disabled={submitting || rows.length >= recipientCap}
              className="text-emerald-300 hover:text-emerald-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title={rows.length >= recipientCap ? `Max ${recipientCap} on this plan` : "Add another recipient"}
            >
              + Add recipient
            </button>
            <div className="text-white/40">
              Per-fire total: <span className="text-white/70">{totalAmountPerFire.toFixed(2)} {token}</span>
            </div>
          </div>
          {anyOverCap && (
            <div className="mt-1 text-[11px] text-rose-300/85">
              At least one row exceeds this wallet&apos;s per-tx cap (${perTxMaxUsd}). Raise the cap or lower that amount.
            </div>
          )}
          {!hasMultichainScope && rows.length > 1 && (
            <div className="mt-1 text-[11px] text-white/40">
              Trial subscriptions can include up to {MAX_RECIPIENTS_TRIAL} recipients per rule. Upgrade to Multichain for up to {MAX_RECIPIENTS_PAID}.
            </div>
          )}
        </Field>

        {/* Cancel window */}
        <Field label="Cancel window (hours)">
          <input
            type="number"
            min={0}
            max={cancelWindowMax}
            step={0.5}
            value={cancelWindowHours}
            onChange={(e) => setCancelWindowHours(Math.max(0, Math.min(cancelWindowMax, Number(e.target.value))))}
            className={`w-full bg-[#0B1626] border rounded-md px-3 py-2 text-sm text-white ${cancelWindowTooLong ? "border-rose-400/50" : "border-white/10"}`}
            disabled={submitting}
          />
          <div className="mt-1 text-[11px] text-white/40">
            Lead time before each fire during which you can still skip or cancel it. Set 0 to fire immediately with no alert window — the rule itself can still be paused or deleted at any time. Max {cancelWindowMax}h for {kind} so the alert can&apos;t outrun the cycle.
          </div>
        </Field>

        {chainGated && (
          <div className="mt-2 mb-3 rounded-md border border-amber-400/30 bg-amber-400/[0.05] p-3 text-[12px] text-amber-200/85">
            {chainMeta.label} requires the paid Multichain subscription. Stay on BNB Chain or upgrade to use the full 10-chain range.
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
