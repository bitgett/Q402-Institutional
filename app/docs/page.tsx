"use client";

import Link from "next/link";
import { useState } from "react";
import { SDK_VERSION, MCP_VERSION } from "@/app/lib/version";

const NAV = [
  { id: "overview",       label: "Overview",        icon: "○" },
  { id: "agentic-wallet", label: "Agentic Wallet",  icon: "○" },
  { id: "yield",          label: "Yield · Aave V3", icon: "○" },
  { id: "bridge",         label: "Bridge · CCIP",   icon: "○" },
  { id: "how-it-works",   label: "How It Works",    icon: "○" },
  { id: "quickstart",     label: "Quick Start",     icon: "○" },
  { id: "claude-mcp",     label: "MCP for AI Clients", icon: "○" },
  { id: "trust-receipt",  label: "Trust Receipt",   icon: "○" },
  { id: "gaspool",        label: "Gas Pool",        icon: "○" },
  { id: "eip-7702-delegation", label: "EIP-7702 Delegation", icon: "○" },
  { id: "auth",           label: "Authentication",  icon: "○" },
  { id: "api-ref",        label: "API Reference",   icon: "○" },
  { id: "chains",         label: "Chain Support",   icon: "○" },
  { id: "eip712",         label: "EIP-712 Signing", icon: "○" },
  { id: "errors",         label: "Error Codes",     icon: "○" },
  { id: "faq",            label: "FAQ",             icon: "○" },
];

function CodeBlock({ code, lang = "typescript" }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative rounded-xl overflow-hidden border border-white/8 mb-5">
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/8" style={{ background: "rgba(255,255,255,0.02)" }}>
        <span className="text-xs text-white/30 font-mono">{lang}</span>
        <button
          onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
          className="text-xs text-white/30 hover:text-white/70 transition-colors"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto bg-[#060C14]">
        <code className="text-xs font-mono text-white/75 leading-relaxed whitespace-pre">{code}</code>
      </pre>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mb-16 scroll-mt-24">
      <h2 className="text-2xl font-bold mb-6 pb-3 border-b border-white/8">{title}</h2>
      {children}
    </section>
  );
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-semibold" style={{ background: `${color}15`, color, border: `1px solid ${color}30` }}>
      {children}
    </span>
  );
}

function Callout({ type, children }: { type: "info" | "warn" | "tip"; children: React.ReactNode }) {
  const styles = {
    info: { border: "rgba(98,126,234,0.25)", bg: "rgba(98,126,234,0.05)", dot: "#627EEA", label: "Note" },
    warn: { border: "rgba(245,197,24,0.25)", bg: "rgba(245,197,24,0.05)", dot: "#F5C518", label: "Important" },
    tip:  { border: "rgba(245,197,24,0.25)", bg: "rgba(245,197,24,0.05)", dot: "#F5C518", label: "Tip" },
  }[type];
  return (
    <div className="rounded-xl p-4 mb-5 text-sm leading-relaxed" style={{ border: `1px solid ${styles.border}`, background: styles.bg }}>
      <span className="font-semibold text-xs uppercase tracking-widest block mb-1" style={{ color: styles.dot }}>{styles.label}</span>
      <div className="text-white/55">{children}</div>
    </div>
  );
}

