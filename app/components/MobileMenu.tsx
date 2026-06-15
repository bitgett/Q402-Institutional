"use client";

/**
 * MobileMenu - hamburger + slide-down drawer for < md viewports.
 *
 * The desktop navbar hides its center menu at < md and previously had no
 * replacement, so phones could only reach the logo + wallet. This restores
 * full navigation: a hamburger toggles a dark panel (same gradient as the
 * NavDropdown menus) listing every grouped item plus the standalone Event /
 * Visualization links. Closes on link tap, Esc, or backdrop tap; locks body
 * scroll while open.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import type { NavDropdownItem } from "./NavDropdown";

interface NavGroup {
  label: string;
  items: NavDropdownItem[];
}

interface Props {
  groups: NavGroup[];
  eventMode: boolean;
}

export default function MobileMenu({ groups, eventMode }: Props) {
  const [open, setOpen] = useState(false);

  // Esc to close + lock body scroll while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  const close = () => setOpen(false);
  const itemClass =
    "flex items-center gap-2 py-2 text-white/80 hover:text-white text-[15px] transition-colors";

  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center justify-center w-9 h-9 rounded-md text-white/70 hover:text-white hover:bg-white/[0.06] transition-colors"
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          {open ? (
            <path d="M6 6l12 12M18 6 6 18" />
          ) : (
            <>
              <path d="M4 7h16" />
              <path d="M4 12h16" />
              <path d="M4 17h16" />
            </>
          )}
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={close}
              className="fixed inset-0 top-[72px] z-40 bg-black/55 backdrop-blur-sm"
              aria-hidden
            />
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="fixed left-0 right-0 top-[72px] z-40 max-h-[calc(100vh-72px)] overflow-y-auto border-b border-white/10 px-5 py-4"
              style={{ background: "linear-gradient(180deg,#0F1626,#080E1C)" }}
              role="menu"
            >
              {eventMode && (
                <Link href="/event" onClick={close} role="menuitem" className="flex items-center gap-2 py-3 text-yellow font-semibold text-[15px]">
                  Event
                  <span className="text-[8px] font-extrabold tracking-[0.14em] text-yellow bg-yellow/15 border border-yellow/40 rounded-sm px-1 leading-[1.4]">
                    FREE
                  </span>
                </Link>
              )}

              {groups.map((g) => (
                <div key={g.label} className="py-3 border-t border-white/[0.06] first:border-t-0">
                  <div className="text-white/30 text-[10px] font-semibold uppercase tracking-[0.22em] mb-2.5">
                    {g.label}
                  </div>
                  <div className="flex flex-col">
                    {g.items.map((it) => {
                      const inner = (
                        <>
                          <span>{it.label}</span>
                          {it.badge && (
                            <span className="text-[8px] font-extrabold tracking-[0.14em] uppercase border rounded-sm px-1 leading-[1.4] text-[#5BC8FA] bg-[#5BC8FA]/15 border-[#5BC8FA]/40">
                              {it.badge.label}
                            </span>
                          )}
                        </>
                      );
                      return it.external ? (
                        <a key={it.href} href={it.href} target="_blank" rel="noreferrer" onClick={close} role="menuitem" className={itemClass}>
                          {inner}
                          <span className="text-[10px] opacity-40">↗</span>
                        </a>
                      ) : (
                        <Link key={it.href} href={it.href} onClick={close} role="menuitem" className={itemClass}>
                          {inner}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}

              <div className="py-3 border-t border-white/[0.06]">
                <Link href="/visualization" onClick={close} role="menuitem" className={itemClass}>
                  Visualization
                </Link>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
