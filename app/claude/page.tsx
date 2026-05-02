"use client";

import Link from "next/link";
import { useState } from "react";

/**
 * /claude — landing page for the @quackai/q402-mcp launch.
 *
 * Long-scroll page. No video assets — text + code blocks only so the page
 * works the moment it ships. Demo videos can be slotted into the placeholder
 * section without changing layout.
 */

const INSTALL_CMD = "claude mcp add q402 -- npx @quackai/q402-mcp";

const CONFIG_JSON_SANDBOX = `{
  "mcpServers": {
    "q402": {
      "command": "npx",
      "args": ["-y", "@quackai/q402-mcp"]
    }
  }
}`;

const CONFIG_JSON_LIVE = `{
  "mcpServers": {
    "q402": {
      "command": "npx",
      "args": ["-y", "@quackai/q402-mcp"],
      "env": {
        "Q402_API_KEY": "q402_live_••••••••",
        "Q402_PRIVATE_KEY": "0x••••••••",
        "Q402_ENABLE_REAL_PAYMENTS": "1",
        "Q402_MAX_AMOUNT_PER_CALL": "5"
      }
    }
  }
}`;

function Code({ code, lang = "bash" }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative rounded-xl overflow-hidden border border-white/8 mb-4">
      <div
        className="flex items-center justify-between px-4 py-2 border-b border-white/8"
        style={{ background: "rgba(255,255,255,0.02)" }}
      >
        <span className="text-xs text-white/30 font-mono">{lang}</span>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="text-xs text-white/30 hover:text-white/80 transition-colors"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto bg-[#060C14]">
        <code className="text-xs font-mono text-white/80 leading-relaxed whitespace-pre">
          {code}
        </code>
      </pre>
    </div>
  );
}

function ToolCard({
  name,
  auth,
  description,
}: {
  name: string;
  auth: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.02] p-5 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <code className="text-yellow text-sm font-mono font-semibold">{name}</code>
        <span className="text-[10px] uppercase tracking-widest text-white/30">{auth}</span>
      </div>
      <p className="text-sm text-white/60 leading-relaxed">{description}</p>
    </div>
  );
}

