"use client";

/**
 * modal-kit — the unified "Command deck" design system for the Agent Wallet
 * action modals. ONE shell (portal + navy backdrop + 3-zone panel: pinned
 * header / scrollable body / pinned footer), ONE gold CTA, and a shared
 * Field / Segmented / Alert vocabulary. Palette is brand-locked: navy + gold
 * (#F5C518) + cyan (#58c7f4) + red. NO green, NO emoji, NO em-dash.
 *
 * Every Agentic*Modal renders through <ModalShell> so the whole action
 * surface reads as one product instead of six bolted-together dialogs.
 */

import { createPortal } from "react-dom";
import type { CSSProperties, ReactNode } from "react";
import { useModalEscape } from "./useModalEscape";
import { v2, fs } from "../v2/theme";

// ── brand-locked palette (kit-local) ────────────────────────────────────────
export const GOLD = v2.yellow; // #F5C518
export const GOLD_TEXT = "#f9d64a";
export const CYAN = v2.cyan; // #58c7f4
const GOLD_SOFT = "rgba(247,202,22,.12)";
const GOLD_LINE = "rgba(247,202,22,.34)";
const GOLD_BORDER = "rgba(247,202,22,.22)";
const PANEL = "#0c1829";
export const INPUT_FILL = "#07111f";
const HAIR = v2.line; // rgba(255,255,255,.085)

const SIZE: Record<"sm" | "md" | "lg", number> = { sm: 444, md: 524, lg: 684 };

// ── ModalShell ──────────────────────────────────────────────────────────────

