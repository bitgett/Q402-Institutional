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

import { useState } from "react";
import { useWallet } from "@/app/context/WalletContext";
import { BrandMark, ScopeChip, TopNav, bodyFont } from "./primitives";
import WalletButton from "@/app/components/WalletButton";
import { v2, type Scope, type V2ViewId } from "./theme";
import { WalletsView } from "./views/WalletsView";
import { ActivityView } from "./views/ActivityView";
import { TreasuryView } from "./views/TreasuryView";
import { DeveloperView } from "./views/DeveloperView";
import DashboardBanners from "./DashboardBanners";

export default function DashboardV2() {
  const { address, signMessage } = useWallet();
  const [view, setView] = useState<V2ViewId>("wallets");
  // KEY IA DECISION: scope is shell-level state, threaded to every view.
  const [scope, setScope] = useState<Scope>("multichain");

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

      <div
        style={{
          maxWidth: 1500,
          margin: "auto",
          padding: "0 22px 28px",
          position: "relative",
          zIndex: 1,
        }}
      >
        {/* ── Top bar ──────────────────────────────────────────────── */}
        <header
          className="v2-topbar"
          style={{
            height: 68,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: `1px solid ${v2.line}`,
            position: "sticky",
            top: 0,
            zIndex: 20,
            background: v2.topbarFill,
            backdropFilter: "blur(18px)",
            WebkitBackdropFilter: "blur(18px)",
          }}
        >
          {/* Brand — exact copy of the landing navbar (Poppins Bold, the
              navbar mark, "by Quack AI" tagline) so the dashboard reads as
              the same product. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
          </div>

          <TopNav active={view} onChange={setView} />

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <ScopeChip scope={scope} onChange={setScope} />
            {/* Real connect flow (MetaMask / OKX modal) — same component the
                landing nav uses, so disconnected users can actually connect. */}
            <WalletButton />
          </div>
        </header>

        {/* Banners slot — top-of-shell mount point for the expiry / quota /
            plan lifecycle banners, driven by the dashboard identity context
            (useDashboardIdentity → isExpired, daysLeft, quota, plan). Renders
            ABOVE the view router without disturbing the sticky topbar; the
            component itself returns null when there's nothing to warn about,
            so the slot adds no empty bar. */}
        <DashboardBanners />

        {/* View router. key={view} re-mounts on switch so the enter animation replays. */}
        <div key={view} className="v2-view-enter">
          {view === "wallets" && <WalletsView {...viewProps} />}
          {view === "activity" && <ActivityView {...viewProps} />}
          {view === "treasury" && <TreasuryView {...viewProps} />}
          {view === "developer" && <DeveloperView {...viewProps} />}
        </div>
      </div>
    </div>
  );
}
