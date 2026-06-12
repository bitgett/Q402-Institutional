"use client";

/**
 * Shared brand-logo primitives for the v2 dashboard — one source so the
 * Wallets / Treasury / Activity views render chains + tokens identically.
 *
 * Chain marks are PNGs already in public/ (bnb/eth/avax/…); token marks are
 * crisp SVGs (USDT/USDC/Aave). Unmapped chains fall back to a colored dot.
 */

import type { CSSProperties } from "react";
import { v2 } from "./theme";

export const CHAIN_LOGO: Record<string, string> = {
  bnb: "/bnb.png",
  eth: "/eth.png",
  avax: "/avax.png",
  arbitrum: "/arbitrum.png",
  xlayer: "/xlayer.png",
  scroll: "/scroll.png",
  mantle: "/mantle.png",
  injective: "/injective.png",
  monad: "/monad.png",
  stable: "/stable.jpg",
};

/** Round chain logo with a colored-dot fallback for unmapped chains. */
export function ChainIcon({ chain, size = 16, color }: { chain: string; size?: number; color?: string }) {
  const src = CHAIN_LOGO[chain];
  if (!src) {
    return (
      <span style={{ width: size, height: size, borderRadius: "50%", background: color ?? v2.muted2, flexShrink: 0, display: "inline-block" }} />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" width={size} height={size} style={{ borderRadius: "50%", flexShrink: 0, objectFit: "cover", display: "block", background: "#0c1626" }} />
  );
}

/** Round token logo (USDT/USDC/Aave) from public/ SVGs. */
export function TokenIcon({ src, size = 27, style }: { src: string; size?: number; style?: CSSProperties }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" width={size} height={size} style={{ borderRadius: "50%", flexShrink: 0, display: "block", ...style }} />
  );
}

/** Q402 brand mark — the yellow rounded square + navy inner notch, sized.
 *  Use for Q402 *products* (e.g. Q402 Yield); pair the protocol logo (Aave)
 *  with the protocol label, not the product title. */
export function Q402Mark({ size = 20 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.22,
        background: v2.yellow,
        display: "grid",
        placeItems: "center",
        flexShrink: 0,
        boxShadow: "0 0 10px rgba(245,197,24,.28)",
      }}
    >
      <span style={{ width: size * 0.43, height: size * 0.43, borderRadius: size * 0.1, background: v2.markInner }} />
    </span>
  );
}

/** Overlapping USDT + USDC pair — the "Stablecoins" chip. */
export function StablePair({ size = 27 }: { size?: number }) {
  return (
    <div style={{ display: "flex", flexShrink: 0, alignItems: "center" }}>
      <TokenIcon src="/usdt.svg" size={size} style={{ boxShadow: "0 0 0 2px #0c1626" }} />
      <TokenIcon src="/usdc.svg" size={size} style={{ marginLeft: -size * 0.38, boxShadow: "0 0 0 2px #0c1626" }} />
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Inline-SVG icon system.
 *
 * ICON CONTRACT: every icon is `({ size = 16, color }) =>` an SVG with
 * viewBox "0 0 24 24", stroke-based (no fill), strokeWidth 1.7 (scaled by
 * size/16 so weight holds at any size), round caps/joins, aria-hidden, and
 * color inheriting via `stroke={color ?? "currentColor"}`.
 * ────────────────────────────────────────────────────────────────────────── */

/** Canonical icon render sizes used across the v2 surface. */
export const ICON_SIZES = { micro: 12, base: 16, card: 27 } as const;

type IconProps = { size?: number; color?: string };

/** Spending limits — a settings gear. */
export function GearIcon({ size = 16, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? "currentColor"} strokeWidth={1.7 * (size / 16)} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

/** Hooks — a hexagon. */
export function HexagonIcon({ size = 16, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? "currentColor"} strokeWidth={1.7 * (size / 16)} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2.5 20.5 7.25v9.5L12 21.5 3.5 16.75v-9.5L12 2.5Z" />
    </svg>
  );
}

/** Recurring "fires in" — a timer / clock. */
export function TimerIcon({ size = 16, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? "currentColor"} strokeWidth={1.7 * (size / 16)} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 1.8" />
      <path d="M9 2.5h6" />
    </svg>
  );
}

/** ERC-8004 agent — a shield badge with an inner dot. */
export function AgentBadgeIcon({ size = 16, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? "currentColor"} strokeWidth={1.7 * (size / 16)} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2.5 19.5 5.5v5.5c0 4.6-3.1 8.4-7.5 10-4.4-1.6-7.5-5.4-7.5-10V5.5L12 2.5Z" />
      <circle cx="12" cy="11" r="2" />
    </svg>
  );
}

/** MCP "tell this wallet what to do" — a clean 4-point sparkle (✦). */
export function SparkIcon({ size = 16, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? "currentColor"} strokeWidth={1.7 * (size / 16)} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3c.4 4.4 1.6 5.6 6 6-4.4.4-5.6 1.6-6 6-.4-4.4-1.6-5.6-6-6 4.4-.4 5.6-1.6 6-6Z" />
    </svg>
  );
}

/** Copied / success — a checkmark. */
export function CheckIcon({ size = 16, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? "currentColor"} strokeWidth={1.7 * (size / 16)} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
    </svg>
  );
}

/** Email alerts — a notification bell. */
export function BellIcon({ size = 16, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? "currentColor"} strokeWidth={1.7 * (size / 16)} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 8.5a6 6 0 0 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14.5 18 8.5Z" />
      <path d="M10.3 20a2 2 0 0 0 3.4 0" />
    </svg>
  );
}

/** Warning / critical — a triangle with an exclamation (replaces ⚠). */
export function WarnTriangleIcon({ size = 16, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? "currentColor"} strokeWidth={1.7 * (size / 16)} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.3 3.2 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.2a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/** Failed test mark — an X. */
export function XIcon({ size = 16, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? "currentColor"} strokeWidth={1.7 * (size / 16)} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 6 18 18" />
      <path d="M18 6 6 18" />
    </svg>
  );
}

/**
 * Sponsored gas reserve — a horizontal battery / charge-cell: a battery body
 * + positive terminal + an inner charge bolt. Reads as "topped-up gas
 * reserve" at 16px and stays crisp scaled up.
 */
export function GasTankIcon({ size = 16, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? "currentColor"} strokeWidth={1.7 * (size / 16)} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.5" y="7" width="16" height="10" rx="2.2" />
      <path d="M21.5 10.5v3" />
      <path d="M11.5 9.5 8.5 13h3l-1 3.5L14 12h-3l.5-2.5Z" />
    </svg>
  );
}
