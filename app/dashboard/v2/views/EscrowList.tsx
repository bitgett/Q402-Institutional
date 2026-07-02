"use client";

/**
 * EscrowList — the track + act half of the Escrow view. A settlement-grade
 * table (Escrow · Seller · Network · Status · Amount · Action) over the owner's
 * escrows (GET /api/escrow, owner-sig).
 *
 * Actions are gasless and signature-authorized:
 *   - release  buyer signs EscrowRelease (vault domain) -> pays the seller
 *   - dispute  a party signs EscrowDispute -> freezes for the arbiter
 *   - refund   permissionless after the timeout (open) / resolve window
 *              (disputed) -> returns to the buyer; no signature
 * Funding (lock) is NOT here: it needs an EIP-7702 authorization injected
 * wallets can't sign, so a `pending` escrow shows a "fund via agent" hint
 * instead (q402_escrow_lock), matching the gasless-pay agent path.
 */

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@/app/context/WalletContext";
import { v2, fs } from "../theme";
import { displayFont, shortAddr } from "../primitives";
import { getAuthCreds, clearAuthCache } from "@/app/lib/auth-client";
import { getEscrowInfo, buildEscrowActionTypedData, randomEscrowNonce, type EscrowActionKind } from "@/app/lib/escrow-sign";

interface PublicEscrow {
  id: string;
  onchainEscrowId: string;
  buyer: string;
  seller: string;
  chain: string;
  token: "USDC" | "USDT";
  amount: string;
  arbiter?: string;
  memo?: string;
  releaseDeadline: string;
  status: "pending" | "open" | "disputed" | "released" | "refunded" | "cancelled" | "expired";
  createdAt: string;
  lockTxHash?: string;
  settleTxHash?: string;
  disputeTxHash?: string;
  receiptId?: string;
  sandbox: boolean;
}

const CHAIN_META: Record<string, { name: string; color: string; explorer: string }> = {
  bnb: { name: "BNB Chain", color: "#F0B90B", explorer: "https://bscscan.com/tx/" },
};
function chainName(c: string) {
  return CHAIN_META[c]?.name ?? c.toUpperCase();
}
function chainColor(c: string) {
  return CHAIN_META[c]?.color ?? v2.muted;
}
function explorerTx(c: string, h: string) {
  const base = CHAIN_META[c]?.explorer;
  return base && h ? base + h : "";
}

const STATUS: Record<PublicEscrow["status"], { color: string; label: string }> = {
  pending: { color: v2.yellow, label: "Pending funding" },
  open: { color: v2.mint, label: "Funded" },
  disputed: { color: "#ff9d5c", label: "Disputed" },
  released: { color: v2.mint, label: "Released" },
  refunded: { color: v2.muted, label: "Refunded" },
  cancelled: { color: v2.muted, label: "Cancelled" },
  expired: { color: v2.muted, label: "Expired" },
};

const PAGE_SIZE = 50;
const RESOLVE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // matches on-chain RESOLVE_WINDOW

function fmtDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function shortHash(h: string) {
  return h ? `${h.slice(0, 8)}…${h.slice(-6)}` : "—";
}

export interface EscrowListProps {
  ownerAddress: string | null;
  signMessage: (message: string) => Promise<string | null>;
  /** Bumped by the parent after a create so the list refetches. */
  refreshKey?: number;
}

