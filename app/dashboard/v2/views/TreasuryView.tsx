"use client";

/**
 * TreasuryView — capital operations (prototype id="treasury", .wide-view).
 *
 * REAL implementation. Re-lays-out + re-skins the v1 dashboard's Gas Tank
 * tab + the agentic Earn / Bridge surfaces into the v2 design language
 * (glass surfaces, yellow/mint accents, Space Grotesk numerals). ALL
 * business logic is reused unchanged from the v1 data layer — this file
 * only fetches via the same endpoints and mounts the same modals.
 *
 * ── Layout ──────────────────────────────────────────────────────────────
 *   .wide-view = 230px context rail + view-main
 *   Col 1  .context: anchor sub-nav — Capital overview / Gas Tank /
 *          Q402 Yield / CCIP Bridge / Deposits. Scroll-spy highlights the
 *          section in view.
 *   Col 2  .view-main: "Capital operations" title + desc, then
 *          .treasury-grid (3 cards): Gas Tank ($ total + per-chain health),
 *          Q402 Yield (embeds AgenticWalletEarnSection), CCIP Bridge (LINK
 *          lanes + "Open CCIP bridge" → AgenticWalletBridgeModal). Then a
 *          per-network .table: Network · Stablecoins (wallet EOA) · Gas Tank
 *          · State · Manage (opens the deposit modal).
 *
 * ── Data sources (REUSED, not reinvented) ───────────────────────────────
 *   - Gas Tank balances / deposits / LINK: GET /api/gas-tank/user-balance
 *       (auth'd via getAuthCreds — mirrors page.tsx refreshUserBalance).
 *   - Token prices: GET /api/gas-tank → { tanks:[{key,price}] }.
 *   - User EOA holdings: GET /api/wallet-balance?address.
 *   - Agent Wallet (for Earn + Bridge): GET /api/wallet/agentic (auth'd) —
 *       picks the owner's first/active wallet so the embedded Earn section
 *       + Bridge modal have a walletId/walletAddress to act on.
 *   - Deposit: sendNativeTransfer + waitForWalletReceipt (app/lib/wallet)
 *       + POST /api/gas-tank/verify-deposit (retrying), same as page.tsx
 *       DepositModal.
 *   - Yield: <AgenticWalletEarnSection/> (owns its own fetch + actions).
 *   - Bridge: <AgenticWalletBridgeModal/> (owns its own auth + CCIP flow).
 *   - Explorer links: explorerAddressUrl / explorerLabel (app/lib/eip7702).
 *
 * ── Scope semantics ─────────────────────────────────────────────────────
 *   trial scope = BNB-only Gas Tank (the rest dim to "Multichain only");
 *   multichain = full 11-chain set + LINK + bridge enabled. Scope gates
 *   which network rows are interactive and whether the bridge card is live.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  Surface,
  Eyebrow,
  SectionHead,
  V2AccentScope,
  displayFont,
} from "../primitives";
import { v2, glass, subCard, fs } from "../theme";
import type { Scope } from "../theme";
import { ChainIcon, TokenIcon, Q402Mark, GasTankIcon, CheckIcon } from "../logos";
import { getAuthCreds, clearAuthCache } from "@/app/lib/auth-client";
import { GASTANK_ADDRESS } from "@/app/lib/wallets";
import {
  sendNativeTransfer,
  waitForWalletReceipt,
  walletErrorMessage,
  type WalletChainKey,
} from "@/app/lib/wallet";
import { explorerAddressUrl, explorerLabel } from "@/app/lib/eip7702";
import { AgenticWalletEarnSection } from "@/app/dashboard/components/AgenticWalletEarnSection";
import { AgenticWalletStakeSection } from "@/app/dashboard/components/AgenticWalletStakeSection";
import { AgenticWalletBridgeModal } from "@/app/dashboard/components/AgenticWalletBridgeModal";
import { useDashboardIdentity } from "../identity-context";

export interface TreasuryViewProps {
  /** Connected owner address (null until wallet connects). */
  ownerAddress: string | null;
  /** Wallet signer — needed to auth gas-tank/yield/bridge reads. */
  signMessage: (message: string) => Promise<string | null>;
  /** Active scope — gates which chains' treasury rows are shown. */
  scope: Scope;
}

// ── Chain config (mirrors page.tsx CHAIN_META — same 11-chain set) ───────────
interface ChainMeta {
  key: string;
  name: string;
  token: string;
  color: string;
  /** Whether the in-app "Top up with wallet" path is supported (native send). */
  depositable: boolean;
}

const CHAIN_META: ChainMeta[] = [
  { key: "bnb",       name: "BNB Chain",  token: "BNB",   color: "#F0B90B", depositable: true },
  { key: "eth",       name: "Ethereum",   token: "ETH",   color: "#627EEA", depositable: true },
  { key: "avax",      name: "Avalanche",  token: "AVAX",  color: "#E84142", depositable: true },
  { key: "xlayer",    name: "X Layer",    token: "OKB",   color: "#A0A0A0", depositable: true },
  { key: "stable",    name: "Stable",     token: "USDT0", color: "#7d8aa0", depositable: true },
  { key: "mantle",    name: "Mantle",     token: "MNT",   color: "#bcbcbc", depositable: true },
  { key: "injective", name: "Injective",  token: "INJ",   color: "#0082FA", depositable: true },
  { key: "monad",     name: "Monad",      token: "MON",   color: "#836EF9", depositable: true },
  { key: "scroll",    name: "Scroll",     token: "ETH",   color: "#EEB431", depositable: true },
  { key: "arbitrum",  name: "Arbitrum",   token: "ETH",   color: "#28A0F0", depositable: true },
  { key: "base",      name: "Base",       token: "ETH",   color: "#0052FF", depositable: true },
];

// Chains a trial-scoped account can transact on (BNB-only, mirroring the
// rest of the dashboard's trial gating). Multichain unlocks all 11.
const TRIAL_CHAINS = new Set(["bnb"]);