export default function DocsPage() {
  const [activeSection, setActiveSection] = useState("overview");

  return (
    <div className="min-h-screen text-white" style={{ background: "#080E1C" }}>
      {/* Top nav */}
      <nav className="fixed top-0 left-0 right-0 z-50 backdrop-blur-md" style={{ background: "rgba(8,14,28,0.92)", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
        {/* Nav inner mirrors the outer (96rem). Right padding 10rem pulls the
            right items group flush with the main content area's right edge —
            outer is 96rem but content only fills aside (16rem) + main
            (max-w-6xl = 72rem), so the right 8rem is dead space and main has
            its own px-8 (2rem) for box borders → 8 + 2 = 10rem reclaim. */}
        <div className="max-w-[96rem] mx-auto h-14 flex items-center justify-between pl-5 pr-[10rem]">
          <div className="flex items-center gap-5">
            <Link href="/" className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-md bg-yellow flex items-center justify-center shadow-[0_0_12px_rgba(245,197,24,0.35)]">
                <span className="w-2.5 h-2.5 rounded-sm bg-navy/90" />
              </span>
              <span className="text-yellow font-bold text-base tracking-tight leading-none">Q402</span>
              <span className="text-white/20 text-xs">/</span>
              <span className="text-white/50 text-xs font-medium">docs</span>
            </Link>
            <div className="hidden sm:flex items-center gap-1 bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5">
              <span className="text-white/25 text-xs font-mono">v{SDK_VERSION}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/" className="text-xs text-white/35 hover:text-white/70 transition-colors">← Landing</Link>
            <Link href="/#pricing" className="text-xs text-white/35 hover:text-white/70 transition-colors">Pricing</Link>
            <Link href="/payment" className="bg-yellow text-navy text-xs font-bold px-4 py-2 rounded-full hover:bg-yellow-hover transition-colors">
              Get API Key →
            </Link>
          </div>
        </div>
        {/* yellow accent line */}
        <div className="h-px w-full" style={{ background: "linear-gradient(90deg, transparent 0%, rgba(245,197,24,0.4) 30%, rgba(245,197,24,0.4) 70%, transparent 100%)" }} />
      </nav>

      <div className="max-w-[96rem] mx-auto flex pt-14">
        {/* Sidebar */}
        <aside className="hidden lg:flex w-64 flex-shrink-0 flex-col sticky top-14 h-[calc(100vh-3.5rem)] overflow-y-auto border-r" style={{ borderColor: "rgba(255,255,255,0.06)", background: "rgba(5,9,18,0.6)" }}>
          {/* Sidebar header */}
          <div className="px-5 pt-8 pb-4">
            <div className="text-[10px] text-white/25 uppercase tracking-[0.2em] font-semibold mb-1">Documentation</div>
          </div>

          <nav className="flex-1 px-3 space-y-0.5 pb-6">
            {NAV.map((item) => {
              const active = activeSection === item.id;
              return (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  onClick={() => setActiveSection(item.id)}
                  className={`flex items-center gap-3 text-sm py-2 px-3 rounded-lg transition-all ${
                    active
                      ? "text-yellow bg-yellow/8 font-medium"
                      : "text-white/45 hover:text-white/80 hover:bg-white/[0.04]"
                  }`}
                  style={active ? { boxShadow: "inset 2px 0 0 #F5C518" } : {}}
                >
                  <span className={`text-[11px] w-4 text-center flex-shrink-0 ${active ? "text-yellow" : "text-white/20"}`}>{item.icon}</span>
                  {item.label}
                </a>
              );
            })}
          </nav>

          <div className="px-5 py-5 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
            <div className="text-[10px] text-white/20 uppercase tracking-widest mb-3">Support</div>
            <a href="mailto:business@quackai.ai" className="flex items-center gap-2 text-xs text-yellow/60 hover:text-yellow transition-colors">
              <span>✉</span> business@quackai.ai
            </a>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 min-w-0 max-w-6xl">
          {/* Docs hero banner */}
          <div className="px-8 pt-12 pb-10 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "linear-gradient(180deg, rgba(245,197,24,0.04) 0%, transparent 100%)" }}>
            <div className="flex items-center gap-2 mb-4">
              <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded" style={{ background: "rgba(245,197,24,0.12)", color: "#F5C518" }}>v{SDK_VERSION}</span>
              <span className="text-white/20 text-xs">·</span>
              <span className="text-white/30 text-xs">EIP-712 + EIP-7702</span>
            </div>
            <h1 className="text-3xl font-bold mb-3">Q402 Developer Docs</h1>
            <p className="text-white/65 text-sm leading-relaxed max-w-xl">
              Gasless stablecoin payments across 10 EVM chains. One API key, one signed request.
            </p>
            <div className="flex items-center gap-6 mt-6">
              <a href="#quickstart" className="inline-flex items-center gap-2 bg-yellow text-navy text-xs font-bold px-5 py-2.5 rounded-full hover:bg-yellow-hover transition-colors">
                Quick Start →
              </a>
              <a href="#api-ref" className="text-xs text-white/40 hover:text-white transition-colors flex items-center gap-1">
                <span className="font-mono">{"{ }"}</span> API Reference
              </a>
            </div>
          </div>

          <div className="px-8 py-10">

          {/* ── OVERVIEW ── */}
          <Section id="overview" title="Overview">
            <p className="text-white/75 text-base leading-relaxed mb-6">
              A managed relay for USDC / USDT / RLUSD across 10 EVM chains.
              Users hold no native token; Q402 submits the TX and pays the gas.
            </p>

            {/* Architecture — one picture before any code */}
            <div className="rounded-xl border border-white/8 mb-6 overflow-hidden" style={{ background: "rgba(255,255,255,0.02)" }}>
              <div className="px-4 py-2 border-b border-white/8 flex items-center justify-between" style={{ background: "rgba(255,255,255,0.02)" }}>
                <span className="text-[10px] text-white/30 uppercase tracking-[0.18em] font-semibold">Architecture</span>
                <span className="text-[10px] text-white/25 font-mono">end-to-end flow</span>
              </div>
              <pre className="p-5 overflow-x-auto text-[11px] leading-[1.7] font-mono text-white/65 whitespace-pre">
{`  User wallet              Q402 API                 On-chain                 Your app
  ───────────              ────────                 ────────                 ────────

  1. Sign EIP-712  ──▶  /api/payment/intent   lock quote, planChain
                        /api/payment/activate scan TX, grant credits
  2. Get API key   ◀──  (sandbox or live)

  3. Call pay()    ──▶  /api/relay            ──▶  EIP-7702 Type-4 TX
                        verify · decrement         USDC/USDT transfer
                        credits · cap checks       user EOA ──▶ recipient
                                                                          ◀── webhook
                                                                              HMAC-signed
                                                                              relay.success

                        Dashboard ◀── delivery log · key rotation · gas tank balance`}
              </pre>
            </div>

            <p className="text-white/60 text-sm leading-relaxed mb-6">
              <span className="text-white/85">intent</span> locks the quote ·{" "}
              <span className="text-white/85">activate</span> grants credits after the on-chain transfer ·{" "}
              <span className="text-white/85">relay</span> submits each payment. Every relay can fire an HMAC-signed webhook.
            </p>

            <div className="grid sm:grid-cols-3 gap-4 mb-8">
              {[
                { label: "Protocol",         value: "EIP-712 + EIP-7702" },
                { label: "Settlement token", value: "USDC · USDT · RLUSD (eth-only)" },
                { label: "Gas source",       value: "Your gas pool" },
              ].map((item) => (
                <div key={item.label} className="rounded-xl p-4 border border-white/8" style={{ background: "rgba(255,255,255,0.02)" }}>
                  <div className="text-xs text-white/30 mb-1">{item.label}</div>
                  <div className="text-sm font-mono text-white/80">{item.value}</div>
                </div>
              ))}
            </div>
          </Section>

          {/* ── AGENTIC WALLET ── */}
          <Section id="agentic-wallet" title="Agentic Wallet">
            <p className="text-white/75 text-base leading-relaxed mb-6">
              A dedicated signing wallet for each AI agent, with on-chain guardrails so an agent
              can transact without holding your main keys. Each owner can provision up to 10 agent
              wallets; every payment settles gaslessly through the same EIP-712 + EIP-7702 relay.
            </p>
            <div className="grid sm:grid-cols-3 gap-4 mb-6">
              {[
                { label: "Spend limits", value: "Per-transaction + daily caps" },
                { label: "Multi-payee",  value: "Up to 20 recipients / batch" },
                { label: "Trust gate",   value: "On-chain ERC-8004 reputation" },
              ].map((item) => (
                <div key={item.label} className="rounded-xl p-4 border border-white/8" style={{ background: "rgba(255,255,255,0.02)" }}>
                  <div className="text-xs text-white/30 mb-1">{item.label}</div>
                  <div className="text-sm font-mono text-white/80">{item.value}</div>
                </div>
              ))}
            </div>
            <p className="text-white/55 text-sm leading-relaxed">
              Manage wallets, caps, and reputation gates from{" "}
              <Link href="/dashboard" className="text-yellow hover:underline">/dashboard</Link>, or
              introspect them from an MCP client with{" "}
              <code className="text-yellow text-xs">q402_agentic_info</code>.
            </p>
          </Section>

          {/* ── YIELD ── */}
          <Section id="yield" title="Yield · Aave V3">
            <p className="text-white/75 text-base leading-relaxed mb-6">
              Supply and withdraw stablecoins on Aave V3 over BNB Chain straight from an Agent
              Wallet. The EIP-7702 relay sponsors the gas, so idle balances compound while you pay
              $0 to move them.
            </p>
            <div className="grid sm:grid-cols-3 gap-4 mb-6">
              {[
                { label: "Protocol", value: "Aave V3" },
                { label: "Chain",    value: "BNB Chain" },
                { label: "Actions",  value: "Gasless supply / withdraw" },
              ].map((item) => (
                <div key={item.label} className="rounded-xl p-4 border border-white/8" style={{ background: "rgba(255,255,255,0.02)" }}>
                  <div className="text-xs text-white/30 mb-1">{item.label}</div>
                  <div className="text-sm font-mono text-white/80">{item.value}</div>
                </div>
              ))}
            </div>
            <p className="text-white/55 text-sm leading-relaxed">
              From an MCP client: <code className="text-yellow text-xs">q402_yield_reserves</code>,{" "}
              <code className="text-yellow text-xs">q402_yield_positions</code>,{" "}
              <code className="text-yellow text-xs">q402_yield_deposit</code>,{" "}
              <code className="text-yellow text-xs">q402_yield_withdraw</code>.
            </p>
          </Section>

          {/* ── BRIDGE ── */}
          <Section id="bridge" title="Bridge · Chainlink CCIP">
            <p className="text-white/75 text-base leading-relaxed mb-6">
              Move native USDC across chains in a single signed request over Chainlink CCIP. Quote,
              send, and track a transfer from the dashboard or an MCP client — no manual bridge hops.
            </p>
            <div className="grid sm:grid-cols-3 gap-4 mb-6">
              {[
                { label: "Protocol", value: "Chainlink CCIP" },
                { label: "Lanes",    value: "Ethereum · Avalanche · Arbitrum" },
                { label: "Asset",    value: "Native USDC" },
              ].map((item) => (
                <div key={item.label} className="rounded-xl p-4 border border-white/8" style={{ background: "rgba(255,255,255,0.02)" }}>
                  <div className="text-xs text-white/30 mb-1">{item.label}</div>
                  <div className="text-sm font-mono text-white/80">{item.value}</div>
                </div>
              ))}
            </div>
            <p className="text-white/55 text-sm leading-relaxed">
              From an MCP client: <code className="text-yellow text-xs">q402_bridge_quote</code>,{" "}
              <code className="text-yellow text-xs">q402_bridge_send</code>,{" "}
              <code className="text-yellow text-xs">q402_bridge_history</code>,{" "}
              <code className="text-yellow text-xs">q402_bridge_gas_tank</code>.
            </p>
          </Section>

          {/* ── HOW IT WORKS ── */}
          <Section id="how-it-works" title="How It Works">
            <p className="text-white/55 text-sm mb-6">Three actors. One transaction. Zero gas for your users.</p>

            <div className="space-y-3 mb-8">
              {[
                {
                  step: "A", color: "#F5C518",
                  title: "User signs an authorization (no gas, no blockchain)",
                  desc: "Using their wallet (e.g. MetaMask), the user signs a typed message saying \"I allow transferring X USDC to address Y\". This is purely a cryptographic signature — no transaction is sent, no gas is needed."
                },
                {
                  step: "B", color: "#627EEA",
                  title: "Your server calls POST /api/relay",
                  desc: "You pass the user's signature to Q402's API. That's it — one HTTP call. Q402 verifies the signature, constructs the on-chain transaction, and submits it."
                },
                {
                  step: "C", color: "#94a3b8",
                  title: "Gas is deducted from your gas pool, USDC lands in recipient wallet",
                  desc: "Q402 uses your pre-funded gas pool to pay the network fee. The USDC moves on-chain, verifiable on BscScan / Snowtrace / Etherscan. User sees zero gas cost."
                },
              ].map((item) => (
                <div key={item.step} className="flex gap-4 p-4 rounded-xl border border-white/8">
                  <div className="w-7 h-7 rounded-lg flex-shrink-0 flex items-center justify-center text-xs font-extrabold font-mono" style={{ background: `${item.color}20`, color: item.color }}>
                    {item.step}
                  </div>
                  <div>
                    <div className="text-sm font-semibold mb-1">{item.title}</div>
                    <div className="text-xs text-white/45 leading-relaxed">{item.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Architecture diagram (text) */}
            <div className="bg-[#060C14] border border-white/8 rounded-xl p-5 font-mono text-xs text-white/50 leading-loose">
              <div><span className="text-white/25">{"// "}</span>Full flow</div>
              <div className="mt-2">
                <span className="text-yellow">User wallet</span>
                <span className="text-white/25">  →  signs EIP-712  →  </span>
                <span className="text-blue-400">your frontend</span>
              </div>
              <div>
                <span className="text-blue-400">Your backend</span>
                <span className="text-white/25">  →  POST /api/relay  →  </span>
                <span className="text-yellow">Q402 API</span>
              </div>
              <div>
                <span className="text-yellow">Q402</span>
                <span className="text-white/25">       →  uses gas pool  →  </span>
                <span className="text-white/60">on-chain TX</span>
              </div>
              <div>
                <span className="text-white/60">Chain</span>
                <span className="text-white/25">       →  confirms TX    →  </span>
                <span className="text-yellow">recipient gets USDC</span>
              </div>
            </div>
          </Section>

          {/* ── QUICK START ── */}
          <Section id="quickstart" title="Quick Start">
            <p className="text-white/65 text-sm mb-6">
              Pick a key, load the SDK, call <code className="text-yellow text-xs">pay()</code>. Under 5 minutes.
            </p>

            <h3 className="text-xs font-semibold text-white/65 uppercase tracking-widest mb-3">0 · Trial key vs Multichain key</h3>
            <div className="grid sm:grid-cols-2 gap-3 mb-6">
              <div className="rounded-xl border border-yellow/20 bg-yellow/[0.04] px-4 py-3">
                <p className="text-yellow font-semibold text-sm mb-1">Trial API Key</p>
                <p className="text-white/70 text-xs leading-relaxed">
                  BNB only · 2,000 sponsored TX · Q402 pays gas. <a className="text-yellow hover:underline" href="/event">/event</a>.
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <p className="text-white/85 font-semibold text-sm mb-1">Multichain API Key</p>
                <p className="text-white/70 text-xs leading-relaxed">
                  10 chains · USDC / USDT / RLUSD (eth) · self-funded Gas Tank. <a className="text-yellow hover:underline" href="/payment">/payment</a>.
                </p>
              </div>
            </div>
            <Callout type="tip">
              Trial keys reject non-BNB with <code className="text-orange-300">TRIAL_BNB_ONLY</code>. Use Multichain for non-BNB chains.
            </Callout>

            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3 mt-6">1 · Load the SDK</h3>
            <CodeBlock lang="html" code={`<script src="https://q402.quackai.ai/q402-sdk.js"></script>`} />

            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3">2a · Trial key — BNB-only sponsored payment</h3>
            <CodeBlock lang="javascript" code={`// Trial keys are BNB-only. No Gas Tank needed — Q402 sponsors gas.
const q402 = new Q402Client({
  apiKey: "q402_live_YOUR_TRIAL_KEY",   // from /event (your Trial API Key)
  chain:  "bnb",
});

const result = await q402.pay({
  to:     recipientAddress,
  amount: "1.00",
  token:  "USDT",   // or "USDC"
});
// result → { success: true, txHash: "0x...", chain: "bnb", method: "eip7702" }`} />

            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3">2b · Multichain key — full 10-chain payment</h3>
            <CodeBlock lang="javascript" code={`// Multichain keys work across all supported chains. Each chain needs
// a funded Gas Tank — deposit at /dashboard → Treasury.
const q402 = new Q402Client({
  apiKey: "q402_live_YOUR_KEY",
  chain:  "bnb",   // "bnb" | "avax" | "eth" | "xlayer" | "stable" | "mantle" | "injective" | "monad" | "scroll" | "arbitrum"
});
// Note: Injective supports both USDC and USDT (native Circle USDC via CCTP).

// Wallet popup appears — user signs, Q402 relays on-chain
// amount MUST be a human-readable decimal STRING (e.g. "50.00", "0.123456").
// Never pass a JS Number — IEEE-754 loses precision on 18-decimal tokens.
// Inputs exceeding the token's decimals or non-decimal strings throw.
const result = await q402.pay({
  to:     recipientAddress,
  amount: "50.00",
  token:  "USDC",
});
// result → { success: true, txHash: "0xabc...", tokenAmount: "50", chain: "bnb" }
`} />

            <h3 className="text-xs font-semibold text-white/65 uppercase tracking-widest mb-3">3 · Injective EVM</h3>
            <p className="text-white/70 text-sm mb-3">
              Native Circle USDC (CCTP) and USDT are both supported on Injective EVM. Cosmos and EVM share one balance via the MultiVM Token Standard.
            </p>
            <CodeBlock lang="javascript" code={`const q402 = new Q402Client({
  apiKey: "q402_live_YOUR_KEY",
  chain:  "injective",
});

const result = await q402.pay({
  to:     recipientAddress,
  amount: "50.00",
  token:  "USDC",   // USDC and USDT both supported on Injective
});`} />

            <h3 className="text-xs font-semibold text-white/65 uppercase tracking-widest mb-3">4 · Ethereum RLUSD (NY DFS regulated)</h3>
            <p className="text-white/70 text-sm mb-3">
              Ripple USD, NY DFS regulated. <strong>Ethereum mainnet only</strong> — rejects on any other chain. Decimals = 18; the SDK handles conversion, pass amount as a decimal string.
            </p>
            <CodeBlock lang="javascript" code={`const q402 = new Q402Client({
  apiKey: "q402_live_YOUR_KEY",
  chain:  "eth",
});

const result = await q402.pay({
  to:     recipientAddress,
  amount: "10.00",
  token:  "RLUSD",   // Ethereum-only — throws on any other chain
});`} />

            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3">5 · That&apos;s it</h3>
            <CodeBlock lang="typescript" code={`// Full result shape:
// {
//   success:       true,
//   txHash:        "0xdef456...",
//   chain:         "bnb",
//   blockNumber:   "38482910",
//   tokenAmount:   "50",
//   token:         "USDC",
//   gasCostNative: 0.000021,
//   method:        "eip7702",
// }
console.log("Paid! TX:", result.txHash);`} />

            <Callout type="tip">
              One call signs + relays. User holds no native token. Gas comes from your pool.
            </Callout>
          </Section>

          {/* ── MCP for AI Clients ── */}
          {/* id retained as "claude-mcp" for backlink stability — visible title is canonical MCP. */}
          <Section id="claude-mcp" title="MCP for AI Clients">
            <p className="text-white/70 text-sm mb-6">
              An MCP server for Claude / Codex / Cursor / Cline.{" "}
              <a className="text-yellow hover:underline" href="https://www.npmjs.com/package/@quackai/q402-mcp">@quackai/q402-mcp</a>
              {" · "}
              <a className="text-yellow hover:underline" href="https://github.com/bitgett/q402-mcp">bitgett/q402-mcp</a>.
            </p>

            <h3 className="text-xs font-semibold text-white/65 uppercase tracking-widest mb-3">1 · Install</h3>
            <p className="text-white/70 text-sm mb-3">
              Same package, one snippet per client. No secrets here.
            </p>
            <CodeBlock lang="bash" code={`# Claude Code / Claude Desktop
claude mcp add q402 -- npx -y @quackai/q402-mcp

# OpenAI Codex CLI
codex mcp add q402 -- npx -y @quackai/q402-mcp

# Cursor — paste into ~/.cursor/mcp.json (or .cursor/mcp.json for per-project scope)
# Cline  — Cline → Settings → MCP Servers → Edit JSON. Same shape.
{
  "mcpServers": {
    "q402": {
      "command": "npx",
      "args": ["-y", "@quackai/q402-mcp"]
    }
  }
}`} />

            <h3 className="text-xs font-semibold text-white/65 uppercase tracking-widest mb-3">2 · First-time setup — ask your AI</h3>
            <p className="text-white/70 text-sm mb-3">
              Restart the client, then say <strong className="text-white/90">&ldquo;Set up Q402&rdquo;</strong>. The agent runs <code className="text-yellow text-xs">q402_doctor</code> →
              creates + opens <code className="text-yellow text-xs">~/.q402/mcp.env</code> → walks you through pasting keys <em>into the file</em>. Auto-loaded for every client.
            </p>
            <Callout type="tip">
              🔒 Keys never paste into chat. Signing is local; the key never leaves your machine.
            </Callout>

            <h3 id="wallet-modes" className="text-xs font-semibold text-white/65 uppercase tracking-widest mb-3 mt-6">3 · Wallet modes — which signing path?</h3>
            <p className="text-white/70 text-sm mb-3">
              Three paths. <code className="text-yellow text-xs">q402_doctor</code> asks once; change later in <code className="text-yellow text-xs">~/.q402/mcp.env</code>.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-6">
              <div className="rounded-xl border p-6 relative" style={{ background: "rgba(245,197,24,0.04)", borderColor: "rgba(245,197,24,0.30)" }}>
                <div className="absolute -top-2.5 right-4 text-[10px] uppercase tracking-widest font-bold px-2.5 py-0.5 rounded bg-emerald-500 text-black">Recommended</div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-emerald-300/85 font-semibold mb-1.5">Mode C</div>
                <div className="text-white font-semibold text-base mb-3">Server-managed</div>
                <p className="text-[13px] text-white/65 leading-relaxed mb-4">
                  Q402 holds an encrypted Agent Wallet for you. <span className="text-emerald-300 font-medium">No private key in your env.</span> No MetaMask popup. Best for AI agents and most users.
                </p>
                <pre className="text-[11.5px] text-emerald-300/85 font-mono bg-black/30 rounded-md px-3 py-2 leading-relaxed overflow-x-auto">{`Q402_MULTICHAIN_API_KEY=q402_live_...`}</pre>
              </div>
              <div className="rounded-xl border p-6" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.08)" }}>
                <div className="text-[11px] uppercase tracking-[0.18em] text-white/55 font-semibold mb-1.5">Mode B</div>
                <div className="text-white font-semibold text-base mb-3">Local Agent Wallet PK</div>
                <p className="text-[13px] text-white/65 leading-relaxed mb-4">
                  Same Agent Wallet as Mode C, but you hold the PK. Export from the dashboard once. Signs locally — key never leaves your machine. MetaMask never touched.
                </p>
                <pre className="text-[11.5px] text-yellow font-mono bg-black/30 rounded-md px-3 py-2 leading-relaxed overflow-x-auto whitespace-pre">{`Q402_AGENTIC_PRIVATE_KEY=0x...
Q402_MULTICHAIN_API_KEY=q402_live_...`}</pre>
              </div>
              <div className="rounded-xl border p-6" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.08)" }}>
                <div className="text-[11px] uppercase tracking-[0.18em] text-white/55 font-semibold mb-1.5">Mode A</div>
                <div className="text-white font-semibold text-base mb-3">Your MetaMask EOA</div>
                <p className="text-[13px] text-white/65 leading-relaxed mb-4">
                  Your existing EOA signs directly via EIP-7702. The &quot;Smart account&quot; marker after first use is normal + reversible with <code className="text-yellow text-[11px]">q402_clear_delegation</code>. <span className="text-amber-200/80">Use a fresh wallet.</span>
                </p>
                <pre className="text-[11.5px] text-yellow font-mono bg-black/30 rounded-md px-3 py-2 leading-relaxed overflow-x-auto whitespace-pre">{`Q402_PRIVATE_KEY=0x...
Q402_MULTICHAIN_API_KEY=q402_live_...`}</pre>
              </div>
            </div>

            <h3 className="text-xs font-semibold text-white/65 uppercase tracking-widest mb-3 mt-6">4 · Tools exposed — 27 total</h3>
            <div className="rounded-xl border border-white/8 mb-6 overflow-hidden" style={{ background: "rgba(255,255,255,0.02)" }}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-widest text-white/55" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                    <th className="px-4 py-3 font-semibold">Tool</th>
                    <th className="px-4 py-3 font-semibold">Auth</th>
                    <th className="px-4 py-3 font-semibold">Purpose</th>
                  </tr>
                </thead>
                <tbody className="text-white/75">
                  {([
                    { name: "q402_doctor",              auth: "none",        purpose: "First-install onboarding + ongoing health check (quota, EIP-7702 state, relay reachability)." },
                    { name: "q402_quote",               auth: "none",        purpose: "Compare gas + supported tokens across 10 chains." },
                    { name: "q402_balance",             auth: "api key",     purpose: "Verify key + remaining quota. Returns Trial + Multichain in one read when both keys set." },
                    { name: "q402_pay",                 auth: "live mode",   purpose: "Single-recipient gasless USDC / USDT / RLUSD send. Sandbox by default." },
                    { name: "q402_batch_pay",           auth: "live mode",   purpose: "Up to 20 recipients per call (trial: 5). 6+ BNB batches with Trial → status=\"ambiguous\" so the agent asks how to split." },
                    { name: "q402_receipt",             auth: "none",        purpose: "Fetch + locally verify a Trust Receipt by rct_… id (ECDSA recovery against the relayer EOA)." },
                    { name: "q402_wallet_status",       auth: "private key", purpose: "Per-chain EIP-7702 delegation state for the EOA derived from Q402_PRIVATE_KEY. Read-only." },
                    { name: "q402_clear_delegation",    auth: "private key", purpose: "Clear EIP-7702 delegation on a single chain. Q402-sponsored gas." },
                    { name: "q402_agentic_info",        auth: "api key",     purpose: "Agent Wallet info (addresses, caps, daily-spend used, ERC-8004 id). Drives Mode C." },
                    { name: "q402_recurring_list",      auth: "api key",     purpose: "List scheduled rules." },
                    { name: "q402_recurring_create",    auth: "api key",     purpose: "Author a rule. Paid Multichain on EVERY chain (BNB included)." },
                    { name: "q402_recurring_fires",     auth: "api key",     purpose: "Last 50 fires per rule (timestamp + txHashes + amount)." },
                    { name: "q402_recurring_pause",     auth: "api key",     purpose: "Pause a rule. Reversible." },
                    { name: "q402_recurring_resume",    auth: "api key",     purpose: "Resume a paused / stopped rule." },
                    { name: "q402_recurring_skip_next", auth: "api key",     purpose: "Skip ONLY the next scheduled fire. Cadence preserved." },
                    { name: "q402_recurring_cancel",    auth: "api key",     purpose: "Permanently stop a rule." },
                    { name: "q402_bridge_quote",        auth: "none",        purpose: "Quote a Chainlink CCIP USDC bridge across the eth/avax/arbitrum triangle (LINK + native fee + ETA)." },
                    { name: "q402_bridge_send",         auth: "live mode",   purpose: "Execute a CCIP USDC bridge from the Agent Wallet (Mode C). Sandbox by default." },
                    { name: "q402_bridge_history",      auth: "api key",     purpose: "Recent CCIP bridge attempts for the Agent Wallet (src/dst/amount/CCIP msgId/status)." },
                    { name: "q402_bridge_gas_tank",     auth: "api key",     purpose: "Per-chain Gas Tank native balance + auto-fund window so the agent can top up before bridging." },
                    { name: "q402_yield_reserves",      auth: "none",        purpose: "List Q402 Yield (Aave V3) lending markets + live supply APY. BNB Chain only today." },
                    { name: "q402_yield_positions",     auth: "api key",     purpose: "The Agent Wallet's current Q402 Yield positions — value + live supply APY. Read-only." },
                    { name: "q402_yield_deposit",       auth: "live mode",   purpose: "Supply the Agent Wallet's USDC / USDT into Aave (Mode C). PAID feature — Trial cannot deposit. Confirm-gated + sandbox by default." },
                    { name: "q402_yield_withdraw",      auth: "live mode",   purpose: "Withdraw supplied stablecoin out of Aave (amount=\"max\" for the full position). Always allowed, even after a plan downgrade." },
                    { name: "q402_request_create",      auth: "api key",     purpose: "Publish a payment request (invoice). No funds move; returns a /pay link + req_ id. Recipient defaults to the Agent Wallet." },
                    { name: "q402_request_status",      auth: "none",        purpose: "Look up a request by req_ id (amount, token, chain, recipient, status). Read-only; notFound instead of throwing." },
                    { name: "q402_request_pay",         auth: "live mode",   purpose: "Pay a request gaslessly from your own Agent Wallet (Mode C). Two-phase consent, same as q402_pay." },
                  ]).map((t, i, arr) => (
                    <tr key={t.name} style={{ borderBottom: i === arr.length - 1 ? undefined : "1px solid rgba(255,255,255,0.04)" }}>
                      <td className="px-4 py-3"><code className="text-yellow text-xs">{t.name}</code></td>
                      <td className="px-4 py-3 text-white/55 text-xs whitespace-nowrap">{t.auth}</td>
                      <td className="px-4 py-3">{t.purpose}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="text-xs font-semibold text-white/65 uppercase tracking-widest mb-3">5 · Sandbox vs live mode</h3>
            <p className="text-white/70 text-sm mb-3">
              Default is <strong>sandbox</strong> — fake txHash, <code className="text-yellow text-xs">sandbox: true</code>, no funds move.
              Live = API key + a signing path. Pick ONE mode:
            </p>
            <ul className="text-white/70 text-sm mb-3 space-y-1.5 list-disc pl-5">
              <li><strong className="text-white/85">Mode A</strong> — <code className="text-yellow text-xs">Q402_PRIVATE_KEY</code> = your MetaMask EOA. Shows &ldquo;Smart account&rdquo; in MetaMask after first use (reversible via <code className="text-yellow text-xs">q402_clear_delegation</code>).</li>
              <li><strong className="text-white/85">Mode B</strong> — <code className="text-yellow text-xs">Q402_AGENTIC_PRIVATE_KEY</code> = exported Agent Wallet PK. Local signing; MetaMask untouched.</li>
              <li><strong className="text-white/85">Mode C</strong> — paid Multichain key only. Q402 holds the AES-GCM-encrypted Agent Wallet key server-side. Optionally set <code className="text-yellow text-xs">Q402_AGENT_WALLET_ADDRESS</code> to pick a wallet.</li>
            </ul>
            <p className="text-white/70 text-sm mb-3">
              <code className="text-yellow text-xs">q402_doctor</code> writes the file with every secret line empty. Live mode only flips when an API key + a signing path are populated — saving the template as-is stays in sandbox.
              <code className="text-yellow text-xs">Q402_ENABLE_REAL_PAYMENTS=0</code> forces sandbox even with real keys.
            </p>
            <CodeBlock lang="bash" code={`# ~/.q402/mcp.env — what q402_doctor creates on first install.
# Paste your values on the right of \`=\`. Q402_ENABLE_REAL_PAYMENTS
# already defaults to 1 — the gate refuses empty values, so partial
# setups stay in sandbox automatically.

# ── API key (pick one or both for auto-routing) ──
Q402_TRIAL_API_KEY=          # Free Trial, BNB only (from /event)
Q402_MULTICHAIN_API_KEY=     # Paid Multichain, all 10 chains (from /payment)

# ── Signing path — pick ONE of Mode A / B / C ──
# Mode A: your MetaMask EOA's hex private key
Q402_PRIVATE_KEY=
# Mode B: exported Agent Wallet pk from dashboard (keeps MetaMask untouched)
Q402_AGENTIC_PRIVATE_KEY=
# Mode C: no PK needed. Paid Multichain key alone + server-managed Agent Wallet.
#   Optional picker when you have multiple wallets:
# Q402_AGENT_WALLET_ADDRESS=0x...

# Live mode switch:
#   0 = sandbox (test mode, no funds move)
#   1 = real on-chain payments
# Default 1 — safe because mode only flips to live when an API key AND
# at least one valid signing path (A/B/C) are populated above.
Q402_ENABLE_REAL_PAYMENTS=1

# Default Q402 deployment. Only change for self-hosted.
Q402_RELAY_BASE_URL=https://q402.quackai.ai/api`} />
            <p className="text-white/55 text-xs mb-6">
              Missing config → sandbox fallback with a hint. Two extra guards: <code className="text-white/80">Q402_MAX_AMOUNT_PER_CALL</code> (default $200) and <code className="text-white/80">Q402_ALLOWED_RECIPIENTS</code> (address allowlist).
            </p>

            <Callout type="tip">
              <code className="text-yellow text-xs">q402_pay</code> requires explicit in-chat confirmation. Four guards total: confirm + sandbox default + per-call cap + allowlist.
            </Callout>
          </Section>

          {/* ── TRUST RECEIPT ── */}
          <Section id="trust-receipt" title="Trust Receipt">
            <p className="text-white/70 text-sm mb-6">
              A verifiable proof page for every Q402 settlement — signed by the relayer EOA, recoverable in any browser.
            </p>

            <h3 className="text-lg font-semibold mb-3 mt-8">What&apos;s on a receipt</h3>
            <ul className="text-white/70 text-sm space-y-2 mb-6 list-disc pl-5">
              <li><strong className="text-white/85">Settlement facts</strong> — payer, recipient, amount, chain, EIP method.</li>
              <li><strong className="text-white/85">On-chain proof</strong> — tx hash, block, sponsored gas, explorer link.</li>
              <li><strong className="text-white/85">Signature</strong> — EIP-191 ECDSA over the canonical hash, recoverable locally in your browser.</li>
              <li><strong className="text-white/85">Delivery trace</strong> — webhook state, retry count, last response code.</li>
            </ul>

            <h3 className="text-lg font-semibold mb-3 mt-8">Receipt URL</h3>
            <p className="text-white/70 text-sm mb-3">
              <code className="text-yellow text-xs">/api/relay</code> responses include <code className="text-yellow text-xs">receiptId</code> + <code className="text-yellow text-xs">receiptUrl</code>:
            </p>
            <CodeBlock lang="json" code={`{
  "success":      true,
  "txHash":       "0x9afd...52a4",
  "tokenAmount":  "0.10",
  "token":        "USDT",
  "chain":        "bnb",
  "receiptId":    "rct_afa5f50bc49a65ebba3b28ab",
  "receiptUrl":   "https://q402.quackai.ai/receipt/rct_afa5f50bc49a65ebba3b28ab"
}`} />
            <p className="text-white/70 text-sm mb-6">
              Mirrored in the webhook payload — no second lookup needed.
            </p>

            <h3 className="text-lg font-semibold mb-3 mt-8">JSON endpoint</h3>
            <p className="text-white/70 text-sm mb-3">
              Machine-readable for downstream verification:
            </p>
            <CodeBlock lang="bash" code={`curl https://q402.quackai.ai/api/receipt/rct_afa5f50bc49a65ebba3b28ab`} />
            <p className="text-white/55 text-sm mb-6">
              Rate limited 120/min per IP, returned with <code className="text-yellow text-xs">X-Robots-Tag: noindex, nofollow</code>. The id is unguessable (12 random bytes) so the URL doubles as a shareable audit link without iteration risk.
            </p>

            <h3 className="text-lg font-semibold mb-3 mt-8">Best-effort inline + durable backfill</h3>
            <p className="text-white/55 text-sm mb-6">
              The relay path tries <code className="text-yellow text-xs">createReceipt()</code> synchronously twice and <code className="text-yellow text-xs">await</code>s a queue write to <code className="text-yellow text-xs">receipt-backfill-queue</code> before responding. <code className="text-yellow text-xs">/api/cron/receipt-backfill</code> drains the queue with a per-tx KV lock and SET-NX idempotency, so a successful relay normally produces exactly one receipt — synchronously when KV is healthy, within the next cron run otherwise. If both inline retries <em>and</em> the backfill enqueue fail (rare, requires KV to be unreachable for both writes within the same request), the relay route fires a critical Telegram alert with the tx hash + payload snapshot so an operator can manually recover. That alert path is the third leg; we don&apos;t claim a hard guarantee in the absence of it.
            </p>

            <h3 className="text-lg font-semibold mb-3 mt-8">Verify any receipt from Claude</h3>
            <p className="text-white/55 text-sm mb-3">
              The <code className="text-yellow text-xs">@quackai/q402-mcp</code> server (v{MCP_VERSION}) exposes a <code className="text-yellow text-xs">q402_receipt</code> tool. After <code className="text-yellow text-xs">q402_pay</code> hands back a <code className="text-yellow text-xs">rct_</code>… id, ask Claude to verify it and the recovery runs inside the MCP process — same canonical-JSON + ECDSA recovery the receipt page does, no UI trust required:
            </p>
            <CodeBlock lang="text" code={`> Send 0.10 USDT to alice on BNB via Q402, then verify the receipt.

Claude → q402_pay   → settles + returns rct_afa5...
Claude → q402_receipt → verified: true · signed by 0xfc77...74ff466`} />

            <h3 className="text-lg font-semibold mb-3 mt-8">Live demo</h3>
            <Callout type="warn">
              First production Trust Receipt — 0.01 USDT settled on BNB Chain via EIP-7702:
              <br/>
              <a
                href="https://q402.quackai.ai/receipt/rct_afa5f50bc49a65ebba3b28ab"
                target="_blank"
                rel="noopener noreferrer"
                className="text-yellow underline underline-offset-2 hover:text-yellow/80 break-all font-mono text-xs mt-2 inline-block"
              >
                q402.quackai.ai/receipt/rct_afa5f50bc49a65ebba3b28ab ↗
              </a>
            </Callout>
          </Section>

          {/* ── GAS POOL ── */}
          <Section id="gaspool" title="Gas Pool">
            <p className="text-white/70 text-sm mb-6">
              Deposit native tokens into your per-wallet Gas Tank. Every relay deducts the actual gas cost.
            </p>

            <div className="grid sm:grid-cols-2 gap-4 mb-6">
              <div className="p-4 rounded-xl border border-white/8 bg-white/[0.02]">
                <div className="text-yellow text-xs font-semibold mb-2">Deposit</div>
                <p className="text-xs text-white/65 leading-relaxed">Send BNB / ETH / AVAX / OKB / MNT / INJ / MON (or USDT0 on Stable) to the Gas Tank address on the dashboard. The Tank is a cold wallet, NOT the relayer — never send to the relayer directly.</p>
              </div>
              <div className="p-4 rounded-xl border border-white/8 bg-white/[0.02]">
                <div className="text-blue-400 text-xs font-semibold mb-2">Auto-deduction</div>
                <p className="text-xs text-white/65 leading-relaxed">Per-relay native-token deduction, real-time balance.</p>
              </div>
              <div className="p-4 rounded-xl border border-white/8 bg-white/[0.02]">
                <div className="text-yellow text-xs font-semibold mb-2">Withdraw</div>
                <p className="text-xs text-white/65 leading-relaxed">Manual via business@quackai.ai. Funds remain yours.</p>
              </div>
            </div>

            <Callout type="warn">
              Empty Gas Tank → relays fail. Set 20% / 10% email alerts from the dashboard.
            </Callout>
          </Section>

          {/* ── EIP-7702 DELEGATION ── */}
          <Section id="eip-7702-delegation" title="EIP-7702 Delegation">
            <p className="text-white/70 text-sm mb-5 leading-relaxed">
              <strong className="text-white/90">EIP-7702 set-code delegation</strong> (Pectra) lets your EOA settle gasless
              payments without a per-user smart-account deploy. Persists across payments, reversible anytime.
            </p>

            <h3 className="text-xs font-semibold text-white/65 uppercase tracking-widest mb-3 mt-6">
              Inspect or clear
            </h3>
            <p className="text-white/70 text-sm mb-3 leading-relaxed">
              <strong className="text-white/90">From your AI client (MCP)</strong> — ask in plain English:
            </p>
            <CodeBlock lang="text" code={`"Show my Q402 wallet status."
"Clear my Q402 delegation on BNB Chain."`} />
            <p className="text-white/70 text-sm mb-3 mt-2 leading-relaxed">
              <code className="text-yellow text-xs">q402_wallet_status</code> reads state.{" "}
              <code className="text-yellow text-xs">q402_clear_delegation</code> signs locally;
              Q402 sponsors the clear TX — $0 gas. The next payment recreates the delegation automatically.
            </p>
            <p className="text-white/70 text-sm mb-3 mt-5 leading-relaxed">
              <strong className="text-white/90">From the terminal (CLI):</strong>
            </p>
            <CodeBlock lang="bash" code={`PRIVATE_KEY=0x<yourKey> node scripts/undelegate-7702.mjs --chain bnb`} />
            <p className="text-white/55 text-xs mt-3 mb-6 leading-relaxed">
              All 10 chains, self-paid (~$0.001 native gas).
            </p>

            <h3 className="text-xs font-semibold text-white/65 uppercase tracking-widest mb-3 mt-6">
              Why we use it
            </h3>
            <p className="text-white/70 text-sm leading-relaxed">
              One primitive, 10 chains, no per-user contract deploy. Each chain&apos;s impl is source-verified on Sourcify.
              The delegation marker is the only on-chain trace.
            </p>

            <details className="mt-6 group">
              <summary className="cursor-pointer text-xs font-semibold text-white/50 uppercase tracking-widest hover:text-white/70 transition-colors select-none list-none flex items-center gap-2">
                <span className="text-white/30 group-open:rotate-90 transition-transform inline-block">▸</span>
                Troubleshooting (things to know)
              </summary>
              <ul className="text-white/55 text-sm space-y-2 mt-4 leading-relaxed pl-5">
                <li>
                  • Your wallet&apos;s <span className="font-mono text-white/70">eth_getCode</span>{" "}
                  returns <span className="font-mono text-white/70">0xef0100&hellip;&lt;impl&gt;</span>{" "}
                  instead of <span className="font-mono text-white/70">0x</span> while the
                  delegation is active.
                </li>
                <li>
                  • MetaMask / OKX may display a{" "}
                  <span className="font-mono text-white/70">Smart account</span> indicator — the
                  delegation is to Q402&apos;s vetted impl, not a third-party contract.
                </li>
                <li>
                  • Native gas tokens (BNB / ETH / etc.) sent directly to a delegated EOA will not
                  land — the impl doesn&apos;t accept native receives. Clear the delegation first
                  if you want to receive native to that EOA.
                </li>
              </ul>
            </details>
          </Section>

          {/* ── AUTHENTICATION ── */}
          <Section id="auth" title="Authentication">
            <p className="text-white/70 text-sm mb-5">
              API key goes in the request body&apos;s <code className="text-yellow text-xs">apiKey</code> field.
              Sandbox keys (<code className="text-yellow text-xs">q402_test_*</code>) on wallet connect.
              Live keys (<code className="text-yellow text-xs">q402_live_*</code>) from <a className="text-yellow hover:underline" href="/event">/event</a> (Trial, BNB)
              or <a className="text-yellow hover:underline" href="/payment">/payment</a> (Multichain, 10 chains).
            </p>
            <CodeBlock lang="json" code={`// POST /api/relay
{
  "apiKey": "q402_live_YOUR_API_KEY",
  "chain":  "avax",
  "token":  "USDC",
  ...
}`} />
            <div className="p-4 rounded-xl border border-white/8 bg-white/[0.02]">
              <div className="text-xs text-yellow font-mono mb-1">q402_live_*</div>
              <div className="text-xs text-white/65">Production. Mainnet TX. <strong className="text-white/85">Keep private — tied to your Gas Tank.</strong></div>
            </div>
          </Section>

          {/* ── API REFERENCE ── */}
          <Section id="api-ref" title="API Reference">
            <p className="text-white/40 text-xs mb-8 font-mono">Base URL: https://q402.quackai.ai/api</p>

            {/* POST /relay */}
            <div className="mb-12">
              <div className="flex items-center gap-3 mb-2">
                <Badge color="#F5C518">POST</Badge>
                <span className="font-mono text-sm text-white/70">/relay</span>
              </div>
              <p className="text-white/65 text-sm mb-4">Submit a signed EIP-712 + EIP-7702 payload. Q402 verifies and relays on-chain.</p>
              <CodeBlock lang="json" code={`// Request body
{
  "apiKey":      "q402_live_YOUR_API_KEY",
  "chain":       "avax",           // avax | bnb | eth | xlayer | stable | mantle | injective | monad | scroll | arbitrum
  "token":       "USDC",           // USDC | USDT
  "from":        "0xUserWallet...",
  "to":          "0xRecipient...",
  "amount":      "50000000",       // atomic units (6 decimals = 50 USDC)
  "deadline":    1751289600,
  "witnessSig":  "0xabc123...",
  "authorization": { ... }         // EIP-7702 authorization object
}

// Response 200
// All numeric amounts are returned as decimal strings to preserve
// 18-decimal token precision (IEEE-754 doubles lose precision at that scale).
{
  "success":        true,
  "txHash":         "0xdef456...",
  "chain":          "avax",
  "blockNumber":    "54540550",
  "tokenAmount":    "50",
  "gasCostNative":  "0.000021",
  "method":         "eip7702"
}`} />
            </div>

            {/* GET /relay/info */}
            <div className="mb-4">
              <div className="flex items-center gap-3 mb-2">
                <Badge color="#627EEA">GET</Badge>
                <span className="font-mono text-sm text-white/70">/relay/info</span>
              </div>
              <p className="text-white/65 text-sm mb-4">Returns the relayer (facilitator) address. The <code className="text-yellow text-xs">facilitator</code> field in your EIP-712 payload must match.</p>
              <CodeBlock lang="json" code={`// GET /api/relay/info
{ "facilitator": "0xRelayerAddress..." }`} />
            </div>
          </Section>

          {/* ── CHAIN SUPPORT ── */}
          <Section id="chains" title="Chain Support">
            <p className="text-white/70 text-sm mb-6">
              Same API, same SDK. Switch with one parameter.
            </p>
            <div className="overflow-x-auto mb-4">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-white/8">
                    {["Chain", "chain param", "Chain ID", "Gas token", "Status", "Avg gas/tx"].map(h => (
                      <th key={h} className="text-left py-3 pr-6 text-white/30 text-xs uppercase tracking-wider font-semibold">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { name: "BNB Chain",  color: "#F0B90B", param: "bnb",    id: "56",    gasToken: "BNB",              gas: "~$0.001", stableNote: false },
                    { name: "Ethereum",   color: "#627EEA", param: "eth",    id: "1",     gasToken: "ETH",              gas: "~$0.19",  stableNote: false },
                    { name: "Avalanche",  color: "#E84142", param: "avax",   id: "43114", gasToken: "AVAX",             gas: "~$0.002", stableNote: false },
                    { name: "X Layer",    color: "#CCCCCC", param: "xlayer", id: "196",   gasToken: "OKB",              gas: "~$0.001", stableNote: false },
                    { name: "Stable",     color: "#4AE54A", param: "stable", id: "988",   gasToken: "USDT0 ★",          gas: "~$0.001", stableNote: true  },
                    { name: "Mantle",     color: "#000000", param: "mantle", id: "5000",  gasToken: "MNT",              gas: "~$0.001", stableNote: false },
                    { name: "Injective",  color: "#0082FA", param: "injective", id: "1776", gasToken: "INJ",            gas: "~$0.10",  stableNote: false },
                    { name: "Monad",      color: "#836EF9", param: "monad", id: "143",   gasToken: "MON",              gas: "~$0.001", stableNote: false },
                    { name: "Scroll",     color: "#EEB431", param: "scroll", id: "534352", gasToken: "ETH",             gas: "~$0.001", stableNote: false },
                    { name: "Arbitrum",   color: "#28A0F0", param: "arbitrum", id: "42161", gasToken: "ETH",            gas: "~$0.001", stableNote: false },
                  ].map((chain) => (
                    <tr key={chain.param} className="border-b border-white/5 hover:bg-white/2 transition-colors">
                      <td className="py-3 pr-6">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: chain.color }} />
                          <span className="font-medium text-sm">{chain.name}</span>
                        </div>
                      </td>
                      <td className="py-3 pr-6 font-mono text-white/50 text-xs">{chain.param}</td>
                      <td className="py-3 pr-6 font-mono text-white/30 text-xs">{chain.id}</td>
                      <td className="py-3 pr-6">
                        <span className={`font-mono text-xs ${chain.stableNote ? "text-yellow font-bold" : "text-white/40"}`}>
                          {chain.gasToken}
                        </span>
                      </td>
                      <td className="py-3 pr-6">
                        <span className="text-yellow text-xs font-semibold bg-yellow/10 px-2 py-0.5 rounded-full">Mainnet Live</span>
                      </td>
                      <td className="py-3 font-mono text-yellow text-xs">{chain.gas}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Callout type="info">
              Gas comes from <strong className="text-white/85">your Gas Tank</strong>, not Q402, not your users. Ethereum costs ~$0.19/TX — size the pool accordingly.
            </Callout>
            <Callout type="warn">
              <strong className="text-white/85">★ Stable:</strong> USDT0 is the gas token AND the payment token. Fund the Gas Tank with USDT0, not a native coin.
            </Callout>
          </Section>

          {/* ── EIP-712 SIGNING ── */}
          <Section id="eip712" title="EIP-712 Signing">
            <p className="text-white/70 text-sm mb-5">
              <strong className="text-white/90">EIP-712 typed structured data</strong> (same standard as Uniswap, Compound). User signs a human-readable message — no gas, no on-chain TX.
            </p>
            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3">Contract Addresses &amp; Domain Names</h3>
            <CodeBlock lang="typescript" code={`// Implementation contract per chain
const CONTRACTS = {
  avax:   "0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c", // Q402 Avalanche (chainId: 43114)
  bnb:    "0x6cF4aD62C208b6494a55a1494D497713ba013dFa", // Q402 BNB Chain (chainId: 56)
  eth:    "0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD", // Q402 Ethereum  (chainId: 1)
  xlayer: "0x8D854436ab0426F5BC6Cc70865C90576AD523E73", // Q402 X Layer   (chainId: 196)
  stable: "0x2fb2B2D110b6c5664e701666B3741240242bf350", // Q402 Stable    (chainId: 988)
  mantle: "0xE5b90D564650bdcE7C2Bb4344F777f6582e05699", // Q402 Mantle    (chainId: 5000)
  injective: "0xa9a7dcE76DEF2AC36057FeF0d8103dF10581d61e", // Q402 Injective (chainId: 1776)
  monad:  "0xc5d4dFA6D2e545409C1abf86f336Dd43bb87621f", // Q402 Monad     (chainId: 143)
  scroll: "0x7635F32D893B64b5944CB8cbF2AC4cd3dA41B2f1", // Q402 Scroll    (chainId: 534352)
  arbitrum: "0x8D854436ab0426F5BC6Cc70865C90576AD523E73", // Q402 Arbitrum  (chainId: 42161)
};

// EIP-712 domain name — must match contract NAME constant exactly
const DOMAIN_NAMES = {
  avax:      "Q402 Avalanche",
  bnb:       "Q402 BNB Chain",
  eth:       "Q402 Ethereum",
  xlayer:    "Q402 X Layer",
  stable:    "Q402 Stable",
  mantle:    "Q402 Mantle",
  injective: "Q402 Injective",
  monad:     "Q402 Monad",
  scroll:    "Q402 Scroll",
  arbitrum:  "Q402 Arbitrum",
};

// verifyingContract:
//   ALL chains → user's own EOA  (address(this) under EIP-7702 delegation)`} />

            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3 mt-6">Witness Type (unified across all chains)</h3>
            <CodeBlock lang="typescript" code={`// Every deployed Q402 impl contract uses the same EIP-712 typed struct:
const types = {
  TransferAuthorization: [
    { name: "owner",       type: "address" }, // token sender (user's EOA)
    { name: "facilitator", type: "address" }, // gas sponsor (Q402 relayer)
    { name: "token",       type: "address" }, // ERC-20 contract (USDC / USDT / USDT0)
    { name: "recipient",   type: "address" }, // payment destination
    { name: "amount",      type: "uint256" }, // atomic units
    { name: "nonce",       type: "uint256" }, // random uint256, replay protection
    { name: "deadline",    type: "uint256" }, // unix timestamp
  ],
};

// verifyingContract is ALWAYS the user's own EOA — the contract computes its
// domain separator with address(this), which equals the user EOA under EIP-7702.`} />

            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3 mt-6">Signing with ethers.js</h3>
            <CodeBlock lang="typescript" code={`// Fetch facilitator address first (required for all chains)
const { facilitator } = await fetch("https://q402.quackai.ai/api/relay/info").then(r => r.json());

const domain = {
  name:              DOMAIN_NAMES[chain],
  version:           "1",
  chainId:           chainId,
  verifyingContract: userAddress,  // user's own EOA — same for all chains under EIP-7702
};

const nonce = ethers.toBigInt(ethers.randomBytes(32)); // random uint256

const signature = await signer.signTypedData(domain, types, {
  owner:       userAddress,
  facilitator,
  token:       tokenAddress,
  recipient:   recipientAddress,
  amount:      ethers.parseUnits("50", decimals), // 6 decimals on most chains; 18 only for Stable chain's USDT0
  nonce,
  deadline:    BigInt(Math.floor(Date.now() / 1000) + 600),
});`} />
            <Callout type="info">
              <strong className="text-white/85">EIP-7702:</strong> All 10 chains use Type-4 TX — atomic delegate + transfer. X Layer also supports EIP-3009 (pass <code>eip3009Nonce</code> instead of <code>authorization</code>).
            </Callout>
            <Callout type="warn">
              <strong className="text-white/85">Stable:</strong> USDT0 here = 18 decimals. Use <code>ethers.parseUnits(amount, 18)</code>. Gas Tank also in USDT0. (Mantle USDT0 = 6 decimals.)
            </Callout>
          </Section>

          {/* ── ERRORS ── */}
          <Section id="errors" title="Error Responses">
            <p className="text-white/70 text-sm mb-3">JSON body: <code className="text-white/85">{`{ "error": string, "code"?: string }`}</code>. <code>error</code> is human-readable; <code>code</code> is a stable machine-readable tag (when present).</p>
            <p className="text-white/55 text-xs mb-5">Codes below are the currently-emitted set; most failures return only <code>error</code>.</p>
            <div className="space-y-2">
              {[
                { code: "(no code)",              http: "400", desc: "Generic validation failure — malformed JSON, missing required field, or chain-specific shape error. The error message describes the offending field." },
                { code: "(no code)",              http: "401", desc: "Missing or invalid API key, or API key has been rotated." },
                { code: "NONCE_EXPIRED",          http: "401", desc: "Auth challenge has expired or already been consumed. Fetch a fresh nonce from /api/auth/nonce." },
                { code: "SIG_MISMATCH",           http: "401", desc: "Auth signature does not match the expected challenge for the given address." },
                { code: "(no code)",              http: "402", desc: "Insufficient gas tank balance for the selected chain. Top up via dashboard." },
                { code: "NO_INTENT",              http: "402", desc: "Activate called without a prior /api/payment/intent — call intent first to lock the quote." },
                { code: "INTENT_MISMATCH",        http: "402", desc: "Activate intentId does not match the stored latest intent for this address." },
                { code: "SENDER_MISMATCH",        http: "402", desc: "On-chain TX sender does not match the calling wallet address." },
                { code: "CHAIN_MISMATCH",         http: "402", desc: "On-chain payment was found but on a different chain than the intent specified." },
                { code: "TOKEN_MISMATCH",         http: "402", desc: "On-chain payment used a different ERC-20 than the intent specified." },
                { code: "AMOUNT_LOW",             http: "402", desc: "On-chain payment amount is below the intent's expectedUSD threshold." },
                { code: "(no code)",              http: "403", desc: "Subscription expired. Renew on /payment to continue." },
                { code: "ACTIVATION_IN_PROGRESS", http: "409", desc: "Another activation request is currently processing this txHash. Retry after a brief pause." },
                { code: "(no code)",              http: "429", desc: "Rate limit exceeded for the IP or API key, OR no TX credits remaining (purchase additional credits)." },
                { code: "ACTIVATION_RETRY",       http: "500", desc: "Activation failed during the KV write phase. Retry — the operation is idempotent, so a second attempt will pick up where the first stopped." },
              ].map((err, i) => (
                <div key={`${err.http}-${err.code}-${i}`} className="flex gap-4 p-4 rounded-xl border border-white/8">
                  <div className="flex-shrink-0 pt-0.5">
                    <span className="font-mono text-xs bg-red-400/10 px-2 py-0.5 rounded" style={{ color: err.http === "402" ? "#F5C518" : "#f87171" }}>{err.http}</span>
                  </div>
                  <div>
                    <div className="font-mono text-xs text-white/80 mb-0.5">{err.code}</div>
                    <div className="text-xs text-white/40 leading-relaxed">{err.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* ── FAQ ── */}
          <Section id="faq" title="FAQ">
            {[
              {
                q: "Do users need BNB, ETH, or AVAX to use Q402?",
                a: "No. Users only need USDC (or USDT) in their wallet. All gas is paid from your gas pool. The user signs a message — that's it."
              },
              {
                q: "Who pays gas?",
                a: "You — from your per-chain Gas Tank. Withdrawals are manual via business@quackai.ai."
              },
              {
                q: "Does Q402 hold my keys?",
                a: "Your personal wallet is non-custodial — you connect it (MetaMask / OKX) and Q402 never holds its key; the EIP-712 signature authorizes one transfer A→C, so Q402 only pays gas and relays and cannot redirect funds. Agent Wallets (Mode C) are managed: Q402 custodies an AES-256-GCM-encrypted key you can export or archive anytime."
              },
              {
                q: "What if a transaction fails?",
                a: "Failed relays discard the payload — no funds move. Common causes: empty Gas Tank or expired deadline."
              },
              {
                q: "Which tokens are supported?",
                a: "USDC + USDT on every chain (Injective added native Circle USDC via CCTP). RLUSD on Ethereum only (18 decimals, NY DFS regulated)."
              },
              {
                q: "How do I get an API key?",
                a: "Connect a wallet → sandbox key (q402_test_*). For a live key: /event (Trial, BNB, 2,000 TX free) or /payment (Multichain, 10 chains)."
              },
              {
                q: "How does billing work?",
                a: "Each paid purchase = 30-day window + TX credits for the tier. Top up within the window to upgrade. Plans never downgrade mid-window; cumulative resets on lapse."
              },
            ].map((item, i) => (
              <div key={i} className="mb-4 p-5 rounded-xl border border-white/8">
                <div className="font-semibold text-sm mb-2">{item.q}</div>
                <div className="text-white/50 text-sm leading-relaxed">{item.a}</div>
              </div>
            ))}
          </Section>

          {/* Bottom CTA */}
          <div className="border border-yellow/15 rounded-2xl p-8 text-center" style={{ background: "rgba(245,197,24,0.04)" }}>
            <h3 className="text-xl font-bold mb-2">Ready to go gasless?</h3>
            <p className="text-white/65 text-sm mb-6">Get a live API key on payment. Sandbox key is free to test first.</p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <a href="/payment" className="bg-yellow text-navy font-bold px-8 py-3 rounded-full hover:bg-yellow-hover transition-colors text-sm">
                Get API Key →
              </a>
              <a href="mailto:business@quackai.ai" className="border border-white/20 text-white/70 font-semibold px-8 py-3 rounded-full hover:bg-white/5 transition-colors text-sm">
                Talk to us
              </a>
            </div>
          </div>

          </div>
        </main>
      </div>
    </div>
  );
}
