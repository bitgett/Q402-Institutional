"use client";

/**
 * DashboardV2 — the v2 dashboard shell.
 *
 * Single-page app with a sticky top bar (brand + 4-view TopNav + ScopeChip
 * + OwnerChip) and a client-side view router rendering one of four task
 * views over the grid + radial-glow background. Direct port of the
 * prototype's `.app` shell (dashboard-v2.html §5).
 *
 * State owned here:
 *   - `view`  : which of the 4 task views is showing (default "wallets").
 *   - `scope` : "trial" | "multichain" — KEY IA DECISION. This is NOT two
 *               dashboards; it's a top-bar toggle that only changes which
 *               API key is active + which chains are selectable. Threaded
 *               into every view via props.
 *
 * Wallet identity comes from useWallet() (shared WalletContext). The owner
 * address + signMessage are passed down so the views' (next-phase) data
 * layers can auth via getAuthCreds.
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@/app/context/WalletContext";
import Link from "next/link";
import { BrandMark, ScopeChip, TopNav, bodyFont } from "./primitives";
import WalletButton from "@/app/components/WalletButton";
import { v2, type Scope, type V2ViewId } from "./theme";
import { WalletsView } from "./views/WalletsView";
import { ActivityView } from "./views/ActivityView";
import { TreasuryView } from "./views/TreasuryView";
import { DeveloperView } from "./views/DeveloperView";
import DashboardBanners from "./DashboardBanners";
import { useDashboardIdentity } from "./identity-context";

export default function DashboardV2({
  onScopeChange,
}: {
  /** Notifies the host (app/dashboard/page.tsx) when the user toggles the
   *  scope chip, so the credit-quota source (trialViewActive) stays in sync
   *  with the on-screen scope instead of frozen at its mount value. */
  onScopeChange?: (scope: Scope) => void;
} = {}) {
  const { address, signMessage } = useWallet();
  const router = useRouter();
  // Initial view is deep-linkable via ?view= (e.g. friendly-error CTAs that
  // point at the Treasury gas tank or the Wallets clear-delegation action).
  // Seeded from window.location.search (not useSearchParams) so the shell stays
  // free of a Suspense boundary — only router.replace is used for writes, which
  // needs none. SSR-safe via the typeof window guard (defaults to "wallets").
  const [view, setView] = useState<V2ViewId>(() => {
    if (typeof window === "undefined") return "wallets";
    const v = new URLSearchParams(window.location.search).get("view");
    return (["wallets", "activity", "treasury", "developer"] as const).includes(v as V2ViewId)
      ? (v as V2ViewId)
      : "wallets";
  });
  // KEY IA DECISION: scope is shell-level state, threaded to every view. Also
  // deep-linkable + restored on reload via ?scope= (read like ?view= above).
  const [scope, setScope] = useState<Scope>(() => {
    if (typeof window === "undefined") return "multichain";
    const s = new URLSearchParams(window.location.search).get("scope");
    return s === "trial" || s === "multichain" ? s : "multichain";
  });

  // URL persistence — mirror in-app view/scope changes back into the query so a
  // reload / share / back lands on the same view+scope instead of resetting to
  // wallets+multichain. We use router.replace (not push) so navigation doesn't
  // pollute the back stack, and { scroll: false } so switching views never
  // jumps the page. Writes go through these wrapped setters; the initializers
  // above handle the read side. (router.replace needs no Suspense boundary,
  // unlike useSearchParams — that's why the shell reads from window instead.)
  const writeUrl = useCallback(
    (nextView: V2ViewId, nextScope: Scope) => {
      if (typeof window === "undefined") return;
      const params = new URLSearchParams(window.location.search);
      params.set("view", nextView);
      params.set("scope", nextScope);
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  const selectView = useCallback(
    (next: V2ViewId) => {
      setView(next);
      writeUrl(next, scope);
    },
    [writeUrl, scope],
  );

  const selectScope = useCallback(
    (next: Scope) => {
      setScope(next);
      writeUrl(view, next);
      // Keep the host's credit-quota scope (trialViewActive) in lockstep with
      // the chip, so the quota + banner never lag a scope toggle.
      onScopeChange?.(next);
    },
    [writeUrl, view, onScopeChange],
  );

  // Entitled-scope default, applied DURING RENDER (React's "adjust state when
  // data changes" pattern — not an effect, so no cascading render and no
  // set-state-in-effect). `scope` seeds to "multichain", but a non-paid
  // (trial / unpaid) wallet's real scope is "trial": leaving them on multichain
  // mislabels the whole dashboard and lands the "Active scope" badge on the
  // locked Multichain key. When hasPaid first resolves, snap a non-paid wallet
  // to "trial" — once, and never over a pinned ?scope=. No URL write: the
  // default is idempotent, and an explicit toggle still persists via
  // selectScope.
  const identity = useDashboardIdentity();
  const [scopePinned] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("scope"),
  );
  const [autoScoped, setAutoScoped] = useState(false);
  if (!autoScoped && !scopePinned && identity.hasPaid != null) {
    setAutoScoped(true);
    if (identity.hasPaid === false && scope !== "trial") setScope("trial");
  }

  // Shared props every view consumes. signMessage from WalletContext is
  // already non-null typed; views forward it to the agentic data layer.
  const viewProps = { ownerAddress: address, signMessage, scope };

  return (
    <div
      className="v2-app"
      style={{
        minHeight: "100vh",
        maxWidth: "100%",
        overflowX: "hidden",
        background: v2.bg,
        color: v2.text,
        fontFamily: bodyFont,
        // Radial glows (body background-image in the prototype).
        backgroundImage:
          "radial-gradient(circle at 82% 2%, rgba(54,130,157,.14), transparent 29rem), radial-gradient(circle at 7% 100%, rgba(247,202,22,.055), transparent 31rem)",
        position: "relative",
      }}
    >
      {/* Grid overlay (body:before). Fixed, non-interactive, fades to bottom. */}
      <div
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          pointerEvents: "none",
          opacity: 0.18,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.02) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
          maskImage: "linear-gradient(to bottom, black, transparent 84%)",
          WebkitMaskImage: "linear-gradient(to bottom, black, transparent 84%)",
          zIndex: 0,
        }}
      />

      {/* ── Top bar — full-bleed (direct child of .v2-app) so the bar
          background spans the whole viewport width; the inner wrapper keeps
          content aligned to the 1500px column. Constraining the bar to the
          content column left the page background + top-right glow showing past
          the bar's right edge, which read as a seam beside the wallet button. */}
      <header
        className="v2-topbar"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          background: v2.topbarFill,
          borderBottom: `1px solid ${v2.line}`,
        }}
      >
        <div
          style={{
            maxWidth: 1500,
            margin: "auto",
            padding: "0 22px",
            height: 68,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          {/* Brand — exact copy of the landing navbar (Poppins Bold, the
              navbar mark, "by Quack AI" tagline) so the dashboard reads as
              the same product. Clicking it returns to the landing page. */}
          <Link
            href="/"
            aria-label="Q402 — back to home"
            style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }}
          >
            <BrandMark />
            <span
              style={{
                fontFamily: "var(--font-poppins)",
                color: v2.yellow,
                fontWeight: 700,
                fontSize: 18,
                letterSpacing: "-0.025em",
                lineHeight: 1,
              }}
            >
              Q402
            </span>
            <span
              style={{
                fontFamily: "var(--font-poppins)",
                color: "rgba(255,255,255,0.3)",
                fontSize: 12,
                fontWeight: 300,
                lineHeight: 1,
              }}
            >
              by Quack AI
            </span>
          </Link>

          <TopNav active={view} onChange={selectView} />

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <ScopeChip scope={scope} onChange={selectScope} />
            {/* Real connect flow (MetaMask / OKX modal) — same component the
                landing nav uses, so disconnected users can actually connect. */}
            <WalletButton />
          </div>
        </div>
      </header>

      <div
        style={{
          maxWidth: 1500,
          margin: "auto",
          padding: "0 22px 28px",
          position: "relative",
          zIndex: 1,
        }}
      >

        {/* Banners slot — top-of-shell mount point for the expiry / quota /
            plan lifecycle banners, driven by the dashboard identity context
            (useDashboardIdentity → isExpired, daysLeft, quota, plan). Renders
            ABOVE the view router without disturbing the sticky topbar; the
            component itself returns null when there's nothing to warn about,
            so the slot adds no empty bar. */}
        <DashboardBanners />

        {/* View router. key={view} re-mounts on switch so the enter animation replays. */}
        <div key={view} className="v2-view-enter">
          {view === "wallets" && <WalletsView {...viewProps} onNavigate={selectView} />}
          {view === "activity" && <ActivityView {...viewProps} />}
          {view === "treasury" && <TreasuryView {...viewProps} />}
          {view === "developer" && <DeveloperView {...viewProps} />}
        </div>
      </div>
    </div>
  );
}
