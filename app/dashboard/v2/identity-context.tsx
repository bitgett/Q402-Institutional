"use client";

/**
 * DashboardIdentityContext — the bridge between the legacy /dashboard identity
 * state machine (app/dashboard/page.tsx) and the v2 dashboard views.
 *
 * WHY THIS EXISTS
 * ---------------
 * The v2 shell (DashboardV2) and its views (WalletsView / ActivityView /
 * TreasuryView / DeveloperView, plus the new <DashboardBanners/> slot) need
 * the SAME identity + subscription + lifecycle facts the legacy page already
 * computes: the email session, the subscription record, expiry/quota, and the
 * action handles (sign out, open trial activation, open usage alerts, rotate
 * an API key). Rather than re-derive (and re-fetch) any of that in v2 — which
 * would risk drifting from the proven, security-reviewed legacy flow — the
 * legacy page.tsx computes everything ONCE and publishes it here.
 *
 * page.tsx owns the fetches (`/api/auth/me`, `/api/keys/provision`,
 * `/api/payment/check`, …) and the legacy modals (TrialActivationModal, the
 * usage-alert modal). It mounts <DashboardIdentityProvider value={...}> around
 * <DashboardV2/> and wires the action handles to those modals/flows. The v2
 * views consume the read side via `useDashboardIdentity()`.
 *
 * SAFETY: the default context value is all-null / no-op so a view that reads
 * the hook before the provider mounts (or in isolation, e.g. a Storybook
 * render) does not crash. Every consumer must tolerate the null shape.
 */

import { createContext, useContext, type ReactNode } from "react";

/** Email session — mirrors page.tsx `emailSession` (canonical bound wallet). */
export interface DashboardEmailSession {
  email: string;
  /** Canonical BOUND wallet (session.address on the server), or null. */
  address: string | null;
}

/**
 * Subscription record — mirrors the `Subscription` interface page.tsx hydrates
 * from `/api/keys/provision` + `/api/payment/check`. Kept structurally
 * compatible (all fields optional beyond the always-present ones) so passing
 * the legacy `subscription` object straight through type-checks.
 */
export interface DashboardSubscription {
  apiKey: string;
  plan: string;
  paidAt: string;
  amountUSD: number;
  quotaBonus?: number;
  trialQuotaBonus?: number;
  paidQuotaBonus?: number;
  sandboxApiKey?: string;
  trialApiKey?: string;
  trialSandboxApiKey?: string;
  isTrialActive?: boolean;
  trialExpiresAt?: string;
  email?: string;
}

/** Scoped quota snapshot for the active view (trial vs multichain). */
export interface DashboardQuota {
  /** Credits already consumed (this billing/trial window). */
  used: number;
  /** Base quota grant the progress bar is measured against. */
  total: number;
  /** Percent consumed, 0–100 (already clamped by page.tsx). */
  pct: number;
}

/**
 * Result of an API-key rotation — mirrors the `/api/keys/rotate` response the
 * legacy `rotateKey()` reads. `apiKey` is the freshly minted key (absent when
 * the rotation was cancelled / failed).
 */
export interface RotateKeyResult {
  apiKey?: string;
  /** Set when the signed session nonce expired and the user must re-sign. */
  code?: string;
}

/** Which key slot to rotate — matches page.tsx `scope` ("trial" | "paid"). */
export type RotateKeyScope = "trial" | "paid";

export interface DashboardIdentityValue {
  // ── Identity ──────────────────────────────────────────────────────────
  /** Active email session, or null for a wallet-only login. */
  emailSession: DashboardEmailSession | null;

  // ── Subscription + lifecycle ──────────────────────────────────────────
  /** Hydrated subscription record, or null while loading / wallet-only stub. */
  subscription: DashboardSubscription | null;
  /** True when the paid subscription has lapsed. */
  isExpired: boolean;
  /** Paid-plan expiry, or null for trial-only / unpaid. */
  expiresAt: Date | null;
  /** Whole days until `expiresAt` (may be negative when expired), or null. */
  daysLeft: number | null;
  /** Scoped quota snapshot for the active view, or null before it resolves. */
  quota: DashboardQuota | null;
  /** Plan key (e.g. "trial", "starter", "enterprise_flex"). */
  plan: string;

  // ── Action handles ────────────────────────────────────────────────────
  /** Sign out of BOTH the email session and the wallet, then reload. */
  signOut: () => void;
  /** Open the legacy TrialActivationModal (wallet-only 2k-credit flow). */
  openTrialActivation: () => void;
  /** Open the legacy usage-alert (email notification) config modal. */
  openUsageAlerts: () => void;
  /**
   * Rotate an API key for the given scope via /api/keys/rotate (intent-bound
   * signature). Resolves with the new key (or a NONCE_EXPIRED code). Mirrors
   * the legacy page.tsx `rotateKey()` exactly.
   */
  rotateKey: (scope: RotateKeyScope) => Promise<RotateKeyResult>;
}

/**
 * Safe default — all-null reads, no-op actions. Used when a view renders
 * outside a provider (so the hook never throws). The async `rotateKey`
 * resolves to an empty result rather than rejecting.
 */
const DEFAULT_IDENTITY: DashboardIdentityValue = {
  emailSession: null,
  subscription: null,
  isExpired: false,
  expiresAt: null,
  daysLeft: null,
  quota: null,
  plan: "starter",
  signOut: () => {},
  openTrialActivation: () => {},
  openUsageAlerts: () => {},
  rotateKey: async () => ({}),
};

const DashboardIdentityContext =
  createContext<DashboardIdentityValue>(DEFAULT_IDENTITY);

export function DashboardIdentityProvider({
  value,
  children,
}: {
  value: DashboardIdentityValue;
  children: ReactNode;
}) {
  return (
    <DashboardIdentityContext.Provider value={value}>
      {children}
    </DashboardIdentityContext.Provider>
  );
}

/**
 * Read the dashboard identity. Always returns a usable value — the default is
 * the all-null / no-op shape, so callers never need to null-check the hook
 * itself (only the fields, which are nullable by design).
 */
export function useDashboardIdentity(): DashboardIdentityValue {
  return useContext(DashboardIdentityContext);
}