const LINK_CHAINS = ["eth", "avax", "arbitrum"] as const;
type LinkChain = (typeof LINK_CHAINS)[number];
const LINK_TOKEN: Record<LinkChain, { address: string; label: string }> = {
  eth:      { address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", label: "Ethereum" },
  avax:     { address: "0x5947BB275c521040051D82396192181b413227A3", label: "Avalanche" },
  arbitrum: { address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", label: "Arbitrum" },
};
const LINK_USD = 12; // rough $/LINK, matches BridgeModal + v1 dashboard

// Minimal mirror of AgenticWalletPublic (the fields Treasury needs from the
// wallet list to drive the embedded Earn section + Bridge modal). Importing
// the full type pulls the whole AgenticWalletTab module; this keeps the
// surface small and the bundle lean while staying drift-checked at compile
// time against the endpoint's documented shape.
interface AgenticWalletLite {
  address: string;
  walletId: string;
  label: string | null;
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── DEMO dataset ─────────────────────────────────────────────────────────────
//
// Rendered when NO wallet is connected (or live data hasn't landed yet) so the
// Treasury view reads as a complete, populated surface at first glance instead
// of a "connect a wallet" empty state. The numbers are realistic placeholders;
// the moment a wallet connects + real reads resolve, the live data path takes
// over (see `demoMode` below) and these are never shown.
//
// Top-card totals are kept internally consistent: the per-row Gas Tank USD
// figures ($8.14 + $7.82 + $2.46) sum to the Gas Tank card total ($18.42).
const DEMO = {
  gasTankUsd: 18.42,
  /** Yield card meta — Q402 Yield is $0.00 with the best available APY shown. */
  yieldUsd: 0,
  yieldApy: "4.12%",
  /** Bridge card — 3 LINK fee lanes, no live LINK balance. */
  bridgeLanes: 3,
  bridgeLaneLabels: ["Ethereum", "Avalanche", "Arbitrum"] as const,
  /** Per-network rows: USD-denominated wallet (native gas) + Gas Tank. */
  rows: {
    bnb:      { walletUsd: 184.2, gasTankUsd: 8.14 },
    eth:      { walletUsd: 75.0,  gasTankUsd: 7.82 },
    arbitrum: { walletUsd: 40.8,  gasTankUsd: 2.46 },
  } as Record<string, { walletUsd: number; gasTankUsd: number }>,
} as const;
const DEMO_ROW_KEYS = ["bnb", "eth", "arbitrum"] as const;

// Sample Gas Tank activity for the demo surface so the "Tank activity" feed
// reads as populated rather than empty when no wallet is connected.
const DEMO_ACTIVITY: Array<{ chain: string; amount: number; date: string }> = [
  { chain: "bnb", amount: 0.25, date: "Jun 9" },
  { chain: "eth", amount: 0.02, date: "Jun 6" },
  { chain: "arbitrum", amount: 0.015, date: "Jun 2" },
];

// ── Context sub-nav (scroll-spy) ─────────────────────────────────────────────
const SECTIONS = [
  { id: "overview", label: "Capital overview", hint: "Stablecoins · yield · gas" },
  { id: "gastank",  label: "Gas Tank",         hint: "Relayer gas across chains" },
  { id: "yield",    label: "Q402 Yield",       hint: "Earn on idle stablecoins" },
  { id: "bridge",   label: "CCIP Bridge",      hint: "Cross-chain via Chainlink" },
  { id: "deposits", label: "Deposits",         hint: "Top up per network" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

export function TreasuryView({ ownerAddress, signMessage, scope }: TreasuryViewProps) {
  const identity = useDashboardIdentity();
  const isMultichain = scope === "multichain";

  // ── Gas Tank state (mirrors page.tsx) ──────────────────────────────────
  const [userGasBalance, setUserGasBalance] = useState<Record<string, number>>({});
  const [gasDeposits, setGasDeposits] = useState<
    Array<{ chain: string; token: string; amount: number; txHash: string; depositedAt: string }>
  >([]);
  const [linkBalances, setLinkBalances] = useState<Record<LinkChain, number>>({
    eth: 0, avax: 0, arbitrum: 0,
  });
  const [tokenPrices, setTokenPrices] = useState<Record<string, number>>({});
  const [walletBalances, setWalletBalances] = useState<Record<string, number>>({});
  const [tankLoading, setTankLoading] = useState(true);

  // Active Agent Wallet — fuels the embedded Earn section + Bridge modal.
  const [agentWallet, setAgentWallet] = useState<AgenticWalletLite | null>(null);
  const [hasMultichainScopeSrv, setHasMultichainScopeSrv] = useState(false);

  // Modals
  const [depositChain, setDepositChain] = useState<ChainMeta | null>(null);
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [bridgeOpen, setBridgeOpen] = useState(false);

  const [activeSection, setActiveSection] = useState<SectionId>("overview");

  // ── Fetch: gas-tank user balance (auth'd, reuses session sig) ──────────
  const refreshUserBalance = useCallback(
    async (addr: string) => {
      const auth = await getAuthCreds(addr, signMessage);
      if (!auth) return;
      const qs = new URLSearchParams({ address: addr, nonce: auth.nonce, sig: auth.signature }).toString();
      try {
        const res = await fetch(`/api/gas-tank/user-balance?${qs}`);
        const data = await res.json();
        if (res.status === 401 && data.code === "NONCE_EXPIRED") {
          clearAuthCache(addr);
          return;
        }
        if (data.balances) setUserGasBalance(data.balances);
        if (data.deposits) setGasDeposits(data.deposits);
        if (data.linkBalances) setLinkBalances(data.linkBalances);
      } catch {
        /* ignore — UI renders zeros */
      }
    },
    [signMessage],
  );

  // ── Fetch: prices (public) ─────────────────────────────────────────────
  // tankLoading already initialises to `true`, so this once-on-mount effect
  // doesn't re-set it synchronously (which would trip a cascading-render
  // lint); it only flips it off in .finally once prices land.
  useEffect(() => {
    fetch("/api/gas-tank")
      .then((r) => r.json())
      .then((data) => {
        if (data.tanks) {
          const prices: Record<string, number> = {};
          for (const t of data.tanks) prices[t.key] = t.price;
          setTokenPrices(prices);
        }
      })
      .catch(() => {})
      .finally(() => setTankLoading(false));
  }, []);

  // ── Fetch: balances + EOA holdings + agent wallet on connect ───────────
  // All three reads are deferred into async closures so no setState runs
  // synchronously in the effect body (avoids the cascading-render lint).
  useEffect(() => {
    if (!ownerAddress) return;
    const addr = ownerAddress;
    let cancelled = false;

    void (async () => {
      // Awaited boundary keeps the gas-balance setState off the synchronous
      // effect path (refreshUserBalance only setStates after its own awaits).
      await refreshUserBalance(addr);
    })();

    void (async () => {
      try {
        const res = await fetch(`/api/wallet-balance?address=${addr}`);
        const data = await res.json();
        if (!cancelled && data.balances) setWalletBalances(data.balances);
      } catch {
        /* ignore */
      }
    })();

    // Agent Wallet list — pick the first wallet for Earn/Bridge wiring.
    void (async () => {
      const auth = await getAuthCreds(addr, signMessage);
      if (!auth) return;
      const qs = new URLSearchParams({ address: addr, nonce: auth.nonce, sig: auth.signature }).toString();
      try {
        const res = await fetch(`/api/wallet/agentic?${qs}`);
        const data = await res.json();
        if (res.status === 401 && data.code === "NONCE_EXPIRED") {
          clearAuthCache(addr);
          return;
        }
        if (cancelled) return;
        if (typeof data.hasMultichainScope === "boolean") {
          setHasMultichainScopeSrv(data.hasMultichainScope);
        }
        // Prefer the first NON-archived wallet (the endpoint also returns
        // soft-deleted ones); fall back to index 0 only if all are archived, so
        // Treasury Yield/Bridge never default to a deleted wallet.
        const first = Array.isArray(data.wallets)
          ? (data.wallets.find((w: { deletedAt?: number | null }) => !w.deletedAt) ?? data.wallets[0])
          : null;
        if (first && typeof first.walletId === "string") {
          setAgentWallet({
            address: first.address,
            walletId: first.walletId,
            label: first.label ?? null,
          });
        }
      } catch {
        /* ignore */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ownerAddress, signMessage, refreshUserBalance]);

  // ── Scroll-spy for the context rail ────────────────────────────────────
  const mainRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = mainRef.current;
    if (!root) return;
    const targets = SECTIONS.map((s) => root.querySelector<HTMLElement>(`#treasury-${s.id}`)).filter(
      (el): el is HTMLElement => el != null,
    );
    if (targets.length === 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) {
          const id = visible.target.id.replace("treasury-", "") as SectionId;
          setActiveSection(id);
        }
      },
      { root: null, rootMargin: "-80px 0px -55% 0px", threshold: [0, 0.25, 0.5, 1] },
    );
    targets.forEach((t) => obs.observe(t));
    return () => obs.disconnect();
  }, [ownerAddress]);

  function scrollTo(id: SectionId) {
    const el = document.getElementById(`treasury-${id}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveSection(id);
  }

  // ── Derived totals ─────────────────────────────────────────────────────
  const totalGasUsd = useMemo(
    () =>
      Object.entries(userGasBalance).reduce(
        (sum, [c, amt]) => sum + amt * (tokenPrices[c] ?? 0),
        0,
      ),
    [userGasBalance, tokenPrices],
  );
  const totalLink = (linkBalances.eth ?? 0) + (linkBalances.avax ?? 0) + (linkBalances.arbitrum ?? 0);
  const linkUsd = totalLink * LINK_USD;
  const fundedChainCount = useMemo(
    () => CHAIN_META.filter((c) => (userGasBalance[c.key] ?? 0) > 0).length,
    [userGasBalance],
  );

  const visibleChains = useMemo(
    () => (isMultichain ? CHAIN_META : CHAIN_META.filter((c) => TRIAL_CHAINS.has(c.key))),
    [isMultichain],
  );

  // ── Demo mode ──────────────────────────────────────────────────────────
  // Show the fully-populated DEMO surface ONLY when NO wallet is connected — a
  // marketing preview for logged-out visitors. A CONNECTED wallet, even one
  // with an empty gas tank / no balances yet, renders its REAL state (zeros,
  // loading spinner) so a fresh-wallet visitor can never mistake fabricated
  // sample numbers for live balances. (Previously a connected-but-empty wallet
  // also fell into demo mode and surfaced placeholder figures.)
  const demoMode = !ownerAddress;

  // Card + table values, sourced from DEMO when in demo mode so the existing
  // layout populates without any "connect" placeholder branch.
  const gasTankUsdDisplay = demoMode ? DEMO.gasTankUsd : totalGasUsd;
  const totalLinkDisplay = demoMode ? 0 : totalLink;
  const linkUsdDisplay = demoMode ? 0 : linkUsd;
  const fundedCountDisplay = demoMode ? DEMO_ROW_KEYS.length : fundedChainCount;
  const networkCountDisplay = demoMode ? DEMO_ROW_KEYS.length : visibleChains.length;

  // Per-network rows: in demo mode use the DEMO row set; otherwise the live
  // scope-gated chain list. `demo` carries USD figures; `live` reads the same
  // balance/price/EOA state as before.
  const tableRows = useMemo(() => {
    if (demoMode) {
      return DEMO_ROW_KEYS.map((key) => {
        const meta = CHAIN_META.find((c) => c.key === key)!;
        return { meta, demo: DEMO.rows[key] };
      });
    }
    return visibleChains.map((meta) => ({ meta, demo: null as null | { walletUsd: number; gasTankUsd: number } }));
  }, [demoMode, visibleChains]);

  // In demo mode the deposit/manage actions are inert (no wallet to sign with):
  // disable them and show a "Connect your wallet" hint rather than opening a
  // modal that would crash on a null owner.
  const actionsDisabled = demoMode;
  const connectHint = "Connect your wallet";

  return (
    <V2AccentScope style={{ paddingTop: 17 }}>
      <div
        className="treasury-wide-view v2-view-shell"
        style={{
          display: "grid",
          gridTemplateColumns: "230px minmax(0, 1fr)",
          gap: 18,
          alignItems: "start",
        }}
      >
        {/* ── Col 1 · context rail ─────────────────────────────────────── */}
        <Surface className="v2-context" style={{ padding: 15, position: "sticky", top: 84 }}>
          <Eyebrow style={{ marginBottom: 11, paddingLeft: 3, fontSize: fs.label }}>Capital</Eyebrow>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {SECTIONS.map((s) => {
              const on = s.id === activeSection;
              return (
                <button
                  key={s.id}
                  type="button"
                  className="v2-trans"
                  onClick={() => scrollTo(s.id)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    border: on ? `1px solid ${v2.line}` : "1px solid transparent",
                    background: on ? "rgba(247,202,22,.07)" : "transparent",
                    borderRadius: 10,
                    padding: "10px 13px",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontSize: fs.body, fontWeight: on ? 700 : 500, color: on ? v2.yellow : v2.text }}>
                    {s.label}
                  </div>
                  <div style={{ fontSize: fs.label, color: v2.muted2, marginTop: 2 }}>{s.hint}</div>
                </button>
              );
            })}
          </div>

          <div
            style={{
              ...subCard(11),
              marginTop: 15,
              padding: 13,
            }}
          >
            <Eyebrow style={{ marginBottom: 5, fontSize: fs.label }}>Custody</Eyebrow>
            <div style={{ color: v2.text, fontSize: fs.body, fontWeight: 600 }}>Cold Gas Tank</div>
            <div style={{ color: v2.muted2, fontSize: fs.micro, marginTop: 4, lineHeight: 1.55 }}>
              Deposits sit in a cold wallet; the hot relayer sponsors gas on every
              settlement.
            </div>
          </div>
        </Surface>

        {/* ── Col 2 · view-main ────────────────────────────────────────── */}
        <div ref={mainRef} style={{ minWidth: 0 }}>
          {/* Title */}
          <div id="treasury-overview" style={{ scrollMarginTop: 84 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ font: `600 ${fs.h2}px ${displayFont}`, letterSpacing: "-.04em" }}>
                Capital operations
              </div>
              <ScopeChipBadge isMultichain={isMultichain} />
              {demoMode && <PreviewChip />}
            </div>
            <div style={{ color: v2.muted, fontSize: fs.body, marginTop: 6, marginBottom: 18 }}>
              Gas Tank, Q402 Yield, and CCIP liquidity across{" "}
              {isMultichain ? "11 networks" : "BNB Chain (trial)"}.
              {demoMode && " Sample figures shown — connect a wallet to load live balances."}
            </div>
          </div>

          {/* ── treasury-grid (3 cards) ────────────────────────────────── */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 15,
              marginBottom: 19,
            }}
          >
            {/* Gas Tank card */}
            <Surface radius={15} style={{ padding: 19, scrollMarginTop: 84 }}>
              <div id="treasury-gastank" style={{ scrollMarginTop: 84 }}>
                <Eyebrow
                  style={{
                    fontSize: fs.label,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <GasTankIcon size={14} color={v2.yellow} />
                  Gas Tank
                </Eyebrow>
                <div
                  style={{
                    font: `600 ${fs.hero}px ${displayFont}`,
                    color: v2.yellow,
                    letterSpacing: "-.04em",
                    marginTop: 10,
                  }}
                >
                  {tankLoading && !demoMode ? (
                    <span style={{ color: v2.muted2, fontSize: fs.h2 }}>Loading…</span>
                  ) : (
                    fmtUsd(gasTankUsdDisplay)
                  )}
                </div>
                <div style={{ color: v2.muted, fontSize: fs.body, marginTop: 6 }}>
                  {demoMode ? "Healthy across active chains." : "Sponsors gas on relayed payments."}
                </div>
                {/* health bar — funded vs total chains */}
                <div
                  style={{
                    height: 5,
                    borderRadius: 3,
                    background: v2.ringTrack,
                    marginTop: 15,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${networkCountDisplay > 0 ? (fundedCountDisplay / networkCountDisplay) * 100 : 0}%`,
                      background: v2.yellow,
                      borderRadius: 3,
                      transition: "width .4s",
                    }}
                  />
                </div>
                <div style={{ color: v2.muted2, fontSize: fs.micro, marginTop: 7 }}>
                  {fundedCountDisplay} / {networkCountDisplay} networks funded
                </div>
                <button
                  type="button"
                  onClick={() => scrollTo("deposits")}
                  style={{
                    marginTop: 15,
                    width: "100%",
                    border: `1px solid var(--v2-accent-line)`,
                    background: "var(--v2-accent-fill)",
                    color: v2.yellow,
                    padding: "10px 0",
                    borderRadius: 9,
                    fontSize: fs.body,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Manage deposits
                </button>
              </div>
            </Surface>

            {/* Q402 Yield card */}
            <Surface radius={15} style={{ padding: 19 }}>
              <div id="treasury-yield" style={{ scrollMarginTop: 84 }}>
                {/* The embedded EarnSection renders its OWN "Q402 Yield / Aave V3"
                    header (with the supplied total), so only show this card-level
                    SectionHead when EarnSection is NOT mounted (demo / no wallet) —
                    otherwise the header doubles up. */}
                {!(ownerAddress && agentWallet) && (
                  <SectionHead
                    title={
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <Q402Mark size={20} />
                        Q402 Yield
                      </span>
                    }
                    meta={
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: v2.mint }}>
                        <TokenIcon src="/aave.svg" size={15} />
                        <TokenIcon src="/logos/morpho.png" size={15} />
                        Aave V3 · Morpho{demoMode ? ` · best ${DEMO.yieldApy} APY` : ""}
                      </span>
                    }
                  />
                )}
                {ownerAddress && agentWallet ? (
                  // Earn (yield) + Q staking share the card; both own their actions.
                  // Mounted inside V2AccentScope so emerald re-skins to gold.
                  <>
                    <AgenticWalletEarnSection
                      ownerAddress={ownerAddress}
                      walletId={agentWallet.walletId}
                      signMessage={signMessage}
                      canDeposit={identity.hasPaid === true}
                    />
                    <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "16px 0" }} />
                    <AgenticWalletStakeSection
                      ownerAddress={ownerAddress}
                      walletId={agentWallet.walletId}
                      signMessage={signMessage}
                    />
                  </>
                ) : demoMode ? (
                  // Demo: show a populated, $0.00 supplied position with the best
                  // available APY so the card reads complete without a wallet.
                  <>
                    <div
                      style={{
                        font: `600 ${fs.hero}px ${displayFont}`,
                        color: v2.mint,
                        letterSpacing: "-.04em",
                        marginTop: 10,
                      }}
                    >
                      {fmtUsd(DEMO.yieldUsd)}
                    </div>
                    <div style={{ color: v2.muted, fontSize: fs.body, marginTop: 6 }}>
                      Supplied to Aave V3 · best {DEMO.yieldApy} APY
                    </div>
                    <div
                      title={connectHint}
                      style={{
                        marginTop: 15,
                        width: "100%",
                        textAlign: "center",
                        border: `1px solid ${v2.line}`,
                        background: "rgba(255,255,255,.03)",
                        color: v2.muted2,
                        padding: "10px 0",
                        borderRadius: 9,
                        fontSize: fs.body,
                        fontWeight: 600,
                        cursor: "not-allowed",
                      }}
                    >
                      Supply USDC / USDT
                    </div>
                  </>
                ) : (
                  <div style={{ color: v2.muted, fontSize: fs.body, lineHeight: 1.6, marginTop: 10 }}>
                    Create an Agent Wallet to supply idle USDC / USDT and earn Aave V3 yield.
                  </div>
                )}
              </div>
            </Surface>

            {/* CCIP Bridge card */}
            <Surface radius={15} style={{ padding: 19 }}>
              <div id="treasury-bridge" style={{ scrollMarginTop: 84 }}>
                <Eyebrow style={{ fontSize: fs.label }}>CCIP Bridge</Eyebrow>
                {demoMode ? (
                  <div
                    style={{
                      font: `600 ${fs.hero}px ${displayFont}`,
                      color: v2.cyan,
                      letterSpacing: "-.04em",
                      marginTop: 10,
                    }}
                  >
                    {DEMO.bridgeLanes}
                    <span style={{ fontSize: fs.cardTitle, color: v2.muted, marginLeft: 6, fontWeight: 400 }}>
                      lanes
                    </span>
                  </div>
                ) : (
                  <div
                    style={{
                      font: `600 ${fs.hero}px ${displayFont}`,
                      color: v2.cyan,
                      letterSpacing: "-.04em",
                      marginTop: 10,
                    }}
                  >
                    {totalLinkDisplay.toLocaleString("en-US", { maximumFractionDigits: 4 })}
                    <span style={{ fontSize: fs.cardTitle, color: v2.muted, marginLeft: 6, fontWeight: 400 }}>
                      LINK
                    </span>
                  </div>
                )}
                <div style={{ color: v2.muted, fontSize: fs.body, marginTop: 6 }}>
                  {demoMode
                    ? `${DEMO.bridgeLaneLabels.join(" · ")}`
                    : `${fmtUsd(linkUsdDisplay)} · fee bucket for 3 lanes (eth · avax · arbitrum)`}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 13 }}>
                  {LINK_CHAINS.map((k) => (
                    <div
                      key={k}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: fs.body,
                        color: v2.muted,
                      }}
                    >
                      <span>{LINK_TOKEN[k].label}</span>
                      <span style={{ font: `500 ${fs.body}px ${displayFont}`, color: demoMode ? v2.muted : v2.text }}>
                        {demoMode ? "Ready" : `${(linkBalances[k] ?? 0).toFixed(4)} LINK`}
                      </span>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 15 }}>
                  <button
                    type="button"
                    disabled={actionsDisabled}
                    onClick={() => setLinkModalOpen(true)}
                    title={actionsDisabled ? connectHint : undefined}
                    style={{
                      flex: 1,
                      border: `1px solid ${v2.line}`,
                      background: "rgba(255,255,255,.03)",
                      color: actionsDisabled ? v2.muted2 : v2.text,
                      padding: "10px 0",
                      borderRadius: 9,
                      fontSize: fs.body,
                      fontWeight: 600,
                      cursor: actionsDisabled ? "not-allowed" : "pointer",
                    }}
                  >
                    Deposit LINK
                  </button>
                  <button
                    type="button"
                    disabled={actionsDisabled || !isMultichain || !ownerAddress || !agentWallet}
                    onClick={() => setBridgeOpen(true)}
                    title={
                      actionsDisabled
                        ? connectHint
                        : !isMultichain
                          ? "Cross-chain bridging needs the Multichain scope"
                          : !agentWallet
                            ? "Create an Agent Wallet to bridge"
                            : undefined
                    }
                    style={{
                      flex: 1,
                      border: 0,
                      background:
                        !actionsDisabled && isMultichain && agentWallet ? v2.yellow : "rgba(255,255,255,.05)",
                      color:
                        !actionsDisabled && isMultichain && agentWallet ? v2.actionText : v2.muted2,
                      padding: "10px 0",
                      borderRadius: 9,
                      fontSize: fs.body,
                      fontWeight: 700,
                      cursor:
                        !actionsDisabled && isMultichain && agentWallet ? "pointer" : "not-allowed",
                    }}
                  >
                    Open bridge
                  </button>
                </div>
              </div>
            </Surface>
          </div>

          {/* ── Per-network table ──────────────────────────────────────── */}
          <Surface radius={15} style={{ overflow: "hidden" }}>
            <div id="treasury-deposits" style={{ scrollMarginTop: 84 }}>
              <div style={{ padding: "19px 19px 13px" }}>
                <SectionHead
                  title="Networks"
                  meta={
                    demoMode
                      ? `${DEMO_ROW_KEYS.length} active networks · sample data`
                      : isMultichain
                        ? `${CHAIN_META.length} networks · deposit to fund gas`
                        : "Trial · BNB Chain only"
                  }
                />
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: fs.base }}>
                <thead>
                  <tr style={{ color: v2.muted2 }}>
                    <Th style={{ paddingLeft: 17 }}>Network</Th>
                    <Th>Wallet (native gas)</Th>
                    <Th>Gas Tank</Th>
                    <Th>State</Th>
                    <Th style={{ textAlign: "right", paddingRight: 17 }}>Manage</Th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map(({ meta: c, demo }) => {
                    // Demo rows carry USD figures directly; live rows compute the
                    // same way as before from balance/price/EOA state.
                    const gas = demo ? 0 : userGasBalance[c.key] ?? 0;
                    const liveGasUsd = gas * (tokenPrices[c.key] ?? 0);
                    const gasTankUsd = demo ? demo.gasTankUsd : liveGasUsd;
                    const eoa = demo ? 0 : walletBalances[c.key] ?? 0;
                    const walletUsd = demo ? demo.walletUsd : eoa;
                    // "Ready" in demo mode (state column), FUNDED/EMPTY when live.
                    const funded = demo ? true : gas > 0;
                    const explorerKey = c.key as Parameters<typeof explorerAddressUrl>[0];
                    return (
                      <tr
                        key={c.key}
                        style={{ borderTop: `1px solid ${v2.line}` }}
                      >
                        <Td style={{ paddingLeft: 17 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                            <ChainIcon chain={c.key} size={18} color={c.color} />
                            <a
                              href={explorerAddressUrl(explorerKey, GASTANK_ADDRESS)}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: v2.text, textDecoration: "none" }}
                              title={`View Gas Tank on ${explorerLabel(explorerKey)}`}
                            >
                              {c.name}
                            </a>
                            <span style={{ color: v2.muted2, fontSize: fs.label }}>{c.token}</span>
                          </div>
                        </Td>
                        <Td>
                          {demo ? (
                            <span style={{ font: `400 ${fs.base}px ${displayFont}`, color: v2.text }}>
                              {fmtUsd(walletUsd)}
                            </span>
                          ) : (
                            <span style={{ font: `400 ${fs.base}px ${displayFont}`, color: eoa > 0 ? v2.text : v2.muted2 }}>
                              {eoa > 0 ? `${eoa.toFixed(4)} ${c.token}` : "—"}
                            </span>
                          )}
                        </Td>
                        <Td>
                          {demo ? (
                            <span style={{ font: `400 ${fs.base}px ${displayFont}`, color: v2.text }}>
                              {fmtUsd(gasTankUsd)}
                            </span>
                          ) : (
                            <>
                              <span style={{ font: `400 ${fs.base}px ${displayFont}`, color: funded ? v2.text : v2.muted2 }}>
                                {gas.toFixed(4)} {c.token}
                              </span>
                              <span style={{ color: v2.muted2, fontSize: fs.label, marginLeft: 6 }}>
                                {gasTankUsd >= 0.01 ? fmtUsd(gasTankUsd) : ""}
                              </span>
                            </>
                          )}
                        </Td>
                        <Td>
                          <span
                            style={{
                              fontSize: fs.label,
                              fontWeight: 700,
                              letterSpacing: ".04em",
                              padding: "4px 8px",
                              borderRadius: 6,
                              color: funded ? v2.yellow : v2.muted2,
                              border: funded
                                ? "1px solid rgba(247,202,22,.30)"
                                : "1px solid transparent",
                              background: funded ? "rgba(247,202,22,.08)" : "rgba(255,255,255,.04)",
                            }}
                          >
                            {demo ? "READY" : funded ? "FUNDED" : "EMPTY"}
                          </span>
                        </Td>
                        <Td style={{ textAlign: "right", paddingRight: 17 }}>
                          <button
                            type="button"
                            onClick={() => {
                              if (!actionsDisabled) setDepositChain(c);
                            }}
                            disabled={actionsDisabled}
                            title={actionsDisabled ? connectHint : undefined}
                            style={{
                              border: `1px solid ${funded && !actionsDisabled ? "var(--v2-accent-line)" : v2.line}`,
                              background:
                                funded && !actionsDisabled ? "var(--v2-accent-fill)" : "rgba(255,255,255,.03)",
                              color: funded && !actionsDisabled ? v2.yellow : v2.muted,
                              padding: "7px 13px",
                              borderRadius: 8,
                              fontSize: fs.body,
                              fontWeight: 600,
                              cursor: actionsDisabled ? "not-allowed" : "pointer",
                              opacity: actionsDisabled ? 0.5 : 1,
                            }}
                          >
                            {actionsDisabled ? "Deposit" : funded ? "Top up" : "Deposit"}
                          </button>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Tank activity (deposit history) */}
              <div style={{ padding: "15px 19px", borderTop: `1px solid ${v2.line}` }}>
                <Eyebrow style={{ marginBottom: 11, fontSize: fs.label }}>Tank activity</Eyebrow>
                {demoMode ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {DEMO_ACTIVITY.map((d, i) => {
                      const meta = CHAIN_META.find((c) => c.key === d.chain);
                      return (
                        <div
                          key={`demo-${i}`}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            fontSize: fs.body,
                          }}
                        >
                          <span style={{ color: v2.muted }}>
                            Deposit · {meta?.name ?? d.chain} · {d.date}
                          </span>
                          <span style={{ font: `500 ${fs.body}px ${displayFont}`, color: v2.mint }}>
                            +{d.amount.toFixed(4)} {meta?.token ?? d.chain.toUpperCase()}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : gasDeposits.length === 0 ? (
                  <div style={{ color: v2.muted2, fontSize: fs.body, textAlign: "center", padding: "12px 0" }}>
                    No deposits yet
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {[...gasDeposits].reverse().slice(0, 8).map((d, i) => {
                      const isWithdrawal = d.amount < 0;
                      const meta = CHAIN_META.find((c) => c.key === d.chain);
                      return (
                        <div
                          key={`${d.txHash}-${i}`}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            fontSize: fs.body,
                          }}
                        >
                          <span style={{ color: v2.muted }}>
                            {isWithdrawal ? "Withdrawal" : "Deposit"} ·{" "}
                            {meta?.name ?? d.chain} ·{" "}
                            {new Date(d.depositedAt).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                            })}
                          </span>
                          <span
                            style={{
                              font: `500 ${fs.body}px ${displayFont}`,
                              color: isWithdrawal ? v2.red : v2.mint,
                            }}
                          >
                            {isWithdrawal ? "-" : "+"}
                            {Math.abs(d.amount).toFixed(4)} {d.token}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </Surface>
        </div>
      </div>

      {/* ── Modals ───────────────────────────────────────────────────────── */}
      {depositChain && ownerAddress && (
        <V2DepositModal
          chain={depositChain}
          address={ownerAddress}
          onClose={() => setDepositChain(null)}
          onVerified={(balances) => {
            setUserGasBalance(balances);
            setDepositChain(null);
          }}
        />
      )}

      {linkModalOpen && (
        <V2LinkDepositModal
          balances={linkBalances}
          onClose={() => setLinkModalOpen(false)}
        />
      )}

      {bridgeOpen && ownerAddress && agentWallet && (
        <AgenticWalletBridgeModal
          walletAddress={agentWallet.address}
          walletId={agentWallet.walletId}
          ownerAddress={ownerAddress}
          signMessage={signMessage}
          hasMultichainScope={isMultichain && hasMultichainScopeSrv}
          onClose={() => setBridgeOpen(false)}
          onSent={() => {
            setBridgeOpen(false);
            if (ownerAddress) refreshUserBalance(ownerAddress);
          }}
        />
      )}
    </V2AccentScope>
  );
}

// ── Title-area chips ─────────────────────────────────────────────────────────
/** Shown only in demo mode, beside the view title — signals example data.
 *  Mirrors the shared PreviewChip pattern used by Wallets/Activity views. */
function PreviewChip() {
  return (
    <span
      title="Sample data — connect your wallet to load live balances"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: fs.label,
        fontWeight: 700,
        letterSpacing: ".02em",
        color: v2.yellow,
        background: "rgba(247,202,22,.10)",
        border: "1px solid rgba(247,202,22,.30)",
        padding: "5px 10px",
        borderRadius: 999,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden style={{ width: 5, height: 5, borderRadius: 999, background: v2.yellow }} />
      Preview · connect your wallet for live data
    </span>
  );
}

/** Active scope badge beside the title — Multichain · 11 chains / Trial · BNB,
 *  matching the WalletsView hero scope badge. */
function ScopeChipBadge({ isMultichain }: { isMultichain: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: fs.label,
        fontWeight: 600,
        letterSpacing: ".02em",
        color: v2.muted,
        background: "rgba(255,255,255,.04)",
        border: `1px solid ${v2.line}`,
        padding: "5px 10px",
        borderRadius: 999,
        whiteSpace: "nowrap",
      }}
    >
      {isMultichain ? "Multichain · 11 chains" : "Trial · BNB"}
    </span>
  );
}

// ── Table cells ──────────────────────────────────────────────────────────────
function Th({ children, style }: { children: React.ReactNode; style?: CSSProperties }) {
  return (
    <th
      style={{
        textAlign: "left",
        fontWeight: 600,
        fontSize: fs.label,
        letterSpacing: ".1em",
        textTransform: "uppercase",
        padding: "0 13px 12px",
        ...style,
      }}
    >
      {children}
    </th>
  );
}
function Td({ children, style }: { children: React.ReactNode; style?: CSSProperties }) {
  return <td style={{ padding: "14px 13px", verticalAlign: "middle", ...style }}>{children}</td>;
}

// ── V2DepositModal ───────────────────────────────────────────────────────────
//
// v2-skinned native gas deposit. REUSES the exact wallet primitives +
// verify-deposit endpoint the v1 DepositModal uses (sendNativeTransfer →
// waitForWalletReceipt → POST /api/gas-tank/verify-deposit with RPC-lag
// retry). Only the chrome is re-laid-out for v2; the settlement logic is
// identical.
function V2DepositModal({
  chain,
  address,
  onClose,
  onVerified,
}: {
  chain: ChainMeta;
  address: string;
  onClose: () => void;
  onVerified: (balances: Record<string, number>) => void;
}) {
  const [phase, setPhase] = useState<
    "main" | "awaiting_wallet" | "confirming_tx" | "checking" | "done" | "error"
  >("main");
  const [amount, setAmount] = useState("");
  const [err, setErr] = useState("");
  const [verified, setVerified] = useState<Record<string, number>>({});

  async function creditByTxHashWithRetry(txHash: string, attempts = 8) {
    let lastError = "Payment submitted, but we could not credit it yet.";
    for (let i = 0; i < attempts; i++) {
      const res = await fetch("/api/gas-tank/verify-deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, txHash, chain: chain.key }),
      });
      const data = await res.json();
      if (res.ok && (data.newDeposits > 0 || data.alreadyCredited)) return data;
      lastError = data.error ?? lastError;
      const retryable = res.status === 404 && /not found|not yet confirmed/i.test(lastError);
      if (!retryable || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 2500 + i * 1000));
    }
    throw new Error(lastError);
  }

  async function topUp() {
    const amt = amount.trim();
    if (!/^(?:\d+|\d*\.\d+)$/.test(amt) || Number(amt) <= 0) {
      setErr(`Enter an amount of ${chain.token} to deposit.`);
      return;
    }
    setErr("");
    try {
      setPhase("awaiting_wallet");
      const txHash = await sendNativeTransfer({
        chain: chain.key as WalletChainKey,
        from: address,
        to: GASTANK_ADDRESS,
        amount: amt,
      });
      setPhase("confirming_tx");
      await waitForWalletReceipt(chain.key as WalletChainKey, txHash);
      setPhase("checking");
      const data = await creditByTxHashWithRetry(txHash);
      setVerified(data.balances ?? {});
      setPhase("done");
      onVerified(data.balances ?? {});
    } catch (e) {
      setErr(e instanceof Error ? e.message : walletErrorMessage(e));
      setPhase("error");
    }
  }

  return <ModalShell title={`${chain.token} · ${chain.name}`} onClose={onClose}>
    {phase === "main" && (
      <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        <div style={{ color: v2.muted, fontSize: fs.body }}>
          Top up the Gas Tank with <span style={{ color: v2.yellow }}>{chain.token}</span>.
        </div>
        <div>
          <Eyebrow style={{ marginBottom: 7, fontSize: fs.label }}>Amount to deposit</Eyebrow>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={`0.10 ${chain.token}`}
              style={{
                flex: 1,
                minWidth: 0,
                background: v2.inputFill,
                border: `1px solid ${v2.line}`,
                borderRadius: 10,
                padding: "12px 13px",
                color: v2.text,
                font: `500 ${fs.cardTitle}px ${displayFont}`,
                outline: "none",
              }}
            />
            <span style={{ color: v2.muted, fontSize: fs.body, fontWeight: 600, width: 52, textAlign: "right" }}>
              {chain.token}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={topUp}
          disabled={!amount.trim()}
          style={{
            border: 0,
            background: v2.yellow,
            color: v2.actionText,
            padding: "13px 0",
            borderRadius: 11,
            fontWeight: 700,
            fontSize: fs.cardTitle,
            cursor: amount.trim() ? "pointer" : "not-allowed",
            opacity: amount.trim() ? 1 : 0.4,
          }}
        >
          Top up with wallet
        </button>
        <div style={{ color: v2.muted2, fontSize: fs.micro, lineHeight: 1.55 }}>
          Switches to {chain.name}, sends {chain.token}, credits your Gas Tank on
          confirmation. {chain.key === "stable" && "Send USDT0 on Stable (chain 988) — not ETH/BNB/AVAX."}
        </div>
        <div style={{ borderTop: `1px solid ${v2.line}`, paddingTop: 12 }}>
          <div style={{ color: v2.muted2, fontSize: fs.micro, lineHeight: 1.55 }}>
            Gas Tank withdrawals are processed manually by Q402 operations. Contact{" "}
            business@quackai.ai to request a refund.
          </div>
        </div>
      </div>
    )}

    {(phase === "awaiting_wallet" || phase === "confirming_tx" || phase === "checking") && (
      <div style={{ textAlign: "center", padding: "28px 0", color: v2.muted, fontSize: fs.base }}>
        {phase === "awaiting_wallet"
          ? `Confirm ${chain.token} deposit in your wallet…`
          : phase === "confirming_tx"
            ? "Waiting for on-chain confirmation…"
            : "Crediting your Gas Tank (RPC lag — retrying automatically)…"}
      </div>
    )}

    {phase === "done" && (
      <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "11px 13px",
            borderRadius: 11,
            background: "rgba(85,230,165,.08)",
            border: `1px solid rgba(85,230,165,.22)`,
          }}
        >
          <CheckIcon size={fs.title} color={v2.mint} />
          <div>
            <div style={{ color: v2.mint, fontWeight: 700, fontSize: fs.base }}>Deposit confirmed</div>
            <div style={{ color: v2.muted, fontSize: fs.body }}>Gas Tank credited.</div>
          </div>
        </div>
        {Object.entries(verified)
          .filter(([, v]) => v > 0)
          .map(([c, amt]) => (
            <div
              key={c}
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: fs.body,
                color: v2.muted,
                background: "rgba(255,255,255,.03)",
                padding: "9px 12px",
                borderRadius: 9,
              }}
            >
              <span style={{ textTransform: "uppercase" }}>{c}</span>
              <span style={{ font: `500 ${fs.body}px ${displayFont}`, color: v2.text }}>
                {amt.toFixed(4)} {CHAIN_META.find((m) => m.key === c)?.token ?? c.toUpperCase()}
              </span>
            </div>
          ))}
        <button
          type="button"
          onClick={onClose}
          style={{
            border: 0,
            background: v2.yellow,
            color: v2.actionText,
            padding: "12px 0",
            borderRadius: 11,
            fontWeight: 700,
            fontSize: fs.cardTitle,
            cursor: "pointer",
          }}
        >
          Back to Treasury
        </button>
      </div>
    )}

    {phase === "error" && (
      <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        <div
          style={{
            color: v2.red,
            fontSize: fs.body,
            background: "rgba(255,119,119,.08)",
            border: `1px solid rgba(255,119,119,.22)`,
            padding: "12px 14px",
            borderRadius: 11,
          }}
        >
          {err || "Deposit could not be confirmed yet. Try again in a moment."}
        </div>
        <button
          type="button"
          onClick={() => {
            setErr("");
            setPhase("main");
          }}
          style={{
            border: `1px solid var(--v2-accent-line)`,
            background: "var(--v2-accent-fill)",
            color: v2.yellow,
            padding: "11px 0",
            borderRadius: 11,
            fontWeight: 600,
            fontSize: fs.base,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </div>
    )}
  </ModalShell>;
}

// ── V2LinkDepositModal ───────────────────────────────────────────────────────
//
// LINK is an ERC-20 (not native), so there's no in-app send shortcut — the
// user copies the GASTANK address + the per-chain LINK token contract and
// sends from their own wallet. The deposit-scan cron credits it within
// ~5 min. Same flow as the v1 LinkDepositModal, re-skinned.
function V2LinkDepositModal({
  balances,
  onClose,
}: {
  balances: Record<LinkChain, number>;
  onClose: () => void;
}) {
  const [chain, setChain] = useState<LinkChain>("eth");
  const [copied, setCopied] = useState<"deposit" | "token" | null>(null);
  const cfg = LINK_TOKEN[chain];
  const bal = balances[chain] ?? 0;

  async function copy(value: string, field: "deposit" | "token") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(field);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <ModalShell title="LINK Gas Tank · CCIP" onClose={onClose}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 7, marginBottom: 13 }}>
        {LINK_CHAINS.map((k) => {
          const on = k === chain;
          const cb = balances[k] ?? 0;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setChain(k)}
              style={{
                textAlign: "left",
                border: `1px solid ${on ? "var(--v2-accent-line)" : v2.line}`,
                background: on ? "var(--v2-accent-fill)" : "rgba(255,255,255,.02)",
                borderRadius: 11,
                padding: "9px 10px",
                cursor: "pointer",
              }}
            >
              <div style={{ color: on ? v2.yellow : v2.muted, fontSize: fs.body, fontWeight: 600 }}>
                {LINK_TOKEN[k].label}
              </div>
              <div style={{ font: `500 ${fs.cardTitle}px ${displayFont}`, color: on ? v2.text : v2.muted }}>
                {cb.toFixed(4)}
              </div>
              <div style={{ color: v2.muted2, fontSize: fs.micro }}>
                {cb > 0 ? `≈ $${(cb * LINK_USD).toFixed(2)}` : "$0.00"}
              </div>
            </button>
          );
        })}
      </div>

      <div style={{ color: v2.muted, fontSize: fs.body, lineHeight: 1.6, marginBottom: 12 }}>
        Send LINK on <span style={{ color: v2.text }}>{cfg.label}</span> to the Q402 facilitator
        below. The deposit-scan cron credits your LINK Gas Tank within ~5 minutes. Current balance:{" "}
        <span style={{ color: v2.cyan }}>{bal.toFixed(4)} LINK</span>.
      </div>

      <CopyRow
        label="Send LINK to"
        value={GASTANK_ADDRESS}
        copied={copied === "deposit"}
        onCopy={() => copy(GASTANK_ADDRESS, "deposit")}
        accent
      />
      <div style={{ height: 9 }} />
      <CopyRow
        label={`LINK token on ${cfg.label}`}
        value={cfg.address}
        copied={copied === "token"}
        onCopy={() => copy(cfg.address, "token")}
      />
    </ModalShell>
  );
}

