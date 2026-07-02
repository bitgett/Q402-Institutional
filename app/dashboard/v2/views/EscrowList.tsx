"use client";

/**
 * EscrowList - the track + act half of the Escrow view. A settlement-grade
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
import { getAuthCreds, clearAuthCache, getActionAuth } from "@/app/lib/auth-client";
import { getEscrowInfo, buildEscrowActionTypedData, randomEscrowNonce } from "@/app/lib/escrow-sign";

/** Escrow actions a row can trigger. `lock` is only offered on agent-funded
 *  escrows (server-signed); owner-EOA escrows fund via an agent. */
type EscrowAction = "lock" | "release" | "dispute" | "refund";

interface PublicEscrow {
  id: string;
  onchainEscrowId: string;
  buyer: string;
  fundedBy: "owner" | "agent";
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

const PAGE_SIZE = 100;
const RESOLVE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // matches on-chain RESOLVE_WINDOW

/** Actionable vs settled buckets, for the left-rail filter + counts. */
const ACTIVE_STATUSES = new Set<PublicEscrow["status"]>(["pending", "open", "disputed"]);
function bucketOf(s: PublicEscrow["status"]): "active" | "history" {
  return ACTIVE_STATUSES.has(s) ? "active" : "history";
}
export type EscrowFilter = "active" | "history" | "all";
export interface EscrowCounts {
  active: number;
  history: number;
  total: number;
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function shortHash(h: string) {
  return h ? `${h.slice(0, 8)}…${h.slice(-6)}` : "-";
}

export interface EscrowListProps {
  ownerAddress: string | null;
  signMessage: (message: string) => Promise<string | null>;
  /** Bumped by the parent after a create so the list refetches. */
  refreshKey?: number;
  /** Opens the "New escrow" composer (empty-state CTA). */
  onCreate?: () => void;
  /** Show only actionable ("active") or settled ("history") escrows; default all. */
  filter?: EscrowFilter;
  /** Reports {active, history, total} after each fetch (for the rail badges). */
  onCounts?: (c: EscrowCounts) => void;
}

export function EscrowList({ ownerAddress, signMessage, refreshKey, onCreate, filter = "all", onCounts }: EscrowListProps) {
  const { signTypedData } = useWallet();
  const [escrows, setEscrows] = useState<PublicEscrow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Fund-moving actions take a two-tap confirm keyed by (id, action).
  const [confirming, setConfirming] = useState<{ id: string; action: EscrowAction } | null>(null);
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

  // Report status counts to the parent (left-rail badges). Counts cover the
  // whole loaded set regardless of the display filter.
  useEffect(() => {
    if (!onCounts) return;
    let active = 0;
    for (const e of escrows) if (bucketOf(e.status) === "active") active++;
    onCounts({ active, history: escrows.length - active, total: escrows.length });
  }, [escrows, onCounts]);

  const runAction = useCallback(
    async (esc: PublicEscrow, action: EscrowAction) => {
      setActionErr(null);
      setConfirming(null);
      setBusy(esc.id);
      try {
        let body: string;
        if (action === "refund") {
          // Permissionless after the timeout / resolve window - no signature.
          body = "{}";
        } else if (esc.fundedBy === "agent") {
          // Agent-Wallet-funded: the SERVER signs (lock/release/dispute) for the
          // wallet. The owner authorizes with a fresh intent signature (a plain
          // personal_sign, so no chain switch + no browser 7702 needed). walletId
          // == the buyer address for an agent-funded escrow.
          if (!ownerAddress) {
            setActionErr({ id: esc.id, msg: "Connect your wallet." });
            setBusy(null);
            return;
          }
          const intent = {
            escrowId: esc.id, onchainEscrowId: esc.onchainEscrowId, chain: esc.chain,
            seller: esc.seller, amount: esc.amount, walletId: esc.buyer,
          };
          const auth = await getActionAuth(ownerAddress, `escrow_${action}`, intent, signMessage);
          if (!auth) {
            setActionErr({ id: esc.id, msg: "Approve the action in your wallet (or it was rejected)." });
            setBusy(null);
            return;
          }
          body = JSON.stringify({ address: ownerAddress, challenge: auth.challenge, signature: auth.signature });
        } else {
          // Owner-EOA escrow: the buyer signs an EIP-712 vault message directly.
          // (lock is never offered here - the browser can't sign the 7702 auth.)
          const info = await getEscrowInfo(esc.chain);
          const nonce = randomEscrowNonce();
          const deadline = String(Math.floor(Date.now() / 1000) + 900);
          const typedData = buildEscrowActionTypedData(action as "release" | "dispute", info, esc.onchainEscrowId, nonce, deadline);
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
    [signTypedData, ownerAddress, signMessage, fetchPage],
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

  const displayed = filter === "all" ? escrows : escrows.filter((e) => bucketOf(e.status) === filter);
  if (displayed.length === 0) {
    const isHistory = filter === "history";
    return (
      <div style={{ padding: "44px 20px", textAlign: "center" }}>
        <div
          style={{
            width: 56, height: 56, borderRadius: 16, margin: "0 auto",
            background: "rgba(245,197,24,.08)", border: `1px solid ${v2.yellow}2e`,
            display: "grid", placeItems: "center", color: v2.yellow,
          }}
        >
          <VaultGlyph size={26} />
        </div>
        <div style={{ color: v2.text, fontFamily: displayFont, fontSize: fs.title, fontWeight: 600, marginTop: 16 }}>
          {isHistory ? "Nothing settled yet" : filter === "active" ? "No active escrows" : "No escrows yet"}
        </div>
        <div style={{ color: v2.muted, fontSize: fs.base, lineHeight: 1.55, maxWidth: 380, margin: "6px auto 0" }}>
          {isHistory
            ? "Released, refunded, and disputed escrows will show up here once they settle."
            : "Create one to hold funds safely until the work is delivered, then release to the seller or get refunded."}
        </div>
        {!isHistory && onCreate && (
          <button onClick={onCreate} style={emptyCta}>Create {filter === "active" ? "an" : "your first"} escrow</button>
        )}
      </div>
    );
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
          {displayed.map((e, i) => {
            const settleUrl = e.settleTxHash ? explorerTx(e.chain, e.settleTxHash) : "";
            const lockUrl = e.lockTxHash ? explorerTx(e.chain, e.lockTxHash) : "";
            const now = Date.now();
            const deadlineMs = new Date(e.releaseDeadline).getTime();
            const refundReady =
              (e.status === "open" && now >= deadlineMs) ||
              (e.status === "disputed" && now >= deadlineMs + RESOLVE_WINDOW_MS);
            return (
              <tr key={e.id} style={{ borderBottom: i === displayed.length - 1 ? "none" : `1px solid rgba(255,255,255,.05)` }}>
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
                    {lockUrl && (
                      <>
                        <Dot />
                        <a href={lockUrl} target="_blank" rel="noopener noreferrer" title="Funding (lock) transaction" style={{ color: v2.mint, fontFamily: displayFont, textDecoration: "none" }}>
                          lock {shortHash(e.lockTxHash!)} ↗
                        </a>
                      </>
                    )}
                    {settleUrl && (
                      <>
                        <Dot />
                        <a href={settleUrl} target="_blank" rel="noopener noreferrer" title="Settlement (release/refund) transaction" style={{ color: v2.yellow, fontFamily: displayFont, textDecoration: "none" }}>
                          settle {shortHash(e.settleTxHash!)} ↗
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
  confirming: EscrowAction | null;
  onArm: (a: EscrowAction) => void;
  onCancel: () => void;
  onConfirm: (a: EscrowAction) => void;
}) {
  if (busy) return <span style={{ fontSize: fs.body, color: v2.muted2 }}>Working…</span>;

  if (confirming) {
    const label =
      confirming === "release" ? "Release funds?"
      : confirming === "refund" ? "Refund to you?"
      : confirming === "lock" ? "Fund the escrow?"
      : "Open dispute?";
    const tone = confirming === "release" || confirming === "lock" ? v2.mint : confirming === "refund" ? v2.yellow : v2.red;
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
        <span style={{ color: v2.muted2, fontSize: fs.body }}>{label}</span>
        <button onClick={() => onConfirm(confirming)} style={{ ...linkBtn, color: tone }}>
          yes
        </button>
        <button onClick={onCancel} style={{ ...linkBtn, color: v2.muted }}>
          no
        </button>
      </span>
    );
  }

  // pending - an agent-funded escrow funds right here (server signs the lock);
  // an owner-EOA escrow needs an agent (the browser can't sign the 7702 lock).
  if (esc.status === "pending") {
    return esc.fundedBy === "agent" ? (
      <button onClick={() => onArm("lock")} style={primaryPill}>
        Fund
      </button>
    ) : (
      <span title="Fund with a Q402 agent (q402_escrow_lock)" style={{ fontSize: fs.body, color: v2.muted2 }}>Fund via agent</span>
    );
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

  return <span style={{ color: v2.muted2 }}>-</span>;
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
    <div style={{ padding: "40px 16px", textAlign: "center", fontSize: fs.base, color: tone === "red" ? v2.red : v2.muted, lineHeight: 1.5 }}>
      {text}
    </div>
  );
}

/** Vault / lock-in-shield glyph for the empty state (24-viewBox, round caps). */
function VaultGlyph({ size = 24, color }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? "currentColor"} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="9" width="16" height="11" rx="2" />
      <path d="M8 9V6.5a4 4 0 0 1 8 0V9" />
      <circle cx="12" cy="14" r="1.6" />
      <path d="M12 15.6V17.5" />
    </svg>
  );
}

const emptyCta: React.CSSProperties = {
  marginTop: 18,
  background: v2.yellow,
  color: v2.actionText,
  border: "none",
  borderRadius: 10,
  padding: "10px 18px",
  fontSize: fs.base,
  fontWeight: 700,
  cursor: "pointer",
  boxShadow: `0 8px 24px ${v2.yellow}2e`,
};

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
