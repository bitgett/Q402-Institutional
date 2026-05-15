"use client";

/**
 * NavDropdown — hover / focus driven menu trigger for the top navbar.
 *
 * Why custom (not Radix / Headless UI):
 *   - Zero new deps. The Navbar's only requirement is "hover to peek,
 *     click to lock open, click outside / Esc to close" — 80 lines does it.
 *   - Animations land on the same framer-motion the Hero already pulls,
 *     so bundle cost is one Motion child per item, not a new toolkit.
 *
 * Accessibility:
 *   - Trigger is a real <button> with aria-expanded / aria-haspopup.
 *   - Menu items are real <Link>/<a>; keyboard tab order is preserved.
 *   - Esc closes; click-outside closes via mousedown listener while open.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";

export interface NavDropdownItem {
  href: string;
  label: string;
  description?: string;
  accent?: "default" | "green" | "orange" | "yellow";
  badge?: { label: string; color: "green" | "orange" | "yellow" };
  external?: boolean;
}

interface Props {
  label: string;
  items: NavDropdownItem[];
}

const ACCENT_CLASS: Record<NonNullable<NavDropdownItem["accent"]>, string> = {
  default: "text-white/85 hover:text-white",
  green: "text-green-400/85 hover:text-green-300",
  orange: "text-orange-300/85 hover:text-orange-200",
  yellow: "text-yellow/85 hover:text-yellow",
};

const BADGE_CLASS: Record<"green" | "orange" | "yellow", string> = {
  green: "text-green-400 bg-green-400/15 border-green-400/40",
  orange: "text-orange-300 bg-orange-300/15 border-orange-300/40",
  yellow: "text-yellow bg-yellow/15 border-yellow/40",
};

export default function NavDropdown({ label, items }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Click-outside + Esc to close. Only attaches listeners while open so
  // the idle navbar doesn't carry a global mousedown handler.
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
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
          open ? "text-white" : "text-white/55 hover:text-white"
        }`}
      >
        {label}
        <svg
          className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <path d="M2.5 4.5L6 8l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            // Bridge gap above the panel so cursor can travel from trigger
            // to menu without crossing a no-pointer zone (which would close).
            className="absolute left-0 top-full pt-2 min-w-[240px]"
            role="menu"
          >
            <div
              className="rounded-xl border border-white/10 overflow-hidden p-1.5"
              style={{
                background: "linear-gradient(180deg, #0F1626 0%, #080E1C 100%)",
                boxShadow: "0 18px 48px rgba(0,0,0,0.55)",
              }}
            >
              {items.map(item => {
                const className = `flex flex-col gap-0.5 px-3 py-2 rounded-md text-sm transition-colors ${ACCENT_CLASS[item.accent ?? "default"]} hover:bg-white/[0.04]`;
                const inner = (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{item.label}</span>
                      {item.badge && (
                        <span className={`text-[8px] font-extrabold tracking-[0.14em] uppercase border rounded-sm px-1 leading-[1.4] ${BADGE_CLASS[item.badge.color]}`}>
                          {item.badge.label}
                        </span>
                      )}
                    </div>
                    {item.description && (
                      <span className="text-white/35 text-[11px] leading-snug">
                        {item.description}
                      </span>
                    )}
                  </>
                );
                if (item.external) {
                  return (
                    <a
                      key={item.href}
                      href={item.href}
                      target="_blank"
                      rel="noreferrer"
                      role="menuitem"
                      className={className}
                    >
                      {inner}
                    </a>
                  );
                }
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    role="menuitem"
                    className={className}
                  >
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
