"use client";

/**
 * EscrowComposerModal — the "New escrow" popup (the create half of the Escrow
 * view). Publishes a `pending` escrow record (buyer = the authed owner; MOVES NO
 * FUNDS) and returns an escrowId. Funding is a separate gasless step: the buyer
 * locks via an EIP-7702 authorization that injected browser wallets can't
 * produce, so the success panel points at the Q402 agent / MCP (q402_escrow_lock)
 * for funding, mirroring how gasless pay is agent-driven.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { v2, fs } from "../theme";
import { displayFont } from "../primitives";
import { getAuthCreds } from "@/app/lib/auth-client";

interface PublicEscrow {
  id: string;
  onchainEscrowId: string;
  buyer: string;
  seller: string;
  chain: string;
  token: "USDC" | "USDT";
  amount: string;
  arbiter?: string;
  status: string;
}

// Escrow is live on BNB mainnet; kept as a map so more chains drop in as their
// vaults deploy (the composer stays a select, not a hard-code).
const CHAIN_LABEL: Record<string, string> = { bnb: "BNB Chain" };
const ESCROW_CHAINS = Object.keys(CHAIN_LABEL);
const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;

export interface EscrowComposerModalProps {
  ownerAddress: string | null;
  signMessage: (message: string) => Promise<string | null>;
  onClose: () => void;
  onCreated?: (escrow: PublicEscrow) => void;
}

export function EscrowComposerModal({ ownerAddress, signMessage, onClose, onCreated }: EscrowComposerModalProps) {
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<"USDC" | "USDT">("USDT");
  const [chain, setChain] = useState("bnb");
  const [seller, setSeller] = useState("");
  const [useArbiter, setUseArbiter] = useState(false);
  const [arbiter, setArbiter] = useState("");
  const [releaseDays, setReleaseDays] = useState(7);
  const [memo, setMemo] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<PublicEscrow | null>(null);
  const [copied, setCopied] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

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
    if (!ETH_ADDR.test(seller)) {
      setFormError("Enter a valid seller address (0x...).");
      return;
    }
    if (seller.toLowerCase() === ownerAddress.toLowerCase()) {
      setFormError("Seller must differ from you (the buyer).");
      return;
    }
    if (useArbiter) {
      if (!ETH_ADDR.test(arbiter)) {
        setFormError("Enter a valid arbiter address, or turn off disputes.");
        return;
      }
      const a = arbiter.toLowerCase();
      if (a === ownerAddress.toLowerCase() || a === seller.toLowerCase()) {
        setFormError("Arbiter must be a neutral third party (not buyer or seller).");
        return;
      }
    }
    setCreating(true);
    try {
      const auth = await getAuthCreds(ownerAddress, signMessage);
      if (!auth) {
        setCreating(false);
        return;
      }
      const res = await fetch("/api/escrow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: ownerAddress,
          nonce: auth.nonce,
          signature: auth.signature,
          chain,
          token,
          seller,
          amount,
          releaseDays,
          ...(useArbiter && arbiter ? { arbiter } : {}),
          ...(memo.trim() ? { memo: memo.trim() } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { escrow?: PublicEscrow; error?: string };
      if (!res.ok || !data.escrow) {
        setFormError(data.error ?? "Could not create escrow.");
        setCreating(false);
        return;
      }
      setCreated(data.escrow);
      onCreated?.(data.escrow);
    } catch {
      setFormError("Could not create escrow.");
    } finally {
      setCreating(false);
    }
  }

  function copyId() {
    if (!created) return;
    navigator.clipboard.writeText(created.id).then(() => {
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

        <div style={eyebrow}>Escrow · non-custodial</div>
        <div style={title}>{created ? "Escrow created" : "New escrow"}</div>

        {created ? (
          <div style={{ marginTop: 14 }}>
            <div style={{ color: v2.muted, fontSize: fs.body, lineHeight: 1.55, marginBottom: 12 }}>
              Escrow for{" "}
              <b style={{ color: v2.text }}>
                {created.amount} {created.token}
              </b>{" "}
              to <span style={{ fontFamily: displayFont }}>{short(created.seller)}</span> is{" "}
              <b style={{ color: v2.yellow }}>pending</b>. No funds have moved yet.
            </div>
            <div style={{ ...noteBox, marginBottom: 12 }}>
              <div style={{ color: v2.text, fontWeight: 600, fontSize: fs.body, marginBottom: 4 }}>
                Fund it gaslessly with a Q402 agent
              </div>
              <div style={{ color: v2.muted, fontSize: fs.label, lineHeight: 1.5 }}>
                Locking funds needs an EIP-7702 signature browser wallets can&apos;t produce. Have your Q402 agent run{" "}
                <span style={codeSpan}>q402_escrow_lock</span> with this id, or fund from the MCP. Once locked it shows as{" "}
                <b style={{ color: v2.mint }}>open</b> here and you can release or dispute it.
              </div>
            </div>
            <div style={idRow}>
              <span style={idText}>{created.id}</span>
              <button onClick={copyId} style={ghostBtn}>
                {copied ? "copied" : "copy id"}
              </button>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button
                onClick={() => {
                  setCreated(null);
                  setAmount("");
                  setSeller("");
                  setMemo("");
                  setUseArbiter(false);
                  setArbiter("");
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
                <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="50.00" inputMode="decimal" style={inputStyle} />
              </Field>
              <Field label="Token">
                <select value={token} onChange={(e) => setToken(e.target.value as "USDC" | "USDT")} style={inputStyle}>
                  <option value="USDT" style={optionStyle}>USDT</option>
                  <option value="USDC" style={optionStyle}>USDC</option>
                </select>
              </Field>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, marginBottom: 12 }}>
              <Field label="Network">
                <select value={chain} onChange={(e) => setChain(e.target.value)} style={inputStyle}>
                  {ESCROW_CHAINS.map((c) => (
                    <option key={c} value={c} style={optionStyle}>
                      {CHAIN_LABEL[c]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Seller (paid on release)">
                <input
                  value={seller}
                  onChange={(e) => setSeller(e.target.value)}
                  placeholder="0x... (the counterparty)"
                  spellCheck={false}
                  style={{ ...inputStyle, fontFamily: "var(--font-jetbrains), monospace", fontSize: fs.body }}
                />
              </Field>
              <Field label="Timeout refund">
                <select value={String(releaseDays)} onChange={(e) => setReleaseDays(Number(e.target.value))} style={inputStyle}>
                  <option value="7" style={optionStyle}>7 days</option>
                  <option value="14" style={optionStyle}>14 days</option>
                  <option value="30" style={optionStyle}>30 days</option>
                  <option value="90" style={optionStyle}>90 days</option>
                </select>
              </Field>
              <div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}>
                  <input type="checkbox" checked={useArbiter} onChange={(e) => setUseArbiter(e.target.checked)} style={{ accentColor: v2.yellow }} />
                  <span style={{ color: v2.text, fontSize: fs.base }}>Enable disputes (named arbiter)</span>
                </label>
                <div style={{ color: v2.muted2, fontSize: fs.label, marginTop: 4, lineHeight: 1.5 }}>
                  Without one it is release-or-timeout-refund only. An arbiter can resolve a dispute either way.
                </div>
                {useArbiter && (
                  <input
                    value={arbiter}
                    onChange={(e) => setArbiter(e.target.value)}
                    placeholder="0x... (neutral third party)"
                    spellCheck={false}
                    style={{ ...inputStyle, fontFamily: "var(--font-jetbrains), monospace", fontSize: fs.body, marginTop: 8 }}
                  />
                )}
              </div>
              <Field label="Memo (optional)">
                <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Milestone 1 / design work" maxLength={200} style={inputStyle} />
              </Field>
            </div>
            {formError && <div style={{ color: v2.red, fontSize: fs.body, marginBottom: 10 }}>{formError}</div>}
            <button onClick={create} disabled={creating || !ownerAddress} style={primaryBtn(creating || !ownerAddress)}>
              {creating ? "Creating..." : "Create escrow"}
            </button>
            {!ownerAddress && <div style={{ color: v2.muted2, fontSize: fs.label, marginTop: 8 }}>Connect your wallet first.</div>}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function short(a: string): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
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
  maxHeight: "90vh",
  overflowY: "auto",
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

const optionStyle: React.CSSProperties = { background: "#0b1220", color: v2.text };

const noteBox: React.CSSProperties = {
  background: "rgba(245,197,24,.05)",
  border: `1px solid rgba(245,197,24,.2)`,
  borderRadius: 12,
  padding: "12px 14px",
};

const codeSpan: React.CSSProperties = {
  fontFamily: "var(--font-jetbrains), monospace",
  fontSize: fs.label,
  color: v2.yellow,
  background: "rgba(255,255,255,.05)",
  padding: "1px 5px",
  borderRadius: 5,
};

const idRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  background: "rgba(255,255,255,.04)",
  border: `1px solid ${v2.line}`,
  borderRadius: 10,
  padding: "10px 12px",
};

const idText: React.CSSProperties = {
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
