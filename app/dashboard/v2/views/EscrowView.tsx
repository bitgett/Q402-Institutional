"use client";

/**
 * EscrowView — the Escrow top-nav view.
 *
 * Q402 Gasless Escrow surfaced end-to-end: a header + "New escrow" action, a
 * three-step explainer (create -> fund -> settle), and the owner's escrow table
 * with inline release / dispute / refund. Funding (the EIP-7702 lock) is an
 * agent step, so it's described here and hinted per-row rather than offered as a
 * browser button. Non-custodial, gasless, live on BNB Chain.
 */

import { useState } from "react";
import { v2, fs, glass, type Scope } from "../theme";
import { displayFont } from "../primitives";
import { EscrowList } from "./EscrowList";
import { EscrowComposerModal } from "./EscrowComposerModal";

export interface EscrowViewProps {
  ownerAddress: string | null;
  signMessage: (message: string) => Promise<string | null>;
  scope: Scope;
}

const STEPS = [
  { n: "01", title: "Create", body: "Set seller, amount, and an optional arbiter. No funds move — you get an escrow id." },
  { n: "02", title: "Fund", body: "Your Q402 agent locks the funds gaslessly into the vault (q402_escrow_lock). Now it is open." },
  { n: "03", title: "Settle", body: "Release to the seller, or dispute to the arbiter. After the timeout, refund is yours." },
];

export function EscrowView({ ownerAddress, signMessage }: EscrowViewProps) {
  const [composerOpen, setComposerOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 18 }}>
        <div style={{ maxWidth: 560 }}>
          <div style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", fontWeight: 700, color: v2.yellow }}>
            Escrow · non-custodial
          </div>
          <h1 style={{ font: `600 ${fs.h2}px ${displayFont}`, letterSpacing: "-.02em", color: v2.text, margin: "6px 0 0" }}>
            Hold funds until it&apos;s done
          </h1>
          <p style={{ color: v2.muted, fontSize: fs.base, lineHeight: 1.55, margin: "8px 0 0" }}>
            Gasless, non-custodial escrow on BNB Chain. Only your signatures move funds — Q402 sponsors the gas and never
            takes custody. Release to the seller, or dispute to a neutral arbiter.
          </p>
        </div>
        <button onClick={() => setComposerOpen(true)} disabled={!ownerAddress} style={newBtn(!ownerAddress)}>
          + New escrow
        </button>
      </div>

      {/* How it works */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 18 }}>
        {STEPS.map((s) => (
          <div key={s.n} style={{ ...glass(15), padding: 16 }}>
            <div style={{ fontFamily: displayFont, fontSize: fs.label, color: v2.yellow, fontWeight: 700 }}>{s.n}</div>
            <div style={{ color: v2.text, fontSize: fs.cardTitle, fontWeight: 600, marginTop: 6 }}>{s.title}</div>
            <div style={{ color: v2.muted, fontSize: fs.body, lineHeight: 1.5, marginTop: 4 }}>{s.body}</div>
          </div>
        ))}
      </div>

      {/* List */}
      <div style={{ ...glass(19), padding: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ color: v2.text, fontSize: fs.title, fontWeight: 600 }}>Your escrows</div>
        </div>
        <EscrowList ownerAddress={ownerAddress} signMessage={signMessage} refreshKey={refreshKey} />
      </div>

      {composerOpen && (
        <EscrowComposerModal
          ownerAddress={ownerAddress}
          signMessage={signMessage}
          onClose={() => setComposerOpen(false)}
          onCreated={() => setRefreshKey((k) => k + 1)}
        />
      )}
    </div>
  );
}

function newBtn(disabled: boolean): React.CSSProperties {
  return {
    background: v2.yellow,
    color: v2.actionText,
    border: "none",
    borderRadius: 10,
    padding: "10px 16px",
    fontSize: fs.base,
    fontWeight: 700,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.55 : 1,
    whiteSpace: "nowrap",
  };
}
