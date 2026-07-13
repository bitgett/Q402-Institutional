/**
 * /mcp — dedicated MCP install page for AI-agent developers.
 *
 * Deliberately short: one install command, three example prompts, the clients
 * it runs in, and the sandbox-first promise. The full tool reference + SDK live
 * in /docs; this page is the 30-second "add Q402 to my agent" surface.
 */

import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/app/components/Navbar";
import Footer from "@/app/components/Footer";

export const metadata: Metadata = {
  title: "Q402 MCP - gasless payments for AI agents",
  description:
    "Add Q402 to Claude, Codex, Cursor, Cline, Copilot, or Hermes. 46 tools to pay, bridge, and earn across 12 chains from natural language. Sandbox by default.",
};

const CLIENTS = ["Claude", "Codex", "Cursor", "Cline", "Copilot", "Hermes"];

const PROMPTS = [
  "Pay 5 USDC to 0xA1b2…9F3c on Base.",
  "What is in my agent wallet, and on which chains?",
  "Bridge 10 USDT to Mantle, then earn yield on it.",
];

const CARD: React.CSSProperties = { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.09)" };

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/40 mb-3">{children}</div>;
}

export default function McpPage() {
  return (
    <>
      <Navbar />
      <main className="min-h-screen px-6 pt-28 pb-24" style={{ background: "linear-gradient(160deg,#06060C 0%,#0A0E1C 100%)" }}>
        <div className="max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-yellow/30 bg-yellow/[0.06] mb-7">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow animate-pulse" />
            <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-yellow/95">Q402 MCP · 46 tools</span>
          </div>

          <h1 className="font-display text-4xl sm:text-5xl font-extrabold tracking-tight leading-[1.05] text-white">
            Gasless payments for AI agents, in your MCP client.
          </h1>
          <p className="mt-5 text-white/60 text-base sm:text-lg leading-relaxed max-w-2xl">
            Claude, Codex, Cursor, and more can pay, get paid, bridge, and earn across 12 chains from natural language. No gas, sandbox by default.
          </p>

          {/* Install */}
          <div className="mt-10 rounded-2xl p-5" style={CARD}>
            <Label>Install</Label>
            <div
              className="rounded-lg px-4 py-3 font-mono text-sm text-yellow overflow-x-auto whitespace-nowrap"
              style={{ background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.07)" }}
            >
              claude mcp add q402 -- npx -y @quackai/q402-mcp
            </div>
            <div className="mt-3 text-white/45 text-[13px] leading-relaxed">
              Any stdio client works. Point it at <span className="font-mono text-white/70">npx -y @quackai/q402-mcp</span>, then run{" "}
              <span className="font-mono text-yellow/90">q402_doctor</span> to set up your key.
            </div>
          </div>

          {/* Try */}
          <div className="mt-9">
            <Label>Try</Label>
            <div className="grid gap-2.5">
              {PROMPTS.map((p) => (
                <div key={p} className="rounded-xl px-4 py-3 text-white/80 text-sm flex items-start gap-3" style={CARD}>
                  <span className="text-yellow/70 mt-px flex-shrink-0">→</span>
                  <span>{p}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Clients */}
          <div className="mt-9">
            <Label>Works in</Label>
            <div className="flex flex-wrap gap-2">
              {CLIENTS.map((c) => (
                <span key={c} className="px-3.5 py-2 rounded-full text-sm text-white/75 font-medium" style={CARD}>
                  {c}
                </span>
              ))}
            </div>
          </div>

          {/* Sandbox-first */}
          <div
            className="mt-9 rounded-2xl p-5 text-white/70 text-sm leading-relaxed"
            style={{ background: "rgba(245,197,24,0.05)", border: "1px solid rgba(245,197,24,0.22)" }}
          >
            <b className="text-white">Sandbox by default.</b> Tools return a fake transaction until you add a live API key, pick a signing path, and confirm in chat. Nothing moves funds until you say so.
          </div>

          {/* CTAs */}
          <div className="mt-10 flex flex-wrap gap-3">
            <Link href="/docs" className="bg-yellow text-navy font-bold text-sm px-6 py-3 rounded-full hover:bg-yellow-hover transition-colors">
              Read the docs →
            </Link>
            <a
              href="https://www.npmjs.com/package/@quackai/q402-mcp"
              target="_blank"
              rel="noopener noreferrer"
              className="border border-white/15 text-white font-semibold text-sm px-6 py-3 rounded-full hover:border-yellow/40 transition-colors"
            >
              npm package
            </a>
            <Link href="/event" className="border border-white/15 text-white font-semibold text-sm px-6 py-3 rounded-full hover:border-yellow/40 transition-colors">
              Free trial
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
