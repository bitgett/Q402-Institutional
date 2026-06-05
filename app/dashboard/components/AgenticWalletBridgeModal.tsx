"use client";

/**
 * AgenticWalletBridgeModal — Cross-chain USDC bridge via Chainlink CCIP.
 *
 * Mode C only: the user picks src / dst / amount / feeToken, signs an
 * intent-bound challenge (`ccip.bridge`), and the server signs ccipSend
 * as the Agent Wallet. Token arrives on the same EOA on the destination
 * chain. Q402 markup is zero — user only pays the actual CCIP fee out
 * of their Gas Tank LINK or native bucket.
 *
 * The 3-chain triangle is eth / avax / arbitrum. Source/destination
 * pickers stay in lockstep with /api/ccip/lanes; if a future deploy
 * adds a chain the manifest is the single source of truth.
 *
 * UX shape:
 *   1. Pick source chain → destination chain picker filters to that
 *      source's supported destinations.
 *   2. Type a USDC amount (human decimal). We convert to 6-dec raw on
 *      submit, just like the on-chain pool expects.
 *   3. Pick fee token (LINK is cheaper, native is simpler).
 *   4. "Get quote" hits /api/ccip/quote — both fees come back so the user
 *      sees the trade-off before signing.
 *   5. "Bridge" prompts a single wallet popup for the intent challenge,
 *      then the server submits ccipSend (and a one-time USDC approve if
 *      the Sender's allowance is unset). We surface both tx hashes.
 *   6. After submit we poll /api/ccip/confirm every ~12s for up to ~6
 *      minutes to flip "Bridging…" → "Delivered ✓".
 */

import { useEffect, useRef, useState } from "react";
import { getActionAuth } from "@/app/lib/auth-client";
import { useModalEscape } from "./useModalEscape";
import { ThemedSelect } from "./ThemedSelect";

type CCIPChainKey = "eth" | "avax" | "arbitrum";
type FeeTokenKind = "LINK" | "native";

interface ChainMeta {
  key: CCIPChainKey;
  label: string;
  native: string;
  explorer: string;
  explorerLabel: string;
}

const CHAINS: ChainMeta[] = [
  { key: "eth",      label: "Ethereum",  native: "ETH",  explorer: "https://etherscan.io",          explorerLabel: "Etherscan" },
  { key: "avax",     label: "Avalanche", native: "AVAX", explorer: "https://snowtrace.io",          explorerLabel: "Snowtrace" },
  { key: "arbitrum", label: "Arbitrum",  native: "ETH",  explorer: "https://arbiscan.io",           explorerLabel: "Arbiscan" },
];

// Lane matrix mirrors the manifest (3-chain triangle, both directions on
// each edge). Kept inline so the modal can render the dest picker before
// /api/ccip/lanes resolves. Static drift is caught by ccip-config.test.ts.
const LANES: Record<CCIPChainKey, CCIPChainKey[]> = {
  eth:      ["avax", "arbitrum"],
  avax:     ["eth",  "arbitrum"],
  arbitrum: ["eth",  "avax"],
};

interface FeeSlice {
  raw: string;
  whole: number;
  usd: number;
}

interface QuoteResponse {
  src: CCIPChainKey;
  dst: CCIPChainKey;
  amount: string;
  destReceiver: string;
  fee: { link: FeeSlice; native: FeeSlice };
  recommended: FeeTokenKind | "link" | "native";
}

interface SendResponse {
  success?:       boolean;
  messageId?:     string;
  txHash?:        string;
  feeRaw?:        string;
  feeWhole?:      number;
  feeToken?:      FeeTokenKind;
  ccipExplorer?:  string;
  srcExplorer?:   string;
  approveTxHash?: string;
  error?:         string;
  code?:          string;
  detail?:        string;
  required?:      number;
  available?:     number;
  chain?:         string;
}

interface ConfirmResponse {
  status?:       "pending" | "delivered" | "failed" | "unknown";
  dstTxHash?:    string;
  dstBlock?:     number;
  dstExplorer?:  string;
  ccipExplorer?: string;
}

interface Props {
  walletAddress: string;
  walletId:      string;
  ownerAddress:  string;
  signMessage:   (msg: string) => Promise<string | null>;
  onClose:       () => void;
  onSent:        () => void;
  hasMultichainScope: boolean;
}

function isDecimalAmount(s: string): boolean {
  return /^\d+(\.\d{1,6})?$/.test(s.trim()) && Number(s) > 0;
}

