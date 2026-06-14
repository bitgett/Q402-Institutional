"use client";

import { motion } from "framer-motion";

/**
 * LaunchHighlights — surfaces the three features that shipped together on
 * launch day so the landing page reflects what's actually live:
 *   1. Agentic Wallet v2  2. Aave V3 gasless yield  3. Chainlink CCIP bridge
 *
 * Visual language mirrors HowItWorks/UseCases (navy cards, yellow accent,
 * whileInView reveal). NO emoji glyphs — inline SVG icons only, per the
 * product UI rule. Yellow is the canonical brand gold (#F5C518).
 */

type Highlight = {
  tag: string;
  title: string;
  description: string;
  chips: string[];
  icon: React.ReactNode;
};

const ACCENT = "#F5C518";

const HIGHLIGHTS: Highlight[] = [
  {
    tag: "New · Agentic Wallet v2",
    title: "Wallets your agents can actually be trusted with",
    description:
      "A dedicated purse per agent with hard guardrails: per-transaction and daily spend caps, multi-payee batches, and on-chain ERC-8004 reputation gates. Up to 10 wallets per owner, all gasless.",
    chips: ["SPEND CAPS", "REPUTATION GATE", "BATCH × 20"],
    icon: (
      // shield + check (trust)
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    ),
  },
  {
    tag: "New · Aave V3 Yield",
    title: "Idle stablecoins earn — without touching gas",
    description:
      "Supply and withdraw on Aave V3 over BNB Chain straight from the Agent Wallet. The same EIP-7702 relay sponsors the gas, so your treasury compounds while paying $0 to move.",
    chips: ["GASLESS SUPPLY", "WITHDRAW ANYTIME", "BNB CHAIN"],
    icon: (
      // upward trend
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 17l6-6 4 4 7-7" />
        <path d="M17 8h4v4" />
      </svg>
    ),
  },
  {
    tag: "New · Chainlink CCIP Bridge",
    title: "Move USDC across chains in one signed request",
    description:
      "Native USDC bridging over Chainlink CCIP across the Ethereum, Avalanche, and Arbitrum triangle. Quote, send, and track from the dashboard or MCP — no manual bridge hops.",
    chips: ["ETH · AVAX · ARB", "NATIVE USDC", "CCIP"],
    icon: (
      // bridge / cross-chain link
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10 8a4 4 0 0 0-4 4H4m6 4a4 4 0 0 1-4-4" />
        <path d="M14 8a4 4 0 0 1 4 4h2m-6 4a4 4 0 0 0 4-4" />
        <path d="M9 12h6" />
      </svg>
    ),
  },
];

export default function LaunchHighlights() {
  return (
    <section id="launch" className="py-28 px-6" style={{ background: "linear-gradient(180deg, #080E1A 0%, #0B1220 100%)" }}>
      <div className="max-w-6xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <span className="inline-block text-[11px] font-mono font-bold uppercase tracking-[0.28em] text-yellow mb-4">
            Shipped today
          </span>
          <h2 className="text-3xl md:text-4xl font-bold mb-4">Three launches, one gasless rail</h2>
          <p className="text-white/40 max-w-xl mx-auto text-sm leading-relaxed">
            Agentic Wallet v2, Aave V3 yield, and the Chainlink CCIP bridge all run on the same EIP-712 + EIP-7702 settlement layer. No new keys, no new gas.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-6">
          {HIGHLIGHTS.map((h, i) => (
            <motion.div
              key={h.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className="card-glow flex flex-col"
              style={{ background: "#0F1929", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "16px", padding: "24px" }}
            >
              <div
                className="w-11 h-11 rounded-xl flex items-center justify-center mb-5 flex-shrink-0"
                style={{ color: ACCENT, background: "rgba(245,197,24,0.1)", border: "1px solid rgba(245,197,24,0.22)" }}
              >
                {h.icon}
              </div>

              <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-yellow/80 mb-2">
                {h.tag}
              </div>
              <h3 className="font-semibold text-[15px] leading-snug mb-2.5">{h.title}</h3>
              <p className="text-white/40 text-sm leading-relaxed mb-5">{h.description}</p>

              <div className="mt-auto flex flex-wrap gap-1.5">
                {h.chips.map((chip) => (
                  <span
                    key={chip}
                    className="text-[9px] font-mono font-bold uppercase tracking-[0.14em] px-2 py-0.5 rounded-full"
                    style={{ color: ACCENT, border: "1px solid rgba(245,197,24,0.25)", background: "rgba(245,197,24,0.05)" }}
                  >
                    {chip}
                  </span>
                ))}
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
