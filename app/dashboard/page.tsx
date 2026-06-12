"use client";

/**
 * /dashboard — entry route.
 *
 * This file OWNS the legacy identity state machine (the Phase 1 4-state
 * model: email-session fetch, wallet-match gating, State D ClaimWalletPrompt,
 * State G WrongWalletHardBlock, the email-only trial view, the no-wallet
 * redirect-to-"/" grace window, and the auto-pop trial activation for
 * unprovisioned wallet-only users) — kept VERBATIM from the pre-v2 dashboard
 * (preserved at app/dashboard/_legacy-page.tsx.bak for reference).
 *
 * The ONE change vs. the legacy page: the final "authenticated, wallet
 * connected" branch no longer renders the old DashboardSidebar + tabs +
 * AgenticWalletTab UI. Instead it renders <DashboardV2/> wrapped in a
 * <DashboardIdentityProvider> that publishes the identity + subscription +
 * lifecycle facts (and the action handles) the v2 views consume via
 * useDashboardIdentity(). The legacy modals the action handles drive
 * (TrialActivationModal, the usage-alert config modal) are mounted here at
 * the page level and toggled through the context.
 *
 * SECURITY: the auth guards (State D / State G early returns, the wallet-match
 * provision gate, the signed fetches, the redirect grace window) are
 * reproduced unchanged — do not relax them.
 */

import Link from "next/link";
import { useWallet } from "../context/WalletContext";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import WalletModal from "../components/WalletModal";
import TrialActivationModal from "../components/TrialActivationModal";
import ClaimWalletPrompt from "./ClaimWalletPrompt";
import WrongWalletHardBlock from "./WrongWalletHardBlock";
import DashboardV2 from "./v2/DashboardV2";
import { BellIcon, CheckIcon, SparkIcon } from "./v2/logos";
import {
  DashboardIdentityProvider,
  type DashboardIdentityValue,
} from "./v2/identity-context";
import { getAuthCreds, clearAuthCache, getActionAuth } from "../lib/auth-client";
import { TRIAL_CREDITS } from "../lib/feature-flags";

// Must mirror TIER_CREDITS / TIER_PLANS in app/lib/blockchain.ts — the server
// grants these values, so the UI display must match to the tx count.
const PLAN_QUOTA: Record<string, number> = {
  trial:          2_000,
  starter:          500,
  basic:          1_000,
  growth:         5_000,
  pro:           10_000,
  scale:         50_000,
  business:     100_000,
  enterprise_flex: 500_000,
};

// ── Types ─────────────────────────────────────────────────────────────────────
interface Subscription { apiKey: string; plan: string; paidAt: string; amountUSD: number; quotaBonus?: number; trialQuotaBonus?: number; paidQuotaBonus?: number; sandboxApiKey?: string; trialApiKey?: string; trialSandboxApiKey?: string; isTrialActive?: boolean; trialExpiresAt?: string; email?: string; }

