"use client";

import { use, useEffect, useState } from "react";
import Navbar from "@/app/components/Navbar";
import Footer from "@/app/components/Footer";

/**
 * Public payment-request page: /pay/[requestId]
 *
 * v1 is a DISPLAY + instructions surface (browser-wallet settlement is
 * deferred - injected wallets can't sign the EIP-7702 authorization an
 * arbitrary first-time payer would need). It shows the request details and
 * how to fulfill it: pay the recipient on the named chain, or have a Q402
 * agent settle it gaslessly via the q402_request_pay MCP tool.
 */

const CHAIN_META: Record<string, { name: string; logo: string; explorer?: string }> = {
  bnb: { name: "BNB Chain", logo: "/bnb.png", explorer: "https://bscscan.com/tx/" },
  eth: { name: "Ethereum", logo: "/eth.png", explorer: "https://etherscan.io/tx/" },
  avax: { name: "Avalanche", logo: "/avax.png", explorer: "https://snowtrace.io/tx/" },
  xlayer: { name: "X Layer", logo: "/xlayer.png", explorer: "https://www.oklink.com/xlayer/tx/" },
  stable: { name: "Stable", logo: "/stable.jpg" },
  mantle: { name: "Mantle", logo: "/mantle.png", explorer: "https://mantlescan.xyz/tx/" },
  injective: { name: "Injective", logo: "/injective.png" },
  monad: { name: "Monad", logo: "/monad.png" },
  scroll: { name: "Scroll", logo: "/scroll.png", explorer: "https://scrollscan.com/tx/" },
  arbitrum: { name: "Arbitrum", logo: "/arbitrum.png", explorer: "https://arbiscan.io/tx/" },
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
  sandbox: boolean;
}

const NAVY = "#070C16";
const PANEL = "#0B1220";
const LINE = "rgba(255,255,255,.08)";
const YELLOW = "#F5C518";
const CYAN = "#5BC8FA";
const TEXT = "#EAF0FA";
const MUTED = "#8C9BB3";

function short(a: string): string {
  return a.length > 14 ? `${a.slice(0, 8)}...${a.slice(-6)}` : a;
}

