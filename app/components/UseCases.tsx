"use client";

import { useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

/**
 * Built for every use case — interactive single-card tabbed showcase.
 *
 * Instead of a 6-card grid, one card body that swaps content as the user
 * picks a tab. AI Agents is the default + only tab that shows a chat
 * transcript; the others show a short code snippet contextual to the use
 * case. Section background carries a mouse-tracking spotlight + dot grid.
 */

type ChatTurn = {
  role: "you" | "agent";
  via?: string;
  body: string;
  meta?: string;
};

type CodeLine = {
  /** "comment" / "code" / "ok" */
  kind: "comment" | "code" | "ok";
  text: string;
};

type Tab = {
  key:        string;
  icon:       string;
  label:      string;          // short tab label
  category:   string;          // overline above the hook
  hook:       string;          // BIG headline
  description: string;
  chips:      string[];
  /** AI tab uses transcript, others use code. Exactly one must be set. */
  transcript?: ChatTurn[];
  code?:      CodeLine[];
};

const TABS: Tab[] = [
  {
    key:      "ai",
    icon:     "◎",
    label:    "AI Agents",
    category: "Agent Infrastructure · New",
    hook:     "Tell your agent. It pays.",
    description:
      "Pre-fund one Gas Tank per chain and let Claude, Codex, Cline — or your own agent — call Q402 through MCP. Five tools, signed Trust Receipts on every settlement, sandbox by default, 2,000 sponsored TX to start.",
    chips: ["5 MCP TOOLS", "BATCH × 20", "TRUST RECEIPTS", "SANDBOX DEFAULT"],
    transcript: [
      { role: "you",   body: "Send 5 USDC to vitalik.eth on BNB." },
      {
        role: "agent", via: "Claude",
        body: 'q402_pay({chain:"bnb", token:"USDC", to:"vitalik.eth", amount:"5"})',
        meta: "✓ sent · 412ms · gas $0 · rct_8f2a…",
      },
      { role: "you",   body: "Now pay 0.50 USDT to each of these 3 contractors." },
      {
        role: "agent", via: "Codex",
        body: 'q402_batch_pay({recipients: [3 rows], token:"USDT"})',
        meta: "✓ 3/3 sent · 1.1s · gas $0 · rct_3c1d…",
      },
    ],
  },
  {
    key:      "defi",
    icon:     "⬡",
    label:    "DeFi",
    category: "Onboarding",
    hook:     "Stop making them buy ETH first.",
    description:
      "First swap, first stake, first vote — one signature, no gas chase. Your treasury covers the relay so a day-1 wallet doesn't dead-end at \"you need gas to do anything.\"",
    chips: ["ONE SIGNATURE", "ZERO TOP-UP", "ANY EOA"],
    code: [
      { kind: "comment", text: "// New user joins your dApp. Already has USDC. Doesn't have ETH." },
      { kind: "code",    text: 'await q402.pay({ to: protocol, amount: "100", token: "USDC", chain: "eth" })' },
      { kind: "ok",      text: "→ Staked. One signature. No top-up step." },
    ],
  },
  {
    key:      "nft",
    icon:     "◈",
    label:    "NFT Drops",
    category: "Drops",
    hook:     "Collectors touch USDC. You touch the chain.",
    description:
      "Stablecoin-priced drops where the mint TX gas debits your Gas Tank, not theirs. Allowlist holders mint without scrambling for L2 gas at the worst possible moment.",
    chips: ["USDC-PRICED", "NO L2 TOP-UP", "ALLOWLIST-SAFE"],
    code: [
      { kind: "comment", text: "// Mint priced at 25 USDC; collector pays in USDC, you cover the chain gas." },
      { kind: "code",    text: 'await q402.pay({ to: mintContract, amount: "25", token: "USDC", chain: "bnb" })' },
      { kind: "ok",      text: "→ Minted. Allowlist row decremented. Gas debited from your tank." },
    ],
  },
  {
    key:      "gaming",
    icon:     "◆",
    label:    "Gaming",
    category: "In-Game Economy",
    hook:     "$0.05 swords. Sub-cent settle.",
    description:
      "Micro-transactions priced at chain economics, not gas economics. Batch a tournament's prize payouts in one signed call across any of the 7 supported chains.",
    chips: ["BATCH × 20", "ANY CHAIN", "SUB-CENT FEES"],
    code: [
      { kind: "comment", text: "// Tournament ends. Distribute prize payouts to 20 winners in one call." },
      { kind: "code",    text: "await q402.batchPay({ token: \"USDT\", recipients: winners })" },
      { kind: "ok",      text: "→ 20/20 sent · sub-cent fee · gas debited once" },
    ],
  },
  {
    key:      "b2b",
    icon:     "▣",
    label:    "B2B Payments",
    category: "Settlement",
    hook:     "Invoices clear in 400ms.",
    description:
      "USDC, USDT, or RLUSD between businesses with an ECDSA-signed Trust Receipt per TX. Your accountant gets a verifiable receipt chain instead of a CSV.",
    chips: ["7-CHAIN", "TRUST RECEIPTS", "~400ms"],
    code: [
      { kind: "comment", text: "// Settle vendor invoice + fetch the receipt for the audit trail." },
      { kind: "code",    text: 'const { receiptId } = await q402.pay({ to: vendor, amount: "12500", token: "USDC" })' },
      { kind: "code",    text: 'const receipt = await q402.receipt(receiptId)  // ECDSA-verifiable' },
      { kind: "ok",      text: "→ Settled · receipt rct_8f2a… (signed by relayer EOA)" },
    ],
  },
  {
    key:      "wallets",
    icon:     "▲",
    label:    "Wallets",
    category: "Embedded Wallets",
    hook:     "Plug it in. Gas disappears.",
    description:
      "Privy, Dynamic, Magic — vanilla EOAs delegate payment authority via EIP-7702. No 4337 bundler, no smart-account migration, no chain-specific paymaster.",
    chips: ["NO 4337", "ANY EMBEDDED WALLET", "EIP-7702"],
    code: [
      { kind: "comment", text: "// Pair Q402 with your embedded wallet — vanilla EOA, no smart-account migration." },
      { kind: "code",    text: "import { Q402Client } from '@quackai/q402-sdk'" },
      { kind: "code",    text: "const q402 = new Q402Client({ apiKey, signer: privy.signer })" },
      { kind: "ok",      text: "→ EIP-7702 delegation installed transaction-by-transaction" },
    ],
  },
];

const containerVariants = {
  hidden:  {},
  visible: { transition: { delayChildren: 0.1, staggerChildren: 0.06 } },
};

const headerVariants = {
  hidden:  { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] as const } },
};

