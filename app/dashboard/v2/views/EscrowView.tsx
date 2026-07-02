"use client";

/**
 * EscrowView — the Escrow top-nav view.
 *
 * Q402 Gasless Escrow, surfaced as a real product page: a hero (headline +
 * benefit copy + an at-a-glance "vault" visual), a three-step flow (Create ->
 * Fund -> Settle) with iconography + connectors, and the owner's escrow table
 * with a premium empty state. Non-custodial, gasless, live on BNB Chain.
 *
 * Design: Space Grotesk display / DM Sans body, navy glass + yellow/cyan/mint
 * accents (theme.ts). No emoji, no em-dash, always "Q402".
 */

import { useState } from "react";
import { v2, fs, glass } from "../theme";
import { displayFont } from "../primitives";
import { useIsMobile } from "../../../lib/use-is-mobile";
import { EscrowList } from "./EscrowList";
import { EscrowComposerModal } from "./EscrowComposerModal";
import type { Scope } from "../theme";

export interface EscrowViewProps {
  ownerAddress: string | null;
  signMessage: (message: string) => Promise<string | null>;
  scope: Scope;
}

const STEPS = [
  {
    n: "01",
    title: "Create",
    body: "Set the seller, amount, and an optional arbiter. Nothing moves yet; you just get an escrow id.",
    accent: v2.yellow,
    Icon: IconDoc,
  },
  {
    n: "02",
    title: "Fund",
    body: "Your Agent Wallet locks the funds into the vault, gaslessly. The escrow is now open.",
    accent: v2.cyan,
    Icon: IconLock,
  },
  {
    n: "03",
    title: "Settle",
    body: "Release to the seller on delivery, or dispute to the arbiter. A timeout refunds you.",
    accent: v2.mint,
    Icon: IconCheck,
  },
];

export function EscrowView({ ownerAddress, signMessage }: EscrowViewProps) {
  const [composerOpen, setComposerOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const isMobile = useIsMobile(860);

  const openComposer = () => setComposerOpen(true);

  return (
    <div style={{ paddingTop: isMobile ? 22 : 40 }}>
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "1.05fr 0.95fr",
          gap: isMobile ? 26 : 40,
          alignItems: "center",
          marginBottom: isMobile ? 32 : 52,
        }}
      >
        <div>
          <span style={eyebrowChip}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: v2.mint, boxShadow: `0 0 8px ${v2.mint}` }} />
            Gasless escrow
          </span>
          <h1
            style={{
              fontFamily: displayFont,
              fontSize: isMobile ? 30 : 44,
              lineHeight: 1.03,
              letterSpacing: "-0.03em",
              fontWeight: 600,
              color: v2.text,
              margin: "16px 0 0",
            }}
          >
            Hold funds until
            <br />
            the work is done.
          </h1>
          <p
            style={{
              color: v2.muted,
              fontSize: isMobile ? 14 : 15.5,
              lineHeight: 1.62,
              maxWidth: 460,
              margin: "18px 0 0",
            }}
          >
            Lock stablecoins in a <span style={{ color: v2.text }}>non-custodial</span> vault. Only your signature
            releases them to the seller or refunds you. Q402 sponsors the gas and{" "}
            <span style={{ color: v2.text }}>never holds your funds</span>.
          </p>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "20px 0 0" }}>
            <TrustChip label="Non-custodial" />
            <TrustChip label="Gasless" />
            <TrustChip label="BNB Chain" />
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "26px 0 0", flexWrap: "wrap" }}>
            <button onClick={openComposer} disabled={!ownerAddress} style={ctaPrimary(!ownerAddress)}>
              Create escrow
            </button>
            {!ownerAddress && <span style={{ color: v2.muted2, fontSize: fs.label }}>Connect your wallet to start.</span>}
          </div>
        </div>

        {/* Vault visual — an escrow at a glance */}
        {!isMobile && <VaultVisual />}
      </div>

      {/* ── How it works ─────────────────────────────────────────────── */}
      <div style={{ marginBottom: isMobile ? 30 : 44 }}>
        <SectionLabel>How it works</SectionLabel>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)",
            gap: isMobile ? 12 : 16,
            marginTop: 16,
            position: "relative",
          }}
        >
          {STEPS.map((s, i) => (
            <StepCard key={s.n} step={s} last={i === STEPS.length - 1} isMobile={isMobile} />
          ))}
        </div>
      </div>

      {/* ── Your escrows ─────────────────────────────────────────────── */}
      <div style={{ ...glass(19), padding: isMobile ? 16 : 22 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ color: v2.text, fontFamily: displayFont, fontSize: fs.title, fontWeight: 600 }}>Your escrows</div>
            <div style={{ color: v2.muted2, fontSize: fs.label, marginTop: 3 }}>Track, release, or dispute every escrow you fund.</div>
          </div>
          <button onClick={openComposer} disabled={!ownerAddress} style={ctaSecondary(!ownerAddress)}>
            + New escrow
          </button>
        </div>
        <EscrowList ownerAddress={ownerAddress} signMessage={signMessage} refreshKey={refreshKey} onCreate={openComposer} />
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

