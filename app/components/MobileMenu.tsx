"use client";

/**
 * MobileMenu - the <md navigation. A hamburger in the 72px bar opens a
 * slide-down panel that mirrors the desktop composition: the grouped Product /
 * Developers menus expanded as labelled sections, then the standalone links.
 * Flat datasheet styling, house colors only. Closes on route change, Esc, and
 * backdrop click.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import type { NavDropdownItem } from "./NavDropdown";

interface Group {
  label: string;
  items: NavDropdownItem[];
}

export default function MobileMenu({
  groups,
  links,
  eventMode,
}: {
  groups: Group[];
  links: { href: string; label: string }[];
  eventMode: boolean;
}) {
  const [open, setOpen] = useState(false);

  // Esc to close while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Toggle menu"
        aria-expanded={open}
        className="w-9 h-9 flex items-center justify-center rounded-md border border-white/10 text-white/70 hover:text-white hover:border-white/25 transition-colors"
      >
        <svg viewBox="0 0 18 18" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
          {open ? (
            <>
              <path d="M4 4l10 10" />
              <path d="M14 4L4 14" />
            </>
          ) : (
            <>
              <path d="M2.5 5h13" />
              <path d="M2.5 9h13" />
              <path d="M2.5 13h13" />
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
              transition={{ duration: 0.15 }}
              className="fixed inset-0 top-[72px] z-40 bg-black/50"
              onClick={() => setOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="fixed top-[72px] left-0 right-0 z-50 border-b border-white/10 max-h-[calc(100vh-72px)] overflow-y-auto"
              style={{ background: "#0B1320" }}
            >
              {/* Any click inside (a link, mostly) closes the menu - covers the
                  route-change case without a setState-in-effect. */}
              <div className="px-6 py-6 space-y-6" onClick={() => setOpen(false)}>
                {eventMode && (
                  <Link href="/event" className="inline-flex items-center gap-2 text-yellow font-semibold text-base">
                    Event
                    <span className="text-[8px] font-extrabold tracking-[0.14em] text-yellow bg-yellow/15 border border-yellow/40 rounded-sm px-1 leading-[1.5]">FREE</span>
                  </Link>
                )}

                {groups.map((g) => (
                  <div key={g.label}>
                    <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-white/30 mb-2">{g.label}</div>
                    <div className="flex flex-col">
                      {g.items.map((item) => {
                        const inner = (
                          <>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-[15px] font-medium text-white/90">{item.label}</span>
                                {item.badge && (
                                  <span className={`text-[8px] font-extrabold tracking-[0.14em] uppercase border rounded-sm px-1 leading-[1.5] ${item.badge.color === "cyan" ? "text-[#5BC8FA] bg-[#5BC8FA]/12 border-[#5BC8FA]/35" : "text-yellow bg-yellow/12 border-yellow/35"}`}>
                                    {item.badge.label}
                                  </span>
                                )}
                              </div>
                              {item.description && <div className="text-white/35 text-xs mt-0.5 leading-snug">{item.description}</div>}
                            </div>
                            {item.external && <span className="text-white/25 text-xs shrink-0" aria-hidden>&#8599;</span>}
                          </>
                        );
                        const cls = "flex items-center justify-between gap-3 py-2.5 border-b border-white/[0.06] last:border-0";
                        return item.external ? (
                          <a key={item.href} href={item.href} target="_blank" rel="noreferrer" className={cls}>{inner}</a>
                        ) : (
                          <Link key={item.href} href={item.href} className={cls}>{inner}</Link>
                        );
                      })}
                    </div>
                  </div>
                ))}

                <div className="pt-2 border-t border-white/[0.06] flex flex-col">
                  {links.map((l) => (
                    <Link key={l.href} href={l.href} className="py-2.5 text-[15px] font-medium text-white/90 border-b border-white/[0.06] last:border-0">
                      {l.label}
                    </Link>
                  ))}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
