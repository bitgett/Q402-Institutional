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

/* "How it works" - the escrow trust flow as a full-width visual (landing-grade),
 * with a supporting FAQ. Responsive: the flow stacks on narrow screens. */
function LearnPane({ isMobile }: { isMobile: boolean }) {
  return (
    <div>
      <EscrowFlow />
      <div style={{ marginTop: isMobile ? 28 : 36 }}>
        <SectionLabel>Good to know</SectionLabel>
        <div style={{ marginTop: 12 }}>
          <FaqAccordion />
        </div>
      </div>
    </div>
  );
}

const FAQS: { q: string; a: string }[] = [
  { q: "What if the seller never delivers?", a: "You reclaim the full amount yourself after the timeout you chose. An escrow never auto-pays the seller." },
  { q: "Can Q402 touch my funds?", a: "No. The vault is non-custodial. Only your signature moves the funds; Q402 only sponsors the gas and never holds them." },
  { q: "What does it cost to fund or settle?", a: "Gas is on us. Q402 sponsors every escrow action, so you never need to hold a native gas token." },
  { q: "Who can settle a dispute?", a: "Only an arbiter you name at creation, and only if you add one. Without an arbiter it is release-or-refund only." },
  { q: "Which tokens and chains?", a: "USDC and USDT on BNB Chain today. More chains open up as their vaults deploy." },
];

/* Good-to-know as a tidy accordion (was a wall of prose). Click a question to
 * expand its answer; the grid-rows transition animates height with no measuring. */
