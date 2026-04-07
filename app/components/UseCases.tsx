"use client";

import { motion } from "framer-motion";

// ── Two primary use-case cards ────────────────────────────────────────────────

const PRIMARY = [
  {
    tag:      "dApps & Consumer Products",
    color:    "#F5C518",
    bg:       "rgba(245,197,24,0.06)",
    border:   "rgba(245,197,24,0.15)",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <circle cx="14" cy="14" r="13" stroke="#F5C518" strokeWidth="1.5" strokeOpacity="0.6"/>
        <path d="M9 14h10M14 9v10" stroke="#F5C518" strokeWidth="2" strokeLinecap="round"/>
      </svg>
    ),
    headline:    "Zero-gas UX for your users",
    description: "Your users click \"Pay\" and they're done. No MetaMask gas prompt, no native token needed. Q402 relayer sponsors every transaction — invisibly.",
    bullets: [
      "DeFi onboarding — interact immediately, no AVAX top-up",
      "NFT mints — no gas barrier, higher conversion",
      "SaaS subscriptions — one-time USDC approval, recurring collect",
      "In-game micro-payments — zero friction, no gas pop-up",
    ],
    cta:     "See how it works",
    ctaHref: "/#how-it-works",
  },
  {
    tag:      "AI Agent Infrastructure",
    color:    "#4AE54A",
    bg:       "rgba(74,229,74,0.04)",
    border:   "rgba(74,229,74,0.18)",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <rect x="2" y="8" width="24" height="14" rx="4" stroke="#4AE54A" strokeWidth="1.5" strokeOpacity="0.7"/>
        <circle cx="9"  cy="15" r="2.5" fill="#4AE54A" fillOpacity="0.8"/>
        <circle cx="14" cy="15" r="2.5" fill="#4AE54A" fillOpacity="0.5"/>
        <circle cx="19" cy="15" r="2.5" fill="#4AE54A" fillOpacity="0.3"/>
        <path d="M10 8V6M14 8V5M18 8V6" stroke="#4AE54A" strokeWidth="1.5" strokeLinecap="round" strokeOpacity="0.6"/>
      </svg>
    ),
    headline:    "Run hundreds of agents. Gas pre-funded.",
    description: "Load your Gas Tank once. Every agent in your fleet executes on-chain payments without managing private keys, wrapping native tokens, or ever running out of gas mid-operation.",
    bullets: [
      "Pre-fund a shared Gas Tank — agents draw automatically",
      "API key per project, not per agent — one key, unlimited agents",
      "Fully programmatic — agents call /api/relay with a signature",
      "Multi-chain — same key works on BNB, ETH, AVAX, X Layer, Stable",
    ],
    cta:     "View Gas Tank docs",
    ctaHref: "/docs#gas-tank",
  },
];

// ── Secondary use-case chips ──────────────────────────────────────────────────

const CHIPS = [
  "Web3 Gaming",
  "B2B USDC Payments",
  "Cross-App Wallets",
  "DAO Payroll",
  "Embedded Wallets",
  "Loyalty Rewards",
  "Cross-border Transfers",
  "Agentic Finance",
];

// ─────────────────────────────────────────────────────────────────────────────

export default function UseCases() {
  return (
    <section
      id="use-cases"
      className="py-28 px-6"
      style={{ background: "linear-gradient(180deg, #080E1A 0%, #0B1220 100%)" }}
    >
      <div className="max-w-6xl mx-auto">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-14"
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-4">Who uses Q402?</h2>
          <p className="text-white/40 max-w-lg mx-auto text-sm leading-relaxed">
            From consumer dApps to autonomous agent fleets — any product that moves value on-chain.
          </p>
        </motion.div>

        {/* Two primary cards */}
        <div className="grid md:grid-cols-2 gap-6 mb-10">
          {PRIMARY.map((item, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className="relative rounded-2xl p-8 flex flex-col gap-6 overflow-hidden"
              style={{
                background: item.bg,
                border: `1px solid ${item.border}`,
              }}
            >
              {/* Tag + icon */}
              <div className="flex items-center justify-between">
                <span
                  className="text-[11px] font-bold uppercase tracking-widest px-3 py-1 rounded-full border"
                  style={{ color: item.color, borderColor: item.border, background: `${item.color}12` }}
                >
                  {item.tag}
                </span>
                {item.icon}
              </div>

              {/* Headline */}
              <div>
                <h3 className="text-xl font-bold mb-2 leading-snug">{item.headline}</h3>
                <p className="text-white/45 text-sm leading-relaxed">{item.description}</p>
              </div>

              {/* Bullets */}
              <ul className="space-y-2.5">
                {item.bullets.map((b, j) => (
                  <li key={j} className="flex items-start gap-2.5 text-sm text-white/55">
                    <span className="mt-0.5 flex-shrink-0" style={{ color: item.color }}>✓</span>
                    {b}
                  </li>
                ))}
              </ul>

              {/* CTA link */}
              <div className="mt-auto pt-2">
                <a
                  href={item.ctaHref}
                  className="text-sm font-semibold transition-opacity hover:opacity-70"
                  style={{ color: item.color }}
                >
                  {item.cta} →
                </a>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Secondary chips */}
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="flex flex-wrap items-center justify-center gap-2"
        >
          <span className="text-white/20 text-xs mr-1">Also used for:</span>
          {CHIPS.map(chip => (
            <span
              key={chip}
              className="text-xs text-white/35 border border-white/8 rounded-full px-3 py-1 hover:text-white/60 hover:border-white/20 transition-colors cursor-default"
            >
              {chip}
            </span>
          ))}
        </motion.div>

      </div>
    </section>
  );
}