/* ── Vault visual ──────────────────────────────────────────────────────── */
function VaultVisual() {
  return (
    <div style={{ position: "relative", justifySelf: "center", width: "100%", maxWidth: 380 }}>
      {/* soft glow behind the card */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: "-12% -6% -6%",
          background: `radial-gradient(60% 55% at 70% 20%, ${v2.yellow}22, transparent 70%), radial-gradient(55% 50% at 20% 90%, ${v2.cyan}1c, transparent 70%)`,
          filter: "blur(6px)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "relative",
          ...glass(18),
          borderTop: `2px solid ${v2.yellow}`,
          padding: 20,
          background: "linear-gradient(180deg, rgba(17,30,50,.92), rgba(10,18,32,.92))",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", fontWeight: 700, color: v2.yellow }}>
            Q402 Escrow
          </span>
          <span style={statusPill(v2.mint)}>
            <span style={{ width: 5, height: 5, borderRadius: 999, background: v2.mint }} />
            Funded
          </span>
        </div>

        <div style={{ marginTop: 18, display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontFamily: displayFont, fontSize: 38, fontWeight: 600, letterSpacing: "-0.02em", color: v2.text }}>250.00</span>
          <span style={{ color: v2.muted, fontSize: fs.cardTitle, fontWeight: 500 }}>USDT</span>
        </div>
        <div style={{ color: v2.muted2, fontSize: fs.label, marginTop: 2 }}>held in the vault</div>

        <div style={{ height: 1, background: v2.line, margin: "18px 0" }} />

        {/* buyer -> lock -> seller */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <PartyNode label="Buyer" addr="0x4ca4…f39a" color={v2.cyan} />
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
            <div style={{ position: "absolute", left: 4, right: 4, top: "50%", height: 1, background: `linear-gradient(90deg, ${v2.cyan}55, ${v2.mint}55)` }} />
            <span style={{ position: "relative", width: 30, height: 30, borderRadius: 9, background: "rgba(245,197,24,.12)", border: `1px solid ${v2.yellow}44`, display: "grid", placeItems: "center", color: v2.yellow }}>
              <IconLock size={15} />
            </span>
          </div>
          <PartyNode label="Seller" addr="0x8a06…1869" color={v2.mint} align="right" />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 18, color: v2.muted, fontSize: fs.label }}>
          <IconShield size={14} color={v2.muted} />
          Releases on delivery, refunds on timeout.
        </div>
      </div>
    </div>
  );
}

function PartyNode({ label, addr, color, align = "left" }: { label: string; addr: string; color: string; align?: "left" | "right" }) {
  return (
    <div style={{ textAlign: align, minWidth: 74 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: align === "right" ? "flex-end" : "flex-start" }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: color }} />
        <span style={{ color: v2.muted, fontSize: fs.label, fontWeight: 600 }}>{label}</span>
      </div>
      <div style={{ color: v2.text, fontFamily: displayFont, fontSize: fs.body, marginTop: 3 }}>{addr}</div>
    </div>
  );
}

