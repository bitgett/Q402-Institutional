"use client";

/**
 * AgenticWalletOftBridgeModal — cross-chain USDT (USDT0) bridge via LayerZero OFT.
 *
 * Companion to AgenticWalletBridgeModal (USDC / CCIP). USDT0 moves over the 5-chain
 * OFT set (eth / arbitrum / mantle / monad / xlayer). Owner-sig (action="oft.bridge")
 * Mode; the server relayer submits Q402OftSender.bridgeFor and the token arrives on
 * the SAME EOA on the destination. Native fee only, debited from the Gas Tank; no
 * LINK, no fee-token choice.
 */

import { useEffect, useRef, useState } from "react";
import { getActionAuth } from "@/app/lib/auth-client";
import { ThemedSelect } from "./ThemedSelect";
import { ChainIcon } from "../v2/logos";
import { ModalShell, Field, PrimaryCTA, AlertBox, inputStyle, MonoAddr, GOLD_TEXT } from "./modal-kit";

type OftChainKey = "eth" | "arbitrum" | "mantle" | "monad" | "xlayer";

interface ChainMeta { key: OftChainKey; label: string; native: string; explorer: string; }
const CHAINS: ChainMeta[] = [
  { key: "eth",      label: "Ethereum", native: "ETH", explorer: "https://etherscan.io" },
  { key: "arbitrum", label: "Arbitrum", native: "ETH", explorer: "https://arbiscan.io" },
  { key: "mantle",   label: "Mantle",   native: "MNT", explorer: "https://explorer.mantle.xyz" },
  { key: "monad",    label: "Monad",    native: "MON", explorer: "https://monadscan.com" },
  { key: "xlayer",   label: "X Layer",  native: "OKB", explorer: "https://www.oklink.com/xlayer" },
];

// Full mesh among the 5 chains (mirrors manifest.oft supportedDestinations).
const LANES: Record<OftChainKey, OftChainKey[]> = {
  eth:      ["arbitrum", "mantle", "monad", "xlayer"],
  arbitrum: ["eth", "mantle", "monad", "xlayer"],
  mantle:   ["eth", "arbitrum", "monad", "xlayer"],
  monad:    ["eth", "arbitrum", "mantle", "xlayer"],
  xlayer:   ["eth", "arbitrum", "mantle", "monad"],
};

interface QuoteResponse {
  nativeFee: { raw: string; whole: number };
  amountReceived: string;
  minAmountLD: string;
  pathLimit: { minLD: string; maxLD: string };
  decimals: number;
  error?: string;
}
interface SendResponse {
  success?: boolean; guid?: string; txHash?: string; feeWhole?: number;
  amountReceived?: string; lzScan?: string; srcExplorer?: string; approveTxHash?: string;
  agentFundTxHash?: string; agentFundEth?: number;
  error?: string; message?: string; code?: string; detail?: string;
}

interface Props {
  walletAddress: string;
  walletId: string;
  ownerAddress: string;
  signMessage: (msg: string) => Promise<string | null>;
  onClose: () => void;
  onSent: () => void;
  hasMultichainScope: boolean;
}

function isDecimalAmount(s: string): boolean {
  return /^\d+(\.\d{1,6})?$/.test(s.trim()) && Number(s) > 0;
}
// Human "1.50" -> raw 6-dec "1500000" (USDT0 is 6-decimal on all v1 chains).
function toUsdtRaw(human: string): string {
  const [whole = "0", frac = ""] = human.trim().split(".");
  const joined = `${whole}${(frac + "000000").slice(0, 6)}`.replace(/^0+(?=\d)/, "");
  return joined === "" ? "0" : joined;
}
function meta(k: OftChainKey): ChainMeta { return CHAINS.find(c => c.key === k) ?? CHAINS[0]; }
function shortHash(h: string): string { return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h; }

