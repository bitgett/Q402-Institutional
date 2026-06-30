"use client";

import { useEffect } from "react";

const REF_KEY = "q402_ref";

/**
 * First-touch referral capture. When a visitor lands on any page with
 * `?ref=<code>`, persist the code so it survives navigation until they create
 * their first Agent Wallet (where it's credited). FIRST-touch: an existing
 * stored code is never overwritten, so the original inviter keeps the credit.
 * Renders nothing; mount once in the root layout.
 */
export function ReferralCapture() {
  useEffect(() => {
    try {
      const ref = new URLSearchParams(window.location.search).get("ref");
      if (ref && ref.trim() && !localStorage.getItem(REF_KEY)) {
        localStorage.setItem(REF_KEY, ref.trim().slice(0, 64));
      }
    } catch {
      /* SSR / private-mode / disabled storage — referral is best-effort. */
    }
  }, []);
  return null;
}

/** The captured referral code, sent on the first wallet-create. Null when none. */
export function getStoredRefCode(): string | null {
  try {
    return localStorage.getItem(REF_KEY);
  } catch {
    return null;
  }
}
