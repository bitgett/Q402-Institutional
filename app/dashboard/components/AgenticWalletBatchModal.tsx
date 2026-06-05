"use client";

/**
 * AgenticWalletBatchModal — multi-recipient send for the Agent tab.
 *
 * Up to 20 rows per submission, one chain + token for the whole batch.
 * The batch is multichain-tier — the backend rejects BNB-only trial
 * subscriptions with 402 SUBSCRIPTION_REQUIRED. The same Injective
 * USDT-only constraint applies as in the single-send modal: USDC is
 * disabled when the chain doesn't support it. Submission idempotency
 * is server-side (keccak fingerprint of owner+chain+token+rows), so the
 * "Submit" button doubles as a safe retry if the network blips.
 */

import { useEffect, useRef, useState } from "react";
import { getActionAuth } from "@/app/lib/auth-client";
import { agenticBatchFingerprint } from "@/app/lib/agentic-batch-fingerprint";
import { explorerTxUrl, explorerLabel } from "@/app/lib/eip7702";
import { friendlyError, type FriendlyError, type BackendError } from "@/app/lib/agentic-wallet-friendly-error";
import { useModalEscape } from "./useModalEscape";
import { ThemedSelect } from "./ThemedSelect";
import type { ChainKey } from "@/app/lib/relayer";

interface Props {
  walletAddress: string;
  walletId: string;
  ownerAddress: string;
  signMessage: (message: string) => Promise<string | null>;
  onClose: () => void;
  onSent: () => void;
}

type Token = "USDC" | "USDT";

interface ChainOption {
  key: ChainKey;
  label: string;
  tokens: readonly Token[];
}

const CHAIN_OPTIONS: ChainOption[] = [
  { key: "bnb",       label: "BNB Chain", tokens: ["USDT", "USDC"] },
  { key: "eth",       label: "Ethereum",  tokens: ["USDT", "USDC"] },
  { key: "avax",      label: "Avalanche", tokens: ["USDT", "USDC"] },
  { key: "xlayer",    label: "X Layer",   tokens: ["USDT", "USDC"] },
  { key: "stable",    label: "Stable",    tokens: ["USDT", "USDC"] },
  { key: "mantle",    label: "Mantle",    tokens: ["USDT", "USDC"] },
  { key: "injective", label: "Injective", tokens: ["USDT"] },
  { key: "monad",     label: "Monad",     tokens: ["USDT", "USDC"] },
  { key: "scroll",    label: "Scroll",    tokens: ["USDT", "USDC"] },
  { key: "arbitrum",  label: "Arbitrum",  tokens: ["USDT", "USDC"] },
];

const MAX_ROWS = 20;

interface Row {
  to: string;
  amount: string;
}

interface BatchResultRow {
  to: string;
  amount: string;
  ok: boolean;
  txHash?: string;
  error?: string;
}

interface BatchResponse {
  batchId?: string;
  status?: "processing" | "complete";
  results?: BatchResultRow[];
  settled?: number;
  failed?: number;
  idempotent?: boolean;
}

function isAddress(s: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(s.trim());
}

function isDecimalAmount(s: string) {
  return /^\d+(\.\d+)?$/.test(s.trim()) && Number(s) > 0;
}

