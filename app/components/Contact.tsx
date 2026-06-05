"use client";

import { useState } from "react";
import RegisterModal from "./RegisterModal";

// ─── AI client chips ─────────────────────────────────────────────────────────
// Real brand marks served from /public/logos/. Anthropic Claude in brand
// orange, OpenAI mark for Codex, Cursor white, Cline light grey — sourced
// from simple-icons + iconify and saved locally so the page works offline.

const AI_CLIENTS: { name: string; src: string }[] = [
  { name: "Claude", src: "/logos/claude.svg" },
  { name: "Codex",  src: "/logos/codex.svg"  },
  { name: "Cursor", src: "/logos/cursor.svg" },
  { name: "Cline",  src: "/logos/cline.svg"  },
];

// ─── Mini-conversation cards ─────────────────────────────────────────────────
// Each card is a self-contained YOU → Q402 dialogue: the user describes the
// intent in natural language, the agent responds with what the settlement
// layer actually does. Two LIVE (single transfer, batch) ground the section
// in shipping product; two ROADMAP (scheduled, treasury routing) show where
// it's headed. The LIVE/ROADMAP pill keeps the line between the two honest.

type PromptCard = {
  category: string;
  status:   "LIVE" | "ROADMAP";
  prompt:   ({ t: string; hl?: boolean })[];
  reply:    string;     // one-line description of what Q402 does
  tags:     string[];
};

const PROMPTS: PromptCard[] = [
  {
    category: "Single transfer",
    status:   "LIVE",
    prompt: [
      { t: "“Send "                 },
      { t: "1 USDT",       hl: true },
      { t: " on "                   },
      { t: "BNB Chain",    hl: true },
      { t: " to "                   },
      { t: "0xf5cd…5c28",  hl: true },
      { t: " and show me the Trust Receipt.”" },
    ],
    reply: "Single gasless transfer. Settled in under a second, signed Trust Receipt attached.",
    tags:  ["q402_pay", "$0 payer gas", "Trust Receipt"],
  },
  {
    category: "Batch payouts",
    status:   "LIVE",
    prompt: [
      { t: "“Send "                 },
      { t: "0.5 USDC",     hl: true },
      { t: " to these "             },
      { t: "20 winners",   hl: true },
      { t: " and export the receipt list as CSV.”" },
    ],
    reply: "20 recipients in one signed batch. Receipts exported.",
    tags:  ["q402_batch_pay", "≤20 recipients", "CSV export"],
  },
  {
    category: "Cheapest route",
    status:   "LIVE",
    prompt: [
      { t: "“Find the cheapest chain to send "         },
      { t: "100 USDC",       hl: true                  },
      { t: " to "                                      },
      { t: "0x9c4f…7e2a",    hl: true                  },
      { t: " right now.”"                              },
    ],
    reply: "Live gas quotes across all 10 chains, ranked by total cost.",
    tags:  ["q402_quote", "gas ranking", "multichain"],
  },
  {
    category: "Receipt audit",
    status:   "LIVE",
    prompt: [
      { t: "“Verify "                                              },
      { t: "rct_a3f1…4d8b", hl: true                               },
      { t: " was signed by Q402’s facilitator on-chain.”"          },
    ],
    reply: "ECDSA recovered from on-chain state — verifiable without Q402.",
    tags:  ["q402_receipt", "ECDSA recovery", "local verify"],
  },
  {
    category: "Scheduled recurring",
    status:   "LIVE",
    prompt: [
      { t: "“Every month on the "  },
      { t: "7th",         hl: true },
      { t: ", send "               },
      { t: "25 USDT",     hl: true },
      { t: " to my contractor — unless I cancel by the " },
      { t: "5th",         hl: true },
      { t: ".”"                    },
    ],
    reply: "Set the rule once on the wallet, get a cancel window before every fire, walk away.",
    tags:  ["scheduled", "cancel window", "wallet-attached"],
  },
  {
    category: "Treasury automation",
    status:   "ROADMAP",
    prompt: [
      { t: "“On the "                          },
      { t: "3rd of every month",   hl: true    },
      { t: ", sweep my idle "                  },
      { t: "USDC",                 hl: true    },
      { t: " into the "                        },
      { t: "highest-yielding Morpho vault",
                                    hl: true   },
      { t: ".”"                                },
    ],
    reply: "Scheduled yield routing into the top-performing vault.",
    tags:  ["scheduled", "vault routing", "auto-rebalance"],
  },
];

