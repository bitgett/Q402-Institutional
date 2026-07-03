"use client";

/**
 * EscrowView - the Escrow top-nav view, as a management app (NOT a landing page).
 *
 * Layout: a compact header, then a left rail (New escrow + Active / History /
 * How it works) beside a right pane that swaps content. Active/History render
 * the escrow table (filtered); "How it works" is the concept/flow explainer.
 * This keeps escrow's many details manageable instead of stacked down one page.
 *
 * Design: Space Grotesk display / DM Sans body, navy glass + yellow/cyan/mint
 * accents. No emoji, no em-dash, always "Q402". The flow panel is a concept
 * diagram (no mock balances/addresses).
 */

import { useState, useRef } from "react";
import { v2, fs, glass } from "../theme";
import { displayFont } from "../primitives";
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

  const NAV: { id: Section; label: string; badge?: number; Icon: (p: { size?: number; color?: string }) => React.ReactNode }[] = [
    { id: "active", label: "Active", badge: counts.active, Icon: IconLock },
    { id: "history", label: "History", badge: counts.history, Icon: IconClock },
    { id: "learn", label: "How it works", Icon: IconShield },
  ];

  const railInner = (
    <>
      <button onClick={openComposer} disabled={!ownerAddress} style={newBtn(!ownerAddress)}>
        + New escrow
      </button>
      <nav
        style={{
          display: "flex",
          flexDirection: isMobile ? "row" : "column",
          gap: 4,
          marginTop: isMobile ? 0 : 14,
          overflowX: isMobile ? "auto" : "visible",
        }}
      >
        {NAV.map((item) => (
          <NavButton key={item.id} item={item} active={section === item.id} onClick={() => goSection(item.id)} isMobile={isMobile} />
        ))}
      </nav>
      {!isMobile && (
        <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${v2.line}`, color: v2.muted2, fontSize: fs.label, lineHeight: 1.7 }}>
          <TrustLine label="Non-custodial" /><TrustLine label="Gasless (Q402 sponsors)" /><TrustLine label="BNB Chain" />
        </div>
      )}
    </>
  );

  return (
    <div style={{ paddingTop: isMobile ? 20 : 30 }}>
      {/* Rail + pane */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "232px 1fr", gap: isMobile ? 14 : 20, alignItems: "start" }}>
        {isMobile ? (
          <div>{railInner}</div>
        ) : (
          <aside style={{ ...glass(16), padding: 14, position: "sticky", top: 84 }}>{railInner}</aside>
        )}

        <div>
          {/* Header lives at the top of the main column (Developer-view style):
              aligned with the rail, sized to the content column, not a
              full-width band spanning the whole page. */}
          <div style={{ marginBottom: isMobile ? 12 : 16 }}>
            <div style={{ font: `600 ${fs.h2}px ${displayFont}`, letterSpacing: "-.04em", color: v2.text }}>
              Escrow
            </div>
            <div style={{ color: v2.muted, fontSize: fs.body, lineHeight: 1.5, marginTop: 6, maxWidth: 640 }}>
              Hold funds in a non-custodial vault until the work is done. Only your signature releases them; Q402 sponsors the gas and never holds your funds.
            </div>
          </div>
          {section === "learn" ? (
            <LearnPane isMobile={isMobile} onCreate={openComposer} ownerAddress={ownerAddress} />
          ) : (
            <div style={{ ...glass(18), padding: isMobile ? 14 : 20 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ color: v2.text, fontFamily: displayFont, fontSize: fs.title, fontWeight: 600 }}>
                    {section === "active" ? "Active escrows" : "History"}
                  </div>
                  <div style={{ color: v2.muted2, fontSize: fs.label, marginTop: 3 }}>
                    {section === "active"
                      ? "Pending, funded, and disputed escrows you can act on."
                      : "Released, refunded, and closed escrows."}
                  </div>
                </div>
                <button onClick={openComposer} disabled={!ownerAddress} style={paneActionBtn(!ownerAddress)}>
                  + New escrow
                </button>
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
          )}
        </div>
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

/* Left-rail nav button (vertical rail on desktop; pill row on mobile). */
function NavButton({
  item, active, onClick, isMobile,
}: {
  item: { id: Section; label: string; badge?: number; Icon: (p: { size?: number; color?: string }) => React.ReactNode };
  active: boolean;
  onClick: () => void;
  isMobile: boolean;
}) {
  const { Icon } = item;
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        width: isMobile ? "auto" : "100%",
        whiteSpace: "nowrap",
        padding: isMobile ? "8px 13px" : "9px 11px",
        borderRadius: 10,
        border: active ? `1px solid ${v2.yellow}33` : "1px solid transparent",
        background: active ? "rgba(245,197,24,.10)" : "transparent",
        color: active ? v2.text : v2.muted,
        fontSize: fs.base,
        fontWeight: 600,
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <Icon size={17} color={active ? v2.yellow : v2.muted} />
      <span style={{ flex: isMobile ? "0" : "1" }}>{item.label}</span>
      {typeof item.badge === "number" && item.badge > 0 && (
        <span
          style={{
            fontSize: fs.micro,
            fontWeight: 700,
            color: active ? v2.yellow : v2.muted2,
            background: active ? "rgba(245,197,24,.14)" : "rgba(255,255,255,.05)",
            borderRadius: 999,
            padding: "1px 7px",
            minWidth: 18,
            textAlign: "center",
          }}
        >
          {item.badge}
        </span>
      )}
    </button>
  );
}

/* "How it works" pane - the concept/flow explainer. */
function LearnPane({ isMobile, onCreate, ownerAddress }: { isMobile: boolean; onCreate: () => void; ownerAddress: string | null }) {
  return (
    <div style={{ ...glass(18), padding: isMobile ? 16 : 24 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "1fr 372px",
          gap: isMobile ? 22 : 32,
          alignItems: "start",
        }}
      >
        <div>
          <SectionLabel>The flow</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
            {STEPS.map((s) => (
              <StepRow key={s.n} step={s} />
            ))}
          </div>
          <button onClick={onCreate} disabled={!ownerAddress} style={{ ...newBtn(!ownerAddress), marginTop: 20, width: isMobile ? "100%" : "auto", padding: "11px 20px" }}>
            Create an escrow
          </button>
        </div>
        {!isMobile && <FlowPanel />}
      </div>

      <div style={{ marginTop: 30 }}>
        <SectionLabel>Where people use it</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr", gap: 12, marginTop: 16 }}>
          <UseCaseCard title="Freelance milestone" body="Lock a milestone up front. The freelancer delivers, you release. If they ghost, you reclaim the full amount after the timeout." />
          <UseCaseCard title="OTC / P2P trade" body="Deal with someone you do not fully trust. Funds sit in the vault until you release, or a named arbiter settles a dispute." />
          <UseCaseCard title="Agent-to-agent deal" body="One AI agent hires another. The buyer agent locks payment gaslessly; it releases on delivery, always inside the policy you set." />
        </div>
      </div>

      <div style={{ marginTop: 30 }}>
        <SectionLabel>Good to know</SectionLabel>
        <div style={{ marginTop: 8 }}>
          <FaqRow q="What if the seller never delivers?" a="You reclaim the full amount yourself after the timeout you chose. An escrow never auto-pays the seller." />
          <FaqRow q="Can Q402 touch my funds?" a="No. The vault is non-custodial. Only your signature moves the funds; Q402 only sponsors the gas and never holds them." />
          <FaqRow q="What does it cost to fund or settle?" a="Gas is on us. Q402 sponsors every escrow action, so you never need to hold a native gas token." />
          <FaqRow q="Who can settle a dispute?" a="Only an arbiter you name at creation, and only if you add one. Without an arbiter it is release-or-refund only." />
          <FaqRow q="Which tokens and chains?" a="USDC and USDT on BNB Chain today. More chains open up as their vaults deploy." />
        </div>
      </div>
    </div>
  );
}

/* Use-case card + FAQ row for the learn pane. */
function UseCaseCard({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ ...glass(14), padding: 14 }}>
      <div style={{ color: v2.text, fontFamily: displayFont, fontSize: fs.cardTitle, fontWeight: 600 }}>{title}</div>
      <div style={{ color: v2.muted, fontSize: fs.label, lineHeight: 1.5, marginTop: 6 }}>{body}</div>
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
  { n: "01", title: "Create", body: "Set the seller, amount, and an optional arbiter. Nothing moves yet; you just get an escrow id.", accent: v2.yellow, Icon: IconDoc },
  { n: "02", title: "Fund", body: "Your Agent Wallet locks the funds into the vault, gaslessly. The escrow is now open.", accent: v2.cyan, Icon: IconLock },
  { n: "03", title: "Settle", body: "Release to the seller on delivery, or dispute to the arbiter. A timeout refunds you.", accent: v2.mint, Icon: IconCheck },
];

/* A horizontal step row (used in the learn pane). */
function StepRow({ step }: { step: { n: string; title: string; body: string; accent: string; Icon: (p: { size?: number; color?: string }) => React.ReactNode } }) {
  const { Icon } = step;
  return (
    <div style={{ display: "flex", gap: 13, alignItems: "flex-start" }}>
      <span style={{ width: 40, height: 40, borderRadius: 11, background: `${step.accent}14`, border: `1px solid ${step.accent}33`, display: "grid", placeItems: "center", color: step.accent, flexShrink: 0 }}>
        <Icon size={19} color={step.accent} />
      </span>
      <div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontFamily: displayFont, fontSize: fs.micro, fontWeight: 700, color: step.accent, letterSpacing: ".08em" }}>{step.n}</span>
          <span style={{ color: v2.text, fontFamily: displayFont, fontSize: fs.cardTitle, fontWeight: 600 }}>{step.title}</span>
        </div>
        <div style={{ color: v2.muted, fontSize: fs.body, lineHeight: 1.5, marginTop: 3 }}>{step.body}</div>
      </div>
    </div>
  );
}

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

function paneActionBtn(disabled: boolean): React.CSSProperties {
  return {
    background: "rgba(245,197,24,.10)",
    color: v2.yellow,
    border: `1px solid ${v2.yellow}44`,
    borderRadius: 10,
    padding: "8px 14px",
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
