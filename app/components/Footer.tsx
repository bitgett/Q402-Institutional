"use client";

import { useState } from "react";
import RegisterModal from "./RegisterModal";

// Infrastructure-style footer: 4-column nav grid, dedicated chain strip,
// and a thin metadata bar at the bottom. Replaces the prior single-row
// sprawl where chain pills, status, and legal links were jammed together.

const CHAINS = [
  { name: "BNB Chain",  img: "/bnb.png"       },
  { name: "Ethereum",   img: "/eth.png"       },
  { name: "Avalanche",  img: "/avax.png"      },
  { name: "X Layer",    img: "/xlayer.png"    },
  { name: "Mantle",     img: "/mantle.png"    },
  { name: "Injective",  img: "/injective.png" },
  { name: "Stable",     img: "/stable.jpg"    },
  { name: "Monad",      img: "/monad.png"     },
  { name: "Scroll",     img: "/scroll.png"    },
];

// `action: "openContactModal"` triggers the same RegisterModal the Contact
// section's "Talk to Us" / "Get an API key" button opens. Used by Contact
// Sales so the footer entry mirrors the in-page conversion path instead of
// dropping the user into an external mailto: client.
const NAV: { heading: string; links: { label: string; href?: string; external?: boolean; action?: "openContactModal" }[] }[] = [
  {
    heading: "Product",
    links: [
      { label: "Dashboard",        href: "/dashboard" },
      { label: "Pricing",          href: "/payment"   },
      { label: "Free Trial",       href: "/event"     },
      { label: "MCP for AI Agents", href: "/claude"   },
      { label: "For AI Agents",    href: "/agents"    },
    ],
  },
  {
    heading: "Developers",
    links: [
      { label: "Documentation",    href: "/docs" },
      { label: "MCP Server",       href: "https://www.npmjs.com/package/@quackai/q402-mcp", external: true },
      { label: "Trust Receipts",   href: "/docs#trust-receipts" },
      { label: "GitHub",           href: "https://github.com/bitgett", external: true },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "Grant Program",    href: "/grant"   },
      { label: "Contact Sales",    action: "openContactModal" },
      { label: "Terms",            href: "/terms"   },
      { label: "Privacy",          href: "/privacy" },
    ],
  },
];