export default function Contact() {
  const [showModal, setShowModal] = useState(false);

  return (
    <section
      id="contact"
      className="relative py-20 lg:py-24 px-6 overflow-hidden"
      style={{ background: "linear-gradient(180deg, transparent 0%, rgba(245,197,24,0.025) 50%, transparent 100%)" }}
    >
      {/* Soft top-of-section halo behind the headline. Compact so the
          section doesn't visually push another 200px of empty atmosphere
          above the content. */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-[360px] pointer-events-none"
        style={{ background: "radial-gradient(ellipse 50% 70% at 50% 0%, rgba(245,197,24,0.07), transparent 70%)" }}
      />

      <div className="relative max-w-7xl mx-auto">

        {/* ── Hero block — wide enough that the 38-char headline lands on a
            single line at lg+ breakpoints. Mobile/tablet still wrap naturally
            because the headline is long. */}
        <div className="text-center max-w-5xl mx-auto mb-10">

          <div className="inline-flex items-center gap-2.5 text-[11px] font-mono text-green-400/90 mb-5 uppercase tracking-[0.28em]">
            <span
              className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"
              style={{ boxShadow: "0 0 8px #4ade80" }}
            />
            Ask your agent
          </div>

          <h2 className="text-3xl md:text-4xl lg:text-[2.5rem] xl:text-[2.75rem] font-extrabold leading-[1.04] tracking-[-0.02em] mb-4">
            <span className="text-white">Scale your product to </span>
            <span className="text-shimmer">100M Web3 users.</span>
          </h2>

          <p className="text-white/55 text-base font-light leading-relaxed mb-6 max-w-xl mx-auto">
            Without asking them to buy gas. Your agent describes the intent;
            Q402 carries it to settlement.
          </p>

          <div className="flex flex-wrap justify-center gap-2">
            {AI_CLIENTS.map((c) => (
              <span
                key={c.name}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-white/10 bg-white/[0.03] text-white/75 text-[11px] font-medium"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.src} alt={c.name} className="w-3 h-3" />
                {c.name}
              </span>
            ))}
          </div>
        </div>

        {/* ── Conversation grid — 1-col mobile, 2-col tablet, 3×2 desktop.
              Six cards: four LIVE (single transfer, batch payouts, cheapest
              route via q402_quote, receipt audit via q402_receipt) and two
              ROADMAP (scheduled recurring, treasury automation). */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-7xl mx-auto">
          {PROMPTS.map((p) => (
            <div
              key={p.category}
              className="rounded-xl p-6"
              style={{
                background: "linear-gradient(180deg, rgba(10,16,30,0.85) 0%, rgba(6,11,20,0.85) 100%)",
                border:     "1px solid rgba(255,255,255,0.07)",
                boxShadow:  "0 14px 32px -16px rgba(0,0,0,0.5)",
              }}
            >
              {/* Card header — category + status pill in a single tight row */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="w-3.5 h-3.5 rounded-[3px] bg-yellow flex items-center justify-center shadow-[0_0_6px_rgba(245,197,24,0.4)]">
                    <span className="w-1 h-1 rounded-[1px] bg-navy/90" />
                  </span>
                  <span className="text-yellow text-[10px] font-mono uppercase tracking-[0.22em] font-semibold">
                    {p.category}
                  </span>
                </div>
                {p.status === "LIVE" ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-green-400/30 bg-green-400/5 text-green-400 text-[9px] font-mono font-bold uppercase tracking-[0.18em]">
                    <span className="w-1 h-1 rounded-full bg-green-400" />
                    Live
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-white/15 bg-white/[0.02] text-white/45 text-[9px] font-mono font-bold uppercase tracking-[0.18em]">
                    Roadmap
                  </span>
                )}
              </div>

              {/* Prompt body — user's natural-language ask */}
              <p className="text-white/90 text-[15px] leading-relaxed mb-3">
                {p.prompt.map((seg, i) =>
                  seg.hl ? (
                    <span key={i} className="text-yellow font-medium">{seg.t}</span>
                  ) : (
                    <span key={i}>{seg.t}</span>
                  )
                )}
              </p>

              {/* Reply + tag row — Q402's response, one line + tags inline */}
              <div className="pt-3 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                <p className="text-white/55 text-[12.5px] leading-relaxed mb-2.5">
                  {p.reply}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {p.tags.map((tag) => (
                    <span
                      key={tag}
                      className="px-2 py-0.5 rounded-md bg-white/[0.04] border border-white/[0.06] text-white/45 text-[10px] font-mono"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* ── CTA — moved to the section bottom so the demonstration leads
              and the action follows. */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-5 mt-12">
          <button
            onClick={() => setShowModal(true)}
            className="group inline-flex items-center gap-3 bg-yellow text-navy font-bold text-sm px-8 py-3.5 rounded-full hover:bg-yellow-hover transition-all hover:scale-[1.03] shadow-[0_0_28px_rgba(245,197,24,0.28)]"
          >
            Talk to us
            <span className="text-base transition-transform group-hover:translate-x-0.5">→</span>
          </button>
          <a
            href="/docs"
            className="inline-flex items-center gap-2 text-sm text-white/55 hover:text-white transition-colors font-medium"
          >
            Read the docs
            <span className="text-[10px] opacity-50">↗</span>
          </a>
        </div>
      </div>

      {showModal && <RegisterModal onClose={() => setShowModal(false)} />}
    </section>
  );
}