export function AgenticWalletOftBridgeModal({ walletAddress, walletId, ownerAddress, signMessage, onClose, onSent, hasMultichainScope }: Props) {
  const [src, setSrc] = useState<OftChainKey>("eth");
  const [dst, setDst] = useState<OftChainKey>("mantle");
  const [amount, setAmount] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SendResponse | null>(null);
  const [confirmStatus, setConfirmStatus] = useState<"pending" | "delivered" | "failed" | "unknown" | undefined>(undefined);
  const inFlightRef = useRef(false);
  const confirmRef = useRef(confirmStatus);
  useEffect(() => { confirmRef.current = confirmStatus; }, [confirmStatus]);

  useEffect(() => {
    if (!LANES[src].includes(dst)) setDst(LANES[src][0]);
    setQuote(null); setQuoteError(null); setError(null);
  }, [src, dst]);
  useEffect(() => { setQuote(null); setQuoteError(null); setError(null); }, [amount]);

  const amountValid = isDecimalAmount(amount);
  const canQuote = !quoteLoading && amountValid && src !== dst && !submitting;
  const canSubmit = !submitting && quote !== null && amountValid && src !== dst;

  async function fetchQuote() {
    if (!amountValid) return;
    setQuoteLoading(true); setQuoteError(null);
    try {
      const res = await fetch("/api/oft/quote", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ src, dst, amount: toUsdtRaw(amount), owner: walletAddress }),
      });
      const data = (await res.json().catch(() => ({}))) as QuoteResponse;
      if (!res.ok || data.error) { setQuoteError(data.error ?? `Quote failed (HTTP ${res.status}).`); return; }
      setQuote(data);
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : "Quote request failed.");
    } finally { setQuoteLoading(false); }
  }

  async function submit() {
    if (inFlightRef.current) return;
    inFlightRef.current = true; setError(null);
    if (!amountValid) { setError("Amount must be a positive USDT decimal (e.g. 1.50)."); inFlightRef.current = false; return; }
    if (!quote) { setError("Fetch a quote first so we can show the exact fee before signing."); inFlightRef.current = false; return; }
    setSubmitting(true);
    try {
      const rawAmount = toUsdtRaw(amount);
      const auth = await getActionAuth(ownerAddress, "oft.bridge", { walletId, src, dst, amount: rawAmount, maxFeeRaw: "" }, signMessage);
      if (!auth) { setError("Sign the bridge challenge in your wallet. It's bound to this exact src -> dst + amount."); return; }
      const res = await fetch("/api/oft/send", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: ownerAddress, nonce: auth.challenge, signature: auth.signature, walletId, src, dst, amount: rawAmount }),
      });
      const data = (await res.json().catch(() => ({}))) as SendResponse;
      if (!res.ok || !data.success) { setError(data.message ?? data.detail ?? data.error ?? `Bridge failed (HTTP ${res.status}).`); return; }
      setResult(data); setConfirmStatus("pending");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSubmitting(false); inFlightRef.current = false; }
  }

  // Poll LayerZero delivery: GET /api/oft/confirm?src=&txHash= every ~15s up to ~7 min.
  useEffect(() => {
    if (!result?.txHash) return;
    if (confirmStatus === "delivered" || confirmStatus === "failed") return;
    let cancelled = false, polls = 0;
    async function poll() {
      polls += 1;
      try {
        const res = await fetch(`/api/oft/confirm?src=${src}&txHash=${result!.txHash}`);
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { status?: "pending" | "delivered" | "failed" | "unknown" };
        if (!cancelled && data.status && data.status !== "pending") setConfirmStatus(data.status);
      } catch { /* retry next tick */ }
      if (cancelled) return;
      const live = confirmRef.current;
      if (polls < 28 && live !== "delivered" && live !== "failed") setTimeout(poll, 15_000);
      else if (polls >= 28 && (live === "pending" || live === undefined)) setConfirmStatus("unknown");
    }
    const t = setTimeout(poll, 8_000);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.txHash]);

  const srcMeta = meta(src), dstMeta = meta(dst);
  const footer = !result ? (
    <PrimaryCTA onClick={submit} disabled={!canSubmit || !hasMultichainScope} busy={submitting}>
      Bridge {amount || "…"} USDT · {srcMeta.label} → {dstMeta.label}
    </PrimaryCTA>
  ) : (<PrimaryCTA onClick={onSent}>Done</PrimaryCTA>);

  return (
    <ModalShell
      icon={
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/layerzero.png" alt="" width={30} height={30} style={{ borderRadius: "50%", background: "#fff", padding: 2, boxSizing: "border-box", display: "block" }} />
      }
      iconBare
      title="Bridge USDT · LayerZero"
      subtitle={<MonoAddr>{walletAddress.slice(0, 10)}…{walletAddress.slice(-6)}</MonoAddr>}
      size="md" onClose={onClose} closeDisabled={submitting} footer={footer}
    >
      {!hasMultichainScope && !result && (
        <AlertBox variant="warn" action={<a href="/payment" style={{ color: GOLD_TEXT, textDecoration: "underline" }}>View plans →</a>}>
          Cross-chain USDT bridging needs an active Multichain subscription.
        </AlertBox>
      )}

      {!result ? (
        <>
          <div style={{ borderRadius: 10, border: "1px solid rgba(245,197,24,.2)", background: "rgba(245,197,24,.05)", padding: "10px 12px", fontSize: 12, lineHeight: 1.5, color: "rgba(226,232,240,0.78)" }}>
            USDT0 over LayerZero, delivered to your same address on {dstMeta.label}. Q402 adds no markup, you pay only the LayerZero network fee from your <span style={{ color: GOLD_TEXT }}>{srcMeta.native}</span> Gas Tank.
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="From">
              <ThemedSelect<OftChainKey> value={src} onChange={setSrc}
                options={CHAINS.map(c => ({ value: c.key, label: c.label, icon: <ChainIcon chain={c.key} size={16} /> }))}
                ariaLabel="Source chain" disabled={submitting} />
            </Field>
            <Field label="To">
              <ThemedSelect<OftChainKey> value={dst} onChange={setDst}
                options={LANES[src].map(k => ({ value: k, label: meta(k).label, icon: <ChainIcon chain={k} size={16} /> }))}
                ariaLabel="Destination chain" disabled={submitting} />
            </Field>
          </div>

          <Field label="Amount (USDT)">
            <input type="text" value={amount} onChange={e => setAmount(e.target.value)} placeholder="1.50" inputMode="decimal"
              disabled={submitting} className="placeholder-white/25"
              style={{ ...inputStyle({ mono: true, invalid: !(amount === "" || amountValid) }), ...(submitting ? { opacity: 0.5, cursor: "not-allowed" } : {}) }} />
            <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", marginTop: 6 }}>USDT0 uses 6 decimals, smallest step 0.000001 USDT.</div>
          </Field>

          <button type="button" disabled={!canQuote} onClick={fetchQuote}
            className="transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: "1px solid rgba(255,255,255,.16)", background: "rgba(255,255,255,.04)", color: "#e2e8f0", fontSize: 13, fontWeight: 600, cursor: canQuote ? "pointer" : "not-allowed" }}>
            {quoteLoading ? "Quoting…" : quote ? "Refresh quote" : "Get quote"}
          </button>

          {quoteError && <div style={{ fontSize: 12, color: "rgba(252,165,165,.85)" }}>{quoteError}</div>}

          {quote && (
            <div style={{ borderRadius: 12, border: "1px solid rgba(247,202,22,.3)", background: "rgba(247,202,22,.06)", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".09em", fontWeight: 600, color: GOLD_TEXT }}>LayerZero fee quote</div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-white/65">Fee ({srcMeta.native})</span>
                <span className="text-white font-mono">{quote.nativeFee.whole.toLocaleString("en-US", { maximumFractionDigits: 8 })}</span>
              </div>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-white/55">You receive on {dstMeta.label}</span>
                <span className="font-mono" style={{ color: "rgba(143,214,247,.9)" }}>{(Number(quote.amountReceived) / 10 ** quote.decimals).toLocaleString("en-US", { maximumFractionDigits: 6 })} USDT</span>
              </div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,.45)" }}>Server rejects over +10% slippage. Re-quote if the price is over a minute old.</div>
            </div>
          )}

          {error && <AlertBox variant="error">{error}</AlertBox>}
        </>
      ) : (
        <div className="space-y-3">
          <div className="rounded-md border px-3 py-2 text-sm" style={
            confirmStatus === "delivered" ? { color: "#8fd6f7", borderColor: "rgba(88,199,244,.34)", background: "rgba(88,199,244,.06)" }
            : confirmStatus === "failed" ? { color: "#fca5a5", borderColor: "rgba(248,113,113,.3)", background: "rgba(248,113,113,.05)" }
            : confirmStatus === "unknown" ? { color: "rgba(255,255,255,.7)", borderColor: "rgba(255,255,255,.15)" }
            : { color: "#f9d64a", borderColor: "rgba(245,197,24,0.30)", background: "rgba(245,197,24,0.05)" }}>
            {confirmStatus === "delivered" ? "Delivered" : confirmStatus === "failed" ? "Failed" : confirmStatus === "unknown" ? "Still in flight, track on LayerZero Scan ↗" : "Bridging…"} · {srcMeta.label} → {dstMeta.label}
            {confirmStatus === "pending" && <div className="text-[10.5px] text-white/55 mt-1">LayerZero usually settles in 1-5 min. We&apos;ll keep checking.</div>}
          </div>
          {result.approveTxHash && <ResultRow label="USDT approve" href={`${srcMeta.explorer}/tx/${result.approveTxHash}`} value={shortHash(result.approveTxHash)} hint="One-time per wallet per chain." />}
          {result.txHash && <ResultRow label="Source tx" href={result.srcExplorer ?? `${srcMeta.explorer}/tx/${result.txHash}`} value={shortHash(result.txHash)} />}
          {result.guid && <ResultRow label="LayerZero message" href={result.lzScan ?? `https://layerzeroscan.com/tx/${result.txHash}`} value={shortHash(result.guid)} hint="Click to open LayerZero Scan." />}
          {typeof result.feeWhole === "number" && <div className="text-[11px] text-white/55">Fee paid: {result.feeWhole.toLocaleString("en-US", { maximumFractionDigits: 8 })} {srcMeta.native} · debited from your Gas Tank.</div>}
        </div>
      )}
    </ModalShell>
  );
}

function ResultRow({ label, value, href, hint }: { label: string; value: string; href: string; hint?: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-widest text-white/45 font-medium">{label}</div>
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-xs font-mono break-all" style={{ color: GOLD_TEXT }}>{value} ↗</a>
      {hint && <div className="text-[10px] text-white/40">{hint}</div>}
    </div>
  );
}