function FaqAccordion() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div style={{ ...glass(14), overflow: "hidden" }}>
      {FAQS.map((it, i) => {
        const isOpen = open === i;
        return (
          <div key={it.q} style={{ borderTop: i === 0 ? "none" : `1px solid ${v2.line}` }}>
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : i)}
              className="v2-trans"
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "15px 17px",
                background: isOpen ? "rgba(245,197,24,.045)" : "transparent",
                border: "none",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span style={{ flex: 1, color: v2.text, fontSize: fs.base, fontWeight: 600 }}>{it.q}</span>
              <span
                style={{
                  color: isOpen ? v2.yellow : v2.muted2,
                  transform: isOpen ? "rotate(180deg)" : "none",
                  transition: "transform .25s ease, color .2s ease",
                  flexShrink: 0,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <IconChevron size={16} />
              </span>
            </button>
            <div style={{ display: "grid", gridTemplateRows: isOpen ? "1fr" : "0fr", transition: "grid-template-rows .28s cubic-bezier(.4,0,.2,1)" }}>
              <div style={{ overflow: "hidden" }}>
                <div style={{ padding: "0 17px 16px", color: v2.muted, fontSize: fs.label, lineHeight: 1.6, maxWidth: 720 }}>{it.a}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const STEPS = [
  { n: "01", title: "Create", railSub: "Set terms, get an id", accent: v2.yellow, Icon: IconDoc },
  { n: "02", title: "Fund", railSub: "Agent Wallet locks it", accent: v2.cyan, Icon: IconLock },
  { n: "03", title: "Settle", railSub: "Release or refund", accent: v2.mint, Icon: IconCheck },
];

/* ── Escrow trust flow: full-width, landing-grade 3-card diagram ─────────────
 * Buyer -> Non-custodial vault -> Settle, with animated connectors, an accent
 * icon per node, and a mono footer. Mirrors the landing "Three addresses" flow,
 * restyled with v2 tokens. The travelling-dot animation lives in FLOW_CSS. */
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';

const FLOW_CSS = `
.escf-flow{display:flex;align-items:stretch;gap:0;}
@media(max-width:900px){.escf-flow{flex-direction:column;}}
.escf-node{flex:0 0 234px;border:1px solid ${v2.line};border-radius:16px;
  background:linear-gradient(180deg,rgba(255,255,255,.028),rgba(255,255,255,.008));
  padding:18px;display:flex;flex-direction:column;gap:12px;position:relative;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.04);}
@media(max-width:900px){.escf-node{flex:1 1 auto;}}
.escf-node-mid{border-color:${v2.yellow}4d;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 26px 56px -30px ${v2.yellow}80;}
.escf-ico{width:46px;height:46px;border-radius:12px;border:1px solid ${v2.line};
  display:flex;align-items:center;justify-content:center;color:${v2.yellow};background:${v2.yellow}0f;}
.escf-ico-cyan{color:${v2.cyan};border-color:${v2.cyan}47;background:${v2.cyan}10;}
.escf-ico-mint{color:${v2.mint};border-color:${v2.mint}47;background:${v2.mint}10;}
.escf-tag{font-family:${displayFont};font-weight:600;font-size:10px;letter-spacing:.16em;
  text-transform:uppercase;color:${v2.muted2};margin-bottom:8px;}
.escf-t{font-family:${displayFont};font-weight:700;font-size:18px;letter-spacing:-.02em;
  margin-bottom:7px;color:${v2.text};}
.escf-s{color:${v2.muted};font-size:13px;line-height:1.5;}
.escf-addr{font-family:${MONO};font-size:11.5px;color:${v2.text};margin-top:auto;
  padding-top:14px;border-top:1px solid ${v2.line};display:flex;align-items:center;gap:6px;}
.escf-addr-acc{color:${v2.yellow};}
.escf-coin{width:14px;height:14px;display:block;}
.escf-link{flex:1 1 auto;min-width:88px;display:flex;flex-direction:column;
  align-items:center;justify-content:center;padding:0 10px;}
@media(max-width:900px){.escf-link{min-height:98px;padding:10px 0;}}
.escf-link-line{position:relative;width:100%;height:2px;border-radius:2px;
  background:linear-gradient(90deg,transparent,${v2.line},transparent);}
@media(max-width:900px){.escf-link-line{width:2px;height:auto;align-self:center;min-height:52px;
  background:linear-gradient(180deg,transparent,${v2.line},transparent);}}
.escf-link-line::after{content:"";position:absolute;right:-1px;top:50%;
  transform:translateY(-50%) rotate(45deg);width:7px;height:7px;
  border-top:2px solid ${v2.yellow};border-right:2px solid ${v2.yellow};opacity:.7;}
@media(max-width:900px){.escf-link-line::after{right:auto;left:50%;top:auto;bottom:-1px;
  transform:translateX(-50%) rotate(135deg);}}
.escf-link-dot{position:absolute;top:50%;left:0;width:9px;height:9px;border-radius:50%;
  background:${v2.yellow};transform:translate(-50%,-50%);
  box-shadow:0 0 0 4px ${v2.yellow}22,0 0 14px 2px ${v2.yellow}99;
  animation:escTravelH 2.6s cubic-bezier(.6,0,.4,1) infinite;}
.escf-link-2 .escf-link-dot{animation-delay:1.3s;}
@keyframes escTravelH{0%{left:0;opacity:0;}9%{opacity:1;}88%{opacity:1;}100%{left:100%;opacity:0;}}
@media(max-width:900px){
  .escf-link-dot{top:0;left:50%;animation-name:escTravelV;}
  @keyframes escTravelV{0%{top:0;opacity:0;}9%{opacity:1;}88%{opacity:1;}100%{top:100%;opacity:0;}}
}
@media(prefers-reduced-motion:reduce){.escf-link-dot{animation:none;opacity:1;}}
.escf-link-top{font-family:${displayFont};font-weight:600;font-size:13px;letter-spacing:.03em;
  color:${v2.muted};margin-bottom:14px;text-align:center;white-space:nowrap;}
.escf-link-1 .escf-link-top{color:${v2.cyan};}
.escf-link-bot{margin-top:14px;}
.escf-badge{font-family:${displayFont};font-weight:700;font-size:11.5px;letter-spacing:.08em;
  text-transform:uppercase;color:${v2.yellow};border:1px solid ${v2.yellow}52;border-radius:999px;
  padding:5px 11px;background:${v2.yellow}12;white-space:nowrap;}
.escf-badge-mint{color:${v2.mint};border-color:${v2.mint}52;background:${v2.mint}12;}
.escf-cap{margin-top:20px;color:${v2.muted2};font-size:13.5px;text-align:center;}
.escf-cap b{color:${v2.text};font-weight:600;}
`;

function EscrowFlow() {
  return (
    <div>
      <style dangerouslySetInnerHTML={{ __html: FLOW_CSS }} />
      <div className="escf-flow">
        <div className="escf-node">
          <span className="escf-ico escf-ico-cyan"><IconDoc size={22} /></span>
          <div>
            <div className="escf-tag">A · Buyer</div>
            <div className="escf-t">Create and fund</div>
            <div className="escf-s">Set the seller, amount, and an optional arbiter. Your Agent Wallet locks it in, gasless.</div>
          </div>
          <div className="escf-addr">escrow #7f3a</div>
        </div>

        <div className="escf-link escf-link-1">
          <div className="escf-link-top">lock</div>
          <div className="escf-link-line"><span className="escf-link-dot" /></div>
          <div className="escf-link-bot"><span className="escf-badge">$0 gas</span></div>
        </div>

        <div className="escf-node escf-node-mid">
          <span className="escf-ico"><IconLock size={22} /></span>
          <div>
            <div className="escf-tag">B · Non-custodial vault</div>
            <div className="escf-t">Holds the funds</div>
            <div className="escf-s">Funds sit here until it settles. Only your signature moves them; Q402 cannot.</div>
          </div>
          <div className="escf-addr escf-addr-acc">your signature →</div>
        </div>

        <div className="escf-link escf-link-2">
          <div className="escf-link-top">on delivery</div>
          <div className="escf-link-line"><span className="escf-link-dot" /></div>
          <div className="escf-link-bot"><span className="escf-badge escf-badge-mint">or timeout</span></div>
        </div>

        <div className="escf-node">
          <span className="escf-ico escf-ico-mint"><IconCheck size={22} /></span>
          <div>
            <div className="escf-tag">C · Settle</div>
            <div className="escf-t">Release or refund</div>
            <div className="escf-s">Release to the seller on delivery, or reclaim the full amount after the timeout.</div>
          </div>
          <div className="escf-addr">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/usdc.svg" alt="" className="escf-coin" />+ 50.00 USDC
          </div>
        </div>
      </div>
      <p className="escf-cap"><b>One vault, only your signature.</b> Q402 sponsors the gas and never holds your funds.</p>
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
function IconClock({ size = 20, color }: { size?: number; color?: string }) {
  return base(size, color, (<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>));
}
function IconChevron({ size = 20, color }: { size?: number; color?: string }) {
  return base(size, color, (<path d="M6 9l6 6 6-6" />));
}
