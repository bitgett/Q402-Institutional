"use client";

/**
 * RequestsView — the "Payment Requests" workspace (v2 view id="requests").
 *
 * The receive side of Q402: create a request (invoice) for a fixed amount on
 * a chain, get a shareable /pay link, and watch it flip to paid. Anyone can
 * fulfill it - a human via the link, or another agent via the q402_request_pay
 * MCP tool (gasless). All reads/writes auth with the same getAuthCreds session
 * handshake the other views use; create + cancel hit /api/request[/[id]/cancel].
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Surface, V2AccentScope, SectionHead, LinkButton, displayFont, shortAddr } from "../primitives";
import { v2, fs } from "../theme";
import type { Scope } from "../theme";
import { getAuthCreds, clearAuthCache } from "@/app/lib/auth-client";

export interface RequestsViewProps {
  ownerAddress: string | null;
  signMessage: (message: string) => Promise<string | null>;
  scope: Scope;
}

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
const ALL_CHAINS = Object.keys(CHAIN_LABEL);

const STATUS_COLOR: Record<PublicRequest["status"], string> = {
  open: v2.yellow,
  paid: v2.cyan,
  expired: v2.muted,
  cancelled: v2.muted,
};
const STATUS_LABEL: Record<PublicRequest["status"], string> = {
  open: "Awaiting payment", paid: "Paid", expired: "Expired", cancelled: "Cancelled",
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function RequestsView({ ownerAddress, signMessage, scope }: RequestsViewProps) {
  const [requests, setRequests] = useState<PublicRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<"USDC" | "USDT">("USDT");
  const [chain, setChain] = useState("bnb");
  const [recipient, setRecipient] = useState("");
  const [memo, setMemo] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Trial scope is BNB-only, mirroring the rest of the dashboard.
  const chainOptions = useMemo(() => (scope === "trial" ? ["bnb"] : ALL_CHAINS), [scope]);
  useEffect(() => {
    if (!chainOptions.includes(chain)) setChain(chainOptions[0]);
  }, [chainOptions, chain]);

  const payOrigin = typeof window !== "undefined" ? window.location.origin : "";

  const load = useCallback(async () => {
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
        `/api/request?address=${ownerAddress}&nonce=${encodeURIComponent(a.nonce)}&sig=${encodeURIComponent(a.signature)}`;
      let res = await fetch(url(auth));
      if (res.status === 401) {
        // Stale session nonce — clear + re-sign once.
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
      const data = (await res.json()) as { requests: PublicRequest[] };
      setRequests(data.requests ?? []);
    } catch {
      setLoadError("Could not load requests.");
    } finally {
      setLoading(false);
    }
  }, [ownerAddress, signMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async () => {
    if (!ownerAddress) return;
    setFormError(null);
    if (!/^\d+(\.\d+)?$/.test(amount) || !(Number(amount) > 0)) {
      setFormError("Enter a positive amount.");
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
      setFormError("Enter a valid recipient address (0x...).");
      return;
    }
    setCreating(true);
    try {
      const auth = await getAuthCreds(ownerAddress, signMessage);
      if (!auth) {
        setCreating(false);
        return;
      }
      const res = await fetch("/api/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: ownerAddress,
          nonce: auth.nonce,
          signature: auth.signature,
          chain,
          token,
          amount,
          recipient,
          ...(memo.trim() ? { memo: memo.trim() } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { request?: PublicRequest; error?: string };
      if (!res.ok || !data.request) {
        setFormError(data.error ?? "Could not create request.");
        setCreating(false);
        return;
      }
      setRequests((prev) => [data.request as PublicRequest, ...prev]);
      setAmount("");
      setMemo("");
      setShowForm(false);
    } catch {
      setFormError("Could not create request.");
    } finally {
      setCreating(false);
    }
  }, [ownerAddress, signMessage, amount, recipient, chain, token, memo]);

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

  // Prefill recipient with the connected owner once known.
  useEffect(() => {
    if (ownerAddress && !recipient) setRecipient(ownerAddress);
  }, [ownerAddress, recipient]);

  return (
    <V2AccentScope>
      <SectionHead
        title="Payment Requests"
        meta={requests.length > 0 ? `${requests.length} total` : undefined}
        action={
          ownerAddress ? (
            <LinkButton onClick={() => setShowForm((s) => !s)}>{showForm ? "Close" : "New request"}</LinkButton>
          ) : undefined
        }
      />

      {!ownerAddress && (
        <Surface style={{ padding: 24, color: v2.muted, fontSize: fs.base }}>
          Connect your wallet to create and track payment requests.
        </Surface>
      )}

      {ownerAddress && showForm && (
        <Surface style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 12, marginBottom: 12 }}>
            <Field label="Amount">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="5.00"
                inputMode="decimal"
                style={inputStyle}
              />
            </Field>
            <Field label="Token">
              <select value={token} onChange={(e) => setToken(e.target.value as "USDC" | "USDT")} style={inputStyle}>
                <option value="USDT">USDT</option>
                <option value="USDC">USDC</option>
              </select>
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, marginBottom: 12 }}>
            <Field label="Network">
              <select value={chain} onChange={(e) => setChain(e.target.value)} style={inputStyle}>
                {chainOptions.map((c) => (
                  <option key={c} value={c}>
                    {CHAIN_LABEL[c]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Receive to">
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="0x..."
                spellCheck={false}
                style={{ ...inputStyle, fontFamily: "var(--font-jetbrains), monospace", fontSize: fs.body }}
              />
            </Field>
            <Field label="Memo (optional)">
              <input
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="Invoice 1024 / API usage"
                maxLength={200}
                style={inputStyle}
              />
            </Field>
          </div>
          {formError && <div style={{ color: v2.red, fontSize: fs.body, marginBottom: 10 }}>{formError}</div>}
          <button onClick={create} disabled={creating} style={primaryBtn(creating)}>
            {creating ? "Creating..." : "Create request"}
          </button>
        </Surface>
      )}

      {ownerAddress && (
        <Surface style={{ padding: 0, overflow: "hidden" }}>
          {loading && requests.length === 0 && (
            <div style={{ padding: 24, color: v2.muted, fontSize: fs.base }}>Loading...</div>
          )}
          {loadError && <div style={{ padding: 24, color: v2.red, fontSize: fs.base }}>{loadError}</div>}
          {!loading && !loadError && requests.length === 0 && (
            <div style={{ padding: 24, color: v2.muted, fontSize: fs.base }}>
              No requests yet. Create one to get a shareable pay link.
            </div>
          )}
          {requests.map((r, i) => (
            <div
              key={r.id}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(140px,1.4fr) 1fr auto auto",
                alignItems: "center",
                gap: 14,
                padding: "14px 18px",
                borderTop: i === 0 ? "none" : `1px solid ${v2.line}`,
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
        </Surface>
      )}
    </V2AccentScope>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ display: "block", color: v2.muted, fontSize: fs.label, marginBottom: 6 }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "rgba(255,255,255,.03)",
  border: `1px solid ${v2.line}`,
  borderRadius: 10,
  padding: "10px 12px",
  color: v2.text,
  fontSize: fs.base,
  outline: "none",
};

function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    background: v2.yellow,
    color: v2.actionText,
    border: "none",
    borderRadius: 10,
    padding: "11px 16px",
    fontSize: fs.base,
    fontWeight: 600,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}

const ghostBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: v2.yellow,
  fontSize: fs.body,
  cursor: "pointer",
  padding: 0,
};