// ── Main ──────────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { address, isConnected, signMessage, disconnect } = useWallet();
  const router = useRouter();
  // NOTE: the legacy `?tab=…` deeplink seeding lived here. The v2 shell
  // (DashboardV2) owns its own top-nav view routing, so the tab state was
  // dropped — old deeplinks still resolve to /dashboard, they just land on
  // the v2 default view (Wallets) instead of erroring.
  const [alertEmail, setAlertEmail] = useState("");
  const [alertEmailInput, setAlertEmailInput] = useState("");
  // Usage-alert config modal — opened via the identity context's
  // openUsageAlerts() handle (the v2 views surface the entry point). Wraps the
  // existing /api/usage-alert flow (POST to set, DELETE to remove).
  const [showAlertModal, setShowAlertModal] = useState(false);
  const [alertSaving, setAlertSaving] = useState(false);
  const [alertDeleting, setAlertDeleting] = useState(false);
  const [emailSaved, setEmailSaved] = useState(false);

  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [isExpired, setIsExpired] = useState(false);
  const [mounted, setMounted] = useState(false);
  // Top-level view toggle — trial-flavored vs the original Multichain
  // dashboard. The v2 shell owns its own scope chip, but this flag still
  // drives the email-only trial view + the trial/paid credit scoping below.
  const [trialViewActive, setTrialViewActive] = useState(false);
  const [hasPaid, setHasPaid] = useState<boolean | null>(null);
  // Server-computed paywall bypass flag from /api/keys/provision. The
  // response field is still read so the API contract stays stable for other
  // callers; the value itself is no longer gated on in the UI.
  const [, setIsOwner] = useState<boolean>(false);
  // Tracks an in-flight key rotation. The v2 Developer view renders its own
  // rotate UI; this flag is retained so the legacy rotate handle's loading
  // semantics stay intact (set true→false around the POST).
  const [, setRotatingKey] = useState(false);
  // Email session (Google OAuth or magic-link signup). When the user signed
  // in via /api/auth/google or clicked an email magic link, /api/auth/me
  // returns { authenticated: true, email, address? }.
  // `address` here is the CANONICAL BOUND wallet (session.address on the
  // server), set ONLY by an explicit signed POST to /api/auth/wallet-bind. A
  // wallet connected in the browser that doesn't match this field triggers
  // WrongWalletHardBlock (State G); a wallet connected with this field still
  // null triggers ClaimWalletPrompt (State D).
  const [emailSession, setEmailSession] = useState<{
    email: string;
    address: string | null;
  } | null>(null);
  // "Skip for now" toggle on ClaimWalletPrompt — session-scoped only, no
  // persistence. Resets on every page-load so the bind decision stays
  // visible until the user makes it.
  const [skipClaimPrompt, setSkipClaimPrompt] = useState(false);
  // Read-side bridge to the email pseudo-account when this wallet is the
  // bound canonical wallet for an email user — populated by
  // /api/keys/provision via the wallet_email_link KV index. Lets a
  // wallet-only login (no session cookie) still surface the trial
  // credits + keys that live on `sub:email:<sub>`.
  const [boundEmailTrial, setBoundEmailTrial] = useState<{
    email: string;
    apiKey: string | null;
    sandboxApiKey: string | null;
    credits: number;
    totalCredits: number;
    trialExpiresAt: string | null;
  } | null>(null);
  const [sessionTrial, setSessionTrial] = useState<{
    apiKey: string | null;
    sandboxApiKey: string | null;
    credits: number;
    totalCredits: number;
    trialExpiresAt: string | null;
  }>({ apiKey: null, sandboxApiKey: null, credits: 0, totalCredits: 2000, trialExpiresAt: null });
  const [sessionLiveCopied, setSessionLiveCopied] = useState(false);
  const [sessionSandboxCopied, setSessionSandboxCopied] = useState(false);
  // Email-only users click "Multichain →" → triggers wallet-connect modal.
  const [showWalletConnectFromEmail, setShowWalletConnectFromEmail] = useState(false);
  // Auto-prompt trial activation for wallet-only users who have no
  // subscription yet. Fired exactly once per page-load via the ref below
  // so a re-render doesn't keep popping the modal after the user closes it.
  const [showAutoTrial, setShowAutoTrial] = useState(false);
  const trialPromptedRef = useRef(false);
  // Tracks whether the /api/auth/me check has resolved. Without it the
  // dashboard would render null between mount and the cookie fetch returning,
  // which a signed-in email user reads as "I got kicked back to the
  // landing page" — the visible flash before the email-only view paints.
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Auto-flip to Trial view on first load ONLY when there's a verifiable
  // active trial:
  //   - wallet sub on plan="trial" (wallet trial still in window), OR
  //   - email session has trial keys (canonical email-pseudo trial), OR
  //   - wallet is bridged to an email pseudo via boundEmailTrial (the
  //     wallet-only-login case the read-side bridge was added for)
  // A paying user with no active trial defaults to Multichain. Users can
  // still toggle scope from the v2 top-bar chip.
  const initialViewMatched = useRef(false);
  useEffect(() => {
    if (initialViewMatched.current) return;
    if (!subscription && !emailSession) return; // still loading
    const walletHasTrialSignal =
      subscription?.plan === "trial" &&
      !!subscription?.trialExpiresAt &&
      new Date(subscription.trialExpiresAt) > new Date();
    const emailHasTrialSignal =
      !!emailSession && (!!sessionTrial.apiKey || !!sessionTrial.trialExpiresAt);
    const bridgedTrialSignal =
      !!boundEmailTrial && (!!boundEmailTrial.apiKey || !!boundEmailTrial.trialExpiresAt);
    if (walletHasTrialSignal || emailHasTrialSignal || bridgedTrialSignal) {
      setTrialViewActive(true);
    }
    // Otherwise keep the default (multichain). Either way, lock the flip
    // so we don't override the user's subsequent manual choice.
    initialViewMatched.current = true;
  }, [subscription, emailSession, sessionTrial, boundEmailTrial]);

  // Phase 1 identity model: wallet binding is no longer auto-fired. The
  // ClaimWalletPrompt component (State D) handles binding via an explicit
  // user click + fresh signed challenge through /api/auth/wallet-bind.

  // Wallet-only auto-trial: when a wallet is connected but the address has
  // no subscription (or only a provisioned stub with amountUSD=0 and no
  // trial plan), pop the trial-activation modal automatically so the user
  // gets 2k credits with one signature instead of bouncing between pages.
  //
  // Critical skip: if the user already has an email session, their trial
  // lives on the email pseudo-account and trial_used_by_email blocks
  // /api/trial/activate. Firing the prompt anyway would surface a 409
  // after the user has already signed. Skip — they have a trial elsewhere.
  useEffect(() => {
    if (trialPromptedRef.current) return;
    if (!isConnected || !address) return;
    if (hasPaid === null) return; // still loading
    if (emailSession) return; // email session already has the trial
    if (subscription?.plan === "trial") return; // already on trial
    if (hasPaid === true) return; // paid user — don't push trial
    // No trial AND not paid AND no email session → eligible. Prompt once.
    trialPromptedRef.current = true;
    setShowAutoTrial(true);
  }, [isConnected, address, hasPaid, subscription, emailSession]);

  useEffect(() => {
    let cancelled = false;
    async function loadSession() {
      try {
        const res = await fetch("/api/auth/me", { credentials: "include" });
        const data = await res.json();
        if (cancelled) return;
        if (data.authenticated && typeof data.email === "string") {
          // Prefer the explicit boundAddress field; fall back to the legacy
          // `address` alias for older /api/auth/me responses (pre-Phase 1).
          const bound = (typeof data.boundAddress === "string" && data.boundAddress)
            || (typeof data.address === "string" && data.address)
            || null;
          setEmailSession({ email: data.email, address: bound });
        }
      } catch {
        /* no session — silent */
      } finally {
        if (!cancelled) setAuthChecked(true);
      }
    }
    loadSession();
    return () => {
      cancelled = true;
    };
  }, []);

  // Always fetch the email pseudo-account's trial data when an email session
  // exists — wallet-connected users with an email session ALSO need it, so
  // the Trial scope can display the canonical email-side trial (the wallet's
  // own subscription is a separate "starter" stub when the user signed up
  // via email first, NOT a trial).
  useEffect(() => {
    if (!emailSession) return;
    let cancelled = false;
    async function loadTrial() {
      try {
        const res = await fetch("/api/keys/email-sandbox", { credentials: "include" });
        const data = await res.json();
        if (cancelled || !res.ok) return;
        setSessionTrial({
          apiKey: data.apiKey ?? null,
          sandboxApiKey: data.sandboxApiKey ?? null,
          credits: typeof data.credits === "number" ? data.credits : 0,
          totalCredits: typeof data.totalCredits === "number" ? data.totalCredits : 2000,
          trialExpiresAt: data.trialExpiresAt ?? null,
        });
      } catch {
        /* leave blanks; UI falls back to "—" */
      }
    }
    loadTrial();
    return () => {
      cancelled = true;
    };
  }, [emailSession]);

  useEffect(() => {
    if (!address) return;
    const addr = address;
    let cancelled = false;
    async function load() {
      const auth = await getAuthCreds(addr, signMessage);
      if (!auth || cancelled) return;
      const { nonce, signature } = auth;
      try {
        const qs  = new URLSearchParams({ address: addr, nonce, sig: signature }).toString();
        const res = await fetch(`/api/usage-alert?${qs}`);
        const d   = await res.json();
        if (cancelled) return;
        if (res.status === 401 && d.code === "NONCE_EXPIRED") { clearAuthCache(addr); return; }
        if (d.configured && d.email) {
          setAlertEmail(d.email);
        } else {
          setAlertEmail("");
        }
      } catch { /* network blip — usage-alert entry stays "off" */ }
    }
    load();
    return () => { cancelled = true; };
  }, [address, signMessage]);
  // 600 ms grace window for the WalletContext to rehydrate from localStorage
  // on a fresh page load — if no wallet AND no email session is present
  // after that, bounce back to the landing. Without the emailSession check
  // here, an email-signed-in user got kicked to / within a second of
  // landing on the dashboard.
  useEffect(() => {
    if (!mounted) return;
    if (!authChecked) return;
    if (emailSession) return;
    const t = setTimeout(() => {
      if (!isConnected && !emailSession) router.push("/");
    }, 600);
    return () => clearTimeout(t);
  }, [mounted, authChecked, isConnected, emailSession, router]);

  // Provision fetch, extracted into a callable so it can be re-run on tab
  // focus / visibility (quota + credits otherwise go stale while the tab
  // stays open). The guards make it a safe no-op when there's no
  // wallet/auth, or when the connected wallet doesn't match the bound email
  // session — so the focus/visibility triggers never pull the wrong record.
  const refreshProvision = useCallback(() => {
    if (!address) return;
    // Wait for /api/auth/me to resolve before issuing /api/keys/provision
    // — without this, a localStorage-rehydrated wallet can race the
    // session fetch and pull its own subscription before we know the
    // session is bound to a different wallet. The State G early-return
    // would then replace the rendered view but the KV read already
    // happened on a wallet we shouldn't have queried.
    if (!authChecked) return;
    // Phase 1 gate — refuse to provision when the email session has a
    // canonical bound wallet that doesn't match the currently-connected
    // wallet. Prevents the dashboard from quietly pulling another
    // wallet's subscription record onto the screen.
    if (
      emailSession &&
      emailSession.address &&
      address.toLowerCase() !== emailSession.address.toLowerCase()
    ) {
      return;
    }
    const addr = address; // narrow to string for async closures

    async function provision() {
      // getAuthCreds caches {nonce, signature} in sessionStorage for 7.5h.
      // On 401 NONCE_EXPIRED the caller clears the cache and the user re-signs on next load.
      const auth = await getAuthCreds(addr, signMessage);
      if (!auth) return; // user rejected wallet prompt

      const { nonce, signature } = auth;

      let provData: Record<string, unknown> = {};
      try {
        const res = await fetch("/api/keys/provision", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ address: addr, nonce, signature }),
        });
        provData = await res.json();
        if (res.status === 401 && provData.code === "NONCE_EXPIRED") {
          clearAuthCache(addr);
          return;
        }
      } catch { return; }

      setHasPaid(provData.hasPaid === true);
      setIsOwner(provData.isOwner === true);

      // Mirror the bound-email-trial bridge into local state so the trial
      // scope can fall back to it when this wallet has no own trial keys
      // (e.g. wallet-only login of a bound user — pseudo carries the trial).
      const bet = provData.boundEmailTrial as {
        email: string;
        credits: number;
        totalCredits: number;
        trialExpiresAt: string | null;
      } | null | undefined;
      if (bet) {
        setBoundEmailTrial({
          email: bet.email,
          // Trial keys themselves are surfaced via trialApiKey /
          // trialSandboxApiKey in the same response, populated from the
          // bridge when the wallet's own slots were empty.
          apiKey: (provData.trialApiKey as string | null) ?? null,
          sandboxApiKey: (provData.trialSandboxApiKey as string | null) ?? null,
          credits: bet.credits,
          totalCredits: bet.totalCredits,
          trialExpiresAt: bet.trialExpiresAt,
        });
      } else {
        setBoundEmailTrial(null);
      }

      setSubscription(prev => ({
        ...(prev ?? { paidAt: "", plan: "starter", amountUSD: 0, apiKey: "" }),
        // Paid live key — prefer the scope-explicit `multichainApiKey` alias.
        // Falls back to legacy `apiKey` for older provision responses during
        // the rollout window. Trial keys live in trialApiKey/
        // trialSandboxApiKey so the two scopes don't collide.
        apiKey:            (provData.hasPaid
                              ? (provData.multichainApiKey ?? provData.apiKey)
                              : "") as string ?? "",
        sandboxApiKey:     (provData.multichainSandboxApiKey as string)
                              ?? (provData.sandboxApiKey as string)
                              ?? prev?.sandboxApiKey,
        trialApiKey:       (provData.trialApiKey as string | null) ?? undefined,
        trialSandboxApiKey:(provData.trialSandboxApiKey as string | null) ?? undefined,
        isTrialActive:     provData.isTrialActive === true,
        plan:              provData.plan as string ?? "starter",
        quotaBonus:        provData.quotaBonus as number ?? prev?.quotaBonus ?? 0,
        // Scoped pool mirrors — primary source for the dashboard credit display.
        trialQuotaBonus:   provData.trialCredits as number ?? prev?.trialQuotaBonus ?? 0,
        paidQuotaBonus:    provData.paidCredits  as number ?? prev?.paidQuotaBonus  ?? 0,
        paidAt:            provData.paidAt as string ?? prev?.paidAt ?? "",
        amountUSD:         (provData.amountUSD as number) ?? prev?.amountUSD ?? 0,
      }));

      // Fetch subscription expiry & status
      fetch(`/api/payment/check?address=${addr}`)
        .then(r => r.json())
        .then(data => {
          if (data.expiresAt) { setExpiresAt(new Date(data.expiresAt)); setIsExpired(data.isExpired ?? false); }
        })
        .catch(() => {});
    }

    provision();
  // address / authChecked / emailSession drive the Phase 1 wallet-match gate
  // above; a late session resolution must rebuild this callback so the next
  // refresh re-evaluates whether this address should still be provisioned.
  // signMessage is intentionally omitted (matches the prior effect) to avoid
  // re-signing churn — getAuthCreds caches the signature.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, authChecked, emailSession]);

  // Run the provision fetch on mount + whenever the identity inputs change.
  useEffect(() => {
    refreshProvision();
  }, [refreshProvision]);

  // Keep quota / credits fresh: re-run the provision fetch when the user
  // returns to the tab (window focus) or the document becomes visible again.
  // refreshProvision is internally guarded, so these fire harmlessly when
  // there's no wallet/auth or on a mismatched wallet.
  useEffect(() => {
    const onFocus = () => refreshProvision();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshProvision();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshProvision]);

  // ── Phase 1 identity-model early returns ──────────────────────────────
  // The 4-state machine routes the user before any multichain data is
  // fetched. The two branches below cover the cases where an email
  // session + browser-connected wallet exist together but in a state
  // that must NOT render the regular dashboard:
  //
  //   State D — wallet connected, session not yet claimed by any wallet
  //             → ClaimWalletPrompt (signed bind via /api/auth/wallet-bind)
  //   State G — session bound to wallet X, browser connected to wallet Y
  //             → WrongWalletHardBlock (no data fetched from Y)
  //
  // skipClaimPrompt is a session-scoped escape hatch for State D only.
  const walletMatches =
    !!emailSession?.address &&
    !!address &&
    address.toLowerCase() === emailSession.address.toLowerCase();

  // Lazy sign-out closure shared by the State D / State G screens — same
  // semantics as the main dashboard's handleSignOut (defined later in
  // render scope, so we inline it here).
  async function earlyReturnSignOut() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    if (isConnected) {
      try { disconnect(); } catch { /* best-effort */ }
    }
    if (typeof window !== "undefined") window.location.reload();
  }

  // State D — email signed in, wallet connected, session has NEVER been
  // claimed. Require explicit signed bind before any multichain data
  // fetch. Skippable per-session via the prompt's own button.
  if (
    mounted &&
    authChecked &&
    emailSession &&
    isConnected &&
    address &&
    !emailSession.address &&
    !skipClaimPrompt
  ) {
    return (
      <ClaimWalletPrompt
        email={emailSession.email}
        connectedAddress={address}
        onBound={(boundAddr) => {
          // Local optimistic update — server already persisted via the
          // /api/auth/wallet-bind call inside ClaimWalletPrompt.
          setEmailSession(prev => prev ? { ...prev, address: boundAddr } : prev);
        }}
        onSkip={() => setSkipClaimPrompt(true)}
        onSignOut={earlyReturnSignOut}
      />
    );
  }

  // State G — email signed in, wallet connected, session is bound but the
  // connected wallet doesn't match. Full-screen non-dismissable block, NO
  // multichain data fetch (the provision useEffect's address dep would
  // otherwise pull the wrong wallet's subscription). The wallet match
  // gate inside that useEffect is the belt-and-suspenders — this early
  // return is the actual UX.
  if (
    mounted &&
    authChecked &&
    emailSession &&
    isConnected &&
    address &&
    emailSession.address &&
    !walletMatches
  ) {
    return (
      <WrongWalletHardBlock
        email={emailSession.email}
        boundAddress={emailSession.address}
        connectedAddress={address}
        onSignOut={earlyReturnSignOut}
      />
    );
  }

  // Email-only view: user signed in via Google / magic-link.
  //   - !isConnected → pure email-only (the "API key fast path" landing)
  //   - skipClaimPrompt && !emailSession.address && isConnected → user
  //     deferred binding from State D; treat them as effectively email-
  //     only and route back to this simpler page rather than the full
  //     multichain dashboard chrome. They can re-trigger State D from
  //     the in-page "Bind ..." button by clearing the skip flag.
  if (
    mounted &&
    emailSession &&
    (!isConnected || (skipClaimPrompt && !emailSession.address))
  ) {
    const trialDaysLeft = sessionTrial.trialExpiresAt
      ? Math.max(0, Math.ceil((new Date(sessionTrial.trialExpiresAt).getTime() - Date.now()) / 86_400_000))
      : null;
    const creditsPct = Math.min(100, Math.max(0, Math.round((sessionTrial.credits / Math.max(1, sessionTrial.totalCredits)) * 100)));

    return (
      <div className="min-h-screen text-white px-6 py-12" style={{ background: "linear-gradient(160deg, #05070A 0%, #0B1220 100%)" }}>
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <Link href="/" className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-md bg-yellow flex items-center justify-center shadow-[0_0_12px_rgba(245,197,24,0.35)]">
                <span className="w-2.5 h-2.5 rounded-sm bg-navy/90" />
              </span>
              <span className="text-yellow font-bold text-base tracking-tight leading-none">Q402</span>
            </Link>
            <div className="flex items-center gap-3 text-xs text-white/45">
              <span>{emailSession.email}</span>
              <button
                onClick={async () => {
                  await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
                  router.push("/");
                }}
                className="text-white/35 hover:text-white transition-colors"
              >
                Sign out
              </button>
            </div>
          </div>

          {/* Trial / Multichain toggle — even though this user has no wallet
              yet, surface the same toggle as the regular dashboard so they
              know where the original Multichain view lives. Clicking
              "Multichain" prompts for wallet connect (since multichain data
              requires an on-chain signer). */}
          <div className="mb-8 inline-flex items-center gap-1 bg-white/4 border border-white/10 rounded-full p-1">
            <button
              disabled
              className="inline-flex items-center gap-1.5 px-5 py-2 rounded-full text-xs font-bold bg-yellow text-navy shadow-lg shadow-yellow/15 cursor-default"
            >
              <SparkIcon size={13} /> Free Trial
            </button>
            <button
              onClick={() => setShowWalletConnectFromEmail(true)}
              className="px-5 py-2 rounded-full text-xs font-bold text-white/45 hover:text-white transition-all"
              title="Connect a wallet to view the original Multichain dashboard"
            >
              Multichain →
            </button>
          </div>

          <h1 className="text-2xl font-bold mb-1">Welcome, {emailSession.email.split("@")[0]}</h1>
          <p className="text-white/60 text-sm mb-8">
            Free trial active — 2,000 sponsored TX on BNB Chain.
          </p>

          {/* Trial summary card — sponsored TX gauge + days left + chain badge */}
          <div className="rounded-2xl border border-yellow/25 p-6 mb-6"
               style={{ background: "linear-gradient(135deg, rgba(245,197,24,0.06) 0%, rgba(85,230,165,0.05) 100%)" }}>
            <div className="flex items-baseline justify-between mb-4">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-yellow font-bold mb-1">Sponsored TX</div>
                <div className="text-3xl font-display font-extrabold text-yellow leading-none">
                  {sessionTrial.credits.toLocaleString()}
                  <span className="text-white/30 text-base ml-1">/ {sessionTrial.totalCredits.toLocaleString()}</span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-widest text-white/35 font-bold mb-1">Trial ends in</div>
                <div className="text-2xl font-display font-extrabold text-white leading-none">
                  {trialDaysLeft !== null ? `${trialDaysLeft}d` : "—"}
                </div>
              </div>
            </div>
            <div className="h-1.5 rounded-full bg-white/5 overflow-hidden mb-3">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${creditsPct}%`,
                  background: "linear-gradient(90deg, #F5C518, #55e6a5)",
                }}
              />
            </div>
            <div className="flex items-center gap-2 text-[11px] text-white/45">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-yellow animate-pulse" />
                Active
              </span>
              <span className="text-white/20">·</span>
              <span>BNB Chain · USDC + USDT</span>
              <span className="text-white/20">·</span>
              <span>Q402 covers gas</span>
            </div>
          </div>

          {/* Trial API Key — primary, the key they came for. */}
          <div className="rounded-2xl border border-white/10 p-6 mb-4" style={{ background: "rgba(255,255,255,0.03)" }}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-widest text-white/45 font-semibold">Trial API Key</div>
              <span className="text-[10px] font-bold uppercase tracking-widest text-yellow bg-yellow/15 border border-yellow/40 rounded-sm px-1.5 py-0.5">
                BNB only
              </span>
            </div>
            <div className="flex items-center gap-3">
              <code className="flex-1 font-mono text-sm text-yellow break-all">
                {sessionTrial.apiKey || "—"}
              </code>
              <button
                onClick={() => {
                  if (!sessionTrial.apiKey) return;
                  navigator.clipboard.writeText(sessionTrial.apiKey);
                  setSessionLiveCopied(true);
                  setTimeout(() => setSessionLiveCopied(false), 2000);
                }}
                disabled={!sessionTrial.apiKey}
                className="text-xs px-3 py-1.5 rounded-md bg-white/5 hover:bg-yellow/15 hover:text-yellow text-white/60 transition-colors disabled:opacity-40"
              >
                {sessionLiveCopied ? "Copied!" : "Copy"}
              </button>
            </div>
            <p className="text-white/30 text-xs mt-3">
              Use with the SDK on <code className="text-white/55">chain: &quot;bnb&quot;</code>, token{" "}
              <code className="text-white/55">&quot;USDC&quot;</code> or <code className="text-white/55">&quot;USDT&quot;</code>.
              Each relay consumes one sponsored TX credit.
            </p>
          </div>

          {/* Sandbox API key — secondary */}
          <div className="rounded-2xl border border-white/8 p-6 mb-6" style={{ background: "rgba(255,255,255,0.02)" }}>
            <div className="text-[10px] uppercase tracking-widest text-white/35 font-semibold mb-2">Sandbox API key</div>
            <div className="flex items-center gap-3">
              <code className="flex-1 font-mono text-sm text-white/70 break-all">
                {sessionTrial.sandboxApiKey || "—"}
              </code>
              <button
                onClick={() => {
                  if (!sessionTrial.sandboxApiKey) return;
                  navigator.clipboard.writeText(sessionTrial.sandboxApiKey);
                  setSessionSandboxCopied(true);
                  setTimeout(() => setSessionSandboxCopied(false), 2000);
                }}
                disabled={!sessionTrial.sandboxApiKey}
                className="text-xs px-3 py-1.5 rounded-md bg-white/5 hover:bg-yellow/15 hover:text-yellow text-white/60 transition-colors disabled:opacity-40"
              >
                {sessionSandboxCopied ? "Copied!" : "Copy"}
              </button>
            </div>
            <p className="text-white/30 text-xs mt-3">
              Mock-response key for integration testing — no real TX, no credits burned.
            </p>
          </div>

          {/* Wallet-bind nudge — three modes:
              (a) bound:            reconnect-for-multichain CTA
              (b) skip-mode:        wallet already connected but user
                                    deferred binding in State D. Show
                                    "Resume claim" instead of "Connect".
              (c) pure email-only:  no wallet connected yet */}
          {emailSession.address ? (
            <div className="rounded-2xl border border-yellow/25 p-6 mb-6"
                 style={{ background: "linear-gradient(135deg, rgba(245,197,24,0.06) 0%, rgba(255,255,255,0.02) 100%)" }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] uppercase tracking-widest text-yellow font-bold">Wallet bound</span>
                <span className="font-mono text-[11px] text-white/55">
                  {emailSession.address.slice(0, 6)}…{emailSession.address.slice(-4)}
                </span>
              </div>
              <h2 className="text-base font-bold mb-2">Reconnect to unlock Multichain</h2>
              <p className="text-white/60 text-sm mb-4">
                Wallet already paired with this email. Reconnect to use Gas Tank, paid plans, and 10-chain history.
              </p>
              <button
                onClick={() => setShowWalletConnectFromEmail(true)}
                className="inline-block bg-yellow text-navy font-bold text-sm px-6 py-2.5 rounded-full hover:bg-yellow-hover transition-colors"
              >
                Reconnect wallet →
              </button>
            </div>
          ) : isConnected && address ? (
            <div className="rounded-2xl border border-yellow/20 p-6 mb-6"
                 style={{ background: "linear-gradient(135deg, rgba(245,197,24,0.04) 0%, rgba(255,255,255,0.02) 100%)" }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] uppercase tracking-widest text-yellow font-bold">Skip mode — trial only</span>
              </div>
              <h2 className="text-base font-bold mb-2">Finish binding this wallet?</h2>
              <p className="text-white/60 text-sm mb-4">
                Trial credits are live, but Multichain stays locked until <span className="font-mono text-white/80">{address.slice(0, 6)}…{address.slice(-4)}</span> is bound to this account.
              </p>
              <button
                onClick={() => setSkipClaimPrompt(false)}
                className="inline-block bg-yellow text-navy font-bold text-sm px-6 py-2.5 rounded-full hover:bg-yellow-hover transition-colors"
              >
                Bind {address.slice(0, 6)}…{address.slice(-4)} permanently →
              </button>
            </div>
          ) : (
            <div className="rounded-2xl border border-white/8 p-6 mb-6" style={{ background: "rgba(255,255,255,0.02)" }}>
              <h2 className="text-base font-bold mb-2">Test the full flow yourself?</h2>
              <p className="text-white/60 text-sm mb-4">
                Connect a wallet to sign EIP-712 in this browser. We&apos;ll bind it to this account so trial credits + keys stay attached.
              </p>
              <button
                onClick={() => setShowWalletConnectFromEmail(true)}
                className="inline-block bg-white/5 border border-white/15 text-white font-semibold text-sm px-6 py-2.5 rounded-full hover:bg-white/10 transition-colors"
              >
                Connect wallet →
              </button>
            </div>
          )}

          <div className="text-white/35 text-xs">
            Docs: <Link href="/docs" className="hover:text-white/60 underline-offset-2 hover:underline">/docs</Link>{" · "}
            MCP server: <Link href="/claude" className="hover:text-white/60 underline-offset-2 hover:underline">/claude</Link>
          </div>
        </div>

        {showWalletConnectFromEmail && (
          <WalletModal onClose={() => setShowWalletConnectFromEmail(false)} />
        )}
      </div>
    );
  }

  // Hold rendering until both (a) the mount tick has completed AND (b) the
  // auth check has resolved — otherwise an email-signed-in user momentarily
  // sees a blank page on /dashboard, which reads as "I got bounced back to
  // the landing". Once auth is checked, the email-only branch above renders
  // first; only after that do we know we genuinely need a wallet.
  if (!mounted || !authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center text-white/40 text-sm" style={{ background: "#0B1220" }}>
        Loading dashboard…
      </div>
    );
  }
  if (!isConnected || !address) return null;

  // ── Scoped credit + lifecycle derivation (reused by the identity context) ──
  // Credits are SCOPED to the active view; trial vs paid pools live in
  // SEPARATE subscription slots so the scopes never collide. (The trial/paid
  // API-KEY strings themselves are no longer derived here — the v2 Developer
  // view fetches them directly via /api/keys/provision; this page only needs
  // the credit/quota + lifecycle facts the identity context publishes.)
  //
  // Two-pool credit model: scoped mirrors are the source of truth post-
  // migration. `quotaBonus` (legacy sum) is retained for back-compat only.
  const trialPoolCredits = subscription?.trialQuotaBonus ?? 0;
  const paidPoolCredits  = subscription?.paidQuotaBonus  ?? 0;
  const legacyTotalCredits = subscription?.quotaBonus ?? 0;
  const hasScopedMirrors =
    subscription?.trialQuotaBonus !== undefined ||
    subscription?.paidQuotaBonus  !== undefined;
  const isTrialOnlySub = subscription?.plan === "trial";
  const hasEmailTrial = !!emailSession && !!sessionTrial.apiKey;
  const trialCredits = hasEmailTrial
    ? sessionTrial.credits
    : hasScopedMirrors
      ? trialPoolCredits
      : (isTrialOnlySub ? legacyTotalCredits : (boundEmailTrial?.credits ?? 0));
  // Multichain side: render real values for paid accounts. `hasPaid` is
  // computed from the provision response (amountUSD > 0 && paid live key
  // exists) and is the source of truth.
  const showPaidScope = !trialViewActive && hasPaid === true;
  const plan = subscription?.plan ?? "starter";

  // TX credits remaining — pulled from the scope-matching pool.
  const remainingCredits = trialViewActive
    ? trialCredits
    : (showPaidScope
        ? (hasScopedMirrors ? paidPoolCredits : legacyTotalCredits)
        : 0);
  // Base quota for the progress bar.
  const baseCredits = trialViewActive
    ? TRIAL_CREDITS
    : (PLAN_QUOTA[plan.toLowerCase()] ?? 500);
  // pct consumed = how far below base we are (capped 0–100)
  const pct = Math.min(100, Math.max(0, Math.round((1 - remainingCredits / Math.max(baseCredits, 1)) * 100)));
  // used = base minus remaining (clamped ≥ 0), consistent with pct.
  const usedCredits = Math.max(0, baseCredits - remainingCredits);
  const daysLeft = expiresAt ? Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000) : null;

  // ── Action handles (wired into the identity context) ──────────────────────
  async function rotateKey(scope: "trial" | "paid") {
    if (!address) return {};
    // Key rotation requires an INTENT-BOUND signature
    // (action="keys.rotate", intent={scope}) so a signature collected
    // for any other action cannot be replayed to mint a fresh API key.
    const auth = await getActionAuth(address, "keys.rotate", { scope }, signMessage);
    if (!auth) return {};
    setRotatingKey(true);
    try {
      const res = await fetch("/api/keys/rotate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, nonce: auth.challenge, signature: auth.signature, scope }),
      });
      const data = await res.json();
      if (res.status === 401 && data.code === "NONCE_EXPIRED") { clearAuthCache(address); return { code: "NONCE_EXPIRED" as const }; }
      if (data.apiKey) {
        setSubscription(prev => {
          if (!prev) return null;
          // Mirror the server-side write: trial rotation lands in
          // trialApiKey and (for legacy pre-Phase-1 subs) clears the
          // paid apiKey slot since the key just migrated forward.
          if (scope === "trial") {
            return {
              ...prev,
              trialApiKey: data.apiKey,
              ...(prev.plan === "trial" ? { apiKey: "" } : {}),
            };
          }
          return { ...prev, apiKey: data.apiKey };
        });
        return { apiKey: data.apiKey as string };
      }
      return {};
    } catch { return {}; } finally { setRotatingKey(false); }
  }

  async function saveAlertEmail() {
    if (!address || !alertEmailInput) return;
    const auth = await getAuthCreds(address, signMessage);
    if (!auth) return;
    const { nonce, signature } = auth;
    setAlertSaving(true);
    try {
      const res = await fetch("/api/usage-alert", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ address, nonce, signature, email: alertEmailInput }),
      });
      const data = await res.json();
      if (res.status === 401 && data.code === "NONCE_EXPIRED") { clearAuthCache(address); return; }
      if (!res.ok || !data.ok) return;
      setAlertEmail(alertEmailInput);
      setEmailSaved(true);
      setTimeout(() => { setShowAlertModal(false); setEmailSaved(false); }, 1200);
    } catch { /* ignore */ } finally { setAlertSaving(false); }
  }

  async function deleteAlertEmail() {
    if (!address) return;
    const auth = await getAuthCreds(address, signMessage);
    if (!auth) return;
    const { nonce, signature } = auth;
    setAlertDeleting(true);
    try {
      const qs = new URLSearchParams({ address, nonce, sig: signature }).toString();
      const res = await fetch(`/api/usage-alert?${qs}`, { method: "DELETE" });
      const data = await res.json();
      if (res.status === 401 && data.code === "NONCE_EXPIRED") { clearAuthCache(address); return; }
      if (!res.ok) return;
      setAlertEmail("");
      setAlertEmailInput("");
    } catch { /* ignore */ } finally { setAlertDeleting(false); }
  }

  function handleSignOut() {
    void (async () => {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
      if (isConnected) {
        try {
          disconnect();
        } catch {
          /* best-effort */
        }
      }
      if (typeof window !== "undefined") window.location.reload();
    })();
  }

  // ── Identity context value — published to the v2 views ────────────────────
  // Everything the v2 shell + views need is computed once here (reusing the
  // proven legacy fetches above) and threaded down. The action handles drive
  // the legacy modals/flows mounted at the bottom of this render.
  const identityValue: DashboardIdentityValue = {
    emailSession,
    subscription,
    isExpired,
    expiresAt,
    daysLeft,
    quota: subscription
      ? { used: usedCredits, total: baseCredits, pct }
      : null,
    plan,
    signOut: handleSignOut,
    // openTrialActivation — re-arms + opens the legacy TrialActivationModal.
    // Resetting the ref allows the user to re-trigger after a prior close.
    openTrialActivation: () => {
      trialPromptedRef.current = false;
      setShowAutoTrial(true);
    },
    openUsageAlerts: () => {
      setAlertEmailInput(alertEmail || "");
      setShowAlertModal(true);
    },
    rotateKey,
  };

  return (
    <DashboardIdentityProvider value={identityValue}>
      {/* The v2 dashboard shell. It owns its own scope chip + view router and
          reads identity/subscription/lifecycle from the context above. */}
      <DashboardV2 />

      {showAutoTrial && (
        <TrialActivationModal
          onClose={() => {
            setShowAutoTrial(false);
            // Re-fetch the subscription so the dashboard reflects the new
            // 2k credits + plan=trial state without a full page reload.
            if (typeof window !== "undefined") window.location.reload();
          }}
        />
      )}

      {/* Email Alert config modal — opened from the identity context's
          openUsageAlerts() handle. Wraps the existing /api/usage-alert flow
          (POST to set, DELETE to remove). Only callable when a wallet is
          connected since the endpoint requires nonce+signature auth. */}
      {showAlertModal && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center px-4"
          style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)" }}
          onClick={() => setShowAlertModal(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/8 p-7 relative"
            style={{ background: "linear-gradient(180deg, #0F1626 0%, #080E1C 100%)", boxShadow: "0 30px 80px rgba(0,0,0,0.6)" }}
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setShowAlertModal(false)}
              className="absolute top-4 right-4 text-white/40 hover:text-white/80 text-lg"
              aria-label="Close"
            >
              ×
            </button>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-yellow">
                <BellIcon size={20} />
              </span>
              <div className="text-[10px] uppercase tracking-[0.2em] text-yellow font-bold">
                Email alerts
              </div>
            </div>
            <h2 className="text-2xl font-bold mb-2">Usage notifications</h2>
            <p className="text-white/65 text-sm mb-5">
              Get an email at 20% and 10% TX remaining.
            </p>

            {!address && (
              <p className="text-red-400 text-xs mb-4">
                Connect a wallet first — email alerts require a signed config.
              </p>
            )}

            <label className="block text-[11px] uppercase tracking-widest text-white/35 font-semibold mb-2">
              Send alerts to
            </label>
            <input
              type="email"
              value={alertEmailInput}
              onChange={e => setAlertEmailInput(e.target.value)}
              placeholder="you@company.com"
              className="w-full bg-white/5 border border-white/8 rounded-xl px-4 py-3 text-sm text-white outline-none focus:border-yellow/40 placeholder-white/20 mb-5"
            />

            <div className="flex flex-wrap gap-2">
              {alertEmail && (
                <button
                  onClick={deleteAlertEmail}
                  disabled={alertDeleting || !address}
                  className="bg-red-400/8 border border-red-400/20 text-red-400 text-sm py-3 px-5 rounded-full hover:bg-red-400/15 transition-colors disabled:opacity-50"
                >
                  {alertDeleting ? "Removing…" : "Remove"}
                </button>
              )}
              <button
                onClick={saveAlertEmail}
                disabled={alertSaving || !address || !alertEmailInput}
                className="flex-1 bg-yellow text-navy font-bold text-sm py-3 rounded-full hover:bg-yellow-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {alertSaving ? (
                  "Saving…"
                ) : emailSaved ? (
                  <span className="inline-flex items-center gap-1.5">
                    Saved <CheckIcon size={14} />
                  </span>
                ) : alertEmail ? (
                  "Update"
                ) : (
                  "Save"
                )}
              </button>
            </div>

            <p className="text-white/30 text-[11px] mt-4 leading-relaxed">
              Hysteresis: each threshold fires once per top-up window. After
              you top up, the next 20% / 10% crossing re-arms automatically.
            </p>
          </div>
        </div>
      )}
    </DashboardIdentityProvider>
  );
}
