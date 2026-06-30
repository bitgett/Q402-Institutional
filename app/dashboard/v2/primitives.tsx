"use client";

/**
 * Q402 Dashboard V2 — shared primitives.
 *
 * Direct React ports of the prototype's CSS components
 * (`q402-agentic-wallet-concept/dashboard-v2.html`). Inline styles read
 * from `theme.ts` so there's one palette source. Typography (Space Grotesk
 * display / DM Sans body) is supplied by the v2 layout via CSS variables
 * `--font-space-grotesk` and `--font-dm-sans`; the helpers below reference
 * them through `displayFont`.
 *
 * Exports:
 *   - Surface        — the glass card
 *   - Eyebrow        — uppercase micro-label
 *   - SectionHead    — title + right-aligned meta/link row
 *   - TopNav         — 4 task-view pill nav (Wallets/Activity/Treasury/Developer)
 *   - ScopeChip      — Trial | Multichain segmented control
 *   - OwnerChip      — short owner-address pill
 *   - V2AccentScope  — CSS-var wrapper that re-skins emerald → yellow
 *   - displayFont / bodyFont — font-family strings for inline style
 */

import type { CSSProperties, ReactNode } from "react";
import { glass, v2, v2CssVars, fs, type Scope, type V2ViewId } from "./theme";
import { useIsMobile } from "../../lib/use-is-mobile";

/** Space Grotesk stack — display / numbers / addresses. */
export const displayFont = 'var(--font-space-grotesk), "Space Grotesk", sans-serif';
/** DM Sans stack — body copy / labels. */
export const bodyFont = 'var(--font-dm-sans), "DM Sans", sans-serif';

export function shortAddr(addr: string): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ── Surface ────────────────────────────────────────────────────────────────
export function Surface({
  children,
  radius = 19,
  className,
  style,
}: {
  children: ReactNode;
  radius?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={className} style={{ ...glass(radius), ...style }}>
      {children}
    </div>
  );
}

// ── Eyebrow ────────────────────────────────────────────────────────────────
export function Eyebrow({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        color: v2.muted,
        fontSize: fs.label,
        letterSpacing: ".16em",
        textTransform: "uppercase",
        fontWeight: 700,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── SectionHead ──────────────────────────────────────────────────────────────
export function SectionHead({
  title,
  meta,
  action,
}: {
  title: ReactNode;
  /** Right-aligned muted text (e.g. "11 networks monitored"). */
  meta?: ReactNode;
  /** Right-aligned yellow link button (e.g. "View all"). */
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-end",
        marginBottom: 10,
      }}
    >
      <div style={{ font: `600 ${fs.title}px ${displayFont}` }}>{title}</div>
      {meta != null && (
        <div style={{ color: v2.muted, fontSize: fs.label }}>{meta}</div>
      )}
      {action}
    </div>
  );
}

/** Yellow text link button used in section heads / cards (.link). */
export function LinkButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: 0,
        background: "none",
        color: v2.yellow,
        fontSize: fs.label,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

// ── TopNav ───────────────────────────────────────────────────────────────────
const NAV_ITEMS: { id: V2ViewId; label: string }[] = [
  { id: "wallets", label: "Wallets" },
  { id: "activity", label: "Activity" },
  { id: "treasury", label: "Treasury" },
  { id: "developer", label: "Developer" },
  { id: "referral", label: "Referral" },
];

export function TopNav({
  active,
  onChange,
}: {
  active: V2ViewId;
  onChange: (id: V2ViewId) => void;
}) {
  // On phones the 4 pills can't fit one rigid flex row, so they overflow the
  // viewport. Below 480px switch to a full-width 2×2 grid (the topbar already
  // wraps the nav onto its own row at ≤760px). Desktop is untouched.
  const isMobile = useIsMobile(480);
  return (
    <nav
      style={{
        display: isMobile ? "grid" : "flex",
        gridTemplateColumns: isMobile ? "1fr 1fr" : undefined,
        width: isMobile ? "100%" : undefined,
        gap: 3,
        padding: 4,
        border: `1px solid ${v2.line}`,
        borderRadius: 12,
        background: "rgba(255,255,255,.022)",
      }}
    >
      {NAV_ITEMS.map((item) => {
        const isActive = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            style={{
              border: 0,
              background: isActive ? "rgba(255,255,255,.065)" : "transparent",
              color: isActive ? v2.text : v2.muted,
              padding: "8px 13px",
              borderRadius: 8,
              fontSize: fs.body,
              fontWeight: 600,
              cursor: "pointer",
              textAlign: isMobile ? "center" : undefined,
            }}
          >
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}

// ── ScopeChip ────────────────────────────────────────────────────────────────
const SCOPES: { id: Scope; label: string }[] = [
  { id: "trial", label: "Trial" },
  { id: "multichain", label: "Multichain" },
];

export function ScopeChip({
  scope,
  onChange,
}: {
  scope: Scope;
  onChange: (s: Scope) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 3,
        border: `1px solid ${v2.line}`,
        borderRadius: 10,
        padding: 3,
        background: "rgba(255,255,255,.02)",
      }}
    >
      {SCOPES.map((s) => {
        const isActive = s.id === scope;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onChange(s.id)}
            style={{
              border: 0,
              background: isActive ? v2.yellow : "none",
              color: isActive ? v2.actionText : v2.muted,
              fontSize: fs.label,
              padding: "7px 9px",
              borderRadius: 7,
              fontWeight: isActive ? 700 : 400,
              cursor: "pointer",
            }}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

// ── OwnerChip ────────────────────────────────────────────────────────────────
export function OwnerChip({ address }: { address: string | null }) {
  return (
    <div
      style={{
        border: `1px solid ${v2.line}`,
        borderRadius: 10,
        padding: "8px 10px",
        color: "#cbd3dd",
        font: `500 ${fs.label}px ${displayFont}`,
      }}
    >
      {address ? shortAddr(address) : "Not connected"}
    </div>
  );
}

// ── BrandMark ────────────────────────────────────────────────────────────────
/** 30×30 yellow rounded square with the dark inner notch (.mark). */
export function BrandMark() {
  return (
    <span
      aria-hidden
      style={{
        // Exact copy of the landing navbar mark (app/components/Navbar.tsx):
        // 28px rounded-md yellow square + 12px rounded-sm navy inner.
        width: 28,
        height: 28,
        borderRadius: 6,
        background: v2.yellow,
        display: "grid",
        placeItems: "center",
        boxShadow: "0 0 12px rgba(245,197,24,.35)",
      }}
    >
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: 2,
          background: v2.markInner,
        }}
      />
    </span>
  );
}

// ── V2AccentScope ────────────────────────────────────────────────────────────
/**
 * Wrap a subtree to expose the v2 palette as CSS custom properties
 * (`--v2-yellow`, `--v2-accent`, …). The next phase mounts the reused
 * agentic-wallet modals inside this scope and swaps their hard-coded
 * emerald literals (rgba(74,222,128,…) / #86efac) to `var(--v2-accent*)`,
 * so they pick up the yellow brand WITHOUT changing the modals' emerald
 * defaults when rendered outside a v2 scope (the existing /dashboard).
 */
export function V2AccentScope({
  children,
  style,
  className,
}: {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div
      className={className ? `v2-accent-scope ${className}` : "v2-accent-scope"}
      style={{ ...v2CssVars, ...style }}
    >
      {children}
    </div>
  );
}
