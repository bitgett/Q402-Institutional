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
