"use client";

/**
 * DashboardBanners — v2 subscription-lifecycle banner stack.
 *
 * Ported from the legacy /dashboard expiry + quota strips
 * (app/dashboard/_legacy-page.tsx.bak ~lines 1794-1892 + the plan badge at
 * ~1834), re-skinned into v2 design language: glass surfaces, yellow =
 * warning/action, mint = ok, a red token for expired/critical, Space Grotesk
 * for numbers, no emoji (inline SVG icons only).
 *
 * Driven entirely by useDashboardIdentity() — the same identity/subscription/
 * lifecycle facts the legacy page already computed (isExpired, daysLeft,
 * expiresAt, quota{used,total,pct}, plan, subscription). This component is a
 * pure read-side view; it derives nothing the legacy page didn't.
 *
 * WHAT RENDERS (top → bottom), each independently gated:
 *   1. PLAN badge   — only when the subscription is genuinely PAID
 *                     (amountUSD > 0): "{Plan} Plan · ${amount} paid".
 *   2. EXPIRY banner — paid only. RED + non-dismissible when isExpired;
 *                     YELLOW + session-dismissible when daysLeft <= 7.
 *   3. QUOTA banner  — any active subscription with pct >= 80. RED-ish at
 *                     >= 90, YELLOW at >= 80. Session-dismissible.
 *
 * Renders nothing (no empty bar) when there is nothing to warn about — the
 * outer fragment collapses to null if every gate is false.
 *
 * DISMISSAL: "session-dismiss" — useState held in this component, so a dismiss
 * lasts until the next full reload (matches the legacy banners' lifetime, none
 * of which persisted). The EXPIRED (critical) state is intentionally NOT
 * dismissible: relay access is already gone, so the user must see it.
 */

import { useState } from "react";
import { useDashboardIdentity } from "./identity-context";
import { v2, fs } from "./theme";
import { displayFont, bodyFont } from "./primitives";

/* ──────────────────────────────────────────────────────────────────────────
 * Local inline icons — no emoji (legacy used ⚠ / 📅). Same stroke contract as
 * logos.tsx: viewBox 0 0 24 24, stroke-based, round caps/joins, aria-hidden,
 * color via stroke. Kept local since logos.tsx has no warning/calendar mark.
 * ────────────────────────────────────────────────────────────────────────── */

type IconProps = { size?: number; color?: string };

/** Warning / critical — a triangle with an exclamation (replaces ⚠). */
function WarnTriangleIcon({ size = 16, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? "currentColor"} strokeWidth={1.7 * (size / 16)} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.3 3.2 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.2a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/** Renewal date — a calendar (replaces 📅). */
function CalendarIcon({ size = 16, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? "currentColor"} strokeWidth={1.7 * (size / 16)} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3.5" y="5" width="17" height="16" rx="2.4" />
      <path d="M3.5 9.5h17" />
      <path d="M8 3v3.5" />
      <path d="M16 3v3.5" />
    </svg>
  );
}

/** Dismiss control — a small X. */
function CloseIcon({ size = 14, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? "currentColor"} strokeWidth={1.7 * (size / 16)} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 6 18 18" />
      <path d="M18 6 6 18" />
    </svg>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Tones — the two severity treatments (yellow warning, red critical). Mint is
 * the "ok" token in v2 but no banner renders in the ok state (we render
 * nothing instead of a green bar), so only warn/crit are needed here.
 * ────────────────────────────────────────────────────────────────────────── */

interface Tone {
  /** Tinted glass fill. */
  bg: string;
  /** Border / hairline. */
  border: string;
  /** Icon + emphasis text color. */
  accent: string;
  /** Filled CTA background. */
  ctaBg: string;
  /** Filled CTA text (dark on yellow, light on red). */
  ctaText: string;
}

const TONE_WARN: Tone = {
  bg: "rgba(245,197,24,0.055)",
  border: "rgba(245,197,24,0.26)",
  accent: v2.yellow,
  ctaBg: v2.yellow,
  ctaText: v2.actionText,
};

const TONE_CRIT: Tone = {
  bg: "rgba(255,119,119,0.07)",
  border: "rgba(255,119,119,0.30)",
  accent: v2.red,
  ctaBg: v2.red,
  ctaText: "#1a0a0a",
};

/* ── Shared banner shell ─────────────────────────────────────────────────── */

function BannerShell({
  tone,
  icon,
  title,
  detail,
  cta,
  onDismiss,
}: {
  tone: Tone;
  icon: React.ReactNode;
  title: React.ReactNode;
  detail?: React.ReactNode;
  /** Filled link CTA. */
  cta?: { label: string; href: string };
  /** When set, renders a dismiss (X) button on the right. */
  onDismiss?: () => void;
}) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "13px 16px",
        borderRadius: 14,
        border: `1px solid ${tone.border}`,
        background: tone.bg,
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        fontFamily: bodyFont,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        <span style={{ display: "grid", placeItems: "center", flexShrink: 0, color: tone.accent }}>
          {icon}
        </span>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: fs.base, fontWeight: 600, color: tone.accent, lineHeight: 1.3 }}>
            {title}
          </p>
          {detail != null && (
            <p style={{ margin: "2px 0 0", fontSize: fs.label, color: v2.muted, lineHeight: 1.3 }}>
              {detail}
            </p>
          )}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {cta && (
          <a
            href={cta.href}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              background: tone.ctaBg,
              color: tone.ctaText,
              fontWeight: 700,
              fontSize: fs.label,
              padding: "7px 14px",
              borderRadius: 999,
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            {cta.label}
          </a>
        )}
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            style={{
              display: "grid",
              placeItems: "center",
              width: 28,
              height: 28,
              border: 0,
              borderRadius: 8,
              background: "transparent",
              color: v2.muted,
              cursor: "pointer",
            }}
          >
            <CloseIcon />
          </button>
        )}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * DashboardBanners — assembles the stack from the identity context.
 * ────────────────────────────────────────────────────────────────────────── */