export default function Footer() {
  const [showModal, setShowModal] = useState(false);

  return (
    <footer className="border-t border-white/[0.08] pt-20 pb-10 px-6 mt-16">
      <div className="max-w-6xl mx-auto">

        {/* ── Top: brand col (wide) + 3 nav cols ─────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-12 md:gap-10 mb-14">

          {/* Brand col — spans 2/5 on desktop so the description has room
              to breathe; nav columns each take 1/5. */}
          <div className="md:col-span-2">
            <div className="flex items-center gap-2.5 mb-4">
              <span className="w-7 h-7 rounded-md bg-yellow flex items-center justify-center shadow-[0_0_18px_rgba(245,197,24,0.4)]">
                <span className="w-3 h-3 rounded-sm bg-navy/90" />
              </span>
              <span className="text-yellow font-bold text-xl leading-none tracking-tight">Q402</span>
              <span className="text-white/35 text-sm leading-none ml-1">by Quack AI</span>
            </div>

            <p className="text-white/45 text-sm leading-relaxed max-w-xs mb-5">
              Gasless payment infrastructure for AI agents and Web3 apps. EIP-712 + EIP-7702, live on mainnet.
            </p>

            <div className="flex items-center gap-2">
              <span
                className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"
                style={{ boxShadow: "0 0 6px #4ade80" }}
              />
              <span className="text-white/40 text-[10px] font-mono uppercase tracking-[0.25em]">
                Live · Mainnet
              </span>
            </div>
          </div>

          {/* Nav cols */}
          {NAV.map((col) => (
            <div key={col.heading}>
              <h4 className="text-white/30 text-[10px] font-semibold uppercase tracking-[0.22em] mb-5">
                {col.heading}
              </h4>
              <ul className="space-y-3">
                {col.links.map((link) => (
                  <li key={link.label}>
                    {link.action === "openContactModal" ? (
                      <button
                        onClick={() => setShowModal(true)}
                        className="inline-flex items-center gap-1.5 text-white/60 text-sm hover:text-yellow transition-colors cursor-pointer text-left"
                      >
                        {link.label}
                      </button>
                    ) : (
                      <a
                        href={link.href}
                        {...(link.external
                          ? { target: "_blank", rel: "noopener noreferrer" }
                          : {})}
                        className="inline-flex items-center gap-1.5 text-white/60 text-sm hover:text-yellow transition-colors"
                      >
                        <span>{link.label}</span>
                        {link.external && (
                          <span className="text-[10px] opacity-40">↗</span>
                        )}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* ── Chain strip ────────────────────────────────────────────────── */}
        {/* No header above the strip — the page already states the chain
            count twice in the hero and once in the section above. The logos
            speak for themselves. */}
        <div className="border-t border-white/[0.06] pt-9 pb-9">
          <div className="flex flex-wrap items-center justify-center gap-x-7 gap-y-4">
            {CHAINS.map((c) => (
              <div key={c.name} className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full overflow-hidden border border-white/10 flex-shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={c.img} alt={c.name} className="w-full h-full object-cover" />
                </span>
                <span className="text-white/50 text-xs">{c.name}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Bottom legal + socials strip ───────────────────────────────── */}
        <div className="border-t border-white/[0.06] pt-7 flex flex-col sm:flex-row items-center justify-between gap-5">

          <div className="flex flex-wrap items-center justify-center sm:justify-start gap-x-3 gap-y-1 text-[11px]">
            <span className="text-white/35">© 2026 Quack AI</span>
            <span className="text-white/12">·</span>
            <span className="text-white/35 font-mono">99.99% uptime</span>
            <span className="text-white/12 hidden sm:inline">·</span>
            <span className="text-white/35 font-mono hidden sm:inline">&lt;0.9 s settle</span>
          </div>

          <div className="flex items-center gap-3">
            <a
              href="https://x.com/QuackAI_AI"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="X / Twitter"
              className="w-8 h-8 rounded-full border border-white/10 flex items-center justify-center text-white/45 hover:text-yellow hover:border-yellow/45 transition-colors"
            >
              {/* X (Twitter) glyph */}
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="currentColor" aria-hidden>
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25h6.834l4.713 6.231 5.443-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z"/>
              </svg>
            </a>
            <a
              href="https://github.com/bitgett"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub"
              className="w-8 h-8 rounded-full border border-white/10 flex items-center justify-center text-white/45 hover:text-yellow hover:border-yellow/45 transition-colors"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor" aria-hidden>
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.74.08-.73.08-.73 1.2.08 1.83 1.24 1.83 1.24 1.07 1.83 2.81 1.3 3.49.99.11-.77.42-1.3.76-1.6-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.48 5.92.43.37.81 1.1.81 2.22 0 1.6-.01 2.89-.01 3.29 0 .32.22.7.83.58C20.56 21.8 24 17.3 24 12c0-6.63-5.37-12-12-12z"/>
              </svg>
            </a>
            <a
              href="https://www.npmjs.com/package/@quackai/q402-mcp"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="npm package @quackai/q402-mcp"
              className="h-8 px-3 rounded-full border border-white/10 flex items-center justify-center text-white/45 hover:text-yellow hover:border-yellow/45 transition-colors text-[10px] font-bold font-mono uppercase tracking-wider"
            >
              npm
            </a>
            <a
              href="mailto:business@quackai.ai"
              className="text-white/45 text-xs hover:text-yellow transition-colors hidden sm:inline"
            >
              business@quackai.ai
            </a>
          </div>
        </div>

      </div>

      {showModal && <RegisterModal onClose={() => setShowModal(false)} />}
    </footer>
  );
}