export function ModalShell({
  icon,
  accent = GOLD,
  title,
  subtitle,
  size = "md",
  onClose,
  closeDisabled = false,
  footer,
  children,
}: {
  /** Icon node rendered in the accent chip at the header's left. */
  icon?: ReactNode;
  /** Accent for the icon chip + (by convention) the modal's identity. */
  accent?: string;
  title: string;
  subtitle?: ReactNode;
  size?: "sm" | "md" | "lg";
  onClose: () => void;
  /** True while a request is in flight — blocks backdrop/escape close. */
  closeDisabled?: boolean;
  /** Pinned footer (usually a <PrimaryCTA>). Omit for list-style modals. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  useModalEscape(onClose, closeDisabled);
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      onClick={() => !closeDisabled && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(2,6,15,0.72)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: SIZE[size],
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: PANEL,
          border: `1px solid ${GOLD_BORDER}`,
          borderRadius: 18,
          boxShadow: "0 30px 90px rgba(0,0,0,.5)",
        }}
      >
        {/* ── header (pinned) ── */}
        <div style={{ flexShrink: 0, display: "flex", alignItems: "flex-start", gap: 12, padding: "17px 19px 15px" }}>
          {icon != null && (
            <span
              aria-hidden
              style={{
                width: 38,
                height: 38,
                borderRadius: 11,
                flexShrink: 0,
                display: "grid",
                placeItems: "center",
                background: `${accent}1a`,
                border: `1px solid ${accent}44`,
                color: accent,
                overflow: "hidden",
              }}
            >
              {icon}
            </span>
          )}
          <div style={{ minWidth: 0, flex: 1, paddingTop: 1 }}>
            <div style={{ fontSize: fs.title, fontWeight: 650, color: v2.text, lineHeight: 1.2, letterSpacing: "-0.01em" }}>{title}</div>
            {subtitle != null && <div style={{ fontSize: fs.label, color: v2.muted, marginTop: 4, lineHeight: 1.45 }}>{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            aria-label="Close"
            className="transition-colors disabled:opacity-40"
            style={{ flexShrink: 0, width: 30, height: 30, marginTop: -2, marginRight: -4, display: "grid", placeItems: "center", borderRadius: 8, color: v2.muted, background: "transparent" }}
          >
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {/* ── body (scrolls) ── */}
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 19px 19px", display: "flex", flexDirection: "column", gap: 15 }}>{children}</div>

        {/* ── footer (pinned) ── */}
        {footer != null && (
          <div style={{ flexShrink: 0, padding: "14px 19px", borderTop: `1px solid ${HAIR}`, background: "rgba(255,255,255,.012)" }}>{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ── Field — uppercase eyebrow label + control + optional right hint ──────────

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 7 }}>
        <label htmlFor={htmlFor} style={{ fontSize: fs.micro, fontWeight: 600, letterSpacing: "0.09em", textTransform: "uppercase", color: v2.muted }}>{label}</label>
        {hint != null && <span style={{ fontSize: fs.micro, color: v2.muted2 }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** Shared input style — spread onto <input>. `mono` for addresses/hashes. */
export function inputStyle(opts?: { mono?: boolean; invalid?: boolean }): CSSProperties {
  return {
    width: "100%",
    background: INPUT_FILL,
    border: `1px solid ${opts?.invalid ? "rgba(248,113,113,.55)" : HAIR}`,
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: fs.body,
    color: v2.text,
    outline: "none",
    fontFamily: opts?.mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined,
  };
}

// ── Segmented — consistent pill picker (chain / token / tier / rail) ─────────

export interface SegOption<V extends string | number> {
  value: V;
  label: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export function Segmented<V extends string | number>({
  options,
  value,
  onChange,
  cols,
  accent = GOLD,
}: {
  options: SegOption<V>[];
  value: V;
  onChange: (v: V) => void;
  cols?: number;
  accent?: string;
}) {
  return (
    <div style={cols ? { display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`, gap: 7 } : { display: "flex", flexWrap: "wrap", gap: 7 }}>
      {options.map((o) => {
        const active = o.value === value;
        const accSoft = `${accent}1f`;
        const accLine = `${accent}57`;
        return (
          <button
            key={String(o.value)}
            type="button"
            disabled={o.disabled}
            onClick={() => !o.disabled && onChange(o.value)}
            className="transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
            style={{
              flex: cols ? undefined : "0 1 auto",
              display: "flex",
              alignItems: "center",
              justifyContent: o.sub ? "flex-start" : "center",
              gap: 7,
              textAlign: "left",
              padding: o.sub ? "8px 11px" : "8px 13px",
              borderRadius: 9,
              border: `1px solid ${active ? accLine : HAIR}`,
              background: active ? accSoft : "rgba(255,255,255,.02)",
              color: active ? GOLD_TEXT : v2.muted,
              fontSize: fs.body,
              fontWeight: active ? 600 : 500,
              cursor: o.disabled ? "not-allowed" : "pointer",
            }}
          >
            {o.icon != null && <span style={{ flexShrink: 0, display: "grid", placeItems: "center" }}>{o.icon}</span>}
            {o.sub != null ? (
              <span style={{ minWidth: 0, lineHeight: 1.25 }}>
                <span style={{ display: "block", fontWeight: 600 }}>{o.label}</span>
                <span style={{ display: "block", fontSize: fs.micro, color: active ? "rgba(249,214,74,.7)" : v2.muted2 }}>{o.sub}</span>
              </span>
            ) : (
              o.label
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Buttons ──────────────────────────────────────────────────────────────────

export function PrimaryCTA({ onClick, disabled, busy, children, type = "button" }: { onClick?: () => void; disabled?: boolean; busy?: boolean; children: ReactNode; type?: "button" | "submit" }) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      className="transition-opacity disabled:opacity-40"
      style={{
        width: "100%",
        padding: "11px 16px",
        borderRadius: 11,
        border: "none",
        background: GOLD,
        color: v2.actionText,
        fontSize: fs.base,
        fontWeight: 700,
        letterSpacing: "-0.01em",
        cursor: disabled || busy ? "not-allowed" : "pointer",
      }}
    >
      {busy ? "Working…" : children}
    </button>
  );
}

export function GhostButton({ onClick, disabled, children, tone = "neutral" }: { onClick?: () => void; disabled?: boolean; children: ReactNode; tone?: "neutral" | "danger" | "gold" }) {
  const c = tone === "danger" ? v2.red : tone === "gold" ? GOLD_TEXT : v2.muted;
  const b = tone === "danger" ? "rgba(248,113,113,.3)" : tone === "gold" ? GOLD_LINE : HAIR;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="transition-colors disabled:opacity-40"
      style={{ padding: "9px 14px", borderRadius: 10, border: `1px solid ${b}`, background: tone === "gold" ? GOLD_SOFT : "rgba(255,255,255,.02)", color: c, fontSize: fs.body, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer" }}
    >
      {children}
    </button>
  );
}

// ── AlertBox — info / warn / error / success (cyan, never green) ─────────────

const ALERT: Record<"info" | "warn" | "error" | "success", { border: string; bg: string; text: string }> = {
  info: { border: "rgba(88,199,244,.28)", bg: "rgba(88,199,244,.06)", text: "#bfe6fb" },
  warn: { border: "rgba(247,202,22,.30)", bg: "rgba(247,202,22,.06)", text: "#f4d98a" },
  error: { border: "rgba(248,113,113,.32)", bg: "rgba(248,113,113,.06)", text: "#fecaca" },
  success: { border: "rgba(88,199,244,.34)", bg: "rgba(88,199,244,.07)", text: "#8fd6f7" },
};

export function AlertBox({ variant = "info", children, action }: { variant?: "info" | "warn" | "error" | "success"; children: ReactNode; action?: ReactNode }) {
  const c = ALERT[variant];
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, borderRadius: 10, border: `1px solid ${c.border}`, background: c.bg, padding: "10px 12px", fontSize: fs.body, lineHeight: 1.5, color: c.text }}>
      <div style={{ minWidth: 0 }}>{children}</div>
      {action != null && <div style={{ flexShrink: 0 }}>{action}</div>}
    </div>
  );
}

/** A simple monospace address line for header subtitles. */
export function MonoAddr({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{children}</span>;
}