export function EscrowList({ ownerAddress, signMessage, refreshKey }: EscrowListProps) {
  const { signTypedData } = useWallet();
  const [escrows, setEscrows] = useState<PublicEscrow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Fund-moving actions take a two-tap confirm keyed by (id, action).
  const [confirming, setConfirming] = useState<{ id: string; action: EscrowActionKind | "refund" } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<{ id: string; msg: string } | null>(null);

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
          `/api/escrow?address=${ownerAddress}&nonce=${encodeURIComponent(a.nonce)}&sig=${encodeURIComponent(a.signature)}&limit=${PAGE_SIZE}&offset=${pageOffset}`;
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
          setLoadError("Could not load escrows.");
          setLoading(false);
          return;
        }
        const data = (await res.json()) as { escrows: PublicEscrow[]; hasMore?: boolean };
        const incoming = data.escrows ?? [];
        setEscrows((prev) => (append ? [...prev, ...incoming] : incoming));
        setHasMore(!!data.hasMore);
        setOffset(pageOffset + PAGE_SIZE);
      } catch {
        setLoadError("Could not load escrows.");
      } finally {
        setLoading(false);
      }
    },
    [ownerAddress, signMessage],
  );

  useEffect(() => {
    void fetchPage(0, false);
  }, [fetchPage, refreshKey]);

  const runAction = useCallback(
    async (esc: PublicEscrow, action: EscrowActionKind | "refund") => {
      setActionErr(null);
      setConfirming(null);
      setBusy(esc.id);
      try {
        let body: string;
        if (action === "refund") {
          body = "{}";
        } else {
          // release | dispute — sign an EIP-712 vault message with the owner wallet.
          const info = await getEscrowInfo(esc.chain);
          const nonce = randomEscrowNonce();
          const deadline = String(Math.floor(Date.now() / 1000) + 900);
          const typedData = buildEscrowActionTypedData(action, info, esc.onchainEscrowId, nonce, deadline);
          const sig = await signTypedData(typedData);
          if (!sig) {
            setActionErr({ id: esc.id, msg: "Wallet signature needed (or was rejected)." });
            setBusy(null);
            return;
          }
          body = JSON.stringify({ sig, nonce, deadline });
        }
        const res = await fetch(`/api/escrow/${esc.id}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setActionErr({ id: esc.id, msg: data.error ?? `Could not ${action}.` });
          setBusy(null);
          return;
        }
        // Refetch so the row reflects the new on-chain state + settle tx.
        await fetchPage(0, false);
      } catch (e) {
        setActionErr({ id: esc.id, msg: e instanceof Error ? e.message : `Could not ${action}.` });
      } finally {
        setBusy(null);
      }
    },
    [signTypedData, fetchPage],
  );

  function copyId(id: string) {
    navigator.clipboard.writeText(id).then(() => {
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1800);
    });
  }

  if (!ownerAddress) return <Empty text="Connect your wallet to see your escrows." />;
  if (loadError) return <Empty text={loadError} tone="red" />;
  if (loading && escrows.length === 0) return <Empty text="Loading escrows…" />;
  if (escrows.length === 0) {
    return <Empty text="No escrows yet. Create one to hold funds until a deliverable is met, then release or dispute." />;
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", minWidth: 720, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${v2.line}` }}>
            <Th>Escrow</Th>
            <Th>Seller</Th>
            <Th>Network</Th>
            <Th>Status</Th>
            <Th align="right">Amount</Th>
            <Th align="right">Action</Th>
          </tr>
        </thead>
        <tbody>
          {escrows.map((e, i) => {
            const settleUrl = e.settleTxHash ? explorerTx(e.chain, e.settleTxHash) : "";
            const now = Date.now();
            const deadlineMs = new Date(e.releaseDeadline).getTime();
            const refundReady =
              (e.status === "open" && now >= deadlineMs) ||
              (e.status === "disputed" && now >= deadlineMs + RESOLVE_WINDOW_MS);
            return (
              <tr key={e.id} style={{ borderBottom: i === escrows.length - 1 ? "none" : `1px solid rgba(255,255,255,.05)` }}>
                <Td>
                  <div style={{ fontSize: fs.cardTitle, color: v2.text, fontWeight: 500 }}>{e.memo || "Escrow"}</div>
                  <div style={{ fontSize: fs.body, color: v2.muted2, marginTop: 3, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
                    <span>{fmtDate(e.createdAt)}</span>
                    <Dot />
                    <button onClick={() => copyId(e.id)} style={linkBtn}>
                      {copied === e.id ? "copied" : "copy id"}
                    </button>
                    {e.arbiter && (
                      <>
                        <Dot />
                        <span title={`Arbiter ${e.arbiter}`} style={{ color: v2.muted2 }}>
                          arbiter {shortAddr(e.arbiter)}
                        </span>
                      </>
                    )}
                    {settleUrl && (
                      <>
                        <Dot />
                        <a href={settleUrl} target="_blank" rel="noopener noreferrer" style={{ color: v2.yellow, fontFamily: displayFont, textDecoration: "none" }}>
                          {shortHash(e.settleTxHash!)} ↗
                        </a>
                      </>
                    )}
                    {e.receiptId && (
                      <>
                        <Dot />
                        <a href={`/receipt/${e.receiptId}`} target="_blank" rel="noopener noreferrer" style={{ color: v2.mint, textDecoration: "none" }}>
                          Receipt ↗
                        </a>
                      </>
                    )}
                    {actionErr?.id === e.id && (
                      <>
                        <Dot />
                        <span style={{ color: v2.red }}>{actionErr.msg}</span>
                      </>
                    )}
                  </div>
                </Td>
                <Td>
                  <span style={{ fontSize: fs.base, color: v2.muted, fontFamily: displayFont }} title={e.seller}>
                    {shortAddr(e.seller)}
                  </span>
                </Td>
                <Td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: fs.base, color: v2.muted }}>
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: chainColor(e.chain), flexShrink: 0 }} />
                    {chainName(e.chain)}
                  </span>
                </Td>
                <Td>
                  <StatusPill status={e.status} />
                </Td>
                <Td align="right">
                  <span style={{ fontSize: fs.base, fontWeight: 600, fontFamily: displayFont }}>
                    {e.amount} <span style={{ color: v2.muted2, fontWeight: 400 }}>{e.token}</span>
                  </span>
                </Td>
                <Td align="right">
                  <ActionCell
                    esc={e}
                    refundReady={refundReady}
                    busy={busy === e.id}
                    confirming={confirming?.id === e.id ? confirming.action : null}
                    onArm={(action) => {
                      setActionErr(null);
                      setConfirming({ id: e.id, action });
                    }}
                    onCancel={() => setConfirming(null)}
                    onConfirm={(action) => runAction(e, action)}
                  />
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

function ActionCell({
  esc,
  refundReady,
  busy,
  confirming,
  onArm,
  onCancel,
  onConfirm,
}: {
  esc: PublicEscrow;
  refundReady: boolean;
  busy: boolean;
  confirming: EscrowActionKind | "refund" | null;
  onArm: (a: EscrowActionKind | "refund") => void;
  onCancel: () => void;
  onConfirm: (a: EscrowActionKind | "refund") => void;
}) {
  if (busy) return <span style={{ fontSize: fs.body, color: v2.muted2 }}>Working…</span>;

  if (confirming) {
    const label = confirming === "release" ? "Release funds?" : confirming === "refund" ? "Refund to you?" : "Open dispute?";
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
        <span style={{ color: v2.muted2, fontSize: fs.body }}>{label}</span>
        <button onClick={() => onConfirm(confirming)} style={{ ...linkBtn, color: confirming === "release" ? v2.mint : confirming === "refund" ? v2.yellow : v2.red }}>
          yes
        </button>
        <button onClick={onCancel} style={{ ...linkBtn, color: v2.muted }}>
          no
        </button>
      </span>
    );
  }

  // pending — funding is an agent step (browser can't sign the 7702 lock).
  if (esc.status === "pending") {
    return <span title="Fund with a Q402 agent (q402_escrow_lock)" style={{ fontSize: fs.body, color: v2.muted2 }}>Fund via agent</span>;
  }

  if (esc.status === "open") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button onClick={() => onArm("release")} style={primaryPill}>
          Release
        </button>
        {esc.arbiter && (
          <button onClick={() => onArm("dispute")} style={ghostPill}>
            Dispute
          </button>
        )}
        {refundReady && (
          <button onClick={() => onArm("refund")} style={ghostPill}>
            Refund
          </button>
        )}
      </span>
    );
  }

  if (esc.status === "disputed") {
    return refundReady ? (
      <button onClick={() => onArm("refund")} style={primaryPill}>
        Refund
      </button>
    ) : (
      <span style={{ fontSize: fs.body, color: v2.muted2 }}>Arbiter resolving</span>
    );
  }

  return <span style={{ color: v2.muted2 }}>—</span>;
}

function Dot() {
  return <span style={{ color: v2.muted2 }}>·</span>;
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th style={{ textAlign: align, fontSize: fs.label, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 700, color: v2.muted2, padding: "0 13px 12px" }}>
      {children}
    </th>
  );
}
function Td({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return <td style={{ textAlign: align, padding: "14px 13px", verticalAlign: "middle" }}>{children}</td>;
}

function StatusPill({ status }: { status: PublicEscrow["status"] }) {
  const { color, label } = STATUS[status];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: fs.label, fontWeight: 700, color, background: `${color}14`, border: `1px solid ${color}33`, padding: "5px 10px", borderRadius: 999, whiteSpace: "nowrap" }}>
      <span style={{ width: 5, height: 5, borderRadius: 999, background: color }} />
      {label}
    </span>
  );
}

function Empty({ text, tone }: { text: string; tone?: "red" }) {
  return (
    <div style={{ padding: "40px 16px", textAlign: "center", fontSize: fs.body, color: tone === "red" ? v2.red : v2.muted, border: `1px dashed ${v2.line}`, borderRadius: 12, marginTop: 6, lineHeight: 1.5 }}>
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

const primaryPill: React.CSSProperties = {
  background: v2.yellow,
  color: v2.actionText,
  border: "none",
  borderRadius: 8,
  padding: "6px 12px",
  fontSize: fs.body,
  fontWeight: 700,
  cursor: "pointer",
};

const ghostPill: React.CSSProperties = {
  background: "rgba(255,255,255,.04)",
  border: `1px solid ${v2.line}`,
  borderRadius: 8,
  padding: "6px 12px",
  fontSize: fs.body,
  fontWeight: 600,
  color: v2.text,
  cursor: "pointer",
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
