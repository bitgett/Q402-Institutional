"use client";

/**
 * EscrowView - the Escrow top-nav view, as a management console (NOT a landing
 * page). Same shell language as the Developer view: a 230px left context rail
 * beside a glass main pane.
 *
 * Left rail (.v2-context, desktop): the "Escrow" eyebrow, a New-escrow CTA, the
 * Active / History / How-it-works nav (Developer-style label + hint buttons),
 * and a vertical LIFECYCLE stepper (Create -> Fund -> Settle) so the model is
 * always visible at a glance. The rail is CSS-hidden on mobile, so mobile falls
 * back to a stacked header + pill nav.
 *
 * Main: the section content swaps - Active/History render the escrow table
 * (filtered); "How it works" is the trust diagram + FAQ. No marketing use-case
 * cards, no mock balances - this reads like a console, not a pitch.
 *
 * Design: Space Grotesk display / DM Sans body, navy glass + yellow/cyan/mint
 * accents. No emoji, no em-dash, always "Q402".
 */

import { useState, useRef } from "react";
import { v2, fs, glass } from "../theme";
import { displayFont, Eyebrow, V2AccentScope } from "../primitives";
import { useIsMobile } from "../../../lib/use-is-mobile";
import { EscrowList, type EscrowCounts } from "./EscrowList";
import { EscrowComposerModal } from "./EscrowComposerModal";
import type { Scope } from "../theme";

export interface EscrowViewProps {
  ownerAddress: string | null;
  signMessage: (message: string) => Promise<string | null>;
  scope: Scope;
}

type Section = "active" | "history" | "learn";

interface NavItem {
  id: Section;
  label: string;
  hint: string;
  Icon: (p: { size?: number; color?: string }) => React.ReactNode;
}

export function EscrowView({ ownerAddress, signMessage }: EscrowViewProps) {
  const [composerOpen, setComposerOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [section, setSection] = useState<Section>("active");
  const [counts, setCounts] = useState<EscrowCounts>({ active: 0, history: 0, total: 0 });
  const isMobile = useIsMobile(860);

  const didAutoRoute = useRef(false);
  const userNav = useRef(false);

  // First-time users (no escrows yet) land on "How it works" so the guide comes
  // before an empty table. Fires once on first counts load; never overrides a
  // manual nav click.
  const handleCounts = (c: EscrowCounts) => {
    setCounts(c);
    if (!didAutoRoute.current) {
      didAutoRoute.current = true;
      if (c.total === 0 && !userNav.current) setSection("learn");
    }
  };
  const goSection = (id: Section) => { userNav.current = true; setSection(id); };
  const openComposer = () => setComposerOpen(true);

  const nav: NavItem[] = [
    { id: "active", label: "Active", hint: `${counts.active} open`, Icon: IconLock },
    { id: "history", label: "History", hint: `${counts.history} settled`, Icon: IconClock },
    { id: "learn", label: "How it works", hint: "The trust model", Icon: IconShield },
  ];

  // Section body, shared between desktop and mobile.
  const body = section === "learn" ? (
    <LearnPane isMobile={isMobile} />
  ) : (
    <div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ color: v2.text, fontFamily: displayFont, fontSize: fs.title, fontWeight: 600 }}>
          {section === "active" ? "Active escrows" : "History"}
        </div>
        <div style={{ color: v2.muted2, fontSize: fs.label, marginTop: 3 }}>
          {section === "active"
            ? "Pending, funded, and disputed escrows you can act on."
            : "Released, refunded, and closed escrows."}
        </div>
      </div>
      <EscrowList
        ownerAddress={ownerAddress}
        signMessage={signMessage}
        refreshKey={refreshKey}
        filter={section}
        onCounts={handleCounts}
        onCreate={openComposer}
      />
    </div>
  );

  const mainHeader = (
    <>
      <div style={{ font: `600 ${fs.h2}px ${displayFont}`, letterSpacing: "-.04em", color: v2.text }}>
        Escrow
      </div>
      <div style={{ color: v2.muted, fontSize: fs.body, marginTop: 6, maxWidth: 640, lineHeight: 1.55 }}>
        Hold funds in a non-custodial vault until the work is done. Only your signature releases them; Q402 sponsors the gas and never holds your funds.
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 12, color: v2.muted, fontSize: fs.label }}>
        <TrustLine label="Non-custodial" />
        <TrustLine label="Gasless (Q402 sponsors)" />
        <TrustLine label="BNB Chain" />
      </div>
    </>
  );

  const modal = composerOpen && (
    <EscrowComposerModal
      ownerAddress={ownerAddress}
      signMessage={signMessage}
      onClose={() => setComposerOpen(false)}
      onCreated={() => setRefreshKey((k) => k + 1)}
    />
  );

  // ── Mobile: stacked (no rail; CSS hides .v2-context) ───────────────────────
  if (isMobile) {
    return (
      <V2AccentScope className="v2-view-enter" style={{ paddingTop: 16 }}>
        <div style={{ ...glass(19), padding: 16 }}>
          {mainHeader}
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 16 }}>
            <button onClick={openComposer} disabled={!ownerAddress} style={{ ...newBtn(!ownerAddress), width: "auto", whiteSpace: "nowrap", padding: "9px 14px" }}>
              + New escrow
            </button>
            {nav.map((item) => (
              <MobilePill key={item.id} item={item} active={section === item.id} onClick={() => goSection(item.id)} />
            ))}
          </div>
          <div style={{ marginTop: 18 }}>{body}</div>
        </div>
        {modal}
      </V2AccentScope>
    );
  }

  // ── Desktop: Developer-style 230px rail + glass main ───────────────────────
  return (
    <V2AccentScope className="v2-view-enter" style={{ paddingTop: 17 }}>
      <div className="v2-view-shell" style={{ display: "grid", gridTemplateColumns: "230px minmax(0,1fr)", gap: 18 }}>
        <EscrowRail nav={nav} active={section} onSelect={goSection} onNew={openComposer} disabled={!ownerAddress} />
        <main className="v2-view-main" style={{ ...glass(19), padding: 21 }}>
          {mainHeader}
          <div style={{ marginTop: 20 }}>{body}</div>
        </main>
      </div>
      {modal}
    </V2AccentScope>
  );
}

