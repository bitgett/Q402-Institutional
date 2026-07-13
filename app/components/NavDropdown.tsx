"use client";

/**
 * NavDropdown - hover / focus driven menu trigger for the top navbar.
 *
 * Flat datasheet styling to match the redesigned product pages: a solid navy
 * panel, a 1px hairline border, mono-free clean item rows, and only the house
 * accent colors (yellow + cyan). The trigger shows an active underline when the
 * current route lives inside this group.
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
  default: "text-white/90",
  yellow: "text-yellow",
  cyan: "text-[#5BC8FA]",
};

const BADGE_CLASS: Record<"yellow" | "cyan", string> = {
  yellow: "text-yellow bg-yellow/12 border-yellow/35",
  cyan: "text-[#5BC8FA] bg-[#5BC8FA]/12 border-[#5BC8FA]/35",
};

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
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`relative inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-all ${
          open || active ? "text-white" : "text-white/55 hover:text-white hover:[text-shadow:0_0_11px_rgba(255,255,255,0.32)]"
        }`}
      >
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
            transition={{ duration: 0.14, ease: "easeOut" }}
            // Bridge the gap above the panel so the cursor can travel from the
            // trigger to the menu without crossing a no-pointer zone.
            className="absolute left-0 top-full pt-2.5 min-w-[268px]"
            role="menu"
          >
            <div
              className="rounded-lg border overflow-hidden p-1.5"
              style={{ background: "#0B1320", borderColor: "rgba(255,255,255,0.1)", boxShadow: "0 20px 48px rgba(0,0,0,0.55)" }}
            >
              {items.map((item) => {
                const isActive = !item.external && item.href.split("#")[0] === pathname && pathname !== "/";
                const className = `group/item flex flex-col gap-0.5 px-3 py-2.5 rounded-md transition-colors ${isActive ? "bg-white/[0.04]" : "hover:bg-white/[0.05]"}`;
                const inner = (
                  <>
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium ${ACCENT_CLASS[item.accent ?? "default"]}`}>{item.label}</span>
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
                      <span className="text-white/35 text-[11px] leading-snug">{item.description}</span>
                    )}
                  </>
                );
                if (item.external) {
                  return (
                    <a key={item.href} href={item.href} target="_blank" rel="noreferrer" role="menuitem" className={className}>
                      {inner}
                    </a>
                  );
                }
                return (
                  <Link key={item.href} href={item.href} role="menuitem" className={className}>
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
