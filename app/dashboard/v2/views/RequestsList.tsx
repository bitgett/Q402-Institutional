"use client";

/**
 * RequestsList — the track half of Payment Requests, shown in
 * Activity -> Requests. A proper settlement-grade table (matching the
 * SettlementTable in ActivityView): Request · Recipient · Network · Status ·
 * Amount, with a copy-link action plus the on-chain tx + Trust Receipt links
 * once paid.
 *
 * Reads straight from /api/request (owner-scoped), so it shows every request
 * regardless of which key scope or source tag the settlement carried — the
 * settlement-ledger filter could miss a paid request (scope/source/timing);
 * this never does. Creating new requests lives in the Wallets right-rail card
 * (RequestComposerModal); this view is read + cancel only.
 */

import { useCallback, useEffect, useState } from "react";
import { v2, fs } from "../theme";
import { displayFont, shortAddr } from "../primitives";
import { explorerTxUrl, explorerLabel } from "@/app/lib/eip7702";
import type { ChainKey } from "@/app/lib/relayer";
import { getAuthCreds, clearAuthCache } from "@/app/lib/auth-client";

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
  receiptId?: string;
  sandbox: boolean;
}

// Chain colour + display name — same palette as ActivityView's CHAIN_META so a
// request row and a settlement row read identically.
const CHAIN_META: Record<string, { name: string; color: string }> = {
  bnb: { name: "BNB Chain", color: "#F0B90B" },
  eth: { name: "Ethereum", color: "#627EEA" },
  avax: { name: "Avalanche", color: "#E84142" },
  xlayer: { name: "X Layer", color: "#bcc6d6" },
  stable: { name: "Stable", color: v2.mint },
  mantle: { name: "Mantle", color: "#FFFFFF" },
  injective: { name: "Injective", color: "#0082FA" },
  monad: { name: "Monad", color: "#836EF9" },
  scroll: { name: "Scroll", color: "#EEB431" },
  arbitrum: { name: "Arbitrum", color: "#28A0F0" },
};
function chainName(c: string): string {
  return CHAIN_META[c]?.name ?? c.toUpperCase();
}
function chainColor(c: string): string {
  return CHAIN_META[c]?.color ?? v2.muted;
}

// Status → pill colour, on the dashboard palette (no standalone cyan): paid
// reads as a settled/success mint, open as an actionable yellow, terminal
// non-paid states stay muted.
const STATUS: Record<PublicRequest["status"], { color: string; label: string }> = {
  paid: { color: v2.mint, label: "Paid" },
  open: { color: v2.yellow, label: "Awaiting payment" },
  expired: { color: v2.muted, label: "Expired" },
  cancelled: { color: v2.muted, label: "Cancelled" },
};

const PAGE_SIZE = 50;

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function shortHash(h: string): string {
  return h ? `${h.slice(0, 8)}…${h.slice(-6)}` : "—";
}

export interface RequestsListProps {
  ownerAddress: string | null;
  signMessage: (message: string) => Promise<string | null>;
}

