"use client";

import Navbar from "@/app/components/Navbar";
import Footer from "@/app/components/Footer";

const FEATURES = [
  {
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
      </svg>
    ),
    title: "Unlimited TX quota",
    desc: "No monthly cap. Relay as many transactions as your agents need — Gas Tank balance is the only limit.",
  },
  {
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
      </svg>
    ),
    title: "All 5 EVM chains",
    desc: "Avalanche, BNB Chain, Ethereum, X Layer, Stable — one API key covers every chain your agents touch.",
  },
  {
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" />
      </svg>
    ),
    title: "Gas Tank pre-pay",
    desc: "Deposit once per chain. Agents relay freely until the tank runs dry — no per-TX billing overhead.",
  },
  {
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
      </svg>
    ),
    title: "Webhooks",
    desc: "Every relay triggers a signed POST to your endpoint. React to payments in real time without polling.",
  },
  {
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
      </svg>
    ),
    title: "Sandbox mode",
    desc: "Test your agent pipeline with q402_test_ keys — mock responses, no gas spent, full webhook events.",
  },
  {
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
      </svg>
    ),
    title: "Node.js SDK",
    desc: "No browser wallet required. Sign EIP-712 + EIP-7702 authorizations directly with viem in your agent process.",
  },
];

const CODE_STEPS = [
  {
    label: "Install",
    lang: "bash",
    code: `npm install viem`,
  },
  {
    label: "Initialize agent",
    lang: "javascript",
    code: `import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalanche } from "viem/chains";

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY);
const client = createWalletClient({
  account,
  chain: avalanche,
  transport: http(process.env.AVAX_RPC),
});`,
  },
  {
    label: "Sign & relay",
    lang: "javascript",
    code: `// EIP-7702 authorization (no browser needed)
const auth = await client.experimental_signAuthorization({
  contractAddress: "0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c",
  nonce: await client.getTransactionCount({ address: account.address }),
});

// EIP-712 payment witness
const sig = await client.signTypedData({ domain, types, message });

// Relay — Q402 pays the gas
const res = await fetch("https://q402.io/api/relay", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    apiKey: process.env.Q402_API_KEY,
    chain: "avax",
    token: "USDC",
    from: account.address,
    to: recipientAddress,
    amount: "5000000",       // 5 USDC (6 decimals)
    deadline: Math.floor(Date.now() / 1000) + 3600,
    nonce: String(randomNonce),
    witnessSig: sig,
    authorization: auth,
  }),
});

const { txHash } = await res.json();
console.log("Relayed:", txHash);`,
  },
];

const COMPARISON = [
  { label: "Holds native gas tokens", traditional: "Every agent wallet", q402: "Q402 Gas Tank only" },
  { label: "Gas management", traditional: "Per-agent, per-chain", q402: "Single shared tank" },
  { label: "TX signing", traditional: "RPC + gas estimation", q402: "EIP-712 off-chain sign" },
  { label: "100 agents × 5 chains", traditional: "500 funded wallets", q402: "1 API key + 5 deposits" },
  { label: "Failed TX (gas spike)", traditional: "Tx dropped, funds stuck", q402: "Relayer handles retry" },
];

