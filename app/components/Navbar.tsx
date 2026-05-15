"use client";

import Link from "next/link";
import WalletButton from "./WalletButton";
import NavDropdown, { type NavDropdownItem } from "./NavDropdown";
import { EVENT_MODE } from "@/app/lib/feature-flags";

// Grouped menu structure. Arbitrum-style: a small number of category triggers
// instead of a long flat list. Each category opens a single column of items
// with optional short descriptions so a first-time visitor knows what each
// destination is without clicking.
const PRODUCT_ITEMS: NavDropdownItem[] = [
  { href: "/#how-it-works", label: "How it works", description: "EIP-712 signing + facilitator relay, end to end." },
  { href: "/#use-cases",    label: "Use cases",    description: "DeFi, AI agents, payments, payouts." },
  { href: "/#pricing",      label: "Pricing",      description: "Per-30-day credits across all chains." },
];

const DEVELOPER_ITEMS: NavDropdownItem[] = [
  { href: "/docs",   label: "Docs",   description: "SDK, API reference, quickstart." },
  { href: "/agents", label: "Agents", description: "Server-side EIP-712 signer for AI pipelines.", accent: "green" },
  { href: "/claude", label: "Claude", description: "MCP server for Claude Desktop + Code.", accent: "orange", badge: { label: "NEW", color: "orange" } },
  { href: "https://github.com/bitgett/Q402-Institutional", label: "GitHub", description: "Open source — landing + relayer + SDK.", external: true },
];

const COMMUNITY_ITEMS: NavDropdownItem[] = [
  { href: "/grant", label: "Grant", description: "Free credits for OSS + hackathon teams.", accent: "yellow" },
];

export default function Navbar() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-navy/80 backdrop-blur-md border-b border-white/10">
      {/* Full-bleed bar (no max-w cap) so logo + wallet sit close to the
          viewport edges, with center nav anchored by justify-between.
          Increased horizontal padding on larger screens for visual
          breathing room without crowding the corners. */}
      <div className="w-full px-5 lg:px-8 h-[72px] flex items-center justify-between gap-4">
        {/* Logo — left corner */}
        <Link href="/" className="flex items-center gap-2 flex-shrink-0">
          <span className="w-7 h-7 rounded-md bg-yellow flex items-center justify-center shadow-[0_0_12px_rgba(245,197,24,0.35)]">
            <span className="w-3 h-3 rounded-sm bg-navy/90" />
          </span>
          <span className="text-yellow font-bold text-lg tracking-tight leading-none">Q402</span>
          <span className="text-white/30 text-xs font-light hidden sm:block leading-none">by Quack AI</span>
        </Link>

        {/* Center nav — Event highlighted standalone, rest grouped. */}
        <div className="hidden md:flex items-center gap-1">
          {EVENT_MODE && (
            <Link
              href="/event"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-semibold text-yellow/90 hover:text-yellow transition-colors"
            >
              Event
              <span className="text-[8px] font-extrabold tracking-[0.14em] text-yellow bg-yellow/15 border border-yellow/40 rounded-sm px-1 leading-[1.4]">
                FREE
              </span>
            </Link>
          )}
          <NavDropdown label="Product"    items={PRODUCT_ITEMS} />
          <NavDropdown label="Developers" items={DEVELOPER_ITEMS} />
          <NavDropdown label="Community"  items={COMMUNITY_ITEMS} />
        </div>

        {/* Right corner — wallet / signin */}
        <div className="flex-shrink-0">
          <WalletButton />
        </div>
      </div>
    </nav>
  );
}