/* ── Left context rail: eyebrow + new CTA + nav + lifecycle stepper ────────── */
function EscrowRail({
  nav, active, onSelect, onNew, disabled,
}: {
  nav: NavItem[];
  active: Section;
  onSelect: (id: Section) => void;
  onNew: () => void;
  disabled: boolean;
}) {
  return (
    <aside className="v2-context" style={{ ...glass(19), padding: 15, height: "fit-content" }}>
      <Eyebrow style={{ margin: "2px 9px 11px" }}>Escrow</Eyebrow>
      <button onClick={onNew} disabled={disabled} style={{ ...newBtn(disabled), marginBottom: 12 }}>
        + New escrow
      </button>
      {nav.map((item) => (
        <RailNavButton key={item.id} item={item} active={active === item.id} onClick={() => onSelect(item.id)} />
      ))}
      <div style={{ height: 1, background: v2.line, margin: "13px 4px 0" }} />
      <LifecycleStepper />
    </aside>
  );
}

/* Developer-style rail button: icon + label + hint, yellow-tinted when active. */
function RailNavButton({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  const { Icon } = item;
  return (
    <button
      type="button"
      className="v2-trans"
      onClick={onClick}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        border: active ? `1px solid ${v2.line}` : "1px solid transparent",
        background: active ? "rgba(247,202,22,.07)" : "none",
        textAlign: "left",
        padding: "9px 11px",
        borderRadius: 10,
        cursor: "pointer",
        marginBottom: 2,
      }}
    >
      <Icon size={16} color={active ? v2.yellow : v2.muted} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", color: active ? v2.text : v2.muted, fontSize: fs.base, fontWeight: 600 }}>{item.label}</span>
        <span style={{ display: "block", color: v2.muted2, fontSize: fs.micro, marginTop: 1 }}>{item.hint}</span>
      </span>
    </button>
  );
}

