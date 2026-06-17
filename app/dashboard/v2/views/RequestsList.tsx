"use client";

/**
 * RequestsList — the track half of Payment Requests, shown in
 * Activity -> Requests. Lists the owner's invoices (open / paid / expired /
 * cancelled) with a copy-link and a cancel action, paged via "Load more".
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
  sandbox: boolean;
}

const CHAIN_LABEL: Record<string, string> = {
  bnb: "BNB Chain", eth: "Ethereum", avax: "Avalanche", xlayer: "X Layer", stable: "Stable",
  mantle: "Mantle", injective: "Injective", monad: "Monad", scroll: "Scroll", arbitrum: "Arbitrum",
};

const STATUS_COLOR: Record<PublicRequest["status"], string> = {
  open: v2.yellow,
  paid: v2.cyan,
  expired: v2.muted,
  cancelled: v2.muted,
};
const STATUS_LABEL: Record<PublicRequest["status"], string> = {
  open: "Awaiting payment",
  paid: "Paid",
  expired: "Expired",
  cancelled: "Cancelled",
};

const PAGE_SIZE = 50;

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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

  if (!ownerAddress) {
    return <Empty text="Connect your wallet to see your payment requests." />;
  }
  if (loadError) {
    return <Empty text={loadError} tone="red" />;
  }
  if (loading && requests.length === 0) {
    return <Empty text="Loading requests…" />;
  }
  if (requests.length === 0) {
    return (
      <Empty text="No payment requests yet. Create one from Wallets → Payment requests to get a shareable pay link." />
    );
  }

  return (
    <div>
      {requests.map((r, i) => (
        <div
          key={r.id}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(140px,1.4fr) 1fr auto auto",
            alignItems: "center",
            gap: 14,
            padding: "14px 2px",
            borderTop: i === 0 ? "none" : `1px solid rgba(255,255,255,.05)`,
          }}
        >
          {/* amount + memo */}
          <div>
            <div style={{ fontSize: fs.cardTitle, fontWeight: 600, fontFamily: displayFont }}>
              {r.amount} <span style={{ color: v2.muted2, fontWeight: 400, fontSize: fs.body }}>{r.token}</span>
            </div>
            <div style={{ color: v2.muted, fontSize: fs.micro, marginTop: 2 }}>
              {CHAIN_LABEL[r.chain] ?? r.chain} · {r.memo ? r.memo : `to ${shortAddr(r.recipient)}`}
            </div>
          </div>

          {/* status */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: STATUS_COLOR[r.status] }} />
            <span style={{ fontSize: fs.body, color: STATUS_COLOR[r.status] }}>{STATUS_LABEL[r.status]}</span>
          </div>

          {/* created */}
          <div style={{ color: v2.muted, fontSize: fs.micro, whiteSpace: "nowrap" }}>{fmtDate(r.createdAt)}</div>

          {/* actions */}
          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
            <button onClick={() => copyLink(r.id)} style={ghostBtn}>
              {copied === r.id ? "copied" : "copy link"}
            </button>
            {r.status === "open" && (
              <button onClick={() => cancel(r.id)} style={{ ...ghostBtn, color: v2.muted }}>
                cancel
              </button>
            )}
          </div>
        </div>
      ))}

      {hasMore && (
        <div style={{ paddingTop: 16, textAlign: "center", borderTop: `1px solid ${v2.line}` }}>
          <button onClick={() => fetchPage(offset, true)} disabled={loading} style={loadMoreBtn}>
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
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

const ghostBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: v2.cyan,
  fontSize: fs.body,
  cursor: "pointer",
  padding: 0,
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