export default function UseCases() {
  const [activeKey, setActiveKey] = useState<string>(TABS[0].key);
  const active = TABS.find(t => t.key === activeKey) ?? TABS[0];

  // Mouse-tracking spotlight at the section level.
  const sectionRef = useRef<HTMLElement>(null);
  function handleMove(e: React.PointerEvent<HTMLElement>) {
    const node = sectionRef.current;
    if (!node) return;
    const r = node.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width)  * 100;
    const y = ((e.clientY - r.top)  / r.height) * 100;
    node.style.setProperty("--spot-x", `${x}%`);
    node.style.setProperty("--spot-y", `${y}%`);
  }

  return (
    <section
      ref={sectionRef}
      onPointerMove={handleMove}
      id="use-cases"
      className="use-case-spotlight py-28 px-6 relative overflow-hidden"
    >
      <div className="max-w-6xl mx-auto relative">
        {/* Header */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-100px" }}
          variants={containerVariants}
          className="text-center mb-12"
        >
          <motion.div
            variants={headerVariants}
            className="text-[11px] font-mono tracking-[0.3em] text-yellow/70 mb-4"
          >
            USE&nbsp;CASES &nbsp;·&nbsp; 06&nbsp;PATTERNS
          </motion.div>
          <motion.h2
            variants={headerVariants}
            className="font-display text-3xl md:text-5xl font-bold tracking-tight mb-4"
          >
            Built for every use case
          </motion.h2>
          <motion.p
            variants={headerVariants}
            className="text-white/55 max-w-xl mx-auto text-base"
          >
            Any product that needs seamless, gasless USDC, USDT, or RLUSD transfers on EVM.
          </motion.p>
        </motion.div>

        {/* Tab pill row */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-wrap justify-center gap-2 mb-10"
        >
          {TABS.map(t => {
            const isActive = t.key === activeKey;
            return (
              <button
                key={t.key}
                onClick={() => setActiveKey(t.key)}
                className={`relative px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 border ${
                  isActive
                    ? "bg-yellow text-navy border-yellow shadow-lg shadow-yellow/20"
                    : "bg-white/[0.03] text-white/65 border-white/10 hover:border-yellow/30 hover:text-white"
                }`}
              >
                <span className="mr-1.5 opacity-80">{t.icon}</span>
                {t.label}
                {t.key === "ai" && !isActive && (
                  <span className="ml-2 text-[9px] font-bold uppercase tracking-widest text-yellow/80">
                    new
                  </span>
                )}
              </button>
            );
          })}
        </motion.div>

        {/* The single hero card — content swaps on tab change */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="
            relative overflow-hidden rounded-3xl
            card-glow card-hero-glow
            bg-gradient-to-br from-[#131E30] via-[#0F1929] to-[#0B1220]
            border border-yellow/25
            p-8 md:p-10 lg:p-12
          "
        >
          {/* Decorative top-right glow blob */}
          <div
            aria-hidden
            className="absolute -top-32 -right-32 w-96 h-96 rounded-full pointer-events-none"
            style={{
              background:
                "radial-gradient(circle, rgba(245,197,24,0.18) 0%, rgba(245,197,24,0) 70%)",
            }}
          />

          {/* Cross-fade animated container */}
          <AnimatePresence mode="wait">
            <motion.div
              key={active.key}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              className="grid lg:grid-cols-12 gap-8 lg:gap-12 relative z-10"
            >
              {/* LEFT: hook + body + chips */}
              <div className="lg:col-span-6 flex flex-col">
                <div className="flex items-center gap-3 mb-5 flex-wrap">
                  <span className="text-4xl text-yellow leading-none">{active.icon}</span>
                  <span className="text-[10px] font-mono tracking-[0.25em] uppercase text-yellow/75">
                    {active.category}
                  </span>
                </div>
                <h3 className="font-display text-3xl md:text-4xl lg:text-5xl font-bold tracking-tight mb-5 leading-[1.05]">
                  {active.hook}
                </h3>
                <p className="text-white/70 text-base lg:text-[15px] leading-relaxed mb-6 max-w-md">
                  {active.description}
                </p>
                <div className="flex flex-wrap gap-2 mt-auto">
                  {active.chips.map(c => (
                    <span
                      key={c}
                      className="text-[10px] font-mono tracking-widest uppercase text-yellow/80 border border-yellow/25 rounded-full px-2.5 py-1"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              </div>

              {/* RIGHT: chat transcript OR code block */}
              <div className="lg:col-span-6">
                <div className="h-full rounded-2xl bg-black/35 border border-white/8 p-5 md:p-6 font-mono text-[12.5px]">
                  {active.transcript ? (
                    <div className="space-y-4">
                      {active.transcript.map((turn, i) => {
                        // Each agent gets its own brand-ish accent so the
                        // multi-agent compatibility reads at a glance —
                        // Claude in copper/orange (Anthropic-ish), Codex in
                        // green (OpenAI-ish), Cline in cyan, fallback yellow.
                        const agentTheme =
                          turn.role !== "agent"
                            ? { badge: "bg-white/8 text-white/60", dot: "" }
                            : turn.via === "Claude"
                              ? { badge: "bg-[#D97757]/15 text-[#E89070] border border-[#D97757]/30", dot: "bg-[#E89070]" }
                              : turn.via === "Codex"
                                ? { badge: "bg-emerald-400/15 text-emerald-300 border border-emerald-400/30", dot: "bg-emerald-300" }
                                : turn.via === "Cline"
                                  ? { badge: "bg-cyan-400/15 text-cyan-300 border border-cyan-400/30", dot: "bg-cyan-300" }
                                  : { badge: "bg-yellow/15 text-yellow/90 border border-yellow/30", dot: "bg-yellow" };
                        return (
                        <div key={i}>
                          <div className="flex items-center gap-2 mb-1.5">
                            <span
                              className={`inline-flex items-center gap-1.5 text-[9px] tracking-[0.25em] uppercase px-1.5 py-0.5 rounded ${agentTheme.badge}`}
                            >
                              {turn.role === "agent" && (
                                <span className={`w-1.5 h-1.5 rounded-full ${agentTheme.dot}`} />
                              )}
                              {turn.role === "you" ? "you" : (turn.via ?? "agent")}
                            </span>
                            {turn.role === "agent" && (
                              <span className="text-[9px] tracking-widest uppercase text-white/30">
                                via Q402 / MCP
                              </span>
                            )}
                          </div>
                          <div
                            className={
                              turn.role === "you"
                                ? "text-white/85 leading-snug pl-1"
                                : "text-white/60 leading-snug pl-1 break-words"
                            }
                          >
                            {turn.role === "you" && <span className="text-yellow/70 mr-2">▸</span>}
                            {turn.body}
                          </div>
                          {turn.meta && (
                            <div className="pl-1 mt-1 text-emerald-400/90 break-words">
                              {turn.meta}
                            </div>
                          )}
                        </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="space-y-2 leading-relaxed">
                      {active.code?.map((ln, i) => (
                        <div
                          key={i}
                          className={
                            ln.kind === "comment"
                              ? "text-white/35"
                              : ln.kind === "ok"
                                ? "text-emerald-400/90"
                                : "text-white/85 break-words"
                          }
                        >
                          {ln.text}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </AnimatePresence>
        </motion.div>
      </div>
    </section>
  );
}