// Human "1.50" → raw 6-dec "1500000". Mirrors USDC's 6 decimals. Avoids
// Number / parseFloat round-trip so 18-dec mental drift can't bite us.
function toUsdcRaw(human: string): string {
  const [whole = "0", frac = ""] = human.trim().split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  const joined = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, "");
  return joined === "" ? "0" : joined;
}

function chainMeta(k: CCIPChainKey): ChainMeta {
  return CHAINS.find(c => c.key === k) ?? CHAINS[0];
}

function shortHash(h: string): string {
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

export function AgenticWalletBridgeModal({
  walletAddress,
  walletId,
  ownerAddress,
  signMessage,
  onClose,
  onSent,
  hasMultichainScope,
}: Props) {
  const [src, setSrc] = useState<CCIPChainKey>("eth");
  const [dst, setDst] = useState<CCIPChainKey>("avax");
  const [amount, setAmount] = useState("");
  const [feeToken, setFeeToken] = useState<FeeTokenKind>("LINK");

  // Quote state — cleared whenever any of (src/dst/amount) changes so the
  // user can't sign against a stale quote.
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SendResponse | null>(null);
  const [confirmStatus, setConfirmStatus] = useState<ConfirmResponse["status"]>(undefined);
  const [confirmTxHash, setConfirmTxHash] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  // Mirror of confirmStatus that the polling loop reads. Without this,
  // the poll() closure captures the value of confirmStatus at effect
  // mount time (always "pending" because we set it right before
  // setResult) and re-schedules itself for all 30 ticks even after the
  // bridge settles. The ref is updated by an effect on every render so
  // the next setTimeout iteration sees the freshest value.
  const confirmStatusRef = useRef(confirmStatus);
  useEffect(() => { confirmStatusRef.current = confirmStatus; }, [confirmStatus]);
  useModalEscape(onClose, submitting);

  // Auto-pick a compatible destination if the user flips src to a chain
  // that doesn't support the currently-selected dst (can't happen with
  // the 3-triangle but the guard keeps the picker honest for any future
  // 4th-chain addition).
  useEffect(() => {
    if (!LANES[src].includes(dst)) {
      setDst(LANES[src][0]);
    }
    setQuote(null);
    setQuoteError(null);
  }, [src, dst]);

  // Clear stale quote when amount changes.
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
  }, [amount]);

  const amountValid = isDecimalAmount(amount);
  const canQuote = !quoteLoading && amountValid && src !== dst;
  const canSubmit = !submitting && quote !== null && amountValid && src !== dst;

  async function fetchQuote() {
    if (!amountValid) return;
    setQuoteLoading(true);
    setQuoteError(null);
    try {
      const res = await fetch("/api/ccip/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          src,
          dst,
          amount: toUsdcRaw(amount),
          destReceiver: walletAddress,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as QuoteResponse & { error?: string };
      if (!res.ok || data.error) {
        setQuoteError(data.error ?? `Quote failed (HTTP ${res.status}).`);
        return;
      }
      setQuote(data);
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : "Quote request failed.");
    } finally {
      setQuoteLoading(false);
    }
  }

  async function submit() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    if (!amountValid) {
      setError("Amount must be a positive USDC decimal (e.g. 1.50).");
      inFlightRef.current = false;
      return;
    }
    if (!quote) {
      setError("Fetch a quote first so we can show the exact fee before signing.");
      inFlightRef.current = false;
      return;
    }
    setSubmitting(true);
    try {
      const rawAmount = toUsdcRaw(amount);
      const intent: Record<string, string> = {
        walletId,
        src,
        dst,
        amount: rawAmount,
        feeToken,
      };
      const auth = await getActionAuth(ownerAddress, "ccip.bridge", intent, signMessage);
      if (!auth) {
        setError(
          "Sign the bridge challenge in your wallet to authorize. " +
          "The signature is bound to this exact src → dst + amount + fee token."
        );
        return;
      }
      const res = await fetch("/api/ccip/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: ownerAddress,
          nonce:   auth.challenge,
          signature: auth.signature,
          walletId,
          src,
          dst,
          amount: rawAmount,
          feeToken,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as SendResponse;
      if (!res.ok || !data.success) {
        setError(friendlyBridgeError(res.status, data));
        return;
      }
      setResult(data);
      setConfirmStatus("pending");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
      inFlightRef.current = false;
    }
  }

  // Polling: once we have a messageId, ping /api/ccip/confirm every ~12s
  // until status flips to delivered or failed. Stops after ~6 minutes
  // (30 polls) — anything slower is on the user to refresh CCIP Explorer
  // manually; we don't want to chew their browser indefinitely.
  useEffect(() => {
    if (!result?.messageId) return;
    if (confirmStatus === "delivered" || confirmStatus === "failed") return;

    let cancelled = false;
    let polls = 0;
    const maxPolls = 30;

    async function poll() {
      polls += 1;
      try {
        const res = await fetch("/api/ccip/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageId: result!.messageId, dst }),
        });
        if (cancelled) return;
        if (!res.ok) return;
        const data = (await res.json()) as ConfirmResponse;
        if (cancelled) return;
        if (data.status && data.status !== "pending") {
          setConfirmStatus(data.status);
          if (data.dstTxHash) setConfirmTxHash(data.dstTxHash);
        }
      } catch {
        /* swallow — retry on next tick */
      }
      if (cancelled) return;
      const liveStatus = confirmStatusRef.current;
      if (polls < maxPolls && liveStatus !== "delivered" && liveStatus !== "failed") {
        setTimeout(poll, 12_000);
      }
    }
    const t = setTimeout(poll, 6_000);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.messageId]);

  const srcMeta = chainMeta(src);
  const dstMeta = chainMeta(dst);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(2,6,15,0.72)" }}
      onClick={submitting ? undefined : onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border p-6 space-y-4 max-h-[92vh] overflow-y-auto"
        style={{ background: "#0F1929", borderColor: "rgba(250,204,21,0.22)" }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="text-white font-semibold text-lg">Bridge USDC · Chainlink CCIP</div>
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

        {!hasMultichainScope && !result && (
          <div
            className="rounded-md border px-3 py-2.5 text-[12px] leading-relaxed"
            style={{
              background: "rgba(250,204,21,0.07)",
              borderColor: "rgba(250,204,21,0.25)",
              color: "rgba(254,240,138,0.95)",
            }}
          >
            Cross-chain USDC bridging needs an active Multichain subscription.{" "}
            <a href="/payment" className="underline hover:text-yellow-200">View plans →</a>
          </div>
        )}

        {!result ? (
          <>
            <div
              className="rounded-md border px-3 py-2.5 text-[11.5px] leading-relaxed"
              style={{
                background: "rgba(250,204,21,0.05)",
                borderColor: "rgba(250,204,21,0.18)",
                color: "rgba(226,232,240,0.78)",
              }}
            >
              Same EOA on the destination chain. Q402 markup is zero — you only pay the
              actual CCIP fee out of your Gas Tank{" "}
              <span className="text-yellow-200">{feeToken === "LINK" ? "LINK" : srcMeta.native}</span>{" "}
              bucket on {srcMeta.label}.
              <div className="mt-1.5 pt-1.5 border-t border-yellow-300/15 text-white/60">
                Heads up: the bridge tx itself is signed by your Agent Wallet, so it needs a
                small amount of {srcMeta.native} on {srcMeta.label} to cover source-chain gas
                (~$0.05–$0.50). This is separate from the CCIP fee debited above.
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">From</div>
                <ThemedSelect<CCIPChainKey>
                  value={src}
                  onChange={setSrc}
                  options={CHAINS.map(c => ({ value: c.key, label: c.label }))}
                  ariaLabel="Source chain"
                />
              </div>
              <div>
                <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">To</div>
                <ThemedSelect<CCIPChainKey>
                  value={dst}
                  onChange={setDst}
                  options={LANES[src].map(k => ({ value: k, label: chainMeta(k).label }))}
                  ariaLabel="Destination chain"
                />
              </div>
            </div>

            <div>
              <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">
                Amount (USDC)
              </div>
              <input
                type="text"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="1.50"
                inputMode="decimal"
                className="w-full rounded-md border px-3 py-2 text-sm font-mono text-white placeholder-white/25"
                style={{
                  background: "rgba(255,255,255,0.02)",
                  borderColor:
                    amount === "" || amountValid ? "rgba(255,255,255,0.05)" : "rgba(248,113,113,0.45)",
                }}
              />
              <div className="text-[10px] text-white/40 mt-1">
                USDC has 6 decimals — max precision 0.000001 USDC.
              </div>
            </div>

            <div>
              <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">
                Pay fee in
              </div>
              <div className="grid grid-cols-2 gap-2">
                {(["LINK", "native"] as FeeTokenKind[]).map(t => {
                  const active = feeToken === t;
                  const label = t === "LINK" ? "LINK (≈10% cheaper)" : `${srcMeta.native} (native)`;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => { setFeeToken(t); setQuote(null); }}
                      className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                        active
                          ? "border-yellow-300 text-yellow-200 bg-yellow-300/8"
                          : "border-white/10 text-white/55 hover:text-white"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!canQuote}
                onClick={fetchQuote}
                className="flex-1 px-3 py-2 rounded-md text-sm font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  borderColor: "rgba(255,255,255,0.18)",
                  background: "rgba(255,255,255,0.04)",
                  color: "#e2e8f0",
                }}
              >
                {quoteLoading ? "Quoting…" : quote ? "Refresh quote" : "Get quote"}
              </button>
            </div>

            {quoteError && (
              <div className="text-[12px] text-red-300/85 px-2">{quoteError}</div>
            )}

            {quote && (
              <div
                className="rounded-xl border p-3 space-y-2"
                style={{
                  background: "rgba(74,222,128,0.04)",
                  borderColor: "rgba(74,222,128,0.18)",
                }}
              >
                <div className="text-[10px] uppercase tracking-widest text-emerald-300/85 font-semibold">
                  CCIP fee quote
                </div>
                <div className="grid grid-cols-2 gap-3 text-[12px]">
                  <FeeCell
                    label="LINK"
                    whole={quote.fee.link.whole}
                    usd={quote.fee.link.usd}
                    highlighted={feeToken === "LINK"}
                    recommended={quote.recommended === "link"}
                  />
                  <FeeCell
                    label={srcMeta.native}
                    whole={quote.fee.native.whole}
                    usd={quote.fee.native.usd}
                    highlighted={feeToken === "native"}
                    recommended={quote.recommended === "native"}
                  />
                </div>
                <div className="text-[10px] text-white/45">
                  Quote is on-chain at this block. Server caps slippage at +10% before
                  rejecting — re-quote if more than a minute has passed.
                </div>
              </div>
            )}

            {error && (
              <div
                className="rounded-md border px-3 py-2.5 text-[12px] leading-relaxed"
                style={{
                  background: "rgba(248,113,113,0.06)",
                  borderColor: "rgba(248,113,113,0.22)",
                  color: "#fecaca",
                }}
              >
                {error}
              </div>
            )}

            <button
              type="button"
              disabled={!canSubmit || !hasMultichainScope}
              onClick={submit}
              className="w-full px-3 py-2 rounded-md text-sm font-semibold bg-yellow-300 text-slate-900 hover:bg-yellow-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting
                ? "Bridging…"
                : `Bridge ${amount || "—"} USDC · ${srcMeta.label} → ${dstMeta.label}`}
            </button>
          </>
        ) : (
          <BridgeResult
            result={result}
            confirmStatus={confirmStatus}
            confirmTxHash={confirmTxHash}
            srcMeta={srcMeta}
            dstMeta={dstMeta}
            onDone={onSent}
          />
        )}
      </div>
    </div>
  );
}