export default function DashboardBanners() {
  const { subscription, isExpired, expiresAt, daysLeft, quota } = useDashboardIdentity();

  // Session dismisses (reset on reload, mirroring legacy banner lifetimes).
  const [expiryDismissed, setExpiryDismissed] = useState(false);
  const [quotaDismissed, setQuotaDismissed] = useState(false);

  // PAID gate — legacy showed the plan badge + paid expiry banner only for a
  // genuinely paying sub (amountUSD > 0), never for a trial-only record.
  const amountUSD = subscription?.amountUSD ?? 0;
  const isPaid = amountUSD > 0;

  // (The plan badge moved to the Wallets-view hero, next to the wallet title.)

  // ── Expiry banner ──────────────────────────────────────────────────────
  // Expired is always shown (critical, non-dismissible). The pre-expiry
  // warning (<= 7d) is yellow + dismissible.
  const showExpiryWarn =
    isPaid && !isExpired && daysLeft != null && daysLeft <= 7 && !expiryDismissed;
  const showExpiryCrit = isPaid && isExpired;
  const showExpiry = showExpiryWarn || showExpiryCrit;

  // ── 3. Quota banner ────────────────────────────────────────────────────
  const pct = quota?.pct ?? 0;
  const showQuota = subscription != null && pct >= 80 && !quotaDismissed;
  const quotaCrit = pct >= 90;
  const remaining = quota ? Math.max(0, quota.total - quota.used) : 0;

  if (!showExpiry && !showQuota) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, margin: "16px 0 4px" }}>

      {showExpiry && (
        <BannerShell
          tone={showExpiryCrit ? TONE_CRIT : TONE_WARN}
          icon={showExpiryCrit ? <WarnTriangleIcon size={20} /> : <CalendarIcon size={20} />}
          title={
            showExpiryCrit
              ? "Subscription expired"
              : daysLeft === 1
                ? "Subscription expires in 1 day"
                : `Subscription expires in ${daysLeft} days`
          }
          detail={
            showExpiryCrit
              ? "Your API key is inactive. Renew to restore relay access."
              : expiresAt
                ? `Renews ${expiresAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
                : "Renew now to avoid service interruption."
          }
          cta={{ label: showExpiryCrit ? "Renew now" : "Renew", href: "/payment" }}
          // Critical state is non-dismissible; only the warning can be hidden.
          onDismiss={showExpiryCrit ? undefined : () => setExpiryDismissed(true)}
        />
      )}

      {showQuota && (
        <BannerShell
          tone={quotaCrit ? TONE_CRIT : TONE_WARN}
          icon={<WarnTriangleIcon size={20} />}
          title={
            <>
              Used <span style={{ fontFamily: displayFont }}>{pct}%</span> of your TX quota
            </>
          }
          detail={
            <>
              <span style={{ fontFamily: displayFont }}>{remaining.toLocaleString()}</span> TXs remaining
              {quotaCrit ? " — buy credits before they run out." : " — consider topping up."}
            </>
          }
          cta={{ label: quotaCrit ? "Buy credits" : "Top up", href: "/payment" }}
          onDismiss={() => setQuotaDismissed(true)}
        />
      )}
    </div>
  );
}
