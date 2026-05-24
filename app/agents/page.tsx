"use client";

/**
 * /agents — Q402 Agent Wallet landing page.
 *
 * Distinct from the main landing aesthetic: warm cream surface, green
 * accents, product-led layout. Frames the Agent Wallet as Q402's
 * super-2.0 feature — the wallet your AI agent operates from.
 *
 * No pricing card; the page exists to land users into the dashboard's
 * Agent tab and the MCP install snippet.
 */

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import Navbar from "@/app/components/Navbar";
import Footer from "@/app/components/Footer";

const INSTALL_CMD = "npx @quackai/q402-mcp";

type UseCase = {
  key: string;
  label: string;
  one: string;
  prompt: string;
};

const USE_CASES: UseCase[] = [
  {
    key: "shop",
    label: "Shopping",
    one: "Pay merchants and SaaS APIs without surfacing the user's wallet.",
    prompt: '"Buy the $25 monthly plan and split the bill across the team."',
  },
  {
    key: "scrape",
    label: "Scrape",
    one: "Stream sub-cent payments to data providers as your agent crawls.",
    prompt: '"Pull yesterday\'s SEC filings — pay each provider per row."',
  },
  {
    key: "research",
    label: "Research",
    one: "Compensate human-in-the-loop reviewers with one-line transfers.",
    prompt: '"Send $40 to the analyst who labelled this dataset."',
  },
  {
    key: "ops",
    label: "Ops",
    one: "Refill workers, vendors, and on-chain services on a schedule.",
    prompt: '"Top up our 12 deploy bots to $10 each, every Friday."',
  },
];

export default function AgentsPage() {
  const [activeTab, setActiveTab] = useState<string>(USE_CASES[0].key);
  const [copied, setCopied] = useState(false);
  const activeCase = USE_CASES.find((u) => u.key === activeTab) ?? USE_CASES[0];

  async function copy() {
    try {
      await navigator.clipboard.writeText(INSTALL_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      <Navbar />

      {/* The /agents canvas is its own surface — warm cream instead of the
          navy used everywhere else. Anchored above the global Footer. */}
      <main
        className="pt-24 pb-24 px-6"
        style={{
          background:
            "radial-gradient(1100px 600px at 80% -10%, rgba(74,222,128,0.18), transparent 65%), linear-gradient(180deg, #F8F2E7 0%, #F1E8D6 100%)",
          color: "#1F2A24",
        }}
      >
        <div className="max-w-5xl mx-auto">
          <Hero />

          <BalanceMockup />

          <InstallCard
            activeCase={activeCase}
            tabs={USE_CASES}
            onSelectTab={setActiveTab}
            copied={copied}
            onCopy={copy}
          />

          <UseCaseGrid />

          <Closing />
        </div>
      </main>

      <Footer />
    </>
  );
}

// ── Hero ───────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="text-center mb-12"
    >
      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[10px] uppercase tracking-[0.22em] font-bold mb-5"
        style={{ background: "rgba(34,131,75,0.10)", color: "#226B43" }}
      >
        <span>✦</span>
        Q402 Agent Wallet · Super 2.0
      </div>
      <h1
        className="text-5xl md:text-6xl font-semibold tracking-tight mb-4"
        style={{ color: "#15201A" }}
      >
        Your AI&apos;s wallet.
        <br />
        <span style={{ color: "#226B43" }}>One install. No popups.</span>
      </h1>
      <p
        className="text-base md:text-lg max-w-2xl mx-auto leading-relaxed"
        style={{ color: "rgba(31,42,36,0.65)" }}
      >
        A Q402-managed wallet your agent signs through. Your MetaMask
        never gets touched. Deposit stablecoins once; your agent operates
        within the per-tx and per-day limits you set.
      </p>

      <div className="flex flex-wrap justify-center gap-3 mt-8">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-semibold transition-colors"
          style={{ background: "#22C55E", color: "#0B1A12" }}
        >
          Open dashboard →
        </Link>
        <Link
          href="/claude"
          className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-medium transition-colors border"
          style={{
            borderColor: "rgba(34,107,67,0.25)",
            color: "#226B43",
            background: "rgba(255,255,255,0.4)",
          }}
        >
          Use from Claude · Codex · Cursor · Cline
        </Link>
      </div>
    </motion.div>
  );
}

