"use client";

import { useEffect, useState } from "react";

/**
 * Returns true on viewports at or below `breakpoint` px (default 760, matching
 * the dashboard's globals.css mobile breakpoint).
 *
 * Desktop-first + SSR-safe: the first render (server and client) returns
 * `false`, so hydration matches and there is no flash; the real value is
 * applied right after mount and on every resize. Use this for the inline-style
 * components (dashboard views/modals) that can't express breakpoints in CSS.
 */
export function useIsMobile(breakpoint = 760): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [breakpoint]);
  return isMobile;
}
