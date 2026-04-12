"use client";

import WalletButton from "./WalletButton";

export default function Navbar() {

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-navy/80 backdrop-blur-md border-b border-white/10">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        {/* Logo */}
        <a href="/" className="flex items-baseline gap-1.5">
          <span className="text-yellow font-bold text-lg tracking-tight">Q402</span>
          <span className="text-white/30 text-xs font-light hidden sm:block">by Quack AI</span>
        </a>

        {/* Nav links */}
        <div className="hidden md:flex items-center gap-8 text-sm text-white/50">
          <a href="/#how-it-works" className="hover:text-white transition-colors">How it works</a>
          <a href="/#use-cases"    className="hover:text-white transition-colors">Use cases</a>
          <a href="/#pricing"      className="hover:text-white transition-colors">Pricing</a>
          <a href="/agents"        className="hover:text-green-400 transition-colors text-green-400/70">Agents</a>
          <a href="/grant"         className="hover:text-yellow transition-colors text-yellow/70 font-medium">Grant</a>
          <a href="/docs"          className="hover:text-white transition-colors">Docs</a>
        </div>

        <WalletButton />
      </div>
    </nav>
  );
}