// ── Mockup of the dashboard Agent card (purely decorative) ────────────────

function BalanceMockup() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.55 }}
      className="rounded-2xl border p-7 mb-10 relative overflow-hidden"
      style={{
        background:
          "linear-gradient(135deg, #FFFFFF 0%, #FBF6EB 100%)",
        borderColor: "rgba(34,107,67,0.18)",
        boxShadow: "0 20px 60px rgba(31,42,36,0.06)",
      }}
    >
      <div
        aria-hidden
        className="absolute top-0 right-0 h-full w-1/2 pointer-events-none opacity-60"
        style={{
          background:
            "radial-gradient(circle, rgba(34,131,75,0.20) 1px, transparent 1.4px) 0 0 / 14px 14px",
          maskImage: "linear-gradient(to left, black 0%, black 30%, transparent 80%)",
          WebkitMaskImage: "linear-gradient(to left, black 0%, black 30%, transparent 80%)",
        }}
      />
      <div className="relative flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] font-medium mb-1" style={{ color: "rgba(31,42,36,0.50)" }}>
            Available balance
          </div>
          <div className="flex items-baseline gap-2">
            <div className="text-4xl font-semibold tracking-tight" style={{ color: "#15201A" }}>$42.50</div>
            <div className="text-xs" style={{ color: "rgba(31,42,36,0.45)" }}>USDC + USDT · BNB</div>
          </div>
        </div>
        <div
          className="rounded-full border px-3 py-1.5 text-[11px] font-mono"
          style={{
            background: "rgba(255,255,255,0.6)",
            borderColor: "rgba(31,42,36,0.10)",
            color: "rgba(31,42,36,0.65)",
          }}
        >
          0xD222…ff64
        </div>
      </div>
      <div className="relative flex flex-wrap gap-2">
        {[
          { l: "Send", a: "↗" },
          { l: "Receive", a: "↙" },
          { l: "Add Funds", a: "+" },
        ].map((b) => (
          <span
            key={b.l}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium"
            style={{
              background: "rgba(34,197,94,0.12)",
              color: "#226B43",
              border: "1px solid rgba(34,197,94,0.28)",
            }}
          >
            <span className="text-sm leading-none">{b.a}</span>
            {b.l}
          </span>
        ))}
      </div>
    </motion.div>
  );
}

// ── Install card (Kite-style tabs) ─────────────────────────────────────────

