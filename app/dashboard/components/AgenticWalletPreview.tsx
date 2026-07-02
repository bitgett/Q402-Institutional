"use client";

/**
 * AgenticWalletPreview — empty-state surface for the Agent tab.
 *
 * Shows the full Agent Wallet UI as a *preview*: the same identity
 * strip, the same four stat tiles (balance default $0.00, default caps,
 * Q402 server signer), but every action surface is replaced by a single
 * prominent "Create Agent Wallet" CTA. The visual continuity means the
 * caller can read the entire UX before touching anything and the act of
 * creating the wallet feels like activation, not initiation.
 *
 * Below the preview card, a two-column block uses the dashboard's full
 * width to surface the prompt examples (left) and a "how it works"
 * recap (right). The install snippet sits at the bottom as a quiet
 * footer.
 */

import { useState } from "react";
import { GearIcon } from "../v2/logos";

interface Props {
  onCreate: () => void;
  creating: boolean;
}

export function AgenticWalletPreview({ onCreate, creating }: Props) {
  return (
    <div className="space-y-6">
      <PreviewCard onCreate={onCreate} creating={creating} />

      <div className="grid md:grid-cols-2 gap-4">
        <PromptExamples />
        <HowItWorks />
      </div>

      <InstallSnippet />
    </div>
  );
}

// ── Preview card — mirrors AgenticWalletCard visually ──────────────────────

function PreviewCard({ onCreate, creating }: { onCreate: () => void; creating: boolean }) {
  return (
    <div
      className="rounded-2xl border p-7 relative overflow-hidden"
      style={{
        background: "linear-gradient(135deg, #0F1929 0%, #0A1521 100%)",
        borderColor: "rgba(74,222,128,0.18)",
      }}
    >
      <DotPattern />

      <div className="relative flex items-start justify-between gap-4 mb-5">
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-[0.22em] text-emerald-400/85 font-semibold">
            Agent Wallet · Preview
          </div>
          <div className="text-white/75 text-sm leading-relaxed max-w-md">
            Your AI&apos;s wallet. MetaMask untouched. Bounded by caps below.
          </div>
        </div>

        <div
          className="rounded-full border px-3 py-1.5 text-[11px] font-mono text-white/70 shrink-0"
          style={{ borderColor: "rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.035)" }}
        >
          Not created yet
        </div>
      </div>

      <div className="relative grid grid-cols-2 md:grid-cols-4 gap-2 mb-5">
        <PreviewStatTile
          label="Balance"
          value="$0.00"
          sub="USDC + USDT across chains"
          tone="hero"
        />
        <PreviewStatTile label="Daily cap" value="$500" sub="resets at 00:00 UTC" />
        <PreviewStatTile label="Per-tx cap" value="$200" sub="per single send" />
        <PreviewStatTile label="Signer" value="Q402 server" sub="encrypted key in keystore" />
      </div>

      <div className="relative flex flex-col md:flex-row md:items-center gap-3">
        <button
          type="button"
          onClick={onCreate}
          disabled={creating}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold transition-colors disabled:opacity-50"
          style={{ background: "#22C55E", color: "#0B1A12" }}
        >
          {creating ? "Creating…" : "Create Agent Wallet →"}
        </button>
        <div className="text-[11.5px] text-white/70 leading-relaxed">
          One signature from your MetaMask. Free to create.
          BNB Chain is included on the trial; other chains need a multichain key.
        </div>
      </div>

      {/* Disabled-action row so callers can see the actions they will get */}
      <div
        className="relative mt-5 pt-4 border-t flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
      >
        <span className="text-white/55">⇡ Send</span>
        <span className="text-white/55">⇣ Receive</span>
        <span className="text-white/55">⇉ Batch send</span>
        <span className="text-white/55">↩ Withdraw</span>
        <span className="inline-flex items-center gap-1.5 text-white/55"><GearIcon size={13} /> Spending limits</span>
        <span className="ml-auto text-white/50 text-[10.5px] uppercase tracking-[0.18em]">
          available after activation
        </span>
      </div>
    </div>
  );
}

function PreviewStatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "hero";
}) {
  const hero = tone === "hero";
  return (
    <div
      className="rounded-xl border p-3"
      style={{
        background: hero ? "rgba(74,222,128,0.06)" : "rgba(255,255,255,0.02)",
        borderColor: hero ? "rgba(74,222,128,0.22)" : "rgba(255,255,255,0.06)",
      }}
    >
      <div className="text-[10px] text-white/65 uppercase tracking-widest font-medium mb-1">
        {label}
      </div>
      <div
        className={`text-white tracking-tight ${hero ? "text-2xl font-semibold" : "text-base font-medium"}`}
        style={{ opacity: 0.88 }}
      >
        {value}
      </div>
      <div className="text-[11px] text-white/55 mt-0.5">{sub}</div>
    </div>
  );
}