function FeeCell({
  label,
  whole,
  usd,
  highlighted,
  recommended,
}: {
  label: string;
  whole: number;
  usd: number;
  highlighted: boolean;
  recommended: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-2.5 py-2 ${highlighted ? "border-yellow-300/55" : "border-white/10"}`}
      style={{ background: highlighted ? "rgba(250,204,21,0.07)" : "rgba(255,255,255,0.02)" }}
    >
      <div className="flex items-center justify-between">
        <span className="text-white/65 text-[10px] uppercase tracking-widest font-medium">{label}</span>
        {recommended && (
          <span className="text-[9px] text-emerald-300/85 uppercase tracking-widest font-semibold">
            best
          </span>
        )}
      </div>
      <div className="text-white text-sm font-mono mt-0.5">
        {whole.toLocaleString("en-US", { maximumFractionDigits: 6 })}
      </div>
      <div className="text-emerald-300/85 text-[11px] font-mono">
        ≈ ${usd.toFixed(usd < 1 ? 4 : 2)}
      </div>
    </div>
  );
}

function BridgeResult({
  result,
  confirmStatus,
  confirmTxHash,
  srcMeta,
  dstMeta,
  onDone,
}: {
  result: SendResponse;
  confirmStatus: ConfirmResponse["status"];
  confirmTxHash: string | null;
  srcMeta: ChainMeta;
  dstMeta: ChainMeta;
  onDone: () => void;
}) {
  const statusLabel =
    confirmStatus === "delivered" ? "Delivered ✓"
    : confirmStatus === "failed"  ? "Failed ✗"
    : "Bridging…";
  const statusTone =
    confirmStatus === "delivered" ? "text-emerald-300 border-emerald-400/30 bg-emerald-400/5"
    : confirmStatus === "failed"  ? "text-red-300 border-red-400/30 bg-red-400/5"
    : "text-yellow-200 border-yellow-300/30 bg-yellow-300/5";

  return (
    <div className="space-y-3">
      <div className={`rounded-md border px-3 py-2 text-sm ${statusTone}`}>
        {statusLabel} · {srcMeta.label} → {dstMeta.label}
        {confirmStatus === "pending" && (
          <div className="text-[10.5px] text-white/55 mt-1">
            CCIP usually settles in 8–25 min depending on lane. We&apos;ll keep checking;
            you can also follow the message on CCIP Explorer below.
          </div>
        )}
      </div>

      {result.approveTxHash && (
        <ResultRow
          label="USDC approve"
          href={`${srcMeta.explorer}/tx/${result.approveTxHash}`}
          value={shortHash(result.approveTxHash)}
          hint="One-time per wallet per chain — future bridges skip this."
        />
      )}
      {result.txHash && (
        <ResultRow
          label={`Source tx · ${srcMeta.explorerLabel}`}
          href={result.srcExplorer ?? `${srcMeta.explorer}/tx/${result.txHash}`}
          value={shortHash(result.txHash)}
        />
      )}
      {result.messageId && (
        <ResultRow
          label="CCIP messageId"
          href={result.ccipExplorer ?? `https://ccip.chain.link/msg/${result.messageId}`}
          value={shortHash(result.messageId)}
          hint="Click to open Chainlink CCIP Explorer."
        />
      )}
      {confirmTxHash && (
        <ResultRow
          label={`Dest tx · ${dstMeta.explorerLabel}`}
          href={`${dstMeta.explorer}/tx/${confirmTxHash}`}
          value={shortHash(confirmTxHash)}
        />
      )}
      {typeof result.feeWhole === "number" && (
        <div className="text-[11px] text-white/55">
          Fee paid: {result.feeWhole.toLocaleString("en-US", { maximumFractionDigits: 6 })}{" "}
          {result.feeToken === "LINK" ? "LINK" : srcMeta.native} · debited from your Gas Tank.
        </div>
      )}

      <button
        type="button"
        onClick={onDone}
        className="w-full px-3 py-2 rounded-md text-sm font-semibold bg-emerald-400 text-slate-900 hover:bg-emerald-300"
      >
        Done
      </button>
    </div>
  );
}