/* Vertical lifecycle stepper (Create -> Fund -> Settle) in the rail. */
function LifecycleStepper() {
  return (
    <div style={{ marginTop: 14, padding: "0 4px" }}>
      <span style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", fontWeight: 700, color: v2.muted2, display: "block", marginBottom: 12 }}>
        Lifecycle
      </span>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {STEPS.map((s, i) => {
          const last = i === STEPS.length - 1;
          return (
            <div key={s.n} style={{ display: "flex", gap: 11 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                <span style={{ width: 10, height: 10, borderRadius: 999, background: s.accent, boxShadow: `0 0 8px ${s.accent}66`, marginTop: 3 }} />
                {!last && <span style={{ width: 1.5, flex: 1, minHeight: 20, background: `linear-gradient(${s.accent}66, ${STEPS[i + 1].accent}66)`, margin: "3px 0" }} />}
              </div>
              <div style={{ paddingBottom: last ? 0 : 13 }}>
                <div style={{ color: v2.text, fontSize: fs.base, fontWeight: 600, fontFamily: displayFont }}>{s.title}</div>
                <div style={{ color: v2.muted2, fontSize: fs.micro, lineHeight: 1.4, marginTop: 2 }}>{s.railSub}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* Mobile pill nav (rail is CSS-hidden on mobile). */
function MobilePill({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  const { Icon } = item;
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "8px 13px",
        borderRadius: 10,
        border: active ? `1px solid ${v2.yellow}33` : `1px solid ${v2.line}`,
        background: active ? "rgba(245,197,24,.10)" : v2.surfaceFill,
        color: active ? v2.text : v2.muted,
        fontSize: fs.base,
        fontWeight: 600,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      <Icon size={16} color={active ? v2.yellow : v2.muted} />
      {item.label}
    </button>
  );
}

/* "How it works" - trust diagram + FAQ (no marketing use-case cards). */
function LearnPane({ isMobile }: { isMobile: boolean }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: isMobile ? "1fr" : "minmax(0,1fr) 372px",
        gap: isMobile ? 22 : 32,
        alignItems: "start",
      }}
    >
      <div>
        <SectionLabel>Good to know</SectionLabel>
        <div style={{ marginTop: 8 }}>
          <FaqRow q="What if the seller never delivers?" a="You reclaim the full amount yourself after the timeout you chose. An escrow never auto-pays the seller." />
          <FaqRow q="Can Q402 touch my funds?" a="No. The vault is non-custodial. Only your signature moves the funds; Q402 only sponsors the gas and never holds them." />
          <FaqRow q="What does it cost to fund or settle?" a="Gas is on us. Q402 sponsors every escrow action, so you never need to hold a native gas token." />
          <FaqRow q="Who can settle a dispute?" a="Only an arbiter you name at creation, and only if you add one. Without an arbiter it is release-or-refund only." />
          <FaqRow q="Which tokens and chains?" a="USDC and USDT on BNB Chain today. More chains open up as their vaults deploy." />
        </div>
      </div>
      {!isMobile && <FlowPanel />}
    </div>
  );
}

function FaqRow({ q, a }: { q: string; a: string }) {
  return (
    <div style={{ padding: "11px 0", borderBottom: `1px solid ${v2.line}` }}>
      <div style={{ color: v2.text, fontSize: fs.base, fontWeight: 600 }}>{q}</div>
      <div style={{ color: v2.muted, fontSize: fs.label, lineHeight: 1.5, marginTop: 4 }}>{a}</div>
    </div>
  );
}

const STEPS = [
  { n: "01", title: "Create", railSub: "Set terms, get an id", accent: v2.yellow, Icon: IconDoc },
  { n: "02", title: "Fund", railSub: "Agent Wallet locks it", accent: v2.cyan, Icon: IconLock },
  { n: "03", title: "Settle", railSub: "Release or refund", accent: v2.mint, Icon: IconCheck },
];

/* Flow panel - a clean concept diagram of the trust model (no fake data). */
function FlowPanel() {
  return (
    <div style={{ position: "relative", width: "100%", maxWidth: 372 }}>
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
      <div style={{ position: "relative", ...glass(16), padding: 20, background: "linear-gradient(180deg, rgba(16,30,50,.9), rgba(10,18,32,.92))" }}>
        <div style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", fontWeight: 700, color: v2.muted, marginBottom: 16 }}>
          How your funds stay safe
        </div>

        <FlowNode label="You (the buyer)" dot={v2.cyan} />
        <Connector label="lock funds, gasless" />

        <div style={{ display: "flex", alignItems: "center", gap: 13, padding: "14px 15px", borderRadius: 14, background: "rgba(245,197,24,.06)", border: `1px solid ${v2.yellow}33` }}>
          <span style={{ width: 40, height: 40, borderRadius: 11, background: "rgba(245,197,24,.12)", border: `1px solid ${v2.yellow}44`, display: "grid", placeItems: "center", color: v2.yellow, flexShrink: 0 }}>
            <IconLock size={20} color={v2.yellow} />
          </span>
          <div>
            <div style={{ color: v2.text, fontFamily: displayFont, fontSize: fs.cardTitle, fontWeight: 600 }}>Non-custodial vault</div>
            <div style={{ color: v2.muted, fontSize: fs.label, lineHeight: 1.45, marginTop: 2 }}>Funds sit here until it settles. Q402 cannot move them.</div>
          </div>
        </div>

        <Connector label="only your signature" split />

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
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "9px 13px", borderRadius: 11, background: "rgba(255,255,255,.03)", border: `1px solid ${v2.line}`, width: "100%" }}>
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ fontSize: 11, letterSpacing: ".2em", textTransform: "uppercase", fontWeight: 700, color: v2.muted }}>{children}</span>
      <span style={{ flex: 1, height: 1, background: v2.line }} />
    </div>
  );
}

function TrustLine({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <IconCheck size={12} color={v2.mint} />
      {label}
    </div>
  );
}

function newBtn(disabled: boolean): React.CSSProperties {
  return {
    width: "100%",
    background: v2.yellow,
    color: v2.actionText,
    border: "none",
    borderRadius: 10,
    padding: "11px 16px",
    fontSize: fs.base,
    fontWeight: 700,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.55 : 1,
    boxShadow: disabled ? "none" : `0 8px 22px ${v2.yellow}2b`,
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
  return base(size, color, (<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9.5 13.5h5M12 11v5" /></>));
}
function IconLock({ size = 20, color }: { size?: number; color?: string }) {
  return base(size, color, (<><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /><path d="M12 15v2" /></>));
}
function IconCheck({ size = 20, color }: { size?: number; color?: string }) {
  return base(size, color, (<><path d="M12 3a9 9 0 1 0 9 9" /><path d="M8.5 12l2.5 2.5L21 5" /></>));
}
function IconShield({ size = 20, color }: { size?: number; color?: string }) {
  return base(size, color, (<><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></>));
}
function IconBack({ size = 20, color }: { size?: number; color?: string }) {
  return base(size, color, (<><path d="M9 7 4 12l5 5" /><path d="M4 12h11a5 5 0 0 1 5 5v1" /></>));
}
function IconClock({ size = 20, color }: { size?: number; color?: string }) {
  return base(size, color, (<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>));
}
