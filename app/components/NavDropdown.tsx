"use client";

/**
 * NavDropdown - hover / focus driven menu trigger for the top navbar.
 *
 * Premium panel styling modelled on the Quack AI landing nav (hex glyphs, a
 * rounded-2xl panel with a deep shadow, item rows that light their hex on hover)
 * but kept on Q402 house colors (navy panel + yellow / cyan accents). The
 * trigger shows an active underline when the current route lives in this group.
 *
 * Accessibility: trigger is a real <button> with aria-expanded / aria-haspopup;
 * items are real <Link>/<a>; Esc and click-outside close while open.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";

export interface NavDropdownItem {
  href: string;
  label: string;
  description?: string;
  accent?: "default" | "yellow" | "cyan";
  badge?: { label: string; color: "yellow" | "cyan" };
  external?: boolean;
}

const ACCENT_CLASS: Record<NonNullable<NavDropdownItem["accent"]>, string> = {
  default: "text-white",
  yellow: "text-yellow",
  cyan: "text-[#5BC8FA]",
};

// Hex glyph tint on row hover, per item accent.
const HEX_HOVER: Record<NonNullable<NavDropdownItem["accent"]>, string> = {
  default: "group-hover/item:text-white/70",
  yellow: "group-hover/item:text-yellow",
  cyan: "group-hover/item:text-[#5BC8FA]",
};

const BADGE_CLASS: Record<"yellow" | "cyan", string> = {
  yellow: "text-yellow bg-yellow/12 border-yellow/35",
  cyan: "text-[#5BC8FA] bg-[#5BC8FA]/12 border-[#5BC8FA]/35",
};

export function Hex({ className = "", size = 14 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M12 2.4l8.3 4.8v9.6L12 21.6 3.7 16.8V7.2z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export default function NavDropdown({ label, items }: { label: string; items: NavDropdownItem[] }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const pathname = usePathname();

  // Active when the current route is one of this group's real (non-anchor,
  // non-external) destinations, so the matching trigger reads as selected.
  const active = items.some((i) => {
    if (i.external) return false;
    const base = i.href.split("#")[0];
    return base && base !== "/" && pathname === base;
  });

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      ref={wrapperRef}
      className="relative group"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`relative inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold tracking-tight transition-all ${
          open || active
            ? "text-white [text-shadow:0_0_12px_rgba(245,197,24,0.4)]"
            : "text-white/60 hover:text-white hover:[text-shadow:0_0_12px_rgba(245,197,24,0.4)]"
        }`}
      >
        <Hex className={`transition-opacity ${open || active ? "opacity-100" : "opacity-60 group-hover:opacity-100"}`} size={13} />
        {label}
        <svg
          className={`w-3 h-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden
        >
          <path d="M2.5 4.5L6 8l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {active && <span aria-hidden className="absolute left-3 right-3 -bottom-0.5 h-px" style={{ background: "#F5C518" }} />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            // pt-3 bridges the gap so the cursor can travel trigger -> panel.
            className="absolute left-0 top-full pt-3 w-[300px]"
            role="menu"
          >
            <div
              className="rounded-2xl border p-2 overflow-hidden"
              style={{
                background: "linear-gradient(180deg,#0C1524,#0A1120)",
                borderColor: "rgba(255,255,255,0.1)",
                boxShadow: "0 34px 90px -24px rgba(0,0,0,0.78), inset 0 1px 0 rgba(255,255,255,0.04)",
              }}
            >
              {items.map((item) => {
                const accent = item.accent ?? "default";
                const isActive = !item.external && item.href.split("#")[0] === pathname && pathname !== "/";
                const rowClass = `group/item flex items-start gap-3 rounded-xl px-3.5 py-2.5 transition-colors ${
                  isActive ? "bg-white/[0.05]" : "hover:bg-white/[0.06]"
                }`;
                const inner = (
                  <>
                    <Hex className={`mt-0.5 shrink-0 text-white/25 transition-colors ${HEX_HOVER[accent]}`} size={15} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={`text-[14px] font-bold tracking-tight ${ACCENT_CLASS[accent]}`}>{item.label}</span>
                        {item.badge && (
                          <span className={`text-[8px] font-extrabold tracking-[0.14em] uppercase border rounded-sm px-1 leading-[1.5] ${BADGE_CLASS[item.badge.color]}`}>
                            {item.badge.label}
                          </span>
                        )}
                        {item.external && (
                          <span className="text-white/25 text-[10px] ml-auto" aria-hidden>&#8599;</span>
                        )}
                      </div>
                      {item.description && (
                        <span className="block text-white/45 text-[12.5px] leading-snug mt-0.5">{item.description}</span>
                      )}
                    </div>
                  </>
                );
                if (item.external) {
                  return (
                    <a key={item.href} href={item.href} target="_blank" rel="noreferrer" role="menuitem" className={rowClass}>
                      {inner}
                    </a>
                  );
                }
                return (
                  <Link key={item.href} href={item.href} role="menuitem" className={rowClass}>
                    {inner}
                  </Link>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