function ResultRow({
  label,
  value,
  href,
  hint,
}: {
  label: string;
  value: string;
  href: string;
  hint?: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-widest text-white/45 font-medium">{label}</div>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-emerald-300 hover:text-emerald-200 font-mono break-all"
      >
        {value} ↗
      </a>
      {hint && <div className="text-[10px] text-white/40">{hint}</div>}
    </div>
  );
}

// Tiny inline error map — CCIP send returns a discrete set of codes we
// can map to one-sentence guidance. Kept inline (not in
// agentic-wallet-friendly-error) because the failure modes here
// (gas-tank-low, fee-spike, CCIP-quote-failed, sender-not-deployed) don't
// overlap with the agentic-send route's vocabulary.
function friendlyBridgeError(status: number, body: SendResponse): string {
  const code = body.error ?? "";
  if (code === "CCIP_SENDER_NOT_DEPLOYED") {
    return "Bridge is temporarily disabled on this lane (sender contract pending redeploy).";
  }
  if (code === "INSUFFICIENT_LINK_BALANCE") {
    return `Not enough LINK on ${body.chain ?? "source chain"} — need ${body.required ?? "?"}, have ${body.available ?? 0}. Top up Gas Tank or switch fee to native.`;
  }
  if (code === "INSUFFICIENT_NATIVE_BALANCE") {
    return `Not enough native gas on ${body.chain ?? "source chain"} — need ${body.required ?? "?"}, have ${body.available ?? 0}. Top up Gas Tank or switch fee to LINK.`;
  }
  if (code === "FEE_EXCEEDS_MAX") {
    return "CCIP fee spiked above the slippage cap. Refresh the quote and try again.";
  }
  if (code === "CCIP_QUOTE_FAILED") {
    return "Couldn't reach the CCIP router to quote the fee. Wait a moment and retry.";
  }
  if (code === "CCIP_BRIDGE_FAILED") {
    return `Bridge tx reverted on source chain. ${body.detail ? `Detail: ${body.detail.slice(0, 140)}` : ""}`.trim();
  }
  if (code === "AGENTIC_WALLET_NOT_FOUND") {
    return "Agent Wallet not found on this source chain — reload the page.";
  }
  if (code === "NONCE_EXPIRED" || code === "BAD_SIGNATURE") {
    return "Your bridge challenge expired or didn't verify. Re-sign and try again.";
  }
  if (status === 402) {
    return "Cross-chain bridging needs an active Multichain subscription.";
  }
  return body.detail ?? body.error ?? `Bridge failed (HTTP ${status}).`;
}
