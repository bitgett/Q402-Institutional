"use client";

/**
 * Hero — Arbitrum-style full-bleed rounded card.
 *
 * Layout reference: arbitrum.foundation hero — a single rounded card filling
 * the viewport below the navbar, big ALL-CAPS headline on the left, two pill
 * CTAs at the bottom, and a radiating stripe pattern on the right. We swap
 * the brand from Arbitrum blue/cyan to Q402 navy/yellow but keep the shape.
 *
 * The stripes are pure CSS — repeating linear gradients origin-anchored at
 * the lower-right corner, then rotated. No SVG/asset cost, no extra HTTP.
 */

import { useState } from "react";
import { motion } from "framer-motion";
import RegisterModal from "./RegisterModal";

export default function Hero() {
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <section className="px-3 sm:px-5 pt-[84px] pb-6">
        {/* The card — fills the viewport minus the navbar and a small outer
            gutter, so the rounded corners are visible top-to-bottom. */}
        <div
          className="relative rounded-3xl overflow-hidden"
          style={{
            minHeight: "calc(100vh - 100px)",
            background:
              "radial-gradient(ellipse at 90% 90%, #1B2540 0%, #0E1A2E 45%, #06060C 100%)",
          }}
        >
          {/* Radiating stripes — anchored bottom-right, rotated to fan out
              toward the upper-left. Two layers of repeating-linear-gradient
              with slightly different angles + opacities give the depth Arbitrum's
              SVG rays have without shipping an SVG. */}
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage: `
                repeating-linear-gradient(
                  from 218deg,
                  rgba(245,197,24,0)   0deg,
                  rgba(245,197,24,0)   3deg,
                  rgba(245,197,24,0.06) 3.4deg,
                  rgba(245,197,24,0.06) 4.6deg,
                  rgba(245,197,24,0)   5deg,
                  rgba(245,197,24,0)   8deg
                )
              `,
              backgroundPosition: "100% 100%",
            }}
          />
          {/* Conic ray fan — the visible darker wedges fanning out from the
              bottom-right vanishing point, like Arbitrum's striped background. */}
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none"
            style={{
              background: `
                conic-gradient(
                  from 218deg at 95% 95%,
                  rgba(245,197,24,0.00) 0deg,
                  rgba(245,197,24,0.00) 4deg,
                  rgba(255,200,40,0.10) 6deg,
                  rgba(245,197,24,0.00) 9deg,
                  rgba(245,197,24,0.00) 14deg,
                  rgba(255,200,40,0.07) 17deg,
                  rgba(245,197,24,0.00) 22deg,
                  rgba(245,197,24,0.00) 28deg,
                  rgba(255,200,40,0.05) 32deg,
                  rgba(245,197,24,0.00) 38deg,
                  rgba(245,197,24,0.00) 360deg
                )
              `,
            }}
          />
          {/* Warm yellow corner glow — anchors the rays. */}
          <motion.div
            aria-hidden
            className="absolute -bottom-32 -right-32 w-[720px] h-[720px] rounded-full blur-[150px] pointer-events-none"
            animate={{ opacity: [0.5, 0.85, 0.5], scale: [1, 1.08, 1] }}
            transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
            style={{ background: "rgba(245,197,24,0.18)" }}
          />
          {/* Cool violet counter-glow on the upper-left so the card isn't
              monochrome — keeps Q402's existing palette. */}
          <motion.div
            aria-hidden
            className="absolute -top-24 -left-24 w-[520px] h-[520px] rounded-full blur-[140px] pointer-events-none"
            animate={{ opacity: [0.35, 0.6, 0.35] }}
            transition={{ duration: 11, repeat: Infinity, ease: "easeInOut", delay: 1.5 }}
            style={{ background: "rgba(139,92,246,0.10)" }}
          />
          {/* Subtle grid overlay — same trick as the old hero, masked to the
              center so the rays stay clean on the right. */}
          <div
            aria-hidden
            className="absolute inset-0 opacity-[0.05] pointer-events-none"
            style={{
              backgroundImage:
                "linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)",
              backgroundSize: "64px 64px",
              maskImage: "radial-gradient(ellipse at 30% 40%, black 30%, transparent 80%)",
              WebkitMaskImage: "radial-gradient(ellipse at 30% 40%, black 30%, transparent 80%)",
            }}
          />

          {/* CONTENT */}
          <div className="relative h-full flex flex-col justify-between px-7 sm:px-12 lg:px-20 py-12 lg:py-16">
            {/* Top: status pill + chain logos */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="flex items-center gap-3 flex-wrap"
            >
              <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-yellow/30 bg-yellow/[0.06]">
                <span className="w-1.5 h-1.5 rounded-full bg-yellow animate-pulse" />
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-yellow/95">
                  Mainnet · 7 chains live
                </span>
              </span>
              <div className="flex items-center gap-2">
                {[
                  { img: "/bnb.png",       label: "BNB"  },
                  { img: "/eth.png",       label: "ETH"  },
                  { img: "/mantle.png",    label: "MNT"  },
                  { img: "/avax.png",      label: "AVAX" },
                  { img: "/injective.png", label: "INJ"  },
                  { img: "/xlayer.png",    label: "X"    },
                  { img: "/stable.jpg",    label: "STB"  },
                ].map((c, i) => (
                  <motion.span
                    key={c.label}
                    initial={{ opacity: 0, scale: 0.7 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.4, delay: 0.15 + i * 0.06 }}
                    className="w-6 h-6 rounded-full overflow-hidden border border-white/10 flex-shrink-0"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={c.img} alt={c.label} className="w-full h-full object-cover" />
                  </motion.span>
                ))}
              </div>
            </motion.div>

            {/* Middle: HEADLINE + subtitle. Pushed up a touch with margin-top:auto
                so the CTAs sit naturally at the bottom on tall viewports. */}
            <div className="mt-10 lg:mt-0">
              <motion.h1
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, delay: 0.15 }}
                className="font-display uppercase font-extrabold tracking-[-0.03em] leading-[0.92] text-[3.4rem] sm:text-[5rem] md:text-[6.4rem] lg:text-[8.2rem] xl:text-[9rem] max-w-[14ch]"
              >
                <span className="block text-white">The final layer for</span>
                <span className="block text-shimmer">stablecoin rails.</span>
              </motion.h1>
              <motion.p
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.3 }}
                className="mt-7 max-w-2xl text-base sm:text-lg lg:text-xl text-white/65 font-light leading-relaxed"
              >
                <span className="text-[#4AE54A] font-semibold">Zero gas.</span> Seven EVM chains.{" "}
                <span className="text-[#4AE54A] font-semibold">Pure stablecoin flow</span> — users pay
                in USDC, USDT, or RLUSD, we cover the rest.
              </motion.p>
            </div>

            {/* Bottom: CTAs + stats row */}
            <div className="mt-12 lg:mt-0 flex flex-col gap-8">
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.45 }}
                className="flex flex-wrap items-center gap-3"
              >
                <button
                  onClick={() => setShowModal(true)}
                  className="group bg-yellow text-navy font-bold text-sm px-7 py-3.5 rounded-full hover:bg-yellow-hover transition-all hover:scale-[1.02] shadow-lg shadow-yellow/25"
                >
                  Start Gasless
                  <span className="ml-2 inline-block group-hover:translate-x-1 transition-transform">→</span>
                </button>
                <a
                  href="#how-it-works"
                  className="border border-white/15 text-white text-sm font-semibold px-7 py-3.5 rounded-full hover:bg-white/[0.04] transition-colors"
                >
                  See how it works
                </a>
              </motion.div>

              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.6, delay: 0.55 }}
                className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-yellow font-bold font-mono">99.99%</span>
                  <span className="text-white/35 text-xs">uptime</span>
                </div>
                <span className="w-px h-4 bg-white/10" />
                <div className="flex items-baseline gap-2">
                  <span className="text-yellow font-bold font-mono">&lt;0.9 sec</span>
                  <span className="text-white/35 text-xs">inclusion</span>
                </div>
                <span className="w-px h-4 bg-white/10" />
                <div className="flex items-baseline gap-2">
                  <span className="text-white font-bold">1 tx</span>
                  <span className="text-white/35 text-xs">full payment flow</span>
                </div>
                <span className="w-px h-4 bg-white/10" />
                <div className="flex items-baseline gap-2">
                  <span className="text-white font-bold">7 chains</span>
                  <span className="text-white/35 text-xs">mainnet live</span>
                </div>
              </motion.div>
            </div>
          </div>
        </div>
      </section>

      {showModal && <RegisterModal onClose={() => setShowModal(false)} />}
    </>
  );
}
