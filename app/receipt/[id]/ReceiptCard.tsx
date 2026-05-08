"use client";

import { useEffect, useMemo, useState } from "react";
// canonicalize/receiptDigest aren't used directly here — verifyReceiptSignature
// internally reproduces them, ensuring server and client agree byte-for-byte.
import {
  verifyReceiptSignature,
  type Receipt,
  type ReceiptSignedFields,
} from "@/app/lib/receipt-shared";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const EXPLORERS: Record<string, { name: string; tx: (h: string) => string }> = {
  bnb:       { name: "BscScan",    tx: h => `https://bscscan.com/tx/${h}` },
  eth:       { name: "Etherscan",  tx: h => `https://etherscan.io/tx/${h}` },
  avax:      { name: "Snowtrace",  tx: h => `https://snowtrace.io/tx/${h}` },
  xlayer:    { name: "OKLink",     tx: h => `https://www.oklink.com/xlayer/tx/${h}` },
  stable:    { name: "Stable Explorer", tx: h => `https://stable-explorer.io/tx/${h}` },
  mantle:    { name: "Mantlescan", tx: h => `https://mantlescan.xyz/tx/${h}` },
  injective: { name: "Blockscout", tx: h => `https://blockscout.injective.network/tx/${h}` },
};

const CHAIN_LABELS: Record<string, string> = {
  bnb:       "BNB Chain",
  eth:       "Ethereum",
  avax:      "Avalanche",
  xlayer:    "X Layer",
  stable:    "Stable",
  mantle:    "Mantle",
  injective: "Injective EVM",
};

const POLL_INTERVAL_MS  = 2_500;
const POLL_MAX_DURATION = 90_000;     // stop polling after 90 s

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

type VerifyState =
  | { kind: "idle" }
  | { kind: "verifying" }
  | { kind: "ok" }
  | { kind: "fail"; reason: string };

