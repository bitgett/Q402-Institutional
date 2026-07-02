"use client";

import { use, useEffect, useState } from "react";

/**
 * Public payment-request page: /pay/[requestId]
 *
 * Mirrors the Trust Receipt card (app/receipt/[id]/ReceiptCard.tsx) — same
 * sectioned layout, header, status banner, label/value rows, and footer — so a
 * request and its receipt read as one family. v1 is DISPLAY + instructions:
 * a Q402 agent settles a request gaslessly via q402_request_pay (browser-wallet
 * settlement is deferred — injected wallets can't sign the EIP-7702 auth a
 * first-time payer would need).
 */

const CHAIN_META: Record<
  string,
  { name: string; logo: string; explorer?: string; explorerName?: string; bg?: string }
> = {
  bnb: { name: "BNB Chain", logo: "/bnb.png", explorer: "https://bscscan.com/tx/", explorerName: "BscScan" },
  eth: { name: "Ethereum", logo: "/eth.png", explorer: "https://etherscan.io/tx/", explorerName: "Etherscan" },
  avax: { name: "Avalanche", logo: "/avax.png", explorer: "https://snowtrace.io/tx/", explorerName: "Snowtrace" },
  xlayer: { name: "X Layer", logo: "/xlayer.png", explorer: "https://www.oklink.com/xlayer/tx/", explorerName: "OKLink" },
  stable: { name: "Stable", logo: "/stable.jpg" },
  mantle: { name: "Mantle", logo: "/mantle.png", explorer: "https://mantlescan.xyz/tx/", explorerName: "Mantlescan" },
  injective: { name: "Injective", logo: "/injective.png" },
  monad: { name: "Monad", logo: "/monad.png" },
  scroll: { name: "Scroll", logo: "/scroll.png", explorer: "https://scrollscan.com/tx/", explorerName: "Scrollscan" },
  arbitrum: { name: "Arbitrum", logo: "/arbitrum.png", explorer: "https://arbiscan.io/tx/", explorerName: "Arbiscan" },
  base: { name: "Base", logo: "/base.png", explorer: "https://basescan.org/tx/", explorerName: "Basescan" },
  robinhood: { name: "Robinhood Chain", logo: "/robinhood.svg", explorer: "https://robinhoodchain.blockscout.com/tx/", explorerName: "Blockscout", bg: "#00C805" },
};

interface PublicRequest {
  id: string;
  recipient: string;
  chain: string;
  token: "USDC" | "USDT";
  amount: string;
  memo?: string;
  status: "open" | "paid" | "expired" | "cancelled";
  createdAt: string;
  expiresAt: string;
  paidTxHash?: string;
  paidAt?: string;
  paidBy?: string;
  receiptId?: string;
  sandbox: boolean;
}

const STATUS: Record<
  PublicRequest["status"],
  { label: string; sub: string; icon: string; tone: "active" | "muted" }
> = {
  open: { label: "Awaiting payment", sub: "Share this link, or have a Q402 agent settle it.", icon: "•", tone: "active" },
  paid: { label: "Paid", sub: "Settled on-chain, gaslessly.", icon: "✓", tone: "active" },
  expired: { label: "Expired", sub: "This request is past its expiry window.", icon: "○", tone: "muted" },
  cancelled: { label: "Cancelled", sub: "The creator cancelled this request.", icon: "○", tone: "muted" },
};

function short(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });
}