export default function ClaudePage() {
  return (
    <div className="min-h-screen text-white" style={{ background: "#080E1C" }}>
      {/* Top nav (slim, mirrors /docs but minimal) */}
      <header className="border-b border-white/8 sticky top-0 z-30 backdrop-blur-md bg-navy/80">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="w-6 h-6 rounded-md bg-yellow flex items-center justify-center shadow-[0_0_12px_rgba(245,197,24,0.35)]">
              <span className="w-2.5 h-2.5 rounded-sm bg-navy/90" />
            </span>
            <span className="text-yellow font-bold text-lg tracking-tight leading-none">Q402</span>
          </Link>
          <div className="flex items-center gap-5 text-sm text-white/50">
            <Link href="/docs" className="hover:text-white">Docs</Link>
            <Link href="/dashboard" className="hover:text-white">Dashboard</Link>
            <a
              href="https://www.npmjs.com/package/@quackai/q402-mcp"
              target="_blank"
              rel="noreferrer"
              className="hover:text-yellow"
            >
              npm
            </a>
          </div>
        </div>
      </header>

      {/* HERO */}
      <section className="relative overflow-hidden border-b border-white/8">
        <div
          className="absolute inset-0 pointer-events-none opacity-60"
          style={{
            background:
              "radial-gradient(ellipse at top, rgba(245,158,11,0.10), transparent 60%), radial-gradient(ellipse at bottom right, rgba(245,197,24,0.08), transparent 60%)",
          }}
        />
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-28 relative">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-orange-300/30 bg-orange-300/5 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-orange-300 animate-pulse" />
            <span className="text-[10px] uppercase tracking-widest text-orange-300/90 font-bold">
              Claude × Quack AI
            </span>
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight leading-[1.05]">
            Pay anyone with Claude.<br />
            <span className="text-yellow">Powered by Q402.</span>
          </h1>
          <p className="text-base md:text-lg text-white/60 mt-6 max-w-2xl leading-relaxed">
            One MCP install and Claude Desktop can quote, settle, and confirm gasless USDC and USDT
            transfers across 7 EVM chains. The recipient receives the full amount. The sender pays
            $0 in gas. The agent never holds a key it shouldn&apos;t.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 mt-8">
            <a
              href="#install"
              className="bg-yellow hover:bg-yellow-hover text-navy font-bold px-6 py-3 rounded-xl transition-colors text-center"
            >
              Install MCP server
            </a>
            <a
              href="#tools"
              className="border border-white/15 hover:border-white/30 text-white/80 hover:text-white px-6 py-3 rounded-xl transition-colors text-center"
            >
              See the four tools
            </a>
          </div>
          <p className="text-xs text-white/40 mt-6">
            Sandbox by default — no API key, no signup, no funds at risk to try the quote tool.
          </p>
        </div>
      </section>

      {/* USE CASES (text-only) */}
      <section className="border-b border-white/8">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <div className="grid md:grid-cols-3 gap-5">
            <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-6">
              <div className="text-yellow text-xs font-bold uppercase tracking-widest mb-2">
                Compare
              </div>
              <h3 className="text-lg font-semibold mb-2">Cheapest chain, instantly</h3>
              <p className="text-sm text-white/55 leading-relaxed">
                <em>&ldquo;Claude, what&apos;s the cheapest chain to send 50 USDC?&rdquo;</em><br />
                The agent calls <code className="text-yellow text-xs">q402_quote</code> and ranks
                all 7 chains by gas, with notes on token availability per chain.
              </p>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-6">
              <div className="text-yellow text-xs font-bold uppercase tracking-widest mb-2">
                Settle
              </div>
              <h3 className="text-lg font-semibold mb-2">Pay in one prompt</h3>
              <p className="text-sm text-white/55 leading-relaxed">
                <em>&ldquo;Send 5 USDT to 0xabc… on Mantle.&rdquo;</em><br />
                Claude asks for confirmation in chat, then calls{" "}
                <code className="text-yellow text-xs">q402_pay</code>. Sandbox by default — flip
                three env vars to settle for real.
              </p>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-6">
              <div className="text-yellow text-xs font-bold uppercase tracking-widest mb-2">
                Unlock
              </div>
              <h3 className="text-lg font-semibold mb-2">Auto-resolve HTTP 402</h3>
              <p className="text-sm text-white/55 leading-relaxed">
                Build agents that hit a paywalled API, see <code className="text-yellow text-xs">402
                Payment Required</code>, and use Q402 to settle the fee inline — the same pattern
                Coinbase&apos;s x402 standardised, now reaching the chains x402 doesn&apos;t.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* INSTALL */}
      <section id="install" className="border-b border-white/8 scroll-mt-20">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <div className="flex items-baseline justify-between mb-6">
            <h2 className="text-2xl md:text-3xl font-bold">Install in 30 seconds</h2>
            <span className="text-xs text-white/30 font-mono">stdio · MCP 1.0</span>
          </div>
          <p className="text-white/55 text-sm mb-6 max-w-2xl">
            Works with any MCP-compatible client — Claude Desktop, Claude Code, Cline, Continue, and
            others. Pick whichever flow matches your client; the package itself is the same.
          </p>

          <h3 className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3">
            1 · Add the server
          </h3>
          <Code lang="bash" code={INSTALL_CMD} />

          <h3 className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3 mt-8">
            2 · Or paste this into your config (sandbox-safe)
          </h3>
          <Code lang="json" code={CONFIG_JSON_SANDBOX} />
          <p className="text-xs text-white/40 mb-6">
            On macOS Claude Desktop reads <code className="text-white/60">~/Library/Application
            Support/Claude/claude_desktop_config.json</code>. Restart the app after editing.
          </p>

          <h3 className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3 mt-8">
            3 · Enable real payments (optional)
          </h3>
          <Code lang="json" code={CONFIG_JSON_LIVE} />
          <p className="text-xs text-white/40">
            Get a live API key at{" "}
            <Link href="/dashboard" className="text-yellow hover:underline">
              /dashboard
            </Link>
            . All three env vars must be set for any real on-chain transaction; missing one falls
            back to sandbox automatically.
          </p>
        </div>
      </section>

      {/* TOOLS */}
      <section id="tools" className="border-b border-white/8 scroll-mt-20">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <h2 className="text-2xl md:text-3xl font-bold mb-2">Three tools, one package</h2>
          <p className="text-white/55 text-sm mb-8 max-w-2xl">
            The MCP server exposes only what an agent should reasonably reach for. No hidden admin
            endpoints, no key-rotation paths, nothing that would let a hallucination cost you money.
          </p>
          <div className="grid md:grid-cols-3 gap-4">
            <ToolCard
              name="q402_quote"
              auth="no auth"
              description="Compare gas cost and supported tokens across all 7 chains. Read-only — perfect first call before deciding where to send."
            />
            <ToolCard
              name="q402_balance"
              auth="api key"
              description="Verify the configured key and show its tier and remaining subscription quota. Read-only."
            />
            <ToolCard
              name="q402_pay"
              auth="api key + signer + flag"
              description="Send a gasless USDC or USDT payment. Sandbox by default; requires Q402_API_KEY (live tier), Q402_PRIVATE_KEY, and Q402_ENABLE_REAL_PAYMENTS=1 for real on-chain TX."
            />
          </div>
        </div>
      </section>

      {/* SAFETY */}
      <section className="border-b border-white/8">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <h2 className="text-2xl md:text-3xl font-bold mb-2">Safe by default</h2>
          <p className="text-white/55 text-sm mb-8 max-w-2xl">
            Letting an LLM touch a payment rail demands more guards than &ldquo;the model will be
            careful.&rdquo; Q402 layers four:
          </p>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-white/8 bg-white/[0.02] p-5">
              <div className="text-yellow text-xs font-bold uppercase tracking-widest mb-1">
                1 · Sandbox-default
              </div>
              <p className="text-sm text-white/60 leading-relaxed">
                Without three explicit env vars, every <code className="text-yellow text-xs">q402_pay</code>{" "}
                call returns a fake hash. No funds move, no quota is consumed.
              </p>
            </div>
            <div className="rounded-xl border border-white/8 bg-white/[0.02] p-5">
              <div className="text-yellow text-xs font-bold uppercase tracking-widest mb-1">
                2 · Per-call cap
              </div>
              <p className="text-sm text-white/60 leading-relaxed">
                <code className="text-yellow text-xs">Q402_MAX_AMOUNT_PER_CALL</code> defaults to $5.
                Anything larger is rejected before signing.
              </p>
            </div>
            <div className="rounded-xl border border-white/8 bg-white/[0.02] p-5">
              <div className="text-yellow text-xs font-bold uppercase tracking-widest mb-1">
                3 · Recipient allowlist
              </div>
              <p className="text-sm text-white/60 leading-relaxed">
                Set <code className="text-yellow text-xs">Q402_ALLOWED_RECIPIENTS</code> to a
                comma-separated list and any other address is rejected — useful for on-call
                pay-bots that should only ever pay one thing.
              </p>
            </div>
            <div className="rounded-xl border border-white/8 bg-white/[0.02] p-5">
              <div className="text-yellow text-xs font-bold uppercase tracking-widest mb-1">
                4 · Confirm-in-chat contract
              </div>
              <p className="text-sm text-white/60 leading-relaxed">
                The tool description requires the model to obtain explicit user confirmation of
                recipient and amount before passing <code className="text-yellow text-xs">confirm:
                true</code>. This is a procedural guard, not a cryptographic one — combine with the
                cap and allowlist for defense in depth.
              </p>
            </div>
          </div>

          <p className="text-xs text-white/40 mt-8 max-w-2xl">
            Server-side, the existing Q402 daily-quota cap and per-API-key spend limits also apply —
            a stolen key still cannot drain anything beyond your dashboard limits.
          </p>
        </div>
      </section>

      {/* CTA */}
      <section className="border-b border-white/8">
        <div className="max-w-6xl mx-auto px-6 py-16 text-center">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Ready when you are.
          </h2>
          <p className="text-white/55 text-sm mb-8 max-w-2xl mx-auto">
            Quote tool works with no setup. Paid tier unlocks real payments across 7 chains for
            $29/month — and your first $1 of gas is on us.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href="#install"
              className="bg-yellow hover:bg-yellow-hover text-navy font-bold px-6 py-3 rounded-xl transition-colors"
            >
              Copy install command
            </a>
            <Link
              href="/dashboard"
              className="border border-white/15 hover:border-white/30 text-white/80 hover:text-white px-6 py-3 rounded-xl transition-colors"
            >
              Get an API key
            </Link>
          </div>
          <p className="text-xs text-white/40 mt-8">
            Source: <a className="text-yellow hover:underline" href="https://github.com/bitgett/q402-mcp">github.com/bitgett/q402-mcp</a>
            {" "}· Package: <a className="text-yellow hover:underline" href="https://www.npmjs.com/package/@quackai/q402-mcp">@quackai/q402-mcp</a>
          </p>
        </div>
      </section>

      <footer className="py-10">
        <div className="max-w-6xl mx-auto px-6 text-xs text-white/30 text-center">
          Apache-2.0 · Q402 is built by Quack AI Labs · MCP is a Model Context Protocol open
          standard developed by Anthropic.
        </div>
      </footer>
    </div>
  );
}