export function RequestsList({ ownerAddress, signMessage }: RequestsListProps) {
  const [requests, setRequests] = useState<PublicRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const payOrigin = typeof window !== "undefined" ? window.location.origin : "";

  const fetchPage = useCallback(
    async (pageOffset: number, append: boolean) => {
      if (!ownerAddress) return;
      setLoading(true);
      setLoadError(null);
      try {
        let auth = await getAuthCreds(ownerAddress, signMessage);
        if (!auth) {
          setLoading(false);
          return;
        }
        const url = (a: { nonce: string; signature: string }) =>
          `/api/request?address=${ownerAddress}&nonce=${encodeURIComponent(a.nonce)}&sig=${encodeURIComponent(a.signature)}&limit=${PAGE_SIZE}&offset=${pageOffset}`;
        let res = await fetch(url(auth));
        if (res.status === 401) {
          clearAuthCache(ownerAddress);
          auth = await getAuthCreds(ownerAddress, signMessage);
          if (!auth) {
            setLoading(false);
            return;
          }
          res = await fetch(url(auth));
        }
        if (!res.ok) {
          setLoadError("Could not load requests.");
          setLoading(false);
          return;
        }
        const data = (await res.json()) as { requests: PublicRequest[]; hasMore?: boolean };
        const incoming = data.requests ?? [];
        setRequests((prev) => (append ? [...prev, ...incoming] : incoming));
        setHasMore(!!data.hasMore);
        setOffset(pageOffset + PAGE_SIZE);
      } catch {
        setLoadError("Could not load requests.");
      } finally {
        setLoading(false);
      }
    },
    [ownerAddress, signMessage],
  );

  useEffect(() => {
    void fetchPage(0, false);
  }, [fetchPage]);

  const cancel = useCallback(
    async (id: string) => {
      if (!ownerAddress) return;
      const auth = await getAuthCreds(ownerAddress, signMessage);
      if (!auth) return;
      const res = await fetch(`/api/request/${id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: ownerAddress, nonce: auth.nonce, signature: auth.signature }),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { request?: PublicRequest };
        if (data.request) setRequests((prev) => prev.map((r) => (r.id === id ? (data.request as PublicRequest) : r)));
      }
    },
    [ownerAddress, signMessage],
  );

  function copyLink(id: string) {
    navigator.clipboard.writeText(`${payOrigin}/pay/${id}`).then(() => {
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1800);
    });
  }

  if (!ownerAddress) return <Empty text="Connect your wallet to see your payment requests." />;
  if (loadError) return <Empty text={loadError} tone="red" />;
  if (loading && requests.length === 0) return <Empty text="Loading requests…" />;
  if (requests.length === 0) {
    return (
      <Empty text="No payment requests yet. Create one from Wallets → Payment requests to get a shareable pay link." />
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", minWidth: 620, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${v2.line}` }}>
            <Th>Request</Th>
            <Th>Recipient</Th>
            <Th>Network</Th>
            <Th>Status</Th>
            <Th align="right">Amount</Th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r, i) => {
            const txUrl = r.paidTxHash ? explorerTxUrl(r.chain as ChainKey, r.paidTxHash) : "";
            const hasExplorer = txUrl.startsWith("http");
            return (
              <tr key={r.id} style={{ borderBottom: i === requests.length - 1 ? "none" : `1px solid rgba(255,255,255,.05)` }}>
                <Td>
                  <div style={{ fontSize: fs.cardTitle, color: v2.text, fontWeight: 500 }}>
                    {r.memo || "Payment request"}
                  </div>
                  <div style={{ fontSize: fs.body, color: v2.muted2, marginTop: 3, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
                    <span>{fmtDate(r.createdAt)}</span>
                    <Dot />
                    <button onClick={() => copyLink(r.id)} style={linkBtn}>
                      {copied === r.id ? "copied" : "copy link"}
                    </button>
                    {r.status === "paid" && hasExplorer && (
                      <>
                        <Dot />
                        <a
                          href={txUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`Open on ${explorerLabel(r.chain as ChainKey)}`}
                          style={{ color: v2.yellow, fontFamily: displayFont, textDecoration: "none" }}
                        >
                          {shortHash(r.paidTxHash!)} ↗
                        </a>
                      </>
                    )}
                    {r.status === "paid" && r.receiptId && (
                      <>
                        <Dot />
                        <a
                          href={`/receipt/${r.receiptId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: v2.mint, textDecoration: "none" }}
                        >
                          Receipt ↗
                        </a>
                      </>
                    )}
                    {r.status === "open" && (
                      <>
                        <Dot />
                        <button onClick={() => cancel(r.id)} style={{ ...linkBtn, color: v2.muted }}>
                          cancel
                        </button>
                      </>
                    )}
                  </div>
                </Td>
                <Td>
                  <span
                    style={{ fontSize: fs.base, color: v2.muted, fontFamily: displayFont }}
                    title={r.recipient}
                  >
                    {shortAddr(r.recipient)}
                  </span>
                </Td>
                <Td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: fs.base, color: v2.muted }}>
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: chainColor(r.chain), flexShrink: 0 }} />
                    {chainName(r.chain)}
                  </span>
                </Td>
                <Td>
                  <StatusPill status={r.status} />
                </Td>
                <Td align="right">
                  <span style={{ fontSize: fs.base, fontWeight: 600, fontFamily: displayFont }}>
                    {r.amount} <span style={{ color: v2.muted2, fontWeight: 400 }}>{r.token}</span>
                  </span>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {hasMore && (
        <div style={{ paddingTop: 16, textAlign: "center", borderTop: `1px solid ${v2.line}`, marginTop: 4 }}>
          <button onClick={() => fetchPage(offset, true)} disabled={loading} style={loadMoreBtn}>
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

function Dot() {
  return <span style={{ color: v2.muted2 }}>·</span>;
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      style={{
        textAlign: align,
        fontSize: fs.label,
        letterSpacing: ".12em",
        textTransform: "uppercase",
        fontWeight: 700,
        color: v2.muted2,
        padding: "0 13px 12px",
      }}
    >
      {children}
    </th>
  );
}
function Td({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return <td style={{ textAlign: align, padding: "14px 13px", verticalAlign: "middle" }}>{children}</td>;
}

function StatusPill({ status }: { status: PublicRequest["status"] }) {
  const { color, label } = STATUS[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: fs.label,
        fontWeight: 700,
        color,
        background: `${color}14`,
        border: `1px solid ${color}33`,
        padding: "5px 10px",
        borderRadius: 999,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: 999, background: color }} />
      {label}
    </span>
  );
}

function Empty({ text, tone }: { text: string; tone?: "red" }) {
  return (
    <div
      style={{
        padding: "40px 16px",
        textAlign: "center",
        fontSize: fs.body,
        color: tone === "red" ? v2.red : v2.muted,
        border: `1px dashed ${v2.line}`,
        borderRadius: 12,
        marginTop: 6,
        lineHeight: 1.5,
      }}
    >
      {text}
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: v2.yellow,
  fontSize: fs.body,
  cursor: "pointer",
  padding: 0,
  fontFamily: displayFont,
};

const loadMoreBtn: React.CSSProperties = {
  background: "rgba(255,255,255,.03)",
  border: `1px solid ${v2.line}`,
  borderRadius: 9,
  color: v2.text,
  fontSize: fs.body,
  fontWeight: 600,
  padding: "8px 14px",
  cursor: "pointer",
};
