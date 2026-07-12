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
            {/* Top: status pill + chain logos. CSS `.hero-rise` (not framer) so
                the above-the-fold hero is visible in SSR / before hydration /
                with JS slow or disabled / under reduced-motion. */}
            <div className="hero-rise flex items-center gap-3 flex-wrap">
              <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-yellow/30 bg-yellow/[0.06]">
                <span className="w-1.5 h-1.5 rounded-full bg-yellow animate-pulse" />
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-yellow/95">
                  Mainnet · 12 chains live
                </span>
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {([
                  { img: "/bnb.png",       label: "BNB"  },
                  { img: "/eth.png",       label: "ETH"  },
                  { img: "/mantle.png",    label: "MNT"  },
                  { img: "/avax.png",      label: "AVAX" },
                  { img: "/injective.png", label: "INJ"  },
                  { img: "/xlayer.png",    label: "X"    },
                  { img: "/stable.jpg",    label: "STB"  },
                  { img: "/monad.png",     label: "MON"  },
                  { img: "/scroll.png",    label: "SCR"  },
                  { img: "/arbitrum.png",  label: "ARB"  },
                  { img: "/base.png",      label: "BASE" },
                  { img: "/robinhood.svg", label: "RH", bg: "#00C805", contain: true },
                ] as { img: string; label: string; bg?: string; contain?: boolean }[]).map((c, i) => (
                  <span
                    key={c.label}
                    className="hero-rise w-6 h-6 rounded-full overflow-hidden border border-white/10 flex-shrink-0"
                    style={{ animationDelay: `${0.15 + i * 0.06}s`, ...(c.bg ? { background: c.bg } : {}) }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={c.img} alt={c.label} className={c.contain ? "w-full h-full object-contain p-[3px]" : "w-full h-full object-cover"} />
                  </span>
                ))}
              </div>
            </div>

            {/* Middle: HEADLINE + subtitle. Pushed up a touch with margin-top:auto
                so the CTAs sit naturally at the bottom on tall viewports. */}
            <div className="mt-10 lg:mt-0">
              <h1
                className="hero-rise font-display uppercase font-extrabold tracking-[-0.03em] leading-[0.92] text-[clamp(2.1rem,9vw,3.4rem)] sm:text-[5rem] md:text-[6.4rem] lg:text-[8.2rem] xl:text-[9rem] max-w-[14ch]"
                style={{ animationDelay: "0.15s" }}
              >
                <span className="block text-white">The final layer for</span>
                <span className="block text-shimmer">stablecoin rails.</span>
              </h1>
              <p
                className="hero-rise mt-7 text-base sm:text-lg lg:text-lg xl:text-xl text-white/65 font-light leading-relaxed lg:whitespace-nowrap"
                style={{ animationDelay: "0.3s" }}
              >
                <span className="text-yellow font-semibold">Zero gas.</span> Twelve EVM chains.{" "}
                <span className="text-yellow font-semibold">Pure stablecoin flow.</span> Users pay in USDC, USDT, or RLUSD, and we cover the rest.
              </p>
            </div>

            {/* Bottom: CTAs + stats grid. Tight gap to subtitle now that
                the subtitle is a single line on wide screens — too much
                whitespace was making the card feel hollow. */}
            <div className="mt-8 lg:mt-10 flex flex-col gap-6">
              <div
                className="hero-rise flex flex-wrap items-center gap-3"
                style={{ animationDelay: "0.45s" }}
              >
                {/* Primary CTA — B2B / partnerships entry. */}
                <a
                  href="#contact"
                  className="group bg-yellow text-navy font-bold text-sm px-7 py-3.5 rounded-full hover:bg-yellow-hover transition-all hover:scale-[1.02] shadow-lg shadow-yellow/25"
                >
                  Talk to us
                  <span className="ml-2 inline-block group-hover:translate-x-1 transition-transform">→</span>
                </a>

                {/* Mid-tier CTA — sparkles to pull attention.
                    Uses the existing `animate-mypage` keyframe (yellow box-
                    shadow + border pulse, 1.8s loop) that already lives in
                    globals.css. Slight yellow tint background + yellow text
                    so it reads as the "fun" option between the formal primary
                    (Talk to us) and the calmer outline (See plans). */}
                <a
                  href="/event"
                  className="group relative bg-yellow/[0.06] text-yellow text-sm font-semibold px-7 py-3.5 rounded-full border border-yellow/40 hover:bg-yellow/10 transition-colors animate-mypage"
                >
                  <span className="inline-block mr-1.5 -translate-y-px">✦</span>
                  Start free trial
                </a>

                {/* Calm secondary — same pill geometry, outlined. */}
                <a
                  href="#pricing"
                  className="border border-white/15 text-white text-sm font-semibold px-7 py-3.5 rounded-full hover:bg-white/[0.04] hover:border-yellow/40 transition-colors"
                >
                  See plans
                </a>
              </div>

              {/* Stats grid — 2-col on phones, 4-col from sm+. Each tile is
                  a small glass card with a colored top accent stripe that
                  brightens on hover; live metrics (uptime, inclusion) get
                  a pulsing green dot, capability metrics (1 tx, chains)
                  get a static dot. */}
              <div
                className="hero-rise grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 max-w-6xl"
                style={{ animationDelay: "0.55s" }}
              >
                {[
                  { value: "99.99%",  label: "Uptime",            sub: "180-day rolling",  live: true,  accent: "yellow" },
                  { value: "<0.9 s",  label: "Inclusion time",    sub: "median, all chains", live: true,  accent: "yellow" },
                  { value: "23K+",    label: "MCP installs",      sub: "and growing",      live: true,  accent: "yellow" },
                  { value: "200K+",   label: "Settlements",       sub: "gasless, onchain", live: true,  accent: "cyan" },
                  { value: "1 tx",    label: "Full payment flow", sub: "EIP-712 + relay",  live: false, accent: "white" },
                  { value: "12",      label: "Chains live",       sub: "mainnet, today",   live: false, accent: "white" },
                ].map((s, i) => {
                  const stripeColor =
                    s.accent === "yellow" ? "rgba(245,197,24,0.55)"
                    : s.accent === "cyan" ? "rgba(34,211,238,0.55)"
                    : "rgba(255,255,255,0.35)";
                  const dotColor =
                    s.accent === "yellow" ? "#F5C518"
                    : s.accent === "cyan" ? "#22D3EE"
                    : "rgba(255,255,255,0.5)";
                  return (
                    <div
                      key={i}
                      className="group relative rounded-xl border border-white/10 backdrop-blur-sm px-5 py-4 overflow-hidden transition-all hover:border-yellow/30 hover:bg-white/[0.05] hover:-translate-y-0.5"
                      style={{ background: "rgba(255,255,255,0.03)" }}
                    >
                      {/* Top accent stripe — brightens on hover. */}
                      <span
                        aria-hidden
                        className="absolute top-0 left-0 right-0 h-[2px] opacity-70 group-hover:opacity-100 transition-opacity"
                        style={{ background: `linear-gradient(90deg, transparent, ${stripeColor}, transparent)` }}
                      />
                      {/* Live / static indicator dot. */}
                      <div className="flex items-center gap-1.5 mb-2">
                        <span
                          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.live ? "animate-pulse" : ""}`}
                          style={{
                            backgroundColor: dotColor,
                            boxShadow: s.live ? `0 0 6px ${dotColor}` : "none",
                          }}
                        />
                        <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-white/35 group-hover:text-white/55 transition-colors">
                          {s.live ? "Live" : "Spec"}
                        </span>
                      </div>
                      <div
                        className={`font-display font-extrabold text-3xl leading-none mb-2 tracking-[-0.02em] ${
                          s.accent === "yellow" ? "text-yellow"
                          : s.accent === "cyan" ? "text-cyan-300"
                          : "text-white"
                        }`}
                      >
                        {s.value}
                      </div>
                      <div className="text-[11px] font-semibold text-white/70 group-hover:text-white transition-colors">
                        {s.label}
                      </div>
                      <div className="text-[10px] text-white/30 mt-0.5">{s.sub}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </section>

      {showModal && <RegisterModal onClose={() => setShowModal(false)} />}
    </>
  );
}