export function AgenticWalletBatchModal({
  walletAddress,
  walletId,
  ownerAddress,
  signMessage,
  onClose,
  onSent,
}: Props) {
  const [chain, setChain] = useState<ChainKey>("bnb");
  const chainCfg = CHAIN_OPTIONS.find((c) => c.key === chain) ?? CHAIN_OPTIONS[0];
  const allowedTokens = chainCfg.tokens;
  const [token, setToken] = useState<Token>("USDT");
  // Effect-based token snap (was queueMicrotask setState in render — a
  // React 19 warning + an eventual error).
  useEffect(() => {
    if (!allowedTokens.includes(token)) setToken(allowedTokens[0]);
  }, [allowedTokens, token]);
  const [rows, setRows] = useState<Row[]>([{ to: "", amount: "" }]);
  const [submitting, setSubmitting] = useState(false);
  useModalEscape(onClose, submitting);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [resp, setResp] = useState<BatchResponse | null>(null);
  const inFlightRef = useRef(false);

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((rs) => (rs.length >= MAX_ROWS ? rs : [...rs, { to: "", amount: "" }]));
  }
  function removeRow(i: number) {
    setRows((rs) => (rs.length === 1 ? rs : rs.filter((_, idx) => idx !== i)));
  }

  const trimmedRows = rows.map((r) => ({ to: r.to.trim(), amount: r.amount.trim() }));
  const validRows =
    trimmedRows.length > 0 &&
    trimmedRows.every((r) => isAddress(r.to) && isDecimalAmount(r.amount));
  const total = trimmedRows.reduce((s, r) => (isDecimalAmount(r.amount) ? s + Number(r.amount) : s), 0);
  const canSubmit = !submitting && validRows;

  async function submit() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    if (!validRows) {
      setError({ headline: "All rows need a valid 0x recipient and a positive decimal amount." });
      inFlightRef.current = false;
      return;
    }
    setSubmitting(true);
    try {
      // Fingerprint matches the server's batch idempotency key. Mixes
      // owner+walletId so two wallets sending the same recipient set
      // share no cache slot. The user signs an intent that pins this
      // exact recipient set + walletId — a leaked signature can't
      // drain a different wallet.
      const fp = agenticBatchFingerprint(
        `${ownerAddress.toLowerCase()}:${walletId}`,
        chain,
        token,
        trimmedRows,
      );
      const auth = await getActionAuth(
        ownerAddress,
        "agentic.batch",
        { walletId, chain, token, rows: String(trimmedRows.length), fp },
        signMessage,
      );
      if (!auth) {
        setError({
          headline:
            "Sign the batch challenge in your wallet to authorize. The signature " +
            "is bound to this exact recipient set.",
        });
        return;
      }
      const res = await fetch("/api/wallet/agentic/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletId,
          chain,
          token,
          recipients: trimmedRows,
          ownerAddress,
          nonce: auth.challenge,
          signature: auth.signature,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as BatchResponse & BackendError;
      if (!res.ok) {
        setError(friendlyError(res.status, data));
        return;
      }
      setResp(data as BatchResponse);
    } catch (e) {
      setError({ headline: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
      inFlightRef.current = false;
    }
  }

  const settled = resp?.settled ?? 0;
  const failed = resp?.failed ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(2,6,15,0.72)" }}
      onClick={submitting ? undefined : onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border p-6 space-y-4"
        style={{ background: "#0F1929", borderColor: "rgba(74,222,128,0.20)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="text-white font-semibold text-lg">Batch send from Agent Wallet</div>
            <div className="text-[11px] text-white/40 font-mono mt-0.5">
              {walletAddress.slice(0, 10)}…{walletAddress.slice(-6)}
            </div>
          </div>
          <button
            type="button"
            onClick={submitting ? undefined : onClose}
            disabled={submitting}
            className="text-white/40 hover:text-white text-lg leading-none disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {resp ? (
          <div className="space-y-3">
            <div className="rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2 text-sm text-green-200">
              Batch processed — {settled} settled, {failed} failed.
              {resp.idempotent ? " (Returned from idempotency cache.)" : ""}
            </div>
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {(resp.results ?? []).map((r, i) => (
                <div
                  key={`${r.to}-${i}`}
                  className="rounded-md border px-3 py-2 text-[12px] flex items-center justify-between gap-2"
                  style={{
                    background: r.ok ? "rgba(74,222,128,0.05)" : "rgba(248,113,113,0.05)",
                    borderColor: r.ok ? "rgba(74,222,128,0.20)" : "rgba(248,113,113,0.25)",
                  }}
                >
                  <div className="font-mono text-white/75 truncate">
                    {r.to.slice(0, 8)}…{r.to.slice(-4)} · {r.amount} {token}
                  </div>
                  {r.ok && r.txHash ? (
                    <a
                      href={explorerTxUrl(chain, r.txHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-emerald-300 hover:text-emerald-200 text-[11px] font-mono shrink-0"
                    >
                      {r.txHash.slice(0, 8)}… ↗ {explorerLabel(chain)}
                    </a>
                  ) : (
                    <span className="text-red-300/80 text-[11px] truncate max-w-[40%]">
                      {r.error ?? "failed"}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={onSent}
              className="w-full px-3 py-2 rounded-md text-sm font-semibold bg-emerald-400 text-slate-900 hover:bg-emerald-300"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">Chain</div>
                <ThemedSelect<ChainKey>
                  value={chain}
                  onChange={setChain}
                  options={CHAIN_OPTIONS.map((c) => ({ value: c.key, label: c.label }))}
                  ariaLabel="Chain"
                />
              </div>
              <div>
                <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">Token</div>
                <div className="grid grid-cols-2 gap-2">
                  {(["USDT", "USDC"] as Token[]).map((t) => {
                    const enabled = allowedTokens.includes(t);
                    const active = token === t;
                    return (
                      <button
                        key={t}
                        type="button"
                        disabled={!enabled}
                        onClick={() => enabled && setToken(t)}
                        className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                          !enabled
                            ? "border-white/5 text-white/25 cursor-not-allowed"
                            : active
                              ? "border-emerald-400 text-emerald-300 bg-emerald-400/8"
                              : "border-white/10 text-white/55 hover:text-white"
                        }`}
                      >
                        {t}
                        {!enabled && <span className="ml-1 text-[9px]">N/A</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="text-[10px] text-white/40">
              Batch sends require an active multichain subscription — trial keys hit the gate.
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[11px] text-white/45 uppercase tracking-widest">
                  Recipients ({rows.length} / {MAX_ROWS})
                </div>
                <button
                  type="button"
                  onClick={addRow}
                  disabled={rows.length >= MAX_ROWS}
                  className="text-[12px] text-emerald-300 hover:text-emerald-200 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  + Add row
                </button>
              </div>
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {rows.map((row, i) => {
                  const recipientOk = row.to === "" || isAddress(row.to);
                  const amountOk = row.amount === "" || isDecimalAmount(row.amount);
                  return (
                    <div key={i} className="flex gap-2 items-start">
                      <input
                        type="text"
                        value={row.to}
                        onChange={(e) => updateRow(i, { to: e.target.value })}
                        placeholder="0x…"
                        spellCheck={false}
                        className="flex-1 rounded-md border px-3 py-2 text-sm font-mono text-white placeholder-white/25"
                        style={{
                          background: "rgba(255,255,255,0.02)",
                          borderColor: recipientOk ? "rgba(255,255,255,0.05)" : "rgba(248,113,113,0.45)",
                        }}
                      />
                      <input
                        type="text"
                        value={row.amount}
                        onChange={(e) => updateRow(i, { amount: e.target.value })}
                        placeholder="1.50"
                        inputMode="decimal"
                        className="w-28 rounded-md border px-3 py-2 text-sm font-mono text-white placeholder-white/25"
                        style={{
                          background: "rgba(255,255,255,0.02)",
                          borderColor: amountOk ? "rgba(255,255,255,0.05)" : "rgba(248,113,113,0.45)",
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => removeRow(i)}
                        disabled={rows.length === 1}
                        className="text-white/40 hover:text-red-300 text-lg leading-none px-1 disabled:opacity-30 disabled:cursor-not-allowed"
                        aria-label="Remove row"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between text-[12px] text-white/55 pt-2 border-t"
              style={{ borderColor: "rgba(255,255,255,0.06)" }}
            >
              <span>Total</span>
              <span className="text-white font-mono">
                {total.toFixed(2)} {token}
              </span>
            </div>

            {error && (
              <div
                className="rounded-md border px-3 py-2.5 text-[12px] leading-relaxed flex items-start justify-between gap-3"
                style={{
                  background: "rgba(248,113,113,0.06)",
                  borderColor: "rgba(248,113,113,0.22)",
                  color: "#fecaca",
                }}
              >
                <span>{error.headline}</span>
                {error.next && (
                  <a
                    href={error.next.href}
                    className="shrink-0 text-emerald-300 hover:text-emerald-200 underline underline-offset-2"
                  >
                    {error.next.label}
                  </a>
                )}
              </div>
            )}

            <button
              type="button"
              disabled={!canSubmit}
              onClick={submit}
              className="w-full px-3 py-2 rounded-md text-sm font-semibold bg-emerald-400 text-slate-900 hover:bg-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting
                ? "Submitting…"
                : `Send ${total > 0 ? total.toFixed(2) : "—"} ${token} to ${rows.length} recipient${rows.length === 1 ? "" : "s"}`}
            </button>
            <div className="text-[10px] text-white/30 text-center">
              Gas sponsored by Q402&apos;s relayer. Each row is one on-chain transfer.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
