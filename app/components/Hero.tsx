"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import RegisterModal from "./RegisterModal";


export default function Hero() {
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <section className="min-h-screen flex flex-col justify-center px-6 pt-20 pb-16 relative overflow-hidden" style={{ background: "radial-gradient(ellipse at 20% 10%, #1A1530 0%, transparent 55%), radial-gradient(ellipse at 85% 90%, #0E1A2E 0%, transparent 60%), linear-gradient(160deg, #06060C 0%, #0A0E1C 45%, #10142A 100%)" }}>
        {/* Background glows */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          {/* Warm yellow core */}
          <motion.div
            className="absolute top-1/2 left-[22%] -translate-y-1/2 w-[640px] h-[640px] rounded-full blur-[160px]"
            animate={{ opacity: [0.55, 0.9, 0.55], scale: [1, 1.08, 1] }}
            transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
            style={{ background: "rgba(245,197,24,0.07)" }}
          />
          {/* Violet accent top-right */}
          <motion.div
            className="absolute -top-10 right-[12%] w-[440px] h-[440px] rounded-full blur-[130px]"
            animate={{ opacity: [0.5, 0.85, 0.5] }}
            transition={{ duration: 11, repeat: Infinity, ease: "easeInOut", delay: 1.5 }}
            style={{ background: "rgba(139,92,246,0.09)" }}
          />
          {/* Cyan accent bottom-right */}
          <motion.div
            className="absolute bottom-[8%] right-[28%] w-[360px] h-[360px] rounded-full blur-[120px]"
            animate={{ opacity: [0.4, 0.75, 0.4] }}
            transition={{ duration: 13, repeat: Infinity, ease: "easeInOut", delay: 3 }}
            style={{ background: "rgba(56,189,248,0.06)" }}
          />
          {/* Deep red-orange ember bottom-left */}
          <motion.div
            className="absolute bottom-[4%] left-[8%] w-[320px] h-[320px] rounded-full blur-[110px]"
            animate={{ opacity: [0.35, 0.65, 0.35] }}
            transition={{ duration: 10, repeat: Infinity, ease: "easeInOut", delay: 2 }}
            style={{ background: "rgba(232,65,66,0.05)" }}
          />
          {/* Diagonal light sweep */}
          <div
            className="absolute -top-[20%] -left-[10%] w-[120%] h-[60%] blur-[80px] rotate-[-12deg] pointer-events-none"
            style={{ background: "linear-gradient(90deg, transparent 0%, rgba(255,235,180,0.035) 50%, transparent 100%)" }}
          />
          {/* Grid overlay — covers the whole hero, softly fades at edges */}
          <div className="absolute inset-0 opacity-[0.09]" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)", backgroundSize: "56px 56px", maskImage: "radial-gradient(ellipse at center, black 55%, transparent 100%)", WebkitMaskImage: "radial-gradient(ellipse at center, black 55%, transparent 100%)" }} />
        </div>

        <div className="relative z-10 w-full max-w-6xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-16 items-center">

            {/* LEFT */}
            <div>
              {/* Claude × Quack AI ribbon — links to /docs#claude-mcp */}
              <motion.a
                href="/docs#claude-mcp"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.05 }}
                whileHover={{ y: -2 }}
                className="group inline-flex items-center gap-2.5 px-3.5 py-1.5 rounded-full mb-6 relative overflow-hidden"
                style={{
                  background: "linear-gradient(120deg, rgba(245,158,11,0.10) 0%, rgba(245,197,24,0.08) 60%, rgba(139,92,246,0.06) 100%)",
                  border: "1px solid rgba(245,158,11,0.28)",
                  boxShadow: "0 0 22px rgba(245,158,11,0.10)",
                }}
              >
                {/* Animated shine */}
                <motion.span
                  className="absolute inset-y-0 w-12 -skew-x-12 pointer-events-none"
                  initial={{ x: "-120%" }}
                  animate={{ x: "260%" }}
                  transition={{ duration: 3.6, repeat: Infinity, repeatDelay: 2.4, ease: "easeInOut" }}
                  style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent)" }}
                />
                <span className="relative w-1.5 h-1.5 rounded-full bg-orange-300 animate-pulse" />
                <span className="relative text-[10px] font-bold uppercase tracking-[0.18em] text-orange-300/90">
                  Claude × Quack AI
                </span>
                <span className="relative text-white/30 text-xs">·</span>
                <span className="relative text-xs text-white/75 font-medium">
                  Now live in Claude Desktop
                </span>
                <span className="relative text-orange-300/80 text-xs ml-0.5 group-hover:translate-x-0.5 transition-transform">
                  →
                </span>
              </motion.a>

              {/* Chain logos */}
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.1 }}
                className="flex items-center gap-5 mb-8"
              >
                {[
                  { img: "/bnb.png",       color: "#F0B90B", label: "BNB"  },
                  { img: "/eth.png",       color: "#627EEA", label: "ETH"  },
                  { img: "/mantle.png",    color: "#FFFFFF", label: "MNT"  },
                  { img: "/avax.png",      color: "#E84142", label: "AVAX" },
                  { img: "/injective.png", color: "#0082FA", label: "INJ"  },
                  { img: "/xlayer.png",    color: "#CCCCCC", label: "X"    },
                  { img: "/stable.jpg",    color: "#4AE54A", label: "STB"  },
                ].map((c, i) => (
                  <motion.div
                    key={c.label}
                    initial={{ opacity: 0, scale: 0.7 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.4, delay: 0.15 + i * 0.07 }}
                    className="relative flex-shrink-0"
                  >
                    {/* Pulse ring */}
                    <motion.div
                      className="absolute inset-0 rounded-full"
                      animate={{ scale: [1, 1.55, 1], opacity: [0.5, 0, 0.5] }}
                      transition={{ duration: 2.4, delay: i * 0.48, repeat: Infinity, ease: "easeInOut" }}
                      style={{ background: `radial-gradient(circle, ${c.color}40 0%, transparent 70%)` }}
                    />
                    {/* Logo */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={c.img}
                      alt={c.label}
                      className="w-8 h-8 rounded-full object-cover relative z-10"
                      style={{ boxShadow: `0 0 10px ${c.color}50` }}
                    />
                  </motion.div>
                ))}
                <span className="text-white/20 text-xs ml-1">7 chains live</span>
              </motion.div>

              {/* Headline */}
              <motion.div
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, delay: 0.2 }}
              >
                <h1 className="text-5xl md:text-[3.8rem] font-extrabold leading-[1.06] mb-4 tracking-tight">
                  The final layer for{" "}
                  <span className="text-shimmer">stablecoin rails.</span>
                </h1>
                <p className="text-xl text-white/45 font-light tracking-wide mb-6">
                  <span className="text-[#4AE54A] font-semibold">Zero gas.</span> Seven EVM chains. <span className="text-[#4AE54A] font-semibold">Pure stablecoin flow</span> — users pay in USDC, USDT, or RLUSD, we cover the rest.
                </p>
              </motion.div>

              {/* Feature list */}
              <motion.ul
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.35 }}
                className="space-y-3 mb-9 text-sm text-white/50"
              >
                {[
                  "EIP-712 off-chain — users never hold a gas token",
                  "One relay call — we cover micro-gas on every chain",
                  "USDC / USDT / RLUSD settle in seconds, every tx auditable on-chain",
                ].map((item, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="text-yellow font-bold text-xs mt-0.5 flex-shrink-0">0{i + 1}</span>
                    {item}
                  </li>
                ))}
              </motion.ul>

              {/* CTAs */}
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.45 }}
                className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mb-10"
              >
                <button
                  onClick={() => setShowModal(true)}
                  className="group relative bg-yellow text-navy font-bold text-sm px-8 py-4 rounded-full hover:bg-yellow-hover transition-all hover:scale-105 shadow-lg shadow-yellow/25 animate-glow"
                >
                  Start Gasless
                  <span className="ml-2 group-hover:translate-x-1 inline-block transition-transform">→</span>
                </button>
                <a
                  href="#how-it-works"
                  className="flex items-center gap-2 text-sm text-white/40 hover:text-white transition-colors"
                >
                  <span className="w-8 h-8 rounded-full border border-white/12 flex items-center justify-center text-xs">↓</span>
                  See how it works
                </a>
              </motion.div>

              {/* Stats — verifiable infra metrics. Sized to fit four data points
                  on a single row at the lg breakpoint; wraps on narrower screens. */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.6, delay: 0.55 }}
                className="flex flex-wrap lg:flex-nowrap items-center gap-3 lg:gap-4"
              >
                <div className="text-center">
                  <div className="text-lg font-bold font-mono text-yellow whitespace-nowrap">99.99%</div>
                  <div className="text-[10px] text-white/30 mt-0.5 whitespace-nowrap">Uptime</div>
                </div>
                <div className="w-px h-9 bg-white/8" />
                <div className="text-center">
                  <div className="text-lg font-bold font-mono text-yellow whitespace-nowrap">&lt;0.9 sec</div>
                  <div className="text-[10px] text-white/30 mt-0.5 whitespace-nowrap">Inclusion time</div>
                </div>
                <div className="w-px h-9 bg-white/8" />
                <div className="text-center">
                  <div className="text-lg font-bold whitespace-nowrap">1 tx</div>
                  <div className="text-[10px] text-white/30 mt-0.5 whitespace-nowrap">full payment flow</div>
                </div>
                <div className="w-px h-9 bg-white/8" />
                <div className="text-center">
                  <div className="text-lg font-bold whitespace-nowrap">7 chains</div>
                  <div className="text-[10px] text-white/30 mt-0.5 whitespace-nowrap">mainnet live</div>
                </div>
              </motion.div>
            </div>

            {/* RIGHT: terminal */}
            <motion.div
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.8, delay: 0.3 }}
              className="animate-float"
            >
              <div className="relative">
                <div className="absolute -inset-4 rounded-3xl blur-2xl opacity-20" style={{ background: "radial-gradient(ellipse, #F5C518 0%, transparent 70%)" }} />

                <div className="relative bg-[#060C14] border rounded-2xl overflow-hidden shadow-2xl shadow-black/70" style={{ borderColor: "rgba(245,197,24,0.12)" }}>
                  {/* Titlebar */}
                  <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ background: "rgba(255,255,255,0.025)", borderColor: "rgba(255,255,255,0.06)" }}>
                    <span className="w-3 h-3 rounded-full bg-red-500/60" />
                    <span className="w-3 h-3 rounded-full bg-yellow/50" />
                    <span className="w-3 h-3 rounded-full bg-green-400/50" />
                    <span className="ml-4 text-white/20 text-xs font-mono">q402-sdk · v1.6.0</span>
                    <div className="ml-auto flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400" style={{ boxShadow: "0 0 5px #4ade80" }} />
                      <span className="text-[10px] text-white/25 font-mono">connected</span>
                    </div>
                  </div>

                  {/* Code */}
                  <div className="p-5 font-mono text-xs leading-[1.7]">
                    <div className="text-white/20 mb-3">{"// Drop the SDK into any page"}</div>
                    <div className="mb-3">
                      <span className="text-white/40">&lt;</span>
                      <span className="text-blue-300">script</span>
                      <span className="text-green-300"> src</span>
                      <span className="text-white/40">=</span>
                      <span className="text-orange-300">&quot;https://q402.quackai.ai/q402-sdk.js&quot;</span>
                      <span className="text-white/40">&gt;&lt;/</span>
                      <span className="text-blue-300">script</span>
                      <span className="text-white/40">&gt;</span>
                    </div>

                    <div className="text-white/20 mb-1">{"// Initialize once"}</div>
                    <div>
                      <span className="text-purple-400">const</span>
                      <span className="text-blue-300"> q402 </span>
                      <span className="text-white/40">= </span>
                      <span className="text-yellow">new</span>
                      <span className="text-blue-300"> Q402Client</span>
                      <span className="text-white/40">{"({"}</span>
                    </div>
                    <div className="pl-5">
                      <div><span className="text-green-300">apiKey</span><span className="text-white/40">: </span><span className="text-orange-300">&quot;q402_live_...&quot;</span><span className="text-white/40">,</span></div>
                      <div><span className="text-green-300">chain</span><span className="text-white/40">:  </span><span className="text-orange-300">&quot;bnb&quot;</span><span className="text-white/30"> {"// or avax | eth | mantle | injective | xlayer | stable"}</span></div>
                    </div>
                    <div className="text-white/40 mb-4">{"});"}</div>

                    <div className="text-white/20 mb-1">{"// User signs — zero gas, one call"}</div>
                    <div className="mb-4">
                      <span className="text-purple-400">const</span>
                      <span className="text-white"> result </span>
                      <span className="text-white/40">= </span>
                      <span className="text-yellow">await</span>
                      <span className="text-blue-300"> q402</span>
                      <span className="text-white/40">.</span>
                      <span className="text-blue-300">pay</span>
                      <span className="text-white/40">{"({ "}</span>
                      <span className="text-green-300">to</span>
                      <span className="text-white/40">, </span>
                      <span className="text-green-300">amount</span>
                      <span className="text-white/40">: </span>
                      <span className="text-orange-300">&quot;50.00&quot;</span>
                      <span className="text-white/40">, </span>
                      <span className="text-green-300">token</span>
                      <span className="text-white/40">: </span>
                      <span className="text-orange-300">&quot;USDC&quot;</span>
                      <span className="text-white/40"> {"});"}</span>
                    </div>

                    <div className="border-t pt-3 space-y-0.5" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
                      <div><span className="text-white/20">{"// ✓ "}</span><span className="text-green-400">result.success</span><span className="text-white/30">: true</span></div>
                      <div><span className="text-white/20">{"// ✓ "}</span><span className="text-green-400">gas paid by user</span><span className="text-white/30">: </span><span className="text-yellow font-bold">$0.000000</span><span className="cursor" /></div>
                    </div>
                  </div>

                  {/* Chain status bar */}
                  <div className="px-5 py-2.5 border-t flex items-center justify-between" style={{ background: "rgba(255,255,255,0.015)", borderColor: "rgba(255,255,255,0.06)" }}>
                    <div className="flex items-center gap-4">
                      {[
                        { label: "BNB",  img: "/bnb.png",       rounded: "rounded-full" },
                        { label: "ETH",  img: "/eth.png",       rounded: "rounded-full" },
                        { label: "MNT",  img: "/mantle.png",    rounded: "rounded-full" },
                        { label: "AVAX", img: "/avax.png",      rounded: "rounded-full" },
                        { label: "INJ",  img: "/injective.png", rounded: "rounded-full" },
                        { label: "X",    img: "/xlayer.png",    rounded: "rounded-full" },
                        { label: "STB",  img: "/stable.jpg",    rounded: "rounded-full" },
                      ].map((c) => (
                        <span key={c.label} className="flex items-center gap-1 text-[10px] font-mono text-white/30">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={c.img} alt={c.label} className={`w-3 h-3 ${c.rounded} opacity-80`} />
                          {c.label}
                        </span>
                      ))}
                    </div>
                    <span className="text-[10px] text-white/20 font-mono">EIP-712 + EIP-7702</span>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {showModal && <RegisterModal onClose={() => setShowModal(false)} />}
    </>
  );
}