const STATUS_STYLE: Record<PublicRequest["status"], { label: string; color: string }> = {
  open: { label: "Awaiting payment", color: YELLOW },
  paid: { label: "Paid", color: CYAN },
  expired: { label: "Expired", color: MUTED },
  cancelled: { label: "Cancelled", color: MUTED },
};

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
        if (res.status === 404) {
          if (!cancelled) setState("notfound");
          return;
        }
        if (!res.ok) {
          if (!cancelled) setState("error");
          return;
        }
        const data = (await res.json()) as { request: PublicRequest };
        if (!cancelled) {
          setReq(data.request);
          setState("ready");
        }
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  function copy(key: string, value: string) {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1800);
    });
  }

  const chain = req ? CHAIN_META[req.chain] : undefined;

  return (
    <div style={{ minHeight: "100vh", background: NAVY, color: TEXT, display: "flex", flexDirection: "column" }}>
      <Navbar />
      <main
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "120px 20px 80px",
        }}
      >
        <div style={{ width: "100%", maxWidth: 520 }}>
          <div style={{ fontSize: 12, letterSpacing: ".12em", textTransform: "uppercase", color: MUTED, marginBottom: 12 }}>
            Q402 Payment Request
          </div>

          {state === "loading" && (
            <div style={{ color: MUTED, fontSize: 14, padding: "40px 0" }}>Loading request...</div>
          )}

          {state === "notfound" && (
            <Card>
              <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Request not found</div>
              <div style={{ color: MUTED, fontSize: 14 }}>
                This payment request does not exist or has expired from the ledger.
              </div>
            </Card>
          )}

          {state === "error" && (
            <Card>
              <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Could not load request</div>
              <div style={{ color: MUTED, fontSize: 14 }}>Something went wrong. Refresh to try again.</div>
            </Card>
          )}

          {state === "ready" && req && (
            <Card>
              {/* Status + sandbox tag */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: STATUS_STYLE[req.status].color,
                    display: "inline-block",
                  }}
                />
                <span style={{ fontSize: 13, color: STATUS_STYLE[req.status].color, fontWeight: 600 }}>
                  {STATUS_STYLE[req.status].label}
                </span>
                {req.sandbox && (
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 11,
                      color: MUTED,
                      border: `1px solid ${LINE}`,
                      borderRadius: 6,
                      padding: "2px 8px",
                      letterSpacing: ".06em",
                    }}
                  >
                    SANDBOX
                  </span>
                )}
              </div>

              {/* Amount */}
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
                <span style={{ fontSize: 44, fontWeight: 700, letterSpacing: "-0.02em", fontFamily: "var(--font-bricolage), sans-serif" }}>
                  {req.amount}
                </span>
                <span style={{ fontSize: 20, color: MUTED, fontWeight: 600 }}>{req.token}</span>
              </div>
              {req.memo && <div style={{ color: MUTED, fontSize: 14, marginBottom: 20 }}>{req.memo}</div>}

              {/* Details rows */}
              <div style={{ display: "grid", gap: 12, margin: "20px 0", paddingTop: 20, borderTop: `1px solid ${LINE}` }}>
                <Row label="Network">
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {chain?.logo && <img src={chain.logo} alt="" width={18} height={18} style={{ borderRadius: "50%" }} />}
                    <span>{chain?.name ?? req.chain}</span>
                  </span>
                </Row>
                <Row label="Pay to">
                  <button
                    onClick={() => copy("recipient", req.recipient)}
                    style={addrBtn}
                    title="Copy recipient address"
                  >
                    <span style={{ fontFamily: "var(--font-jetbrains), monospace" }}>{short(req.recipient)}</span>
                    <span style={{ color: copied === "recipient" ? CYAN : MUTED, fontSize: 11 }}>
                      {copied === "recipient" ? "copied" : "copy"}
                    </span>
                  </button>
                </Row>
                {req.status === "paid" && req.paidTxHash && (
                  <Row label="Settlement">
                    {chain?.explorer ? (
                      <a href={`${chain.explorer}${req.paidTxHash}`} target="_blank" rel="noreferrer" style={{ color: CYAN, fontFamily: "var(--font-jetbrains), monospace", fontSize: 13 }}>
                        {short(req.paidTxHash)} ↗
                      </a>
                    ) : (
                      <span style={{ fontFamily: "var(--font-jetbrains), monospace", fontSize: 13 }}>{short(req.paidTxHash)}</span>
                    )}
                  </Row>
                )}
              </div>

              {/* Pay instructions (only while open) */}
              {req.status === "open" && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 12, letterSpacing: ".08em", textTransform: "uppercase", color: MUTED, marginBottom: 10 }}>
                    How to pay
                  </div>
                  <div style={{ fontSize: 14, color: TEXT, marginBottom: 14, lineHeight: 1.55 }}>
                    Send <b>{req.amount} {req.token}</b> to the address above on <b>{chain?.name ?? req.chain}</b>.
                    A Q402 agent can settle it gaslessly:
                  </div>
                  <div
                    style={{
                      background: "#05080F",
                      border: `1px solid ${LINE}`,
                      borderRadius: 10,
                      padding: "12px 14px",
                      fontFamily: "var(--font-jetbrains), monospace",
                      fontSize: 12.5,
                      color: CYAN,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      q402_request_pay {"{"} requestId: &quot;{req.id}&quot; {"}"}
                    </span>
                    <button onClick={() => copy("cmd", `q402_request_pay { requestId: "${req.id}" }`)} style={miniBtn}>
                      {copied === "cmd" ? "copied" : "copy"}
                    </button>
                  </div>

                  <button
                    onClick={() => copy("link", typeof window !== "undefined" ? window.location.href : "")}
                    style={{ ...primaryBtn, marginTop: 16 }}
                  >
                    {copied === "link" ? "Link copied" : "Copy payment link"}
                  </button>
                </div>
              )}

              {req.status === "paid" && (
                <div style={{ marginTop: 8, fontSize: 14, color: CYAN }}>This request has been paid. Thank you.</div>
              )}
            </Card>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );

  function Card({ children }: { children: React.ReactNode }) {
    return (
      <div
        style={{
          background: PANEL,
          border: `1px solid ${LINE}`,
          borderRadius: 18,
          padding: 28,
          boxShadow: "0 24px 60px rgba(0,0,0,.4)",
        }}
      >
        {children}
      </div>
    );
  }

  function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <span style={{ color: MUTED, fontSize: 13 }}>{label}</span>
        <span style={{ fontSize: 14 }}>{children}</span>
      </div>
    );
  }
}

const addrBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  background: "transparent",
  border: "none",
  color: "#EAF0FA",
  cursor: "pointer",
  fontSize: 14,
  padding: 0,
};

const miniBtn: React.CSSProperties = {
  background: "transparent",
  border: `1px solid ${LINE}`,
  borderRadius: 6,
  color: MUTED,
  fontSize: 11,
  padding: "3px 8px",
  cursor: "pointer",
  flexShrink: 0,
};

const primaryBtn: React.CSSProperties = {
  width: "100%",
  background: YELLOW,
  color: "#0A0E16",
  border: "none",
  borderRadius: 10,
  padding: "12px 16px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};
