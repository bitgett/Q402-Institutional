"use client";

import Link from "next/link";
import { useState } from "react";

const NAV = [
  { id: "overview",     label: "Overview",        icon: "○" },
  { id: "how-it-works", label: "How It Works",    icon: "○" },
  { id: "quickstart",   label: "Quick Start",     icon: "○" },
  { id: "claude-mcp",   label: "Claude MCP",      icon: "○" },
  { id: "gaspool",      label: "Gas Pool",         icon: "○" },
  { id: "auth",         label: "Authentication",   icon: "○" },
  { id: "api-ref",      label: "API Reference",    icon: "○" },
  { id: "chains",       label: "Chain Support",    icon: "○" },
  { id: "eip712",       label: "EIP-712 Signing",  icon: "○" },
  { id: "errors",       label: "Error Codes",      icon: "○" },
  { id: "faq",          label: "FAQ",              icon: "○" },
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
    tip:  { border: "rgba(74,222,128,0.25)", bg: "rgba(74,222,128,0.05)", dot: "#4ade80", label: "Tip" },
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
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-5">
            <Link href="/" className="flex items-center gap-2">
              <span className="text-yellow font-bold text-base">Q402</span>
              <span className="text-white/20 text-xs">/</span>
              <span className="text-white/50 text-xs font-medium">docs</span>
            </Link>
            <div className="hidden sm:flex items-center gap-1 bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5">
              <span className="text-white/25 text-xs font-mono">v1.6.0</span>
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

      <div className="max-w-7xl mx-auto flex pt-14">
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
        <main className="flex-1 min-w-0 max-w-3xl">
          {/* Docs hero banner */}
          <div className="px-8 pt-12 pb-10 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "linear-gradient(180deg, rgba(245,197,24,0.04) 0%, transparent 100%)" }}>
            <div className="flex items-center gap-2 mb-4">
              <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded" style={{ background: "rgba(245,197,24,0.12)", color: "#F5C518" }}>v1.6.0</span>
              <span className="text-white/20 text-xs">·</span>
              <span className="text-white/30 text-xs">EIP-712 + EIP-7702</span>
            </div>
            <h1 className="text-3xl font-bold mb-3">Q402 Developer Docs</h1>
            <p className="text-white/50 text-sm leading-relaxed max-w-xl">
              Everything you need to add gasless USDC payments to your product. One API. Any EVM chain. Zero gas for your users.
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
            <p className="text-white/60 text-base leading-relaxed mb-6">
              Q402 is a <span className="text-white font-medium">managed relay layer for stablecoin payments</span> across EVM chains.
              Your product sends USDC or USDT from a user&apos;s wallet without the user ever holding a native token —
              Q402&apos;s relayer submits the on-chain transaction and pays the gas.
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

            <p className="text-white/45 text-sm leading-relaxed mb-6">
              Three moving parts: an <span className="text-white/70">intent</span> that locks the quote before payment,
              an <span className="text-white/70">activate</span> step that scans the on-chain transfer and issues credits,
              and a <span className="text-white/70">relay</span> that submits gasless payments for your users.
              Every relay can fire a signed webhook and is recorded for audit.
            </p>

            {/* What is an API? — plain language */}
            <div className="bg-white/[0.03] border border-white/8 rounded-xl p-5 mb-6">
              <p className="text-xs text-white/30 uppercase tracking-widest font-semibold mb-2">What is an API?</p>
              <p className="text-white/55 text-sm leading-relaxed">
                An API is just a URL your server calls. Like ordering food at a restaurant — you send a request (&quot;here&apos;s a user&apos;s signed transaction&quot;), Q402&apos;s server handles the work, and sends back a result (&quot;done, txHash: 0xabc...&quot;). No blockchain expertise needed on your end.
              </p>
            </div>

            <div className="grid sm:grid-cols-3 gap-4 mb-8">
              {[
                { label: "Protocol",         value: "EIP-712 + EIP-7702" },
                { label: "Settlement token", value: "USDC · USDT" },
                { label: "Gas source",       value: "Your gas pool" },
              ].map((item) => (
                <div key={item.label} className="rounded-xl p-4 border border-white/8" style={{ background: "rgba(255,255,255,0.02)" }}>
                  <div className="text-xs text-white/30 mb-1">{item.label}</div>
                  <div className="text-sm font-mono text-white/80">{item.value}</div>
                </div>
              ))}
            </div>
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
                  step: "C", color: "#4ade80",
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
                <span className="text-green-400">Q402 API</span>
              </div>
              <div>
                <span className="text-green-400">Q402</span>
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
            <p className="text-white/55 text-sm mb-6">
              Get your first gasless transaction running in under 5 minutes.
            </p>

            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3">1 · Load the SDK</h3>
            <CodeBlock lang="html" code={`<script src="https://q402.quackai.ai/q402-sdk.js"></script>`} />

            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3">2 · One-line gasless payment (client-side)</h3>
            <CodeBlock lang="javascript" code={`// Initialize once with your API key + chain
const q402 = new Q402Client({
  apiKey: "q402_live_YOUR_KEY",
  chain:  "bnb",   // "bnb" | "avax" | "eth" | "xlayer" | "stable" | "mantle" | "injective"
});
// Note: when chain is "injective", only token: "USDT" is supported.
// Native USDC via Circle CCTP is announced for Q2 2026.

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

            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3">3 · Injective EVM (USDT-only)</h3>
            <p className="text-white/55 text-sm mb-3">
              Native USDC via Circle CCTP is announced for Q2 2026; until then, Injective uses USDT as the only payment token. The SDK gates this explicitly — passing <code className="text-orange-300">token: &quot;USDC&quot;</code> with <code className="text-orange-300">chain: &quot;injective&quot;</code> throws before any signature is requested, and the relay route enforces the same allowlist server-side.
            </p>
            <CodeBlock lang="javascript" code={`const q402 = new Q402Client({
  apiKey: "q402_live_YOUR_KEY",
  chain:  "injective",
});

const result = await q402.pay({
  to:     recipientAddress,
  amount: "50.00",
  token:  "USDT",   // required — USDC not yet supported on Injective
});`} />

            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3">4 · That&apos;s it</h3>
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
              The SDK handles signing <em>and</em> relay in one call — no separate backend step needed. The user never touches BNB, ETH, or AVAX. Gas is deducted from your pre-funded gas pool automatically.
            </Callout>
          </Section>

          {/* ── CLAUDE MCP ── */}
          <Section id="claude-mcp" title="Claude MCP">
            <p className="text-white/55 text-sm mb-6">
              Q402 ships as a Model Context Protocol server so Claude Desktop, Claude Code, Cline, and any other MCP-compatible AI client can quote and (optionally) settle gasless USDC and USDT payments directly from a chat. The package is{" "}
              <a className="text-yellow hover:underline" href="https://www.npmjs.com/package/@quackai/q402-mcp">@quackai/q402-mcp</a>{" "}
              on npm and{" "}
              <a className="text-yellow hover:underline" href="https://github.com/bitgett/q402-mcp">bitgett/q402-mcp</a> on GitHub.
            </p>

            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3">1 · Install</h3>
            <CodeBlock lang="bash" code={`# Claude Code CLI
claude mcp add q402 -- npx -y @quackai/q402-mcp

# Or paste this into claude_desktop_config.json:
# (macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json)
# (Windows: %APPDATA%\\Claude\\claude_desktop_config.json)
{
  "mcpServers": {
    "q402": {
      "command": "npx",
      "args": ["-y", "@quackai/q402-mcp"]
    }
  }
}`} />

            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3">2 · Tools exposed</h3>
            <div className="rounded-xl border border-white/8 mb-6 overflow-hidden" style={{ background: "rgba(255,255,255,0.02)" }}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-widest text-white/35" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                    <th className="px-4 py-3 font-semibold">Tool</th>
                    <th className="px-4 py-3 font-semibold">Auth</th>
                    <th className="px-4 py-3 font-semibold">Purpose</th>
                  </tr>
                </thead>
                <tbody className="text-white/65">
                  <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                    <td className="px-4 py-3"><code className="text-yellow text-xs">q402_quote</code></td>
                    <td className="px-4 py-3 text-white/40 text-xs">no auth</td>
                    <td className="px-4 py-3">Compare gas cost + supported tokens across chains. Read-only.</td>
                  </tr>
                  <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                    <td className="px-4 py-3"><code className="text-yellow text-xs">q402_balance</code></td>
                    <td className="px-4 py-3 text-white/40 text-xs">api key</td>
                    <td className="px-4 py-3">Verify the configured key and report its plan tier (live vs sandbox).</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3"><code className="text-yellow text-xs">q402_pay</code></td>
                    <td className="px-4 py-3 text-white/40 text-xs">api key + signer + flag</td>
                    <td className="px-4 py-3">Send a gasless payment. <strong>Sandbox by default</strong> — see below.</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3">3 · Sandbox vs live mode</h3>
            <p className="text-white/55 text-sm mb-3">
              By default <code className="text-yellow text-xs">q402_pay</code> runs in <strong>sandbox</strong> — it returns a deterministic-looking fake transaction hash, no funds move, no gas-tank credit is consumed. To enable real on-chain transactions, all three environment variables must be set:
            </p>
            <CodeBlock lang="bash" code={`Q402_API_KEY=q402_live_...      # live-tier key from /dashboard
Q402_PRIVATE_KEY=0xabc...       # signer for the payer EOA
Q402_ENABLE_REAL_PAYMENTS=1     # explicit opt-in`} />
            <p className="text-white/40 text-xs mb-6">
              Anything missing → automatic sandbox fallback with a hint pointing at what to set. Two additional guards run regardless of mode: <code className="text-white/60">Q402_MAX_AMOUNT_PER_CALL</code> (default $5) caps any single call, and <code className="text-white/60">Q402_ALLOWED_RECIPIENTS</code> optionally restricts to an address allowlist.
            </p>

            <Callout type="tip">
              The <code className="text-yellow text-xs">q402_pay</code> tool description tells the model to ALWAYS get explicit user confirmation of recipient + amount in chat before invoking. Combined with the sandbox default + cap + allowlist, that gives four layers of safety before any wei moves.
            </Callout>
          </Section>

          {/* ── GAS POOL ── */}
          <Section id="gaspool" title="Gas Pool">
            <p className="text-white/55 text-sm mb-6">
              Q402 uses a gas pool model. You deposit native tokens (BNB, ETH, MNT, AVAX, INJ, OKB, or USDT0 on Stable) into a single Q402-managed Gas Tank address that is shared across all customers — your balance is tracked off-chain, per wallet, in our ledger. Every time a user transaction is relayed, the gas fee is automatically deducted from your per-wallet balance.
            </p>

            <div className="grid sm:grid-cols-2 gap-4 mb-6">
              <div className="p-4 rounded-xl border border-white/8 bg-white/[0.02]">
                <div className="text-yellow text-xs font-semibold mb-2">Deposit</div>
                <p className="text-xs text-white/50 leading-relaxed">Send native tokens (BNB / ETH / MNT / AVAX / INJ / OKB / USDT0 on Stable) to the Q402 Gas Tank address shown in your dashboard. Your balance is tracked per wallet address. Note: the Gas Tank is a separate cold wallet from the hot relayer — never send funds to the relayer address directly.</p>
              </div>
              <div className="p-4 rounded-xl border border-white/8 bg-white/[0.02]">
                <div className="text-blue-400 text-xs font-semibold mb-2">Auto-deduction</div>
                <p className="text-xs text-white/50 leading-relaxed">Each relayed transaction deducts the actual gas cost in native tokens. Balances update in real time.</p>
              </div>
              <div className="p-4 rounded-xl border border-white/8 bg-white/[0.02]">
                <div className="text-green-400 text-xs font-semibold mb-2">Withdraw</div>
                <p className="text-xs text-white/50 leading-relaxed">Withdrawals are processed manually by Q402 operations. Contact business@quackai.ai to request a refund. Funds always remain yours.</p>
              </div>
            </div>

            <Callout type="warn">
              If your gas pool is empty, transactions will fail. Monitor the balance in your dashboard — and opt in to TX-credit email alerts (fire at 20 % / 10 % remaining) from the dashboard&apos;s Alerts panel. Top up via the dashboard or send native tokens directly to the Gas Tank address.
            </Callout>
          </Section>

          {/* ── AUTHENTICATION ── */}
          <Section id="auth" title="Authentication">
            <p className="text-white/55 text-sm mb-5">
              All relay requests require your API key in the <span className="font-mono text-white/70">apiKey</span> field of the request body. Connect your wallet to get a sandbox key (<span className="font-mono text-white/70">q402_test_*</span>) immediately. Your live key (<span className="font-mono text-white/70">q402_live_*</span>) is issued automatically once your on-chain payment is confirmed on <span className="font-mono text-white/70">/payment</span>.
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
              <div className="text-xs text-white/50">Production key. Transactions hit mainnet. <strong className="text-white/70">Keep this key private — it is tied to your gas tank.</strong></div>
            </div>
          </Section>

          {/* ── API REFERENCE ── */}
          <Section id="api-ref" title="API Reference">
            <p className="text-white/40 text-xs mb-8 font-mono">Base URL: https://q402.quackai.ai/api</p>

            {/* POST /relay */}
            <div className="mb-12">
              <div className="flex items-center gap-3 mb-2">
                <Badge color="#4ade80">POST</Badge>
                <span className="font-mono text-sm text-white/70">/relay</span>
              </div>
              <p className="text-white/50 text-sm mb-4">Submit a signed EIP-712 + EIP-7702 payload. Q402 verifies the signature and relays the transaction on-chain using your gas pool.</p>
              <CodeBlock lang="json" code={`// Request body
{
  "apiKey":      "q402_live_YOUR_API_KEY",
  "chain":       "avax",           // avax | bnb | eth | xlayer | stable | mantle | injective
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
              <p className="text-white/50 text-sm mb-4">Returns the relayer (facilitator) wallet address. Call this before constructing any TransferAuthorization — the facilitator field in the EIP-712 payload must match this value on all chains.</p>
              <CodeBlock lang="json" code={`// GET /api/relay/info
{ "facilitator": "0xRelayerAddress..." }`} />
            </div>
          </Section>

          {/* ── CHAIN SUPPORT ── */}
          <Section id="chains" title="Chain Support">
            <p className="text-white/55 text-sm mb-6">
              Same API, same SDK — regardless of which chain. Switch with one parameter.
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
                        <span className={`font-mono text-xs ${chain.stableNote ? "text-green-400 font-bold" : "text-white/40"}`}>
                          {chain.gasToken}
                        </span>
                      </td>
                      <td className="py-3 pr-6">
                        <span className="text-green-400 text-xs font-semibold bg-green-400/10 px-2 py-0.5 rounded-full">Mainnet Live</span>
                      </td>
                      <td className="py-3 font-mono text-yellow text-xs">{chain.gas}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Callout type="info">
              Gas costs are deducted from <strong className="text-white/80">your gas pool</strong> — not from Q402&apos;s pocket, not from your users. Ethereum gas is significantly higher; consider funding a larger pool for ETH.
            </Callout>
            <Callout type="warn">
              <strong className="text-white/80">★ Stable chain:</strong> USDT0 is both the gas token <em>and</em> the payment token on Stable (Chain ID 988). Your Gas Tank must be funded with USDT0 — not a native coin. Users also send USDT0 when making payments on this chain.
            </Callout>
          </Section>

          {/* ── EIP-712 SIGNING ── */}
          <Section id="eip712" title="EIP-712 Signing">
            <p className="text-white/55 text-sm mb-5">
              Q402 uses <span className="text-white font-medium">EIP-712 typed structured data signing</span> — the same standard used by Uniswap, Compound, and major DeFi protocols. The user signs a human-readable message. No gas. No blockchain interaction.
            </p>
            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3">Contract Addresses &amp; Domain Names</h3>
            <CodeBlock lang="typescript" code={`// Implementation contract per chain
const CONTRACTS = {
  avax:   "0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c", // Q402 Avalanche (chainId: 43114)
  bnb:    "0x6cF4aD62C208b6494a55a1494D497713ba013dFa", // Q402 BNB Chain (chainId: 56)
  eth:    "0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD", // Q402 Ethereum  (chainId: 1)
  xlayer: "0x8D854436ab0426F5BC6Cc70865C90576AD523E73", // Q402 X Layer   (chainId: 196)
  stable: "0x2fb2B2D110b6c5664e701666B3741240242bf350", // Q402 Stable    (chainId: 988)
  mantle: "0x2fb2B2D110b6c5664e701666B3741240242bf350", // Q402 Mantle    (chainId: 5000)
  injective: "0x2fb2B2D110b6c5664e701666B3741240242bf350", // Q402 Injective (chainId: 1776)
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
              <strong className="text-white/80">EIP-7702 note:</strong> All supported chains (BNB, ETH, Avalanche, X Layer, Stable, Mantle, Injective) use EIP-7702 Type 4 transactions. The relayer submits one transaction that delegates impl code to the user&apos;s EOA and executes the transfer atomically. X Layer additionally supports EIP-3009 as a fallback (pass <code>eip3009Nonce</code> instead of <code>authorization</code>).
            </Callout>
            <Callout type="warn">
              <strong className="text-white/80">Stable chain:</strong> USDT0 here has 18 decimals (not 6). Use <code>ethers.parseUnits(amount, 18)</code>. The gas pool must also be funded in USDT0 — there is no separate native gas coin. (Note: USDT0 on Mantle uses the same OFT address but 6 decimals, matching the other chains.)
            </Callout>
          </Section>

          {/* ── ERRORS ── */}
          <Section id="errors" title="Error Responses">
            <p className="text-white/55 text-sm mb-3">Errors return a JSON body of the form <span className="font-mono text-white/70">{`{ "error": string, "code"?: string }`}</span>. The HTTP status conveys the failure class; <span className="font-mono text-white/70">error</span> is a human-readable message and <span className="font-mono text-white/70">code</span> (when present) is a stable machine-readable tag for programmatic handling.</p>
            <p className="text-white/40 text-xs mb-5">Most failure modes today return only <span className="font-mono text-white/60">error</span> (no <span className="font-mono text-white/60">code</span>). The codes listed below are the stable tags currently emitted by the server.</p>
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
                q: "Who pays the gas fees?",
                a: "You do — from your gas pool. You deposit native tokens (BNB on BNB Chain, ETH on Ethereum, etc.) to your project's gas pool address. Q402 auto-deducts the exact gas cost per transaction. To withdraw, contact business@quackai.ai — withdrawals are processed manually by Q402 operations."
              },
              {
                q: "Is Q402 non-custodial?",
                a: "Yes. Q402 never holds user funds. The EIP-712 signature authorizes exactly one transfer from A to C. Q402 only pays gas and relays — it cannot redirect or intercept USDC."
              },
              {
                q: "What if a transaction fails?",
                a: "If relay fails, the payload is discarded and no user funds are moved. Check the error code in the API response — common causes are insufficient gas tank balance or an expired deadline."
              },
              {
                q: "Can I use Q402 with tokens other than USDC?",
                a: "Currently USDC and USDT are supported on every live chain except Injective EVM, which is USDT-only at launch — native USDC via Circle CCTP is announced for Q2 2026 and will be added in the next minor release. Additional ERC-20 token support is on the roadmap."
              },
              {
                q: "How do I get an API key?",
                a: "Connect your wallet on the dashboard — a sandbox API key (q402_test_ prefix) is provisioned for free so you can test the integration. To get a live key, complete an on-chain payment on the /payment page. Your live key is issued automatically after the payment is confirmed."
              },
              {
                q: "How does billing work? Can I upgrade my plan?",
                a: "Each paid purchase grants a 30-day access window plus the transaction credits listed for that tier. Your plan tier is set by cumulative paid amount within the active window, normalized to BNB Chain base pricing (Ethereum and Avalanche are converted at the chain multiplier). Top up within 30 days and your plan upgrades automatically when cumulative spend crosses the next tier. Plans never downgrade while the window is active; if you let the window lapse, cumulative resets."
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
            <p className="text-white/40 text-sm mb-6">Pick a plan, send an on-chain payment, and your live API key is issued automatically. Sandbox key available for free to test first.</p>
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
