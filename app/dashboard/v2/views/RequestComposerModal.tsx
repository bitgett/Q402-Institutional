"use client";

/**
 * RequestComposerModal — the "New request" popup.
 *
 * The create half of Payment Requests, surfaced as a modal from the Wallets
 * right-rail card (mirrors the other wallet actions: Send / Receive / Batch all
 * open a popup). On success it shows the shareable /pay link to copy. The
 * resulting invoices are tracked in Activity -> Requests (RequestsList), not
 * here — this modal is purely the action.
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { v2, fs } from "../theme";
import { displayFont, shortAddr } from "../primitives";
import type { Scope } from "../theme";
import { getAuthCreds } from "@/app/lib/auth-client";

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
  sandbox: boolean;
}

const CHAIN_LABEL: Record<string, string> = {
  bnb: "BNB Chain", eth: "Ethereum", avax: "Avalanche", xlayer: "X Layer", stable: "Stable",
  mantle: "Mantle", injective: "Injective", monad: "Monad", scroll: "Scroll", arbitrum: "Arbitrum",
};
const ALL_CHAINS = Object.keys(CHAIN_LABEL);

export interface RequestComposerModalProps {
  ownerAddress: string | null;
  signMessage: (message: string) => Promise<string | null>;
  scope: Scope;
  /** The active Agent Wallet, so "Receive to" can offer it alongside the owner
   *  EOA instead of making the user paste an address. */
  agentWallet?: { address: string; label?: string | null };
  onClose: () => void;
  /** Fired with the created request so a parent list can refresh if it wants. */
  onCreated?: (req: PublicRequest) => void;
}

export function RequestComposerModal({
  ownerAddress,
  signMessage,
  scope,
  agentWallet,
  onClose,
  onCreated,
}: RequestComposerModalProps) {
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<"USDC" | "USDT">("USDT");
  const [chain, setChain] = useState("bnb");
  // "Receive to" presets: the active Agent Wallet (default — you're billing
  // into it) and the owner EOA. Deduped so the two never collide.
  const recipientOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    if (agentWallet?.address) {
      opts.push({
        value: agentWallet.address,
        label: `${agentWallet.label?.trim() || "Agent wallet"} · ${shortAddr(agentWallet.address)}`,
      });
    }
    if (ownerAddress && ownerAddress.toLowerCase() !== agentWallet?.address?.toLowerCase()) {
      opts.push({ value: ownerAddress, label: `Owner wallet (EOA) · ${shortAddr(ownerAddress)}` });
    }
    return opts;
  }, [agentWallet, ownerAddress]);
  const [recipient, setRecipient] = useState(agentWallet?.address ?? ownerAddress ?? "");
  const [memo, setMemo] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<PublicRequest | null>(null);
  const [copied, setCopied] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Trial scope is BNB-only, mirroring the rest of the dashboard.
  const chainOptions = useMemo(() => (scope === "trial" ? ["bnb"] : ALL_CHAINS), [scope]);
  useEffect(() => {
    if (!chainOptions.includes(chain)) setChain(chainOptions[0]);
  }, [chainOptions, chain]);

  const payOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const payUrl = created ? `${payOrigin}/pay/${created.id}` : "";

  async function create() {
    if (!ownerAddress) return;
    setFormError(null);
    if (!/^\d+(\.\d+)?$/.test(amount) || !(Number(amount) > 0)) {
      setFormError("Enter a positive amount.");
      return;
    }
    if (Number(amount) > 1_000_000) {
      setFormError("Amount exceeds the 1,000,000 maximum.");
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
      setCreated(data.request);
      onCreated?.(data.request);
    } catch {
      setFormError("Could not create request.");
    } finally {
      setCreating(false);
    }
  }

  function copy() {
    if (!payUrl) return;
    navigator.clipboard.writeText(payUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  if (!mounted) return null;

  return createPortal(
    <div onClick={onClose} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={card}>
        <button onClick={onClose} style={closeBtn} aria-label="Close">
          ×
        </button>

        <div style={eyebrow}>Receive · invoice</div>
        <div style={title}>{created ? "Request created" : "New payment request"}</div>

        {created ? (
          <div style={{ marginTop: 14 }}>
            <div style={{ color: v2.muted, fontSize: fs.body, lineHeight: 1.5, marginBottom: 12 }}>
              Request for{" "}
              <b style={{ color: v2.text }}>
                {created.amount} {created.token}
              </b>{" "}
              on {CHAIN_LABEL[created.chain] ?? created.chain} is live. Share this link — a person can
              pay it from a browser, or a Q402 agent settles it gaslessly.
            </div>
            <div style={linkRow}>
              <span style={linkText}>{payUrl}</span>
              <button onClick={copy} style={ghostBtn}>
                {copied ? "copied" : "copy"}
              </button>
            </div>
            <div style={{ color: v2.muted2, fontSize: fs.label, marginTop: 10 }}>
              Track it in Activity → Requests.
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button
                onClick={() => {
                  setCreated(null);
                  setAmount("");
                  setMemo("");
                }}
                style={secondaryBtn}
              >
                New another
              </button>
              <button onClick={onClose} style={primaryBtn(false)}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
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
                {recipientOptions.length > 1 ? (
                  <select
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    style={inputStyle}
                  >
                    {recipientOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    placeholder="0x..."
                    spellCheck={false}
                    style={{ ...inputStyle, fontFamily: "var(--font-jetbrains), monospace", fontSize: fs.body }}
                  />
                )}
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
            <button onClick={create} disabled={creating || !ownerAddress} style={primaryBtn(creating || !ownerAddress)}>
              {creating ? "Creating..." : "Create request"}
            </button>
            {!ownerAddress && (
              <div style={{ color: v2.muted2, fontSize: fs.label, marginTop: 8 }}>Connect your wallet first.</div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
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

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 80,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  background: "rgba(3,7,16,0.72)",
  backdropFilter: "blur(6px)",
};

const card: React.CSSProperties = {
  position: "relative",
  width: "100%",
  maxWidth: 460,
  background: "linear-gradient(180deg, #0F1626 0%, #0A1120 100%)",
  border: "1px solid rgba(255,255,255,.08)",
  borderTop: `2px solid ${v2.yellow}`,
  borderRadius: 16,
  padding: 24,
  boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
};

const closeBtn: React.CSSProperties = {
  position: "absolute",
  top: 14,
  right: 16,
  background: "transparent",
  border: "none",
  color: v2.muted,
  fontSize: 20,
  cursor: "pointer",
  lineHeight: 1,
};

const eyebrow: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: ".2em",
  textTransform: "uppercase",
  fontWeight: 700,
  color: v2.yellow,
};

const title: React.CSSProperties = {
  font: `600 20px ${displayFont}`,
  letterSpacing: "-.02em",
  color: v2.text,
  marginTop: 6,
};

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

const linkRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  background: "rgba(255,255,255,.04)",
  border: `1px solid ${v2.line}`,
  borderRadius: 10,
  padding: "10px 12px",
};

const linkText: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: fs.label,
  fontFamily: "var(--font-jetbrains), monospace",
  color: v2.text,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    flex: 1,
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

const secondaryBtn: React.CSSProperties = {
  flex: 1,
  background: "rgba(255,255,255,.03)",
  border: `1px solid ${v2.line}`,
  borderRadius: 10,
  color: v2.text,
  fontSize: fs.base,
  fontWeight: 600,
  padding: "11px 16px",
  cursor: "pointer",
};

const ghostBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: v2.yellow,
  fontSize: fs.body,
  cursor: "pointer",
  padding: 0,
  whiteSpace: "nowrap",
  fontWeight: 600,
};
