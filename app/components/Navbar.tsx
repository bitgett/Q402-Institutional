"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import WalletButton from "./WalletButton";
import NavDropdown, { Hex, type NavDropdownItem } from "./NavDropdown";
import MobileMenu from "./MobileMenu";
import { EVENT_MODE } from "@/app/lib/feature-flags";

/**
 * Navbar - fixed top bar, 72px tall, full-bleed so the brand mark (left) and the
 * WalletButton (right) keep their original viewport-edge positions. Flat
 * datasheet styling, house colors only (navy + #F5C518 + #5BC8FA).
 *
 * Composition: the flagship product pages (Agent Wallet, MCP server) lead the
 * Product menu; Developers holds the build resources; Grant and Visualization
 * are standalone links (no more single-item Community dropdown).
 */

const PRODUCT_ITEMS: NavDropdownItem[] = [
  { href: "/agents", label: "Agent Wallet", description: "Gasless, bounded spend for AI agents.", accent: "yellow" },
  { href: "/claude", label: "MCP server", description: "Q402 in Claude, Codex, Cursor, Cline.", accent: "cyan", badge: { label: "NEW", color: "cyan" } },
  { href: "/#how-it-works", label: "How it works", description: "EIP-712 signing + facilitator relay, end to end." },
  { href: "/#use-cases", label: "Use cases", description: "DeFi, AI agents, payments, payouts." },
  { href: "/#pricing", label: "Pricing", description: "Per-30-day credits across all chains." },
];

const DEVELOPER_ITEMS: NavDropdownItem[] = [
  { href: "/docs", label: "Docs", description: "SDK, API reference, quickstart." },
  { href: "https://github.com/bitgett/Q402-Institutional", label: "GitHub", description: "Open source: landing, relayer, SDK.", external: true },
];

const GROUPS = [
  { label: "Product", items: PRODUCT_ITEMS },
  { label: "Developers", items: DEVELOPER_ITEMS },
];

const LINKS = [
  { href: "/grant", label: "Grant" },
  { href: "/visualization", label: "Visualization" },
];

export default function Navbar() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 border-b border-white/10"
      style={{ background: "rgba(7,11,20,0.8)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
    >
      <div className="w-full px-5 lg:px-8 h-[72px] flex items-center justify-between gap-4">
        <style dangerouslySetInnerHTML={{ __html: `
          .q402-navshine{position:absolute;inset:0;background:linear-gradient(110deg,transparent 32%,rgba(255,255,255,0.62) 50%,transparent 68%);transform:translateX(-130%);animation:q402NavShine 3.6s ease-in-out infinite;pointer-events:none;}
          @keyframes q402NavShine{0%,55%{transform:translateX(-130%);}82%,100%{transform:translateX(130%);}}
          @media(prefers-reduced-motion:reduce){.q402-navshine{animation:none;opacity:0;}}
        ` }} />
        {/* Brand - left corner, at the viewport edge (unchanged position) */}
        <Link href="/" className="flex items-center gap-2.5 flex-shrink-0 group">
          <span className="w-7 h-7 rounded-md bg-yellow flex items-center justify-center shadow-[0_0_12px_rgba(245,197,24,0.35)] transition-transform group-hover:scale-105">
            <span className="w-3 h-3 rounded-sm bg-navy/90" />
          </span>
          <span className="text-yellow font-bold text-lg tracking-tight leading-none">Q402</span>
          <span className="text-white/30 text-xs font-light hidden sm:block leading-none">by Quack AI</span>
        </Link>

        {/* Center nav - md and up */}
        <div className="hidden md:flex items-center gap-0.5">
          {EVENT_MODE && (
            <Link
              href="/event"
              className="relative overflow-hidden inline-flex items-center mr-2 px-3.5 py-1.5 rounded-full text-[12.5px] font-extrabold tracking-wide text-navy bg-yellow shadow-[0_0_15px_rgba(245,197,24,0.45)] hover:shadow-[0_0_26px_rgba(245,197,24,0.8)] hover:scale-[1.03] transition-all"
            >
              <span className="relative z-10">Free trial</span>
              <span aria-hidden className="q402-navshine" />
            </Link>
          )}
          <NavDropdown label="Product" items={PRODUCT_ITEMS} />
          <NavDropdown label="Developers" items={DEVELOPER_ITEMS} />
          {LINKS.map((l) => {
            const isActive = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`relative inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold tracking-tight transition-all ${isActive ? "text-white [text-shadow:0_0_12px_rgba(245,197,24,0.4)]" : "text-white/60 hover:text-white hover:[text-shadow:0_0_12px_rgba(245,197,24,0.4)]"}`}
              >
                <Hex className="opacity-55" size={12} />
                {l.label}
                {isActive && <span aria-hidden className="absolute left-3 right-3 -bottom-0.5 h-px" style={{ background: "#F5C518" }} />}
              </Link>
            );
          })}
        </div>

        {/* Right - wallet + mobile trigger */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <WalletButton />
          <MobileMenu groups={GROUPS} links={LINKS} eventMode={EVENT_MODE} />
        </div>
      </div>
    </nav>
  );
}
