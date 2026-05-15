"use client";

import Link from "next/link";
import WalletButton from "./WalletButton";
import { EVENT_MODE } from "@/app/lib/feature-flags";

export default function Navbar() {

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-navy/80 backdrop-blur-md border-b border-white/10">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        {/* Left group: logo + nav */}
        <div className="flex items-center gap-10">
          <Link href="/" className="flex items-center gap-2">
            <span className="w-6 h-6 rounded-md bg-yellow flex items-center justify-center shadow-[0_0_12px_rgba(245,197,24,0.35)]">
              <span className="w-2.5 h-2.5 rounded-sm bg-navy/90" />
            </span>
            <span className="text-yellow font-bold text-lg tracking-tight leading-none">Q402</span>
            <span className="text-white/30 text-xs font-light hidden sm:block leading-none">by Quack AI</span>
          </Link>

          {/* Nav links — left-aligned, close to the logo */}
          <div className="hidden md:flex items-center gap-7 text-sm text-white/50">
            <Link href="/#how-it-works" className="hover:text-white transition-colors">How it works</Link>
            <Link href="/#use-cases"    className="hover:text-white transition-colors">Use cases</Link>
            <Link href="/#pricing"      className="hover:text-white transition-colors">Pricing</Link>
            {EVENT_MODE && (
              <Link href="/event" className="inline-flex items-center gap-1.5 hover:text-yellow transition-colors text-yellow/85 font-medium">
                Event
                <span className="text-[8px] font-extrabold tracking-[0.14em] text-yellow bg-yellow/15 border border-yellow/40 rounded-sm px-1 leading-[1.4]">FREE</span>
              </Link>
            )}
            <a href="/agents"        className="hover:text-green-400 transition-colors text-green-400/70">Agents</a>
            <a href="/claude" className="inline-flex items-center gap-1.5 hover:text-orange-200 transition-colors text-orange-300/85 font-medium">
              Claude
              <span className="text-[8px] font-extrabold tracking-[0.14em] text-orange-300 bg-orange-300/15 border border-orange-300/40 rounded-sm px-1 leading-[1.4]">NEW</span>
            </a>
            <a href="/grant"         className="hover:text-yellow transition-colors text-yellow/70 font-medium">Grant</a>
            <a href="/docs"          className="hover:text-white transition-colors">Docs</a>
          </div>
        </div>

        <WalletButton />
      </div>
    </nav>
  );
}