export default function PayRequestPage({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = use(params);
  const [state, setState] = useState<"loading" | "ready" | "notfound" | "error">("loading");
  const [req, setReq] = useState<PublicRequest | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/request/${requestId}`);
        if (res.status === 404) { if (!cancelled) setState("notfound"); return; }
        if (!res.ok) { if (!cancelled) setState("error"); return; }
        const data = (await res.json()) as { request: PublicRequest };
        if (!cancelled) { setReq(data.request); setState("ready"); }
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => { cancelled = true; };
  }, [requestId]);

  function copy(key: string, value: string) {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1800);
    });
  }

  const chain = req ? CHAIN_META[req.chain] : undefined;
  const st = req ? STATUS[req.status] : null;

  return (
    <main className="min-h-screen bg-[#0B0F1A] text-white antialiased px-4 py-12 flex items-center justify-center">
      <div className="w-full max-w-md">
        {state === "loading" && <div className="text-center text-white/40 text-sm py-20">Loading request…</div>}

        {state === "notfound" && (
          <Shell>
            <div className="px-7 py-10 text-center">
              <div className="text-lg font-semibold mb-1">Request not found</div>
              <div className="text-white/45 text-sm">This payment request does not exist or has expired from the ledger.</div>
            </div>
          </Shell>
        )}

        {state === "error" && (
          <Shell>
            <div className="px-7 py-10 text-center">
              <div className="text-lg font-semibold mb-1">Couldn&apos;t load request</div>
              <div className="text-white/45 text-sm">Something went wrong. Refresh to try again.</div>
            </div>
          </Shell>
        )}

        {state === "ready" && req && st && (
          <div className="relative">
            <div
              aria-hidden
              className="pointer-events-none absolute -top-16 left-1/2 -translate-x-1/2 w-80 h-40 rounded-full"
              style={{ background: "radial-gradient(circle, rgba(245,197,24,0.13), transparent 70%)" }}
            />
            <Shell>
              {/* Header */}
              <div className="px-7 pt-7 pb-5 border-b border-white/8 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/q402-logo.svg" alt="Q402" className="h-8 w-auto" />
                    <span className="text-[10px] uppercase tracking-[0.22em] text-white/40 font-semibold border-l border-white/10 pl-2.5">
                      Payment request
                    </span>
                  </div>
                  <div className="font-mono text-xs text-white/45 mt-2 break-all">{req.id}</div>
                </div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-white/35 text-right shrink-0">
                  {req.sandbox ? "Sandbox" : "Created"}
                  <br />
                  <span className="text-white/55 normal-case font-mono tracking-normal">{fmtDate(req.createdAt)}</span>
                </div>
              </div>

              {/* Status banner */}
              <div
                className={`mx-7 my-5 rounded-2xl border p-5 ${
                  st.tone === "active" ? "border-yellow/40 bg-yellow/10" : "border-white/10 bg-white/[0.02]"
                }`}
              >
                <div className="flex items-center gap-4">
                  <div
                    className="w-11 h-11 rounded-full flex items-center justify-center text-lg shrink-0 border border-white/15"
                    style={{ background: st.tone === "active" ? "rgba(245,197,24,0.16)" : "rgba(255,255,255,0.05)" }}
                  >
                    <span className={st.tone === "active" ? "text-yellow" : "text-white/40"}>{st.icon}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold">{st.label}</div>
                    <div className="text-[11px] text-white/45 mt-0.5">{st.sub}</div>
                  </div>
                </div>
              </div>

              {/* Request details */}
              <div className="px-7 py-5 border-t border-white/8">
                <SectionHeader>Request</SectionHeader>
                <div className="space-y-2.5 text-xs">
                  <div className="flex items-baseline justify-between py-3 mb-1 border-b border-white/5">
                    <span className="text-white/40">Amount</span>
                    <span>
                      <span className="text-3xl font-bold tracking-tight">{req.amount}</span>
                      <span className="text-sm text-white/55 ml-2">{req.token}</span>
                    </span>
                  </div>
                  <Row label="Network">
                    <span className="inline-flex items-center gap-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {chain?.logo && <img src={chain.logo} alt="" width={16} height={16} className="rounded-full" style={chain.bg ? { background: chain.bg, objectFit: "contain", padding: 2, boxSizing: "border-box" } : undefined} />}
                      <span className="text-white/85">{chain?.name ?? req.chain}</span>
                    </span>
                  </Row>
                  <Row label="Pay to">
                    <button onClick={() => copy("recipient", req.recipient)} className="font-mono text-white/85 hover:text-white transition">
                      {short(req.recipient)} <span className="text-white/30">{copied === "recipient" ? "copied" : "copy"}</span>
                    </button>
                  </Row>
                  {req.memo && <Row label="Memo"><span className="text-white/85">{req.memo}</span></Row>}
                </div>
              </div>

              {/* Paid → on-chain proof */}
              {req.status === "paid" && (
                <div className="px-7 py-5 border-t border-white/8">
                  <SectionHeader>On-chain proof</SectionHeader>
                  <div className="space-y-2.5 text-xs">
                    {req.paidAt && <Row label="Paid"><span className="text-white/85 font-mono">{fmtDateTime(req.paidAt)}</span></Row>}
                    {req.paidBy && <Row label="Paid by"><span className="font-mono text-white/85">{short(req.paidBy)}</span></Row>}
                    <Row label="Gas"><span className="text-white/85 font-mono">$0 · sponsored by Q402</span></Row>
                    {req.paidTxHash && (
                      <Row label="Tx hash"><code className="font-mono text-white/85">{short(req.paidTxHash)}</code></Row>
                    )}
                    <div className="flex items-center gap-4 pt-2">
                      {req.paidTxHash && chain?.explorer && (
                        <a href={`${chain.explorer}${req.paidTxHash}`} target="_blank" rel="noreferrer" className="text-[11px] text-yellow/80 hover:text-yellow transition">
                          View on {chain.explorerName ?? "explorer"} ↗
                        </a>
                      )}
                      {req.receiptId && (
                        <a href={`/receipt/${req.receiptId}`} target="_blank" rel="noreferrer" className="text-[11px] text-yellow/80 hover:text-yellow transition">
                          Trust Receipt ↗
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Open → how to pay (compact) */}
              {req.status === "open" && (
                <div className="px-7 py-5 border-t border-white/8">
                  <SectionHeader>Pay with an agent</SectionHeader>
                  <div className="text-[10px] uppercase tracking-wider text-white/35 mb-1.5">Step 1 · preview command (does not move funds)</div>
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-white/8 bg-black/30 px-3 py-2.5">
                    <code className="font-mono text-[11px] text-yellow/90 truncate">
                      q402_request_pay {"{"} requestId: &quot;{req.id}&quot;, confirm: true {"}"}
                    </code>
                    <button
                      onClick={() => copy("cmd", `q402_request_pay { requestId: "${req.id}", confirm: true }`)}
                      className="text-[10px] text-white/50 hover:text-white border border-white/10 rounded px-2 py-1 shrink-0 transition"
                    >
                      {copied === "cmd" ? "copied" : "copy"}
                    </button>
                  </div>
                  <p className="text-[11px] text-white/35 mt-2.5">
                    Two-phase: the first call returns a preview + a consentToken; the agent
                    re-calls with that token to settle. confirm:true alone won&apos;t move funds.
                    Settled gaslessly. A manual transfer to the address works too, but won&apos;t update this page.
                  </p>
                </div>
              )}

              {/* Footer */}
              <div className="px-7 py-5 border-t border-white/8 flex items-center justify-between gap-3">
                <div className="text-[10px] text-white/30 leading-snug">
                  {req.status === "open" ? "Expires" : "Created"}
                  <br />
                  <span className="font-mono text-white/55">{fmtDate(req.status === "open" ? req.expiresAt : req.createdAt)}</span>
                </div>
                <div className="flex items-center gap-2">
                  {copied === "link" && <span className="text-[11px] text-yellow/85">Link copied</span>}
                  <button
                    onClick={() => copy("link", typeof window !== "undefined" ? window.location.href : "")}
                    className="h-9 px-4 rounded-lg border border-white/15 text-xs text-white/80 hover:text-white hover:border-white/30 transition"
                  >
                    Copy link
                  </button>
                </div>
              </div>
            </Shell>

            <p className="mt-6 text-center text-[11px] text-white/30">
              Powered by Q402 · gasless payment request
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-3xl border border-white/8 overflow-hidden shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)]"
      style={{ background: "linear-gradient(180deg, #131A2B 0%, #0F1424 100%)" }}
    >
      {children}
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] uppercase tracking-[0.2em] text-white/40 font-semibold mb-3">{children}</div>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-white/40 shrink-0">{label}</span>
      <span className="text-right truncate">{children}</span>
    </div>
  );
}