function CopyRow({
  label,
  value,
  copied,
  onCopy,
  accent,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  accent?: boolean;
}) {
  return (
    <div
      style={{
        ...subCard(11),
        ...(accent ? { borderColor: "var(--v2-accent-line)", background: "var(--v2-accent-fill)" } : {}),
        padding: 11,
      }}
    >
      <Eyebrow style={{ marginBottom: 7, color: accent ? v2.yellow : v2.muted, fontSize: fs.label }}>{label}</Eyebrow>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <code style={{ flex: 1, minWidth: 0, fontSize: fs.body, color: v2.text, wordBreak: "break-all" }}>
          {value}
        </code>
        <button
          type="button"
          onClick={onCopy}
          style={{
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            border: `1px solid ${v2.line}`,
            background: "rgba(255,255,255,.04)",
            color: copied ? v2.mint : v2.muted,
            padding: "6px 10px",
            borderRadius: 7,
            fontSize: fs.body,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {copied ? (
            <>
              <CheckIcon size={13} color={v2.mint} />
              Copied!
            </>
          ) : (
            "Copy"
          )}
        </button>
      </div>
    </div>
  );
}

// ── ModalShell ───────────────────────────────────────────────────────────────
// Shared v2 modal chrome (portal + backdrop + glass card). Wrapped in
// V2AccentScope so any descendant reading --v2-accent* resolves to yellow.
function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <V2AccentScope
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(2,6,15,.72)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        fontFamily: displayFont,
      }}
    >
      <div
        onClick={onClose}
        style={{ position: "absolute", inset: 0 }}
        aria-hidden
      />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          ...glass(17),
          position: "relative",
          width: "100%",
          maxWidth: 420,
          padding: 21,
          color: v2.text,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 17 }}>
          <div style={{ font: `600 ${fs.title}px ${displayFont}`, letterSpacing: "-.02em" }}>{title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ border: 0, background: "none", color: v2.muted, fontSize: 22, cursor: "pointer", lineHeight: 1 }}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </V2AccentScope>,
    document.body,
  );
}