export default function ReceiptCard({ initialReceipt }: { initialReceipt: Receipt }) {
  const [receipt,  setReceipt]  = useState<Receipt>(initialReceipt);
  const [verify,   setVerify]   = useState<VerifyState>({ kind: "idle" });
  const [shareTip, setShareTip] = useState<string | null>(null);

  // ── Live webhook delivery polling ─────────────────────────────────────────
  // Stop conditions: terminal status reached, or we've polled past
  // POLL_MAX_DURATION (a misconfigured customer endpoint shouldn't keep
  // us hammering KV forever).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const status = receipt.webhook.deliveryStatus;
    if (status === "delivered" || status === "failed" || status === "not_configured") return;

    let cancelled = false;
    const startedAt = Date.now();

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/receipt/${receipt.receiptId}`, { cache: "no-store" });
        if (res.ok) {
          const next = (await res.json()) as Receipt;
          if (!cancelled) setReceipt(next);
          const ns = next.webhook.deliveryStatus;
          if (ns === "delivered" || ns === "failed") return;
        }
      } catch {
        /* network blip — keep trying */
      }
      if (!cancelled && Date.now() - startedAt < POLL_MAX_DURATION) {
        setTimeout(tick, POLL_INTERVAL_MS);
      }
    };

    setTimeout(tick, POLL_INTERVAL_MS);
    return () => { cancelled = true; };
  // Re-arm only when receipt id changes; webhook state transitions are
  // handled inside the loop's own re-checks.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.receiptId]);

  // ── Canonical fields used by Verify (memoized so we don't re-pluck on every render)
  const signedFields: ReceiptSignedFields = useMemo(() => ({
    receiptId:      receipt.receiptId,
    createdAt:      receipt.createdAt,
    txHash:         receipt.txHash,
    chain:          receipt.chain,
    payer:          receipt.payer,
    recipient:      receipt.recipient,
    token:          receipt.token,
    tokenAmount:    receipt.tokenAmount,
    tokenAmountRaw: receipt.tokenAmountRaw,
    method:         receipt.method,
    apiKeyId:       receipt.apiKeyId,
    sandbox:        receipt.sandbox,
  }), [receipt]);

  const onVerify = () => {
    setVerify({ kind: "verifying" });
    // Tiny artificial delay so the user sees the "verifying…" state — pure
    // ECDSA recovery is sub-millisecond, which feels instant and skips the
    // visual moment we want for the demo.
    setTimeout(() => {
      const ok = verifyReceiptSignature(signedFields, receipt.signature, receipt.signedBy);
      setVerify(ok
        ? { kind: "ok" }
        : { kind: "fail", reason: "Signature does not recover to the relayer address." });
    }, 400);
  };

  const onShare = async () => {
    if (typeof window === "undefined") return;
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setShareTip("Receipt URL copied");
    } catch {
      setShareTip("Copy failed — select the URL bar manually");
    }
    setTimeout(() => setShareTip(null), 2_500);
  };

  const explorer = EXPLORERS[receipt.chain];
  const chainLabel = CHAIN_LABELS[receipt.chain] ?? receipt.chain;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main className="min-h-screen bg-[#0B0F1A] text-white antialiased px-4 py-12 flex items-center justify-center">
      <div className="w-full max-w-2xl">
        {receipt.sandbox && <SandboxBanner />}

        <div className="rounded-3xl border border-white/8 overflow-hidden shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)]"
             style={{ background: "linear-gradient(180deg, #131A2B 0%, #0F1424 100%)" }}>
          <Header receiptId={receipt.receiptId} createdAt={receipt.createdAt} />
          <VerifyBlock state={verify} signedBy={receipt.signedBy} onVerify={onVerify} />
          <Settlement
            payer={receipt.payer}
            recipient={receipt.recipient}
            token={receipt.token}
            tokenAmount={receipt.tokenAmount}
            chainLabel={chainLabel}
            method={receipt.method}
            apiKeyTier={receipt.apiKeyTier}
          />
          <OnChainProof
            txHash={receipt.txHash}
            blockNumber={receipt.blockNumber}
            explorerName={explorer?.name ?? "Explorer"}
            explorerUrl={explorer ? explorer.tx(receipt.txHash) : null}
            gasCostNative={receipt.gasCostNative}
          />
          <DeliveryTrace webhook={receipt.webhook} />
          <Footer onShare={onShare} shareTip={shareTip} signedAt={receipt.signedAt} />
        </div>

        <p className="mt-6 text-center text-[11px] text-white/30">
          Powered by Q402 · machine-verifiable settlement record
        </p>
      </div>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcomponents
// ─────────────────────────────────────────────────────────────────────────────

function Header({ receiptId, createdAt }: { receiptId: string; createdAt: string }) {
  const created = new Date(createdAt).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });
  return (
    <div className="px-7 pt-7 pb-5 border-b border-white/8 flex items-start justify-between gap-3">
      <div>
        <div className="text-[10px] uppercase tracking-[0.22em] text-yellow font-semibold">Q402 · TRUST RECEIPT</div>
        <div className="font-mono text-xs text-white/55 mt-1 break-all">{receiptId}</div>
      </div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-white/35 text-right shrink-0">
        Issued<br/><span className="text-white/55 normal-case font-mono tracking-normal">{created}</span>
      </div>
    </div>
  );
}

function VerifyBlock({
  state, signedBy, onVerify,
}: { state: VerifyState; signedBy: string; onVerify: () => void }) {
  const colorClass =
    state.kind === "ok"        ? "border-green-400/40 bg-green-400/10"
  : state.kind === "fail"      ? "border-red-400/40 bg-red-400/10"
  : state.kind === "verifying" ? "border-yellow/40 bg-yellow/10"
  :                              "border-white/10 bg-white/[0.02]";

  return (
    <div className={`mx-7 my-5 rounded-2xl border p-5 transition-colors ${colorClass}`}>
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-full flex items-center justify-center text-xl shrink-0
                        border border-white/15"
             style={{
               background: state.kind === "ok"   ? "rgba(74,229,74,0.18)"
                        :  state.kind === "fail" ? "rgba(244,99,99,0.18)"
                        :                          "rgba(245,197,24,0.10)"
             }}>
          {state.kind === "ok"        ? "✓"
        : state.kind === "fail"      ? "✗"
        : state.kind === "verifying" ? <Spinner />
        :                               "🔏"}
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold">
            {state.kind === "ok"        ? "Verified — ECDSA signature matched"
          : state.kind === "fail"      ? "Verification failed"
          : state.kind === "verifying" ? "Verifying signature…"
          :                               "Cryptographic proof"}
          </div>
          <div className="text-[11px] text-white/45 mt-0.5">
            {state.kind === "ok"
              ? <>Signed by <code className="font-mono text-white/70">{shortAddr(signedBy)}</code> · recovered locally in your browser</>
            : state.kind === "fail"
              ? state.reason
            : state.kind === "verifying"
              ? "Recovering relayer address from canonical hash…"
              : <>Signed by <code className="font-mono text-white/65">{shortAddr(signedBy)}</code> · click below to verify locally</>
            }
          </div>
        </div>
        <button
          onClick={onVerify}
          disabled={state.kind === "verifying"}
          className="px-4 h-9 rounded-lg bg-yellow text-[#0B0F1A] text-xs font-semibold hover:bg-yellow/90 disabled:opacity-60 transition shrink-0"
        >
          {state.kind === "ok" ? "Verify again" : "Verify signature"}
        </button>
      </div>
    </div>
  );
}

function Settlement({
  payer, recipient, token, tokenAmount, chainLabel, method, apiKeyTier,
}: {
  payer: string; recipient: string; token: string; tokenAmount: string;
  chainLabel: string; method: string; apiKeyTier?: string;
}) {
  return (
    <div className="px-7 py-5 border-t border-white/8">
      <SectionHeader>Settlement</SectionHeader>
      <div className="space-y-2.5 text-xs">
        <Row label="Payer">     <code className="font-mono text-white/85">{payer}</code></Row>
        <Row label="Recipient"> <code className="font-mono text-white/85">{recipient}</code></Row>
        <div className="flex items-baseline justify-between py-3 my-1 border-y border-white/5">
          <span className="text-white/40">Amount</span>
          <span>
            <span className="text-3xl font-bold tracking-tight">{tokenAmount}</span>
            <span className="text-sm text-white/55 ml-2">{token}</span>
          </span>
        </div>
        <Row label="Chain">  <span className="text-white/85">{chainLabel}</span></Row>
        <Row label="Method"> <code className="font-mono text-white/65 text-[11px]">{method}</code></Row>
        {apiKeyTier && (
          <Row label="API tier"><span className="text-white/85 capitalize">{apiKeyTier}</span></Row>
        )}
      </div>
    </div>
  );
}

function OnChainProof({
  txHash, blockNumber, explorerName, explorerUrl, gasCostNative,
}: {
  txHash: string; blockNumber?: number;
  explorerName: string; explorerUrl: string | null; gasCostNative?: string;
}) {
  return (
    <div className="px-7 py-5 border-t border-white/8">
      <SectionHeader>On-chain proof</SectionHeader>
      <div className="space-y-2.5 text-xs">
        <Row label="Tx hash">
          <code className="font-mono text-white/85 break-all">{txHash}</code>
        </Row>
        {typeof blockNumber === "number" && (
          <Row label="Block"><span className="text-white/85 font-mono">{blockNumber.toLocaleString()}</span></Row>
        )}
        {gasCostNative && (
          <Row label="Gas (sponsored by Q402)">
            <span className="text-white/85 font-mono">{gasCostNative}</span>
          </Row>
        )}
        {explorerUrl && (
          <a href={explorerUrl} target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1.5 mt-2 text-[11px] text-yellow/80 hover:text-yellow transition">
            View on {explorerName} ↗
          </a>
        )}
      </div>
    </div>
  );
}

function DeliveryTrace({ webhook }: { webhook: Receipt["webhook"] }) {
  return (
    <div className="px-7 py-5 border-t border-white/8">
      <SectionHeader>Delivery trace</SectionHeader>
      <ol className="space-y-2 text-xs">
        <TraceStep state="done" label="On-chain settlement" detail="Confirmed" />
        {!webhook.configured ? (
          <TraceStep state="muted" label="Webhook delivery" detail="No webhook configured" />
        ) : webhook.deliveryStatus === "pending" ? (
          <TraceStep state="pending" label="Webhook delivery" detail="Dispatching…" />
        ) : webhook.deliveryStatus === "delivered" ? (
          <TraceStep state="done" label="Webhook delivery"
                     detail={`Delivered · ${webhook.lastStatusCode ?? 200} · attempt ${webhook.attempts ?? 1}`} />
        ) : (
          <TraceStep state="failed" label="Webhook delivery"
                     detail={`Failed after ${webhook.attempts ?? 0} attempts${webhook.lastError ? ` · ${webhook.lastError}` : ""}`} />
        )}
      </ol>
      {webhook.payloadSha256 && (
        <div className="mt-3 text-[10px] text-white/30 font-mono break-all">
          payload sha256: {webhook.payloadSha256}
        </div>
      )}
    </div>
  );
}

function Footer({ onShare, shareTip, signedAt }: {
  onShare: () => void; shareTip: string | null; signedAt: string;
}) {
  const issued = new Date(signedAt).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });
  return (
    <div className="px-7 py-5 border-t border-white/8 flex items-center justify-between gap-3">
      <div className="text-[10px] text-white/30 leading-snug">
        Signed at<br/><span className="font-mono text-white/55">{issued}</span>
      </div>
      <div className="flex items-center gap-2">
        {shareTip && <span className="text-[11px] text-yellow/85">{shareTip}</span>}
        <button
          onClick={onShare}
          className="h-9 px-4 rounded-lg border border-white/15 text-xs text-white/80 hover:text-white hover:border-white/30 transition"
        >
          Copy link
        </button>
      </div>
    </div>
  );
}

function SandboxBanner() {
  return (
    <div className="mb-4 rounded-2xl border-2 border-dashed border-orange-400/50 bg-orange-400/10 px-4 py-3 text-xs text-orange-200 flex items-center gap-3">
      <span className="text-base">⚠</span>
      <div>
        <div className="font-semibold">SANDBOX — NOT A REAL SETTLEMENT</div>
        <div className="text-orange-200/80 leading-relaxed">
          This receipt was issued from a Q402 sandbox key. The transaction
          hash is fabricated and no on-chain transfer occurred.
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiny UI primitives
// ─────────────────────────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-[0.2em] text-white/40 font-semibold mb-3">
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-white/40 shrink-0">{label}</span>
      <span className="text-right truncate">{children}</span>
    </div>
  );
}

function TraceStep({
  state, label, detail,
}: { state: "done" | "pending" | "failed" | "muted"; label: string; detail: string }) {
  const icon = state === "done"    ? <span className="text-green-400">✓</span>
            :  state === "pending" ? <Spinner small />
            :  state === "failed"  ? <span className="text-red-400">✗</span>
            :                        <span className="text-white/30">○</span>;

  const labelClass = state === "muted" ? "text-white/45" : "text-white/85";
  const detailClass = state === "muted"   ? "text-white/30"
                   :  state === "failed"  ? "text-red-300/80"
                   :  state === "pending" ? "text-yellow/70"
                   :                        "text-white/55";

  return (
    <li className="flex items-start gap-3">
      <span className="w-4 mt-0.5 shrink-0 text-center">{icon}</span>
      <div className="flex-1">
        <div className={`text-xs font-semibold ${labelClass}`}>{label}</div>
        <div className={`text-[11px] mt-0.5 ${detailClass}`}>{detail}</div>
      </div>
    </li>
  );
}

function Spinner({ small = false }: { small?: boolean }) {
  const size = small ? "w-3 h-3 border-[1.5px]" : "w-5 h-5 border-2";
  return (
    <span className={`inline-block ${size} border-yellow/60 border-t-yellow rounded-full animate-spin`} />
  );
}

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
