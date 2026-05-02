"use client";

import Link from "next/link";

/**
 * Above-the-fold announcement strip linking to /claude.
 *
 * Sits between Hero and TrustedBy to surface the MCP launch without forcing a
 * full hero-section rewrite. Removed by deleting one import + one JSX line in
 * app/page.tsx — no other component depends on it.
 */
export default function ClaudeStrip() {
  return (
    <section className="border-y border-orange-300/20 bg-gradient-to-r from-orange-500/[0.06] via-yellow/[0.05] to-transparent">
      <div className="max-w-6xl mx-auto px-6 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-sm">
          <span className="inline-flex items-center gap-1 text-[10px] font-bold tracking-widest text-orange-300/90 uppercase">
            <span className="w-1.5 h-1.5 rounded-full bg-orange-300 animate-pulse" />
            New
          </span>
          <span className="text-white/80">
            Q402 is live in Claude Desktop —{" "}
            <span className="text-yellow font-semibold">pay anyone in one prompt.</span>
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <Link
            href="/claude"
            className="text-white/60 hover:text-white underline-offset-4 hover:underline transition-colors"
          >
            How it works
          </Link>
          <Link
            href="/claude#install"
            className="bg-yellow hover:bg-yellow-hover text-navy px-3 py-1.5 rounded-lg font-bold transition-colors"
          >
            Install MCP
          </Link>
        </div>
      </div>
    </section>
  );
}
