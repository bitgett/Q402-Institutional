"use client";

/**
 * Dashboard Sidebar — left rail that consolidates the view toggle + tab
 * navigation that used to stack at the top of the dashboard.
 *
 * Two view sections (Free Trial / Multichain) each containing the tabs
 * that make sense in that scope. Clicking a tab item:
 *   - flips the dashboard's view (trial vs multichain) if needed
 *   - sets the active tab
 *
 * Account section at the bottom shows the identity (email + addr) +
 * trial expiry status + sign-out button. Replaces the top-of-page
 * trial banner + usage-alert popup which used to occupy that real-estate.
 */

import Link from "next/link";

export type DashboardTab =
  | "overview"
  | "developer"
  | "transactions"
  | "claude"
  | "gas-tank"
  | "webhooks";

export interface SidebarSelection {
  view: "trial" | "multichain";
  tab: DashboardTab;
}

interface Props {
  selection: SidebarSelection;
  onSelect: (sel: SidebarSelection) => void;

  identity: {
    email?: string | null;
    address?: string | null;
  };

  trial: {
    creditsLeft: number;
    totalCredits: number;
    daysLeft: number | null;
  };

  signOut: () => void;
}

interface TabDef {
  id: DashboardTab;
  label: string;
  icon: string;
}

// Trial view exposes the parts of the dashboard that are wired up to
// trial credit + BNB-only enforcement. Gas Tank + Webhooks are omitted
// (trial doesn't fund a tank, and webhook dispatch needs a paid plan).
const TRIAL_TABS: TabDef[] = [
  { id: "overview",     label: "Overview",     icon: "◇" },
  { id: "developer",    label: "Developer",    icon: "{ }" },
  { id: "transactions", label: "Transactions", icon: "≡" },
  { id: "claude",       label: "Claude",       icon: "C" },
];

// Multichain view is the full paid product — restores the surfaces that
// existed before the sprint.
const MULTICHAIN_TABS: TabDef[] = [
  { id: "overview",     label: "Overview",     icon: "◇" },
  { id: "gas-tank",     label: "Gas Tank",     icon: "⛽" },
  { id: "developer",    label: "Developer",    icon: "{ }" },
  { id: "transactions", label: "Transactions", icon: "≡" },
  { id: "claude",       label: "Claude",       icon: "C" },
];

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function TabItem({
  tab,
  active,
  onClick,
}: {
  tab: TabDef;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
        active
          ? "bg-yellow/10 text-yellow font-semibold"
          : "text-white/55 hover:text-white hover:bg-white/[0.04]"
      }`}
    >
      <span className={`text-[11px] w-4 text-center flex-shrink-0 ${active ? "text-yellow" : "text-white/30"}`}>
        {tab.icon}
      </span>
      {tab.label}
    </button>
  );
}

export default function DashboardSidebar({
  selection,
  onSelect,
  identity,
  trial,
  signOut,
}: Props) {
  const { view, tab } = selection;

  return (
    <aside
      className="hidden md:flex w-60 flex-shrink-0 flex-col sticky top-0 h-screen overflow-y-auto border-r"
      style={{ borderColor: "rgba(255,255,255,0.06)", background: "rgba(5,9,18,0.5)" }}
    >
      {/* Logo */}
      <div className="px-5 pt-6 pb-5 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <Link href="/" className="flex items-center gap-2">
          <span className="w-6 h-6 rounded-md bg-yellow flex items-center justify-center shadow-[0_0_12px_rgba(245,197,24,0.35)]">
            <span className="w-2.5 h-2.5 rounded-sm bg-navy/90" />
          </span>
          <span className="text-yellow font-bold text-base tracking-tight leading-none">Q402</span>
          <span className="text-white/25 text-xs">Dashboard</span>
        </Link>
      </div>

      {/* Free Trial section */}
      <div className="px-3 pt-4">
        <button
          onClick={() => onSelect({ view: "trial", tab: "overview" })}
          className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md text-sm font-semibold transition-colors ${
            view === "trial"
              ? "text-yellow bg-yellow/8"
              : "text-white/65 hover:text-white"
          }`}
        >
          <span className="flex items-center gap-2">
            <span className={view === "trial" ? "text-yellow" : "text-white/40"}>✦</span>
            Free Trial
          </span>
          {trial.daysLeft !== null && trial.daysLeft > 0 && (
            <span className="text-[9px] font-bold uppercase tracking-widest text-green-400">
              {trial.daysLeft}d
            </span>
          )}
        </button>
        {view === "trial" && (
          <ul className="ml-2 mt-1 space-y-0.5">
            {TRIAL_TABS.map(t => (
              <li key={t.id}>
                <TabItem
                  tab={t}
                  active={tab === t.id}
                  onClick={() => onSelect({ view: "trial", tab: t.id })}
                />
              </li>
            ))}
          </ul>
        )}

        {/* Trial credit mini-gauge — surfaces the 2k/2k status without
            stealing top-of-page real estate. */}
        {view === "trial" && (
          <div className="mx-3 mt-3 mb-2 p-2.5 rounded-lg border border-white/8" style={{ background: "rgba(255,255,255,0.02)" }}>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-[10px] uppercase tracking-widest text-white/35 font-bold">Sponsored TX</span>
              <span className="text-[10px] text-white/35">
                {trial.creditsLeft.toLocaleString()} / {trial.totalCredits.toLocaleString()}
              </span>
            </div>
            <div className="h-1 rounded-full bg-white/5 overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(100, Math.max(0, (trial.creditsLeft / Math.max(1, trial.totalCredits)) * 100))}%`,
                  background: "linear-gradient(90deg, #F5C518, #4ade80)",
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Multichain section */}
      <div className="px-3 pt-3">
        <button
          onClick={() => onSelect({ view: "multichain", tab: "overview" })}
          className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md text-sm font-semibold transition-colors ${
            view === "multichain"
              ? "text-white bg-white/[0.06]"
              : "text-white/65 hover:text-white"
          }`}
        >
          <span>Multichain</span>
        </button>
        {view === "multichain" && (
          <ul className="ml-2 mt-1 space-y-0.5">
            {MULTICHAIN_TABS.map(t => (
              <li key={t.id}>
                <TabItem
                  tab={t}
                  active={tab === t.id}
                  onClick={() => onSelect({ view: "multichain", tab: t.id })}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Account section */}
      <div className="mt-auto px-3 pb-6">
        <div className="border-t pt-4" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          <div className="px-3 mb-3 space-y-1">
            <div className="text-[10px] uppercase tracking-widest text-white/35 font-bold">Account</div>
            {identity.email && (
              <div className="flex items-center gap-1.5 text-white/75 text-xs truncate">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" style={{ boxShadow: "0 0 4px #4ade80" }} />
                <span className="truncate">{identity.email}</span>
              </div>
            )}
            {identity.address && (
              <div className="flex items-center gap-1.5 text-white/65 text-xs font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-yellow flex-shrink-0" style={{ boxShadow: "0 0 4px #F5C518" }} />
                <span>{shortAddr(identity.address)}</span>
              </div>
            )}
          </div>
          <button
            onClick={signOut}
            className="w-full px-3 py-2 rounded-md text-xs text-white/40 hover:text-white hover:bg-white/[0.04] transition-colors text-left"
          >
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