export default function AgentsPage() {
  return (
    <div className="min-h-screen text-white" style={{ background: "#080E1C" }}>
      <Navbar />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="pt-32 pb-20 px-6 text-center">
        <div className="max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 text-green-400 text-xs font-bold uppercase tracking-widest border border-green-400/20 bg-green-400/5 px-3 py-1.5 rounded-full mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            AI / Agents
          </div>
          <h1 className="text-4xl md:text-5xl font-extrabold leading-tight mb-5">
            Gasless payments for<br />
            <span className="text-green-400">autonomous agents</span>
          </h1>
          <p className="text-white/50 text-lg leading-relaxed mb-8 max-w-2xl mx-auto">
            Running hundreds of AI agents across 5 chains shouldn&apos;t mean managing 500 funded wallets.
            Fund one Gas Tank per chain — your agents relay freely.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href="mailto:hello@quackai.ai?subject=Q402 Agent Plan Inquiry"
              className="bg-green-400 text-navy font-extrabold px-8 py-4 rounded-xl hover:bg-green-300 transition-all hover:scale-[1.02]"
            >
              Contact Sales →
            </a>
            <a
              href="/docs"
              className="border border-white/20 text-white font-semibold px-8 py-4 rounded-xl hover:bg-white/5 transition-all"
            >
              Read the Docs
            </a>
          </div>
        </div>
      </section>

      {/* ── The Problem ──────────────────────────────────────────────────── */}
      <section className="py-16 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl font-bold text-center mb-10">Why gas management kills agent pipelines</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8">
                  <th className="text-left py-3 px-4 text-white/30 font-medium w-1/3"></th>
                  <th className="text-left py-3 px-4 text-white/50 font-medium">Traditional approach</th>
                  <th className="text-left py-3 px-4 text-green-400 font-medium">With Q402</th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map((row, i) => (
                  <tr key={i} className="border-b border-white/5">
                    <td className="py-3 px-4 text-white/40 text-xs">{row.label}</td>
                    <td className="py-3 px-4 text-red-400/70 text-xs">{row.traditional}</td>
                    <td className="py-3 px-4 text-green-400/80 text-xs">{row.q402}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────────────────── */}
      <section className="py-16 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl font-bold text-center mb-10">Everything agents need</h2>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map((f, i) => (
              <div key={i} className="rounded-2xl border border-white/8 p-5" style={{ background: "rgba(255,255,255,0.02)" }}>
                <div className="w-9 h-9 rounded-xl bg-green-400/10 text-green-400 flex items-center justify-center mb-3">
                  {f.icon}
                </div>
                <p className="font-semibold text-sm mb-1">{f.title}</p>
                <p className="text-white/40 text-xs leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Code ─────────────────────────────────────────────────────────── */}
      <section className="py-16 px-6">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl font-bold text-center mb-2">3 steps to gasless agents</h2>
          <p className="text-white/35 text-sm text-center mb-10">No browser wallet. No MetaMask. Pure Node.js.</p>
          <div className="space-y-4">
            {CODE_STEPS.map((step, i) => (
              <div key={i} className="rounded-2xl border border-white/8 overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/8" style={{ background: "rgba(255,255,255,0.02)" }}>
                  <span className="w-5 h-5 rounded-full bg-green-400/15 text-green-400 text-xs font-bold flex items-center justify-center flex-shrink-0">
                    {i + 1}
                  </span>
                  <span className="text-xs text-white/50 font-medium">{step.label}</span>
                  <span className="ml-auto text-xs text-white/20 font-mono">{step.lang}</span>
                </div>
                <pre className="p-4 text-xs text-white/70 overflow-x-auto leading-relaxed font-mono">
                  <code>{step.code}</code>
                </pre>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ──────────────────────────────────────────────────────── */}
      <section className="py-16 px-6">
        <div className="max-w-lg mx-auto">
          <div className="rounded-2xl border border-green-400/20 p-8 text-center" style={{ background: "linear-gradient(135deg, rgba(74,229,74,0.06) 0%, rgba(255,255,255,0.02) 100%)" }}>
            <div className="text-green-400 text-xs font-bold uppercase tracking-widest mb-4">Agent Plan</div>
            <div className="flex items-baseline justify-center gap-1 mb-2">
              <span className="text-5xl font-extrabold">$500</span>
              <span className="text-white/40">/mo</span>
            </div>
            <p className="text-white/40 text-sm mb-6">+ Gas Tank (deposit per chain, consumed at cost)</p>
            <ul className="text-left space-y-2 mb-8">
              {[
                "Unlimited TX quota",
                "All 5 EVM chains",
                "Gas Tank pre-pay model",
                "Webhooks + sandbox mode",
                "Node.js agent SDK support",
                "Priority support",
              ].map((f, i) => (
                <li key={i} className="flex items-center gap-2 text-sm text-white/70">
                  <span className="text-green-400 flex-shrink-0">✓</span>
                  {f}
                </li>
              ))}
            </ul>
            <a
              href="mailto:hello@quackai.ai?subject=Q402 Agent Plan Inquiry"
              className="block w-full bg-green-400 text-navy font-extrabold py-4 rounded-xl hover:bg-green-300 transition-all hover:scale-[1.01]"
            >
              Contact Sales →
            </a>
            <p className="text-white/20 text-xs mt-4">
              Custom pricing available for pipelines with 1,000+ agents.
            </p>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