function InstallCard({
  activeCase,
  tabs,
  onSelectTab,
  copied,
  onCopy,
}: {
  activeCase: UseCase;
  tabs: UseCase[];
  onSelectTab: (k: string) => void;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5 }}
      className="rounded-2xl border p-7 mb-10"
      style={{
        background: "rgba(255,255,255,0.65)",
        borderColor: "rgba(31,42,36,0.10)",
        boxShadow: "0 14px 36px rgba(31,42,36,0.04)",
      }}
    >
      <div className="text-xl font-semibold mb-4" style={{ color: "#15201A" }}>
        Start using your Agent Wallet
      </div>

      <div
        className="flex flex-wrap gap-1 mb-5 pb-3 border-b"
        style={{ borderColor: "rgba(31,42,36,0.08)" }}
      >
        <Tab label="Install" active={activeCase.key === "install"} onClick={() => onSelectTab("install")} sticky />
        {tabs.map((t) => (
          <Tab
            key={t.key}
            label={t.label}
            active={activeCase.key === t.key}
            onClick={() => onSelectTab(t.key)}
          />
        ))}
      </div>

      <div
        className="rounded-md border px-4 py-3 flex items-center justify-between font-mono text-sm"
        style={{
          background: "rgba(34,131,75,0.06)",
          borderColor: "rgba(34,131,75,0.18)",
          color: "#15201A",
        }}
      >
        <span>
          <span className="mr-2" style={{ color: "rgba(34,107,67,0.7)" }}>{">"}</span>
          {INSTALL_CMD}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className="text-[11px] transition-colors"
          style={{ color: copied ? "#22C55E" : "rgba(31,42,36,0.5)" }}
        >
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>

      <div
        className="mt-4 text-sm rounded-md px-4 py-3"
        style={{
          background: "rgba(255,255,255,0.7)",
          color: "rgba(31,42,36,0.72)",
          border: "1px solid rgba(31,42,36,0.06)",
        }}
      >
        <span className="font-medium" style={{ color: "#226B43" }}>{activeCase.label}:</span>{" "}
        {activeCase.one}{" "}
        <span className="italic" style={{ color: "rgba(31,42,36,0.55)" }}>{activeCase.prompt}</span>
      </div>

      <a
        href="/docs#claude-mcp"
        className="inline-block mt-4 text-sm font-medium hover:underline"
        style={{ color: "#226B43" }}
      >
        View quickstart guide →
      </a>
    </motion.div>
  );
}

function Tab({ label, active, onClick, sticky }: { label: string; active: boolean; onClick: () => void; sticky?: boolean }) {
  const isActive = sticky || active;
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-1.5 text-sm font-medium transition-colors"
      style={{
        color: isActive ? "#15201A" : "rgba(31,42,36,0.45)",
        borderBottom: isActive ? "2px solid #22C55E" : "2px solid transparent",
        marginBottom: "-13px",
      }}
    >
      {label}
    </button>
  );
}

// ── Use case grid ──────────────────────────────────────────────────────────

function UseCaseGrid() {
  return (
    <div className="grid md:grid-cols-3 gap-4 mb-12">
      {USE_CASES.slice(0, 3).map((u, i) => (
        <motion.div
          key={u.key}
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4, delay: i * 0.08 }}
          className="rounded-2xl border p-5"
          style={{
            background: "rgba(255,255,255,0.55)",
            borderColor: "rgba(31,42,36,0.08)",
          }}
        >
          <div
            className="text-[10px] uppercase tracking-[0.20em] font-bold mb-3"
            style={{ color: "#226B43" }}
          >
            {u.label}
          </div>
          <div className="text-base font-semibold mb-2" style={{ color: "#15201A" }}>
            {u.prompt}
          </div>
          <div className="text-sm leading-relaxed" style={{ color: "rgba(31,42,36,0.60)" }}>
            {u.one}
          </div>
        </motion.div>
      ))}
    </div>
  );
}

// ── Closing CTA ────────────────────────────────────────────────────────────

function Closing() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.45 }}
      className="text-center"
    >
      <div className="text-xl font-semibold mb-3" style={{ color: "#15201A" }}>
        Build with it today.
      </div>
      <div className="text-sm mb-6 max-w-xl mx-auto leading-relaxed" style={{ color: "rgba(31,42,36,0.62)" }}>
        Free during the trial — 2,000 sponsored TX on BNB Chain. A Multichain
        key extends the same wallet to the full 9 EVM chains Q402 supports.
        Wallet creation, soft-delete, and per-wallet limits are always free.
      </div>
      <div className="flex flex-wrap justify-center gap-3">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-semibold"
          style={{ background: "#22C55E", color: "#0B1A12" }}
        >
          Create your Agent Wallet →
        </Link>
        <Link
          href="/docs#claude-mcp"
          className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-medium border"
          style={{
            borderColor: "rgba(34,107,67,0.25)",
            color: "#226B43",
            background: "rgba(255,255,255,0.4)",
          }}
        >
          Read the docs
        </Link>
      </div>
    </motion.div>
  );
}