/* ── Step card ─────────────────────────────────────────────────────────── */
function StepCard({
  step,
  last,
  isMobile,
}: {
  step: { n: string; title: string; body: string; accent: string; Icon: (p: { size?: number; color?: string }) => React.ReactNode };
  last: boolean;
  isMobile: boolean;
}) {
  const { Icon } = step;
  return (
    <div style={{ position: "relative", ...glass(15), padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span
          style={{
            width: 40,
            height: 40,
            borderRadius: 11,
            background: `${step.accent}14`,
            border: `1px solid ${step.accent}33`,
            display: "grid",
            placeItems: "center",
            color: step.accent,
            flexShrink: 0,
          }}
        >
          <Icon size={20} color={step.accent} />
        </span>
        <span style={{ fontFamily: displayFont, fontSize: fs.label, fontWeight: 700, color: step.accent, letterSpacing: ".08em" }}>
          {step.n}
        </span>
      </div>
      <div style={{ color: v2.text, fontFamily: displayFont, fontSize: fs.cardTitle, fontWeight: 600, marginTop: 14 }}>{step.title}</div>
      <div style={{ color: v2.muted, fontSize: fs.body, lineHeight: 1.55, marginTop: 5 }}>{step.body}</div>

      {/* connector arrow to the next card (desktop only) */}
      {!last && !isMobile && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            right: -11,
            top: "50%",
            transform: "translateY(-50%)",
            width: 22,
            height: 22,
            borderRadius: 999,
            background: v2.panel,
            border: `1px solid ${v2.line}`,
            display: "grid",
            placeItems: "center",
            color: v2.muted,
            zIndex: 2,
          }}
        >
          <IconArrow size={12} />
        </span>
      )}
    </div>
  );
}

/* ── Small building blocks ─────────────────────────────────────────────── */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ fontSize: 11, letterSpacing: ".2em", textTransform: "uppercase", fontWeight: 700, color: v2.muted }}>{children}</span>
      <span style={{ flex: 1, height: 1, background: v2.line }} />
    </div>
  );
}

function TrustChip({ label }: { label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: fs.label,
        fontWeight: 600,
        color: v2.muted,
        background: "rgba(255,255,255,.03)",
        border: `1px solid ${v2.line}`,
        borderRadius: 999,
        padding: "5px 11px",
      }}
    >
      <IconCheck size={13} color={v2.mint} />
      {label}
    </span>
  );
}

const eyebrowChip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  fontSize: 11,
  letterSpacing: ".18em",
  textTransform: "uppercase",
  fontWeight: 700,
  color: v2.yellow,
  background: "rgba(245,197,24,.07)",
  border: `1px solid rgba(245,197,24,.22)`,
  borderRadius: 999,
  padding: "6px 12px",
};

function statusPill(color: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: fs.micro,
    fontWeight: 700,
    color,
    background: `${color}14`,
    border: `1px solid ${color}33`,
    borderRadius: 999,
    padding: "3px 9px",
  };
}

function ctaPrimary(disabled: boolean): React.CSSProperties {
  return {
    background: v2.yellow,
    color: v2.actionText,
    border: "none",
    borderRadius: 11,
    padding: "12px 22px",
    fontSize: fs.base,
    fontWeight: 700,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.55 : 1,
    boxShadow: disabled ? "none" : `0 8px 26px ${v2.yellow}33`,
  };
}

function ctaSecondary(disabled: boolean): React.CSSProperties {
  return {
    background: "rgba(245,197,24,.10)",
    color: v2.yellow,
    border: `1px solid ${v2.yellow}44`,
    borderRadius: 10,
    padding: "9px 15px",
    fontSize: fs.body,
    fontWeight: 700,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.55 : 1,
    whiteSpace: "nowrap",
  };
}

/* ── Glyphs (24-viewBox, currentColor, round caps — matches action-icons) ── */
function base(size: number, color: string | undefined, children: React.ReactNode) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? "currentColor"} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}
function IconDoc({ size = 20, color }: { size?: number; color?: string }) {
  return base(size, color, (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9.5 13.5h5M12 11v5" />
    </>
  ));
}
function IconLock({ size = 20, color }: { size?: number; color?: string }) {
  return base(size, color, (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      <path d="M12 15v2" />
    </>
  ));
}
function IconCheck({ size = 20, color }: { size?: number; color?: string }) {
  return base(size, color, (
    <>
      <path d="M12 3a9 9 0 1 0 9 9" />
      <path d="M8.5 12l2.5 2.5L21 5" />
    </>
  ));
}
function IconShield({ size = 20, color }: { size?: number; color?: string }) {
  return base(size, color, (
    <>
      <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ));
}
function IconArrow({ size = 12, color }: { size?: number; color?: string }) {
  return base(size, color, <path d="M5 12h13M13 6l6 6-6 6" />);
}