// ── Prompt examples (left column) ──────────────────────────────────────────

function PromptExamples() {
  const lines: { quote: string; lane: string }[] = [
    { quote: "Every Friday, send 25 USDT to these 8 contributors.", lane: "recurring payout" },
    { quote: "Use BNB Chain by default. Other chains only when the recipient asks.", lane: "chain routing" },
    { quote: "Never spend more than $200 per transaction or $500 per day.", lane: "spending policy" },
  ];
  return (
    <div
      className="rounded-2xl border p-5"
      style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}
    >
      <div className="text-[10px] uppercase tracking-[0.22em] text-emerald-400/85 font-semibold mb-1">
        Try saying this
      </div>
      <div className="text-white/85 font-medium mb-4">Plain English. Real settlement.</div>

      <div className="space-y-3">
        {lines.map((l) => (
          <div
            key={l.quote}
            className="rounded-md border px-3 py-2.5"
            style={{ background: "rgba(8,17,30,0.45)", borderColor: "rgba(74,222,128,0.18)" }}
          >
            <div className="text-[14px] text-white/90 leading-snug">{l.quote}</div>
            <div className="text-[10px] uppercase tracking-[0.18em] mt-1.5" style={{ color: "rgba(134,239,172,0.7)" }}>
              {l.lane}
            </div>
          </div>
        ))}
      </div>

      <div className="text-[11px] text-white/65 mt-4 leading-relaxed">
        Caps enforced server-side on every send.
      </div>
    </div>
  );
}

// ── How it works (right column) ────────────────────────────────────────────

function HowItWorks() {
  const steps: { n: string; title: string; body: string }[] = [
    {
      n: "01",
      title: "Sign once from this page",
      body: "Q402 generates a dedicated wallet for your agent and ties it to your account. One MetaMask signature is the only popup you'll see.",
    },
    {
      n: "02",
      title: "Deposit on any of 12 EVM chains",
      body: "Same address across BNB, Ethereum, Avalanche, X Layer, Stable, Mantle, Injective, Monad, Scroll, Arbitrum, Base, and Robinhood Chain. Pick the network in the Receive modal — the explorer link updates to match.",
    },
    {
      n: "03",
      title: "Your AI signs through Q402",
      body: "Gas sponsored by our relayer; only the stablecoin moves from your Agent Wallet balance. Caps you set bound the spend.",
    },
  ];
  return (
    <div
      className="rounded-2xl border p-5"
      style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}
    >
      <div className="text-[10px] uppercase tracking-[0.22em] text-emerald-400/85 font-semibold mb-1">
        How it works
      </div>
      <div className="text-white/85 font-medium mb-4">Three steps. No more popups.</div>

      <div className="space-y-3">
        {steps.map((s) => (
          <div key={s.n} className="flex gap-3">
            <div
              className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-[11px] font-mono font-semibold"
              style={{
                background: "rgba(74,222,128,0.10)",
                color: "#86efac",
                border: "1px solid rgba(74,222,128,0.22)",
              }}
            >
              {s.n}
            </div>
            <div className="min-w-0">
              <div className="text-[13px] text-white/90 font-medium leading-snug">{s.title}</div>
              <div className="text-[11.5px] text-white/75 leading-relaxed mt-0.5">{s.body}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Install snippet (compact footer) ───────────────────────────────────────

function InstallSnippet() {
  const [copied, setCopied] = useState(false);
  const cmd = "npx -y @quackai/q402-mcp";

  async function copy() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      className="rounded-xl border px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm"
      style={{ background: "rgba(255,255,255,0.015)", borderColor: "rgba(255,255,255,0.06)" }}
    >
      <span className="text-white/80">Already have an AI client?</span>
      <code className="font-mono text-white/95 text-[13px]">{cmd}</code>
      <button
        type="button"
        onClick={copy}
        className="text-[12px] text-white/70 hover:text-emerald-300 transition-colors"
      >
        {copied ? "copied ✓" : "copy"}
      </button>
      <a
        href="/docs#claude-mcp"
        className="ml-auto text-[12px] text-emerald-400/85 hover:text-emerald-300"
      >
        Quickstart →
      </a>
    </div>
  );
}

// ── Decorative dot pattern ────────────────────────────────────────────────

function DotPattern() {
  return (
    <div
      aria-hidden
      className="absolute top-0 right-0 h-full w-1/2 pointer-events-none opacity-40"
      style={{
        background:
          "radial-gradient(circle, rgba(74,222,128,0.25) 1px, transparent 1.5px) 0 0 / 14px 14px",
        maskImage: "linear-gradient(to left, black 0%, black 30%, transparent 80%)",
        WebkitMaskImage: "linear-gradient(to left, black 0%, black 30%, transparent 80%)",
      }}
    />
  );
}
