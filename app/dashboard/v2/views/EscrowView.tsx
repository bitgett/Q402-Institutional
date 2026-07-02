"use client";

/**
 * EscrowView - the Escrow top-nav view.
 *
 * Q402 Gasless Escrow surfaced as a real product page: a hero (headline +
 * benefit copy + a clean "how your funds stay safe" flow panel), a three-step
 * flow (Create -> Fund -> Settle) with iconography, and the owner's escrow table
 * with a premium empty state. Non-custodial, gasless, live on BNB Chain.
 *
 * Design: Space Grotesk display / DM Sans body, navy glass + yellow/cyan/mint
 * accents (theme.ts). No emoji, no em-dash, always "Q402". The flow panel is a
 * concept diagram (no fake balances/addresses) -- it explains the trust model,
 * it is not a mock account.
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
      {/* Hero */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "1.05fr 0.95fr",
          gap: isMobile ? 26 : 44,
          alignItems: "center",
          marginBottom: isMobile ? 32 : 54,
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

        {/* Flow panel - explains the trust model (concept, not a mock account) */}
        {!isMobile && <FlowPanel />}
      </div>

      {/* How it works */}
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

      {/* Your escrows */}
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

/* Flow panel - a clean concept diagram of the trust model (no fake data). */
function FlowPanel() {
  return (
    <div style={{ position: "relative", justifySelf: "center", width: "100%", maxWidth: 372 }}>
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: "-14% -8% -8%",
          background: `radial-gradient(58% 50% at 72% 12%, ${v2.yellow}1f, transparent 70%), radial-gradient(52% 48% at 18% 92%, ${v2.cyan}18, transparent 70%)`,
          filter: "blur(8px)",
          pointerEvents: "none",
        }}
      />
      <div style={{ position: "relative", ...glass(18), padding: 22, background: "linear-gradient(180deg, rgba(16,30,50,.9), rgba(10,18,32,.92))" }}>
        <div style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", fontWeight: 700, color: v2.muted, marginBottom: 16 }}>
          How your funds stay safe
        </div>

        {/* Buyer */}
        <FlowNode label="You (the buyer)" dot={v2.cyan} />
        <Connector label="lock funds, gasless" />

        {/* Vault (highlight) */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 13,
            padding: "14px 15px",
            borderRadius: 14,
            background: "rgba(245,197,24,.06)",
            border: `1px solid ${v2.yellow}33`,
          }}
        >
          <span style={{ width: 40, height: 40, borderRadius: 11, background: "rgba(245,197,24,.12)", border: `1px solid ${v2.yellow}44`, display: "grid", placeItems: "center", color: v2.yellow, flexShrink: 0 }}>
            <IconLock size={20} color={v2.yellow} />
          </span>
          <div>
            <div style={{ color: v2.text, fontFamily: displayFont, fontSize: fs.cardTitle, fontWeight: 600 }}>Non-custodial vault</div>
            <div style={{ color: v2.muted, fontSize: fs.label, lineHeight: 1.45, marginTop: 2 }}>Funds sit here until it settles. Q402 cannot move them.</div>
          </div>
        </div>

        <Connector label="only your signature" split />

        {/* Two outcomes */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <OutcomeTile accent={v2.mint} title="Release" sub="to the seller" foot="you sign" Icon={IconCheck} />
          <OutcomeTile accent={v2.cyan} title="Refund" sub="back to you" foot="on timeout" Icon={IconBack} />
        </div>
      </div>
    </div>
  );
}

function FlowNode({ label, dot }: { label: string; dot: string }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "9px 13px",
        borderRadius: 11,
        background: "rgba(255,255,255,.03)",
        border: `1px solid ${v2.line}`,
        width: "100%",
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 999, background: dot, boxShadow: `0 0 7px ${dot}88` }} />
      <span style={{ color: v2.text, fontSize: fs.base, fontWeight: 600 }}>{label}</span>
    </div>
  );
}

function Connector({ label, split }: { label: string; split?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0 7px 16px" }}>
      <span style={{ width: 1, height: 22, background: `linear-gradient(${v2.line}, ${v2.muted2})` }} />
      <span style={{ color: v2.muted2, fontSize: fs.micro, fontStyle: "italic" }}>{label}</span>
      {split && <span style={{ flex: 1, height: 1, background: v2.line, marginRight: 2 }} />}
    </div>
  );
}

function OutcomeTile({
  accent, title, sub, foot, Icon,
}: {
  accent: string; title: string; sub: string; foot: string; Icon: (p: { size?: number; color?: string }) => React.ReactNode;
}) {
  return (
    <div style={{ padding: "12px 13px", borderRadius: 12, background: "rgba(255,255,255,.02)", border: `1px solid ${v2.line}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, color: accent }}>
        <Icon size={15} color={accent} />
        <span style={{ fontFamily: displayFont, fontSize: fs.base, fontWeight: 700 }}>{title}</span>
      </div>
      <div style={{ color: v2.muted, fontSize: fs.label, marginTop: 5 }}>{sub}</div>
      <div style={{ color: v2.muted2, fontSize: fs.micro, marginTop: 2 }}>{foot}</div>
    </div>
  );
}

/* Step card */
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

/* Small building blocks */
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

/* Glyphs (24-viewBox, currentColor, round caps - matches action-icons) */
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
function IconBack({ size = 20, color }: { size?: number; color?: string }) {
  return base(size, color, (
    <>
      <path d="M9 7 4 12l5 5" />
      <path d="M4 12h11a5 5 0 0 1 5 5v1" />
    </>
  ));
}
function IconArrow({ size = 12, color }: { size?: number; color?: string }) {
  return base(size, color, <path d="M5 12h13M13 6l6 6-6 6" />);
}
