"use client";

/**
 * DeveloperView — scoped credentials + AI-client integration
 * (prototype id="developer", .wide-view).
 *
 * REAL IMPLEMENTATION (replaces the foundation stub).
 *
 * ── Layout (dashboard-v2.html line 92) ──────────────────────────────────
 *   .view-shell = 230px context rail + view-main
 *   Col 1  .context: Credentials / MCP setup / Webhook / API playground /
 *          Documentation  (scroll-spy sub-nav; clicking scrolls to section)
 *   Col 2  .view-main: title "Developer access", desc, then
 *          .developer-grid — but the KEY trial/multichain IA FIX is that BOTH
 *          API keys render SIDE BY SIDE (Multichain · 11 chains · paid Gas
 *          Tank scope  AND  Trial · 2,000 sponsored TX · 30-day · BNB-only)
 *          so the user never has to switch "mode" to find a key. The card
 *          matching the active `scope` prop is highlighted (yellow ring).
 *          The 3rd grid cell is the Webhook status card. Below: MCP setup
 *          card, full Webhook config, and the API playground.
 *
 * ── DATA SOURCES wired (REUSE — same fetches the v1 dashboard uses) ──────
 *   - Keys: POST /api/keys/provision (auth'd via getAuthCreds) →
 *       { multichainApiKey/apiKey, sandboxApiKey/multichainSandboxApiKey,
 *         trialApiKey, trialSandboxApiKey, hasPaid, isTrialActive, plan,
 *         trialCredits, ... }. Mirrors the v1 derivation
 *         (page.tsx walletApiKey / trialApiKey / showPaidScope).
 *   - Webhook: GET /api/webhook?address&nonce&sig → { configured, url };
 *       POST /api/webhook (save → { success, secret? });
 *       POST /api/webhook/test → { success, statusCode | error }.
 *       Same NONCE_EXPIRED handling + clearAuthCache as v1.
 *   - MCP card: install string for @quackai/q402-mcp (version from
 *       app/lib/version.ts) — mirrors
 *       app/components/ClaudeMcpCard.tsx, re-skinned to v2 chrome.
 *   - Playground: ports the v1 <Playground/> simulate logic + per-chain
 *       token allowlist (page.tsx:496) into v2-styled chrome (the v1 one is
 *       a private, Tailwind-themed function — business logic preserved).
 *   - Docs link: /docs route.
 *
 * ── SCOPE semantics ─────────────────────────────────────────────────────
 *   `scope` highlights the active key card and selects the playground's
 *   chain set (trial → trial key + BNB-only; multichain → live key + 10
 *   chains). BOTH key cards always render — scope only changes emphasis.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Surface,
  V2AccentScope,
  Eyebrow,
  SectionHead,
  displayFont,
} from "../primitives";
import { v2, glass, subCard, fs, type Scope } from "../theme";
import { CheckIcon, XIcon, SparkIcon, TimerIcon } from "../logos";
import { useDashboardIdentity } from "../identity-context";
import { getAuthCreds, clearAuthCache } from "@/app/lib/auth-client";
import { MCP_VERSION as MCP_PKG_VERSION } from "@/app/lib/version";

/** Published @quackai/q402-mcp version surfaced on the MCP setup card.
 *  Derived from the single source of truth in app/lib/version.ts so a
 *  publish bump can't leave this card stale (the `v` prefix is local). */
const MCP_VERSION = `v${MCP_PKG_VERSION}`;
const MCP_INSTALL = "npx -y @quackai/q402-mcp";

/** npm + GitHub source for the MCP package (surfaced on the tool-reference grid). */
const MCP_NPM_URL = "https://www.npmjs.com/package/@quackai/q402-mcp";
const MCP_GITHUB_URL = "https://github.com/bitgett/q402-mcp";

/**
 * SDK integration snippets — the four-step quickstart the legacy Developer tab
 * showed (app/dashboard/_legacy-page.tsx.bak STEPS). Ported verbatim so the v2
 * surface teaches the same script-load → init → pay → settlement path. Each
 * block carries a short metadata `label` rendered above its dashed code box.
 */
const STEPS: ReadonlyArray<{ n: string; title: string; label: string; code: string }> = [
  {
    n: "01",
    title: "Load the SDK",
    label: "Browser · script tag",
    code: `<script src="https://q402.quackai.ai/q402-sdk.js"></script>\n<!-- or: import { Q402Client } from "q402-sdk" -->`,
  },
  {
    n: "02",
    title: "Initialize with your API key",
    label: "Client init",
    code: `const q402 = new Q402Client({\n  apiKey: "q402_live_xxxxx",\n  chain:  "avax",  // avax | bnb | eth | xlayer | stable | mantle | injective | monad | scroll | arbitrum | base\n});`,
  },
  {
    n: "03",
    title: "One-line gasless payment",
    label: "Pay",
    code: `const result = await q402.pay({\n  to:     "0xRecipient...",\n  amount: "5.00",\n  token:  "USDC",  // use "USDT" for chain: "injective"\n});\nconsole.log(result.txHash);`,
  },
  {
    n: "04",
    title: "Settlement confirmed",
    label: "Result shape",
    code: `// result = {\n//   success: true,\n//   txHash: "0xf3c8...d91e",\n//   tokenAmount: "5", token: "USDC"\n// }\n// Gas paid by Q402 — user spends $0`,
  },
];

/**
 * Canonical @quackai/q402-mcp tool surface — 27 tools, source of truth is
 * mcp-server/src/index.ts (ListTools order). One-line purposes condensed from
 * each tool's own `description` + app/docs/page.tsx. Grouped so the grid reads
 * as Core → Recurring → Bridge (CCIP) → Yield (Aave).
 */
const MCP_TOOLS: ReadonlyArray<{ group: string; name: string; purpose: string }> = [
  // Core
  { group: "Core", name: "q402_doctor", purpose: "First-install onboarding + ongoing health check (quota, EIP-7702 state, relay reachability)." },
  { group: "Core", name: "q402_quote", purpose: "Compare gas + supported tokens across 11 chains. No auth." },
  { group: "Core", name: "q402_balance", purpose: "Verify key + remaining quota. Returns Trial + Multichain in one read." },
  { group: "Core", name: "q402_pay", purpose: "Single-recipient gasless USDC / USDT / RLUSD send. Sandbox by default." },
  { group: "Core", name: "q402_batch_pay", purpose: "Up to 20 recipients per call (trial: 5) in one settlement." },
  { group: "Core", name: "q402_receipt", purpose: "Fetch + locally verify a Trust Receipt by rct_… id (ECDSA recovery)." },
  { group: "Core", name: "q402_wallet_status", purpose: "Per-chain EIP-7702 delegation state for the configured EOA. Read-only." },
  { group: "Core", name: "q402_clear_delegation", purpose: "Clear EIP-7702 delegation on a single chain (Mode A/B local key OR Mode C api key, server-signed). Sponsored except Ethereum (Gas Tank). Needs confirm: true." },
  { group: "Core", name: "q402_agentic_info", purpose: "Agent Wallet info (addresses, caps, daily-spend used, ERC-8004 id)." },
  // Recurring
  { group: "Recurring", name: "q402_recurring_list", purpose: "List scheduled rules." },
  { group: "Recurring", name: "q402_recurring_create", purpose: "Author a rule. Paid Multichain on every chain (BNB included)." },
  { group: "Recurring", name: "q402_recurring_fires", purpose: "Last 50 fires per rule (timestamp + txHashes + amount)." },
  { group: "Recurring", name: "q402_recurring_pause", purpose: "Pause a rule. Reversible." },
  { group: "Recurring", name: "q402_recurring_resume", purpose: "Resume a paused / stopped rule." },
  { group: "Recurring", name: "q402_recurring_skip_next", purpose: "Skip only the next scheduled fire. Cadence preserved." },
  { group: "Recurring", name: "q402_recurring_cancel", purpose: "Permanently stop a rule." },
  // Bridge (Chainlink CCIP — eth/avax/arbitrum triangle)
  { group: "Bridge", name: "q402_bridge_quote", purpose: "Quote the CCIP fee for a USDC bridge (LINK vs native). Read-only." },
  { group: "Bridge", name: "q402_bridge_send", purpose: "Execute a CCIP USDC bridge via the Agent Wallet (Mode C). Sandbox by default." },
  { group: "Bridge", name: "q402_bridge_history", purpose: "Recent CCIP bridges — dashboard pointer until session-binding lands." },
  { group: "Bridge", name: "q402_bridge_gas_tank", purpose: "Bridge Gas Tank fee model + deposit address (dashboard pointer)." },
  // Yield (Aave V3 — BNB only today)
  { group: "Yield", name: "q402_yield_reserves", purpose: "List Q402 Yield (Aave) markets + supply APY. Read-only, no auth." },
  { group: "Yield", name: "q402_yield_positions", purpose: "Agent Wallet's current Aave positions + aggregate USD value. Read-only." },
  { group: "Yield", name: "q402_yield_deposit", purpose: "Supply USDC / USDT into Aave V3 to earn APY. Moves funds — needs confirm." },
  { group: "Yield", name: "q402_yield_withdraw", purpose: `Withdraw stablecoin from Aave (amount "max" = full). Moves funds — needs confirm.` },
  // Requests
  { group: "Requests", name: "q402_request_create", purpose: "Publish a payment request (invoice). No funds move — returns a /pay link + req_ id." },
  { group: "Requests", name: "q402_request_status", purpose: "Look up a request by req_ id (amount, recipient, status). Read-only, no auth." },
  { group: "Requests", name: "q402_request_pay", purpose: "Pay a request gaslessly from your own Agent Wallet. Moves funds — two-phase consent, like q402_pay." },
];

/**
 * DEMO — sample dataset shown when no wallet is connected (or the signed
 * provision read hasn't landed yet). It lets the full Developer surface read
 * as "complete at a glance" instead of a wall of "Connect wallet" locks.
 *
 * The key VALUES are obviously masked samples (the •••• middle is fabricated,
 * not a truncated real secret): a curious user cannot reconstruct a working
 * key from them, and the Preview chip + disabled Copy buttons make the demo
 * status explicit. Real provisioned keys always win the moment they load.
 */
const DEMO = {
  /** Multichain live key — masked sample, never a real secret. */
  multichainKey: "q402_live_804685527••••",
  /** Trial live key — masked sample, never a real secret. */
  trialKey: "q402_live_4479df8••••",
  multichainSub: "11 EVM chains · paid Gas Tank scope",
  trialSub: "2,000 sponsored TX · 30-day trial · 1,847 left · 14d left",
  webhookSub: "Signed POST after each settlement",
  /** Sandbox key shown inside the MCP config JSON (safe-to-paste tier). */
  sandboxKey: "q402_test_demo0000••••",
} as const;

/** Tooltip shown on Copy controls while the view is in demo (preview) mode. */
const DEMO_COPY_TOOLTIP = "Connect your wallet";

export interface DeveloperViewProps {
  /** Connected owner address (null until wallet connects). */
  ownerAddress: string | null;
  /** Wallet signer — needed to auth key provisioning + webhook config. */
  signMessage: (message: string) => Promise<string | null>;
  /** Active scope — selects which API key is highlighted + playground chains. */
  scope: Scope;
}

// ── Shape returned by the provision endpoint we actually read ────────────────
interface ProvisionResult {
  multichainApiKey?: string | null;
  apiKey?: string | null;
  sandboxApiKey?: string | null;
  multichainSandboxApiKey?: string | null;
  trialApiKey?: string | null;
  trialSandboxApiKey?: string | null;
  hasPaid?: boolean;
  isTrialActive?: boolean;
  plan?: string;
  trialCredits?: number;
  trialExpiresAt?: string | null;
  code?: string;
}

/**
 * useDeveloperData — runs the same provision + webhook reads the v1 dashboard
 * does, derived down to exactly what the Developer surface needs. One signed
 * session (getAuthCreds) covers both reads. On NONCE_EXPIRED it clears the
 * cache so the next mount re-signs.
 */
function useDeveloperData(
  address: string | null,
  signMessage: (m: string) => Promise<string | null>,
) {
  const [prov, setProv] = useState<ProvisionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  // Auth creds cached on the instance so webhook save/test reuse them.
  const credsRef = useRef<{ nonce: string; signature: string } | null>(null);

  useEffect(() => {
    if (!address) {
      setProv(null);
      setWebhookUrl("");
      credsRef.current = null;
      return;
    }
    const addr = address;
    let cancelled = false;

    (async () => {
      setLoading(true);
      const auth = await getAuthCreds(addr, signMessage);
      if (!auth || cancelled) {
        setLoading(false);
        return;
      }
      credsRef.current = auth;
      const { nonce, signature } = auth;

      // Keys
      try {
        const res = await fetch("/api/keys/provision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: addr, nonce, signature }),
        });
        const data = (await res.json()) as ProvisionResult;
        if (res.status === 401 && data.code === "NONCE_EXPIRED") {
          clearAuthCache(addr);
          credsRef.current = null;
        } else if (!cancelled) {
          setProv(data);
        }
      } catch {
        /* leave prov null — cards render the locked placeholder */
      }

      // Webhook config (URL only; secret is never returned on GET)
      try {
        const qs = new URLSearchParams({
          address: addr,
          nonce,
          sig: signature,
        }).toString();
        const res = await fetch(`/api/webhook?${qs}`);
        const data = await res.json();
        if (!cancelled && data.configured && data.url) {
          setWebhookUrl(data.url as string);
        }
      } catch {
        /* ignore */
      }

      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // signMessage identity is stable from WalletContext (useCallback).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // ── Derived key surface — mirrors app/dashboard/page.tsx:1464-1498 ──────
  const hasPaid = prov?.hasPaid === true;
  // Paid (Multichain) live key: prefer the scope-explicit alias, fall back to
  // legacy apiKey, only surfaced when the wallet has actually paid.
  const multichainKey = hasPaid
    ? (prov?.multichainApiKey ?? prov?.apiKey ?? "")
    : "";
  // Trial key: dedicated slot, populated by the provision endpoint (covers
  // the bound-email bridge for wallet-only logins of bound users).
  const trialKey = prov?.trialApiKey ?? "";
  const isTrialActive = prov?.isTrialActive === true || !!trialKey;
  const trialCredits = prov?.trialCredits ?? 0;
  const trialDaysLeft =
    prov?.trialExpiresAt && isTrialActive
      ? Math.max(0, Math.ceil((new Date(prov.trialExpiresAt).getTime() - Date.now()) / 86_400_000))
      : null;
  // Sandbox key — feeds the MCP setup card (safe to surface anywhere).
  const sandboxKey =
    prov?.multichainSandboxApiKey ?? prov?.sandboxApiKey ?? "";

  // True once a signed provision read has actually landed. Until then (no
  // wallet, or auth/fetch still in flight) the view renders the DEMO dataset.
  const dataLoaded = prov !== null;

  return {
    loading,
    dataLoaded,
    multichainKey,
    trialKey,
    hasPaid,
    isTrialActive,
    trialCredits,
    trialDaysLeft,
    sandboxKey,
    webhookUrl,
    setWebhookUrl,
    credsRef,
  };
}

// ── Small copy helper ────────────────────────────────────────────────────────
function maskKey(key: string): string {
  if (!key) return "—";
  if (key.length <= 18) return key;
  return `${key.slice(0, 12)}${"•".repeat(12)}${key.slice(-4)}`;
}

function CopyButton({
  value,
  label = "Copy",
  disabled,
  disabledTooltip,
}: {
  value: string;
  label?: string;
  disabled?: boolean;
  /** Native tooltip shown when the control is disabled (e.g. demo mode). */
  disabledTooltip?: string;
}) {
  const [copied, setCopied] = useState(false);
  const isOff = disabled || !value;
  return (
    <button
      type="button"
      className="v2-trans"
      disabled={isOff}
      title={isOff ? disabledTooltip : undefined}
      onClick={() => {
        if (isOff || !value) return;
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
      style={{
        marginTop: 15,
        border: 0,
        background: "none",
        color: copied ? v2.mint : v2.yellow,
        fontSize: fs.label,
        fontWeight: 600,
        cursor: isOff ? (disabledTooltip ? "help" : "default") : "pointer",
        opacity: isOff ? 0.4 : 1,
        padding: 0,
        textAlign: "left",
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        transform: copied ? "scale(1.08)" : "scale(1)",
        transformOrigin: "left center",
      }}
    >
      {copied ? (
        <>
          <CheckIcon size={13} color={v2.mint} />
          Copied
        </>
      ) : (
        label
      )}
    </button>
  );
}

/**
 * MetaLabel — small uppercase metadata caption for code/config blocks so they
 * read as read-only artifacts (not editable inputs). Optional accent suffix.
 */
function MetaLabel({
  children,
  accent,
}: {
  children: React.ReactNode;
  accent?: React.ReactNode;
}) {
  return (
    <div
      style={{
        fontSize: fs.micro,
        letterSpacing: ".14em",
        textTransform: "uppercase",
        fontWeight: 700,
        color: v2.muted2,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {children}
      {accent}
    </div>
  );
}

/** Dashed border treatment marking a block as a read-only code/config artifact. */
const CODE_BLOCK_BORDER = "1px dashed rgba(255,255,255,.10)";

/** Inline copy control for code-block flex headers (icon + label, scale feedback). */
function InlineCopy({
  value,
  label = "Copy",
  disabled,
  disabledTooltip,
}: {
  value: string;
  label?: string;
  disabled?: boolean;
  disabledTooltip?: string;
}) {
  const [copied, setCopied] = useState(false);
  const isOff = disabled || !value;
  return (
    <button
      type="button"
      className="v2-trans"
      disabled={isOff}
      title={isOff ? disabledTooltip : undefined}
      onClick={() => {
        if (isOff || !value) return;
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
      style={{
        border: 0,
        background: copied ? "rgba(245,197,24,.10)" : "rgba(255,255,255,.05)",
        color: copied ? v2.yellow : v2.muted,
        fontSize: fs.micro,
        fontWeight: 700,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        padding: "4px 9px",
        borderRadius: 6,
        cursor: isOff ? (disabledTooltip ? "help" : "default") : "pointer",
        opacity: isOff ? 0.45 : 1,
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        transform: copied ? "scale(1.08)" : "scale(1)",
      }}
    >
      {copied ? (
        <>
          <CheckIcon size={12} color={v2.mint} />
          Copied
        </>
      ) : (
        label
      )}
    </button>
  );
}

// ── Context sub-nav (left rail) ──────────────────────────────────────────────
const SECTIONS = [
  { id: "credentials", label: "Credentials", hint: "API keys · scopes" },
  { id: "integration", label: "Integration guide", hint: "SDK in 4 steps" },
  { id: "mcp", label: "MCP setup", hint: "Claude · Cursor · Cline" },
  { id: "tools", label: "MCP tool reference", hint: "27 tools" },
  { id: "webhook", label: "Webhook", hint: "Signed settlement POSTs" },
  { id: "playground", label: "API playground", hint: "Simulate a quote" },
  { id: "docs", label: "Documentation", hint: "Full reference" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

function ContextRail({
  active,
  onSelect,
}: {
  active: SectionId;
  onSelect: (id: SectionId) => void;
}) {
  return (
    <aside className="v2-context" style={{ ...glass(19), padding: 15, height: "fit-content" }}>
      <Eyebrow style={{ margin: "2px 9px 11px" }}>Developer</Eyebrow>
      {SECTIONS.map((s) => {
        const isActive = s.id === active;
        return (
          <button
            key={s.id}
            type="button"
            className="v2-trans"
            onClick={() => onSelect(s.id)}
            style={{
              width: "100%",
              border: isActive ? `1px solid ${v2.line}` : "1px solid transparent",
              background: isActive ? "rgba(247,202,22,.07)" : "none",
              textAlign: "left",
              padding: "10px 13px",
              borderRadius: 10,
              cursor: "pointer",
            }}
          >
            <div style={{ fontSize: fs.body, fontWeight: isActive ? 700 : 500, color: isActive ? v2.yellow : v2.text }}>
              {s.label}
            </div>
            <div style={{ fontSize: fs.label, color: v2.muted2, marginTop: 2 }}>{s.hint}</div>
          </button>
        );
      })}
    </aside>
  );
}

// ── Trial credit gauge ───────────────────────────────────────────────────────
// Credits-left/total progress bar + a "days left" chip, fed by identity.quota
// (used/total/pct) + identity.daysLeft. Rendered inside the Trial KeyCard so
// the trial's remaining headroom reads at a glance. Yellow fill = healthy;
// flips to red as it depletes (>=80% consumed). No green.
function TrialGauge({
  used,
  total,
  pct,
  daysLeft,
}: {
  used: number;
  total: number;
  pct: number;
  daysLeft: number | null;
}) {
  const clampedPct = Math.max(0, Math.min(100, pct));
  const left = Math.max(0, total - used);
  // Low-headroom → warn color. Keeps the "running low" cue without green.
  const fill = clampedPct >= 90 ? v2.red : clampedPct >= 80 ? "#f0a35e" : v2.yellow;

  return (
    <div style={{ marginTop: 13 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 7,
        }}
      >
        <span style={{ color: v2.muted, fontSize: fs.label }}>
          <span style={{ color: v2.text, fontWeight: 700 }}>{left.toLocaleString()}</span>
          {" / "}
          {total.toLocaleString()} credits left
        </span>
        {daysLeft != null && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: fs.micro,
              fontWeight: 700,
              letterSpacing: ".06em",
              color: daysLeft <= 3 ? "#f0a35e" : v2.yellow,
              background: daysLeft <= 3 ? "rgba(240,163,94,.10)" : "rgba(245,202,22,.10)",
              border: `1px solid ${daysLeft <= 3 ? "rgba(240,163,94,.28)" : "rgba(245,202,22,.26)"}`,
              borderRadius: 7,
              padding: "3px 8px",
            }}
          >
            <TimerIcon size={12} color={daysLeft <= 3 ? "#f0a35e" : v2.yellow} />
            {daysLeft === 1 ? "1 day left" : `${daysLeft} days left`}
          </span>
        )}
      </div>
      <div
        style={{
          width: "100%",
          height: 8,
          borderRadius: 999,
          overflow: "hidden",
          background: "rgba(255,255,255,.07)",
        }}
      >
        <div
          style={{
            width: `${clampedPct}%`,
            height: "100%",
            borderRadius: 999,
            background: fill,
            boxShadow: `0 0 10px ${fill}55`,
            transition: "width .8s cubic-bezier(.22,.61,.36,1)",
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 6,
          color: v2.muted2,
          fontSize: fs.micro,
        }}
      >
        <span>{used.toLocaleString()} used</span>
        <span>{clampedPct}%</span>
      </div>
    </div>
  );
}

// ── Usage alerts row ─────────────────────────────────────────────────────────
// "Email me at 80% / 90%" — opens the legacy usage-alert config modal via
// identity.openUsageAlerts(). Yellow = action.
function UsageAlertsRow({ onOpen }: { onOpen: () => void }) {
  return (
    <div
      className="v2-lift"
      style={{
        ...glass(13),
        padding: "13px 18px",
        display: "flex",
        alignItems: "center",
        gap: 13,
        flexWrap: "wrap",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 9, minWidth: 0, flex: 1 }}>
        <TimerIcon size={16} color={v2.yellow} />
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block", font: `600 ${fs.base}px ${displayFont}`, color: v2.text }}>
            Usage alerts
          </span>
          <span style={{ color: v2.muted, fontSize: fs.label }}>
            Email me when sponsored TXs hit 80% / 90% consumed.
          </span>
        </span>
      </span>
      <button
        type="button"
        className="v2-trans v2-press"
        onClick={onOpen}
        style={{
          flexShrink: 0,
          border: `1px solid rgba(245,202,22,.30)`,
          background: "rgba(245,202,22,.10)",
          color: v2.yellow,
          borderRadius: 9,
          padding: "8px 15px",
          fontSize: fs.label,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        Email me at 80% / 90%
      </button>
    </div>
  );
}

// ── API key card ─────────────────────────────────────────────────────────────
function KeyCard({
  eyebrow,
  apiKey,
  tag,
  tagColor,
  sub,
  active,
  locked,
  lockedNote,
  demo,
  onRotate,
  footer,
}: {
  eyebrow: string;
  apiKey: string;
  tag: string;
  tagColor: string;
  sub: string;
  active: boolean;
  locked?: boolean;
  lockedNote?: string;
  /**
   * Demo (preview) mode — `apiKey` is a pre-masked sample, so show it as the
   * key value (not a locked note) but keep Copy disabled with a tooltip.
   */
  demo?: boolean;
  /**
   * Rotate handler — wired to identity.rotateKey(scope). When supplied (real
   * data, key present), the card surfaces a "Rotate key…" control behind a
   * confirm step. Resolves with the freshly minted key (or null on failure).
   */
  onRotate?: () => Promise<string | null>;
  /** Optional extra block rendered under the sub-line (e.g. the trial gauge). */
  footer?: React.ReactNode;
}) {
  // Rotation is only offered on a real, unlocked key (never in demo/locked).
  const canRotate = !!onRotate && !demo && !locked && !!apiKey;
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotatedKey, setRotatedKey] = useState<string | null>(null);
  const [rotatedCopied, setRotatedCopied] = useState(false);

  async function doRotate() {
    if (!onRotate) return;
    setRotating(true);
    try {
      const next = await onRotate();
      if (next) {
        setRotatedKey(next);
        setConfirming(false);
      }
    } finally {
      setRotating(false);
    }
  }

  // The "active scope" treatment (glow ring + halo + "Active scope" badge) must
  // NEVER land on a locked card. A trial user whose scope defaults to multichain
  // would otherwise see "Active scope" on the locked, upgrade-gated Multichain
  // key. Gate the whole hero treatment on the card actually being usable.
  const isActiveScope = active && !locked;

  return (
    <div
      className="v2-lift"
      style={{
        ...glass(15),
        flex: 1,
        minWidth: 0,
        minHeight: 240,
        padding: 19,
        display: "flex",
        flexDirection: "column",
        opacity: isActiveScope ? 1 : 0.72,
        borderColor: isActiveScope ? "rgba(245,202,22,.45)" : v2.line,
        // Layered glow on the active scope's key — yellow ring + soft halo +
        // deep drop so it reads as the hero of the surface.
        boxShadow: isActiveScope
          ? "0 0 0 2px rgba(245,202,22,.45), 0 0 24px rgba(245,202,22,.15), 0 24px 80px rgba(0,0,0,.34)"
          : glass(15).boxShadow,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Eyebrow>{eyebrow}</Eyebrow>
        {isActiveScope && (
          <span
            style={{
              fontSize: fs.micro,
              letterSpacing: ".14em",
              textTransform: "uppercase",
              fontWeight: 700,
              color: v2.actionText,
              background: v2.yellow,
              borderRadius: 6,
              padding: "3px 8px",
            }}
          >
            Active scope
          </span>
        )}
      </div>

      <div
        style={{
          marginTop: 14,
          padding: "15px 15px",
          border: `1px solid ${v2.line}`,
          borderRadius: 11,
          background: v2.inputFill,
          color: locked ? v2.muted2 : "#aab5c4",
          font: `500 ${fs.base}px ${displayFont}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ overflowWrap: "anywhere" }}>
          {demo
            ? apiKey /* pre-masked sample — shown verbatim, never re-masked */
            : locked
              ? (lockedNote ?? "Locked")
              : maskKey(apiKey)}
        </span>
        <span style={{ color: tagColor, fontSize: fs.label, fontWeight: 700, flexShrink: 0 }}>
          {tag}
        </span>
      </div>

      <div style={{ color: v2.muted, fontSize: fs.label, marginTop: 11, lineHeight: 1.6 }}>{sub}</div>

      {footer}

      {/* Freshly rotated key — surfaced once, with its own copy control. The
          old key is dead the moment this lands, so we make it loud + copyable. */}
      {rotatedKey && (
        <div
          style={{
            marginTop: 12,
            ...subCard(11, 0.0),
            background: "rgba(85,230,165,.05)",
            borderColor: "rgba(85,230,165,.22)",
            padding: "10px 11px",
          }}
        >
          <div
            style={{
              fontSize: fs.label,
              letterSpacing: ".12em",
              textTransform: "uppercase",
              fontWeight: 700,
              color: v2.mint,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <CheckIcon size={12} color={v2.mint} /> New key — old one is now dead
          </div>
          <div
            style={{
              font: `500 ${fs.body}px ${displayFont}`,
              color: "#cbd3dd",
              wordBreak: "break-all",
              marginTop: 6,
            }}
          >
            {rotatedKey}
          </div>
          <button
            type="button"
            className="v2-trans"
            onClick={() => {
              navigator.clipboard.writeText(rotatedKey);
              setRotatedCopied(true);
              setTimeout(() => setRotatedCopied(false), 1600);
            }}
            style={{
              marginTop: 8,
              border: 0,
              background: "none",
              color: rotatedCopied ? v2.mint : v2.muted,
              fontSize: fs.label,
              fontWeight: 600,
              cursor: "pointer",
              padding: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              transform: rotatedCopied ? "scale(1.08)" : "scale(1)",
              transformOrigin: "left center",
            }}
          >
            {rotatedCopied ? (
              <>
                <CheckIcon size={13} color={v2.mint} /> Copied
              </>
            ) : (
              "Copy new key"
            )}
          </button>
        </div>
      )}

      <div
        style={{
          marginTop: "auto",
          paddingTop: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        {demo ? (
          <CopyButton
            value=""
            label="Copy key"
            disabled
            disabledTooltip={DEMO_COPY_TOOLTIP}
          />
        ) : (
          <CopyButton value={locked ? "" : apiKey} label="Copy key" disabled={locked} />
        )}

        {/* Rotation control — confirm-then-rotate. Yellow = action; the confirm
            row stays neutral-glass (no green) and the destructive note is muted. */}
        {canRotate &&
          (confirming ? (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                marginTop: 13,
              }}
            >
              <span style={{ color: v2.muted, fontSize: fs.label }}>
                Rotating invalidates the current key — continue?
              </span>
              <button
                type="button"
                className="v2-trans"
                onClick={() => setConfirming(false)}
                disabled={rotating}
                style={{
                  border: 0,
                  background: "none",
                  color: v2.muted2,
                  fontSize: fs.label,
                  fontWeight: 600,
                  cursor: rotating ? "default" : "pointer",
                  padding: 0,
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="v2-trans v2-press"
                onClick={doRotate}
                disabled={rotating}
                style={{
                  border: `1px solid rgba(245,202,22,.30)`,
                  background: "rgba(245,202,22,.10)",
                  color: v2.yellow,
                  borderRadius: 8,
                  padding: "6px 12px",
                  fontSize: fs.label,
                  fontWeight: 700,
                  cursor: rotating ? "default" : "pointer",
                  opacity: rotating ? 0.5 : 1,
                }}
              >
                {rotating ? "Rotating…" : "Rotate now"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="v2-trans"
              onClick={() => setConfirming(true)}
              style={{
                marginTop: 13,
                border: 0,
                background: "none",
                color: v2.muted2,
                fontSize: fs.label,
                fontWeight: 600,
                cursor: "pointer",
                padding: 0,
              }}
            >
              Rotate key…
            </button>
          ))}
      </div>
    </div>
  );
}

// ── Webhook status card (in the grid) ────────────────────────────────────────
function WebhookStatusRow({
  configured,
  onConfigure,
}: {
  configured: boolean;
  onConfigure: () => void;
}) {
  return (
    <div
      className="v2-lift"
      style={{
        ...glass(13),
        padding: "14px 18px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
      }}
    >
      <Eyebrow style={{ flexShrink: 0 }}>Webhook</Eyebrow>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          font: `600 ${fs.base}px ${displayFont}`,
          color: configured ? v2.mint : v2.text,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: configured ? v2.mint : v2.muted2,
            boxShadow: configured ? `0 0 8px ${v2.mint}` : "none",
            display: "inline-block",
          }}
        />
        {configured ? "Configured" : "Not configured"}
      </span>
      <span style={{ color: v2.muted, fontSize: fs.label }}>
        Signed POST after each settlement
      </span>
      <button
        type="button"
        className="v2-trans"
        onClick={onConfigure}
        style={{
          marginLeft: "auto",
          border: 0,
          background: "none",
          color: v2.yellow,
          fontSize: fs.label,
          fontWeight: 600,
          cursor: "pointer",
          padding: 0,
        }}
      >
        Configure webhook →
      </button>
    </div>
  );
}

// ── MCP setup card ───────────────────────────────────────────────────────────
// Mirrors app/components/ClaudeMcpCard.tsx: install command + a config JSON
// pre-filled with the SANDBOX key only (q402_test_* — safe to surface here;
// live keys go through q402_doctor → ~/.q402/mcp.env, never this JSON).
function buildMcpConfig(sandboxKey: string): string {
  return `{
  "mcpServers": {
    "q402": {
      "command": "npx",
      "args": ["-y", "@quackai/q402-mcp"],
      "env": { "Q402_MULTICHAIN_API_KEY": "${sandboxKey || "q402_test_..."}" }
    }
  }
}`;
}

function McpSetupCard({
  sandboxKey,
  demo,
}: {
  sandboxKey: string;
  /** Demo (preview) mode — disable copy actions with a connect tooltip. */
  demo?: boolean;
}) {
  const config = useMemo(() => buildMcpConfig(sandboxKey), [sandboxKey]);

  // Shared chrome for the read-only code/config artifacts: dashed border +
  // a flex header (metadata label on the left, inline Copy on the right).
  const codeBlock: React.CSSProperties = {
    padding: 14,
    border: CODE_BLOCK_BORDER,
    borderRadius: 11,
    background: v2.inputFill,
    color: "#aeb8c6",
    font: `500 ${fs.body}px/1.6 ${displayFont}`,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  };
  const blockHeader: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 7,
  };

  return (
    <div className="v2-lift" style={{ ...glass(15), padding: 19, marginTop: 12 }}>
      <SectionHead
        title={
          <div>
            <div style={{ font: `600 ${fs.title}px ${displayFont}` }}>MCP setup</div>
            <div style={{ color: v2.muted, fontSize: fs.label, marginTop: 3 }}>
              Claude · Codex · Cursor · Cline
            </div>
          </div>
        }
        action={
          <span style={{ color: v2.mint, fontSize: fs.label, fontWeight: 700 }}>
            {MCP_VERSION}
          </span>
        }
      />

      {/* Install command — read-only artifact (dashed) with header copy. */}
      <div style={{ marginTop: 14 }}>
        <div style={blockHeader}>
          <MetaLabel>Install command</MetaLabel>
          <InlineCopy
            value={MCP_INSTALL}
            label="Copy"
            disabled={demo}
            disabledTooltip={DEMO_COPY_TOOLTIP}
          />
        </div>
        <div style={codeBlock}>{MCP_INSTALL}</div>
      </div>

      <div style={{ marginTop: 12 }}>
        <a
          href="/claude"
          className="v2-trans"
          style={{ color: v2.cyan, fontSize: fs.label, fontWeight: 600, textDecoration: "none" }}
        >
          Full guide →
        </a>
      </div>

      {/* Config JSON pre-filled with the sandbox key (safe to paste). */}
      <div style={{ marginTop: 16 }}>
        <div style={blockHeader}>
          <MetaLabel
            accent={
              <span style={{ color: "rgba(245,202,22,.8)", textTransform: "none", letterSpacing: 0, fontWeight: 600 }}>
                — sandbox key
              </span>
            }
          >
            Claude config
          </MetaLabel>
          <InlineCopy
            value={config}
            label="Copy"
            disabled={demo}
            disabledTooltip={DEMO_COPY_TOOLTIP}
          />
        </div>
        <div style={codeBlock}>{config}</div>
      </div>

      <div style={{ color: v2.muted2, fontSize: fs.label, marginTop: 13, lineHeight: 1.6 }}>
        Safe to paste anywhere, then ask your AI &ldquo;Set up Q402&rdquo; —{" "}
        <code style={{ color: v2.muted }}>q402_doctor</code> writes{" "}
        <code style={{ color: v2.muted }}>~/.q402/mcp.env</code> with your live
        key + wallet for real payments.
      </div>
    </div>
  );
}

// ── Webhook config (full) ────────────────────────────────────────────────────
function WebhookConfig({
  address,
  signMessage,
  webhookUrl,
  setWebhookUrl,
  credsRef,
}: {
  address: string | null;
  signMessage: (m: string) => Promise<string | null>;
  webhookUrl: string;
  setWebhookUrl: (u: string) => void;
  credsRef: React.MutableRefObject<{ nonce: string; signature: string } | null>;
}) {
  const [urlInput, setUrlInput] = useState("");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<null | { ok: boolean; msg: string }>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  // Re-uses the v1 save/test handlers (app/dashboard/page.tsx saveWebhook /
  // testWebhook) verbatim in behaviour: getAuthCreds → POST → NONCE_EXPIRED
  // handling. credsRef seeds the cached pair so this rarely re-prompts.
  async function ensureAuth() {
    if (!address) return null;
    if (credsRef.current) return credsRef.current;
    const auth = await getAuthCreds(address, signMessage);
    if (auth) credsRef.current = auth;
    return auth;
  }

  async function saveWebhook() {
    if (!address || !urlInput) return;
    const auth = await ensureAuth();
    if (!auth) return;
    setSaving(true);
    try {
      const res = await fetch("/api/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          nonce: auth.nonce,
          signature: auth.signature,
          url: urlInput,
        }),
      });
      const data = await res.json();
      if (res.status === 401 && data.code === "NONCE_EXPIRED") {
        clearAuthCache(address);
        credsRef.current = null;
        return;
      }
      if (data.success) {
        setWebhookUrl(urlInput);
        if (data.secret) setSecret(data.secret as string);
      }
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  }

  async function testWebhook() {
    if (!address) return;
    const auth = await ensureAuth();
    if (!auth) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/webhook/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          nonce: auth.nonce,
          signature: auth.signature,
        }),
      });
      const data = await res.json();
      if (res.status === 401 && data.code === "NONCE_EXPIRED") {
        clearAuthCache(address);
        credsRef.current = null;
        setTestResult({ ok: false, msg: "Session expired. Please reload." });
        return;
      }
      setTestResult({
        ok: data.success,
        msg: data.success
          ? `Delivered (HTTP ${data.statusCode})`
          : (data.error ?? "Failed"),
      });
    } catch {
      setTestResult({ ok: false, msg: "Network error" });
    } finally {
      setTesting(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    background: v2.inputFill,
    border: `1px solid ${v2.line}`,
    borderRadius: 10,
    padding: "11px 13px",
    fontSize: fs.body,
    color: v2.text,
    outline: "none",
  };

  // Configure-zone state: an edited-but-not-yet-saved URL reads yellow
  // ("unsaved"); saved (webhook live) and idle both read neutral glass — mint
  // is reserved for settlement success, not a configured-webhook state.
  const saved = !!webhookUrl;
  const unsaved = !!urlInput && urlInput !== webhookUrl;
  const zoneBorder = unsaved
    ? "rgba(245,202,22,.45)"
    : v2.line;
  const zoneShadow = unsaved
    ? "0 0 22px rgba(245,202,22,.10), 0 24px 80px rgba(0,0,0,.23)"
    : glass(15).boxShadow;

  return (
    <Surface
      className="v2-trans"
      style={{
        padding: 19,
        marginTop: 12,
        borderColor: zoneBorder,
        boxShadow: zoneShadow,
      }}
      radius={15}
    >
      <SectionHead
        title="Webhook"
        meta={
          <span style={{ color: v2.muted }}>
            Header <code style={{ color: "#cbd3dd" }}>X-Q402-Signature</code>
          </span>
        }
      />
      <div
        style={{
          color: v2.muted,
          fontSize: fs.label,
          marginBottom: 13,
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
        }}
      >
        Signed POST after every relay.
        {saved && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: v2.yellow }}>
            · <CheckIcon size={12} color={v2.yellow} /> Active
          </span>
        )}
        {unsaved && !saved && (
          <span style={{ color: v2.yellow }}>· Unsaved changes</span>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={urlInput || webhookUrl}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="https://your-server.com/webhook"
          style={inputStyle}
        />
        <button
          type="button"
          className="v2-trans"
          onClick={saveWebhook}
          disabled={saving || !urlInput}
          style={{
            border: `1px solid rgba(245,202,22,.30)`,
            background: "rgba(245,202,22,.10)",
            color: v2.yellow,
            borderRadius: 10,
            padding: "0 18px",
            fontSize: fs.body,
            fontWeight: 700,
            cursor: saving || !urlInput ? "default" : "pointer",
            opacity: saving || !urlInput ? 0.4 : 1,
          }}
        >
          {saving ? "…" : "Save"}
        </button>
      </div>

      {secret && (
        <div
          style={{
            marginTop: 12,
            ...subCard(11, 0.0),
            background: "rgba(247,202,22,.05)",
            borderColor: "rgba(247,202,22,.20)",
            padding: "10px 11px",
          }}
        >
          <div
            style={{
              fontSize: fs.label,
              letterSpacing: ".12em",
              textTransform: "uppercase",
              fontWeight: 700,
              color: "rgba(247,202,22,.75)",
            }}
          >
            Signing Secret — save this now
          </div>
          <div
            style={{
              font: `500 ${fs.body}px ${displayFont}`,
              color: "#cbd3dd",
              wordBreak: "break-all",
              marginTop: 6,
            }}
          >
            {secret}
          </div>
          <button
            type="button"
            className="v2-trans"
            onClick={() => {
              navigator.clipboard.writeText(secret);
              setSecretCopied(true);
              setTimeout(() => setSecretCopied(false), 1600);
            }}
            style={{
              marginTop: 8,
              border: 0,
              background: "none",
              color: secretCopied ? v2.mint : v2.muted,
              fontSize: fs.label,
              fontWeight: 600,
              cursor: "pointer",
              padding: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              transform: secretCopied ? "scale(1.08)" : "scale(1)",
              transformOrigin: "left center",
            }}
          >
            {secretCopied ? (
              <>
                <CheckIcon size={13} color={v2.mint} /> Copied
              </>
            ) : (
              "Copy secret"
            )}
          </button>
        </div>
      )}

      {webhookUrl && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
          <button
            type="button"
            className="v2-trans v2-press"
            onClick={testWebhook}
            disabled={testing}
            style={{
              border: `1px solid ${v2.line}`,
              background: "none",
              color: v2.muted,
              borderRadius: 8,
              padding: "8px 14px",
              fontSize: fs.label,
              fontWeight: 600,
              cursor: testing ? "default" : "pointer",
              opacity: testing ? 0.4 : 1,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {testing ? (
              "Sending…"
            ) : (
              <>
                <PlayGlyph color={v2.muted} /> Test
              </>
            )}
          </button>
          {testResult && (
            <span
              style={{
                fontSize: fs.label,
                color: testResult.ok ? v2.mint : v2.red,
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              {testResult.ok ? (
                <CheckIcon size={13} color={v2.mint} />
              ) : (
                <XIcon size={13} color={v2.red} />
              )}
              {testResult.msg}
            </span>
          )}
        </div>
      )}
    </Surface>
  );
}

/** Small filled triangle "run/test" glyph (replaces the ▶ text mark). */
function PlayGlyph({ size = 11, color }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden style={{ flexShrink: 0 }}>
      <path d="M3 2.2 9.5 6 3 9.8Z" fill={color ?? "currentColor"} />
    </svg>
  );
}

// ── API playground ───────────────────────────────────────────────────────────
// Ports the v1 <Playground/> simulate logic + per-chain token allowlist
// (app/dashboard/page.tsx:496) into v2 chrome. The simulate is a client-side
// preview (no relay) exactly as in v1 — same 1.8s fake settle + masked key.
type PgToken = "USDC" | "USDT" | "RLUSD";

function Playground({
  apiKey,
  trialView,
  demo,
}: {
  apiKey: string;
  trialView: boolean;
  /** Demo (preview) mode — `apiKey` is a pre-masked sample; disable Copy. */
  demo?: boolean;
}) {
  const [chain, setChain] = useState(trialView ? "bnb" : "avax");
  const [token, setToken] = useState<PgToken>("USDC");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("5");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<null | { hash: string }>(null);
  const [keyCopied, setKeyCopied] = useState(false);

  // Per-chain token availability mirrors the v1 playground / relay allowlist.
  const availableTokens: PgToken[] = useMemo(() => {
    if (trialView) return ["USDC", "USDT"];
    if (chain === "injective") return ["USDT"];
    if (chain === "eth") return ["USDC", "USDT", "RLUSD"];
    return ["USDC", "USDT"];
  }, [trialView, chain]);

  useEffect(() => {
    if (!availableTokens.includes(token)) setToken(availableTokens[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain]);

  useEffect(() => {
    if (trialView && chain !== "bnb") setChain("bnb");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trialView]);

  const simulate = useCallback(async () => {
    setLoading(true);
    setResult(null);
    await new Promise((r) => setTimeout(r, 1800));
    setLoading(false);
    setResult({
      hash: `0x${Math.random().toString(16).slice(2, 10)}…${Math.random()
        .toString(16)
        .slice(2, 6)}`,
    });
  }, []);

  const fieldLabel: React.CSSProperties = {
    fontSize: fs.label,
    letterSpacing: ".14em",
    textTransform: "uppercase",
    color: v2.muted2,
    display: "block",
    marginBottom: 7,
  };
  const field: React.CSSProperties = {
    width: "100%",
    background: v2.inputFill,
    border: `1px solid ${v2.line}`,
    borderRadius: 10,
    padding: "11px 13px",
    fontSize: fs.body,
    color: v2.text,
    outline: "none",
  };

  return (
    <Surface className="v2-lift" style={{ padding: 19, marginTop: 12 }} radius={15}>
      <SectionHead
        title="API playground"
        meta={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                fontSize: fs.micro,
                letterSpacing: ".1em",
                textTransform: "uppercase",
                fontWeight: 700,
                color: v2.muted2,
                border: `1px solid ${v2.line}`,
                borderRadius: 6,
                padding: "2px 7px",
              }}
            >
              Sandbox
            </span>
            {trialView ? "Trial · BNB-only" : "Multichain"}
          </span>
        }
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 10,
        }}
      >
        <div>
          <label style={fieldLabel}>Chain</label>
          <select
            value={chain}
            onChange={(e) => setChain(e.target.value)}
            style={{ ...field, cursor: "pointer", appearance: "none" }}
          >
            {/* Native <option> text cannot host an SVG icon, so supported
                chains carry a textual "· live" cue instead of a ✓ glyph. */}
            {trialView ? (
              <option value="bnb" style={{ background: v2.panel }}>
                BNB Chain · trial
              </option>
            ) : (
              <>
                <option value="avax" style={{ background: v2.panel }}>Avalanche · live</option>
                <option value="bnb" style={{ background: v2.panel }}>BNB Chain · live</option>
                <option value="eth" style={{ background: v2.panel }}>Ethereum · live</option>
                <option value="xlayer" style={{ background: v2.panel }}>X Layer · live</option>
                <option value="stable" style={{ background: v2.panel }}>Stable · live</option>
                <option value="mantle" style={{ background: v2.panel }}>Mantle · live</option>
                <option value="injective" style={{ background: v2.panel }}>Injective · live</option>
                <option value="monad" style={{ background: v2.panel }}>Monad · live</option>
                <option value="scroll" style={{ background: v2.panel }}>Scroll · live</option>
                <option value="arbitrum" style={{ background: v2.panel }}>Arbitrum · live</option>
              </>
            )}
          </select>
        </div>
        <div>
          <label style={fieldLabel}>Token</label>
          <select
            value={token}
            onChange={(e) => setToken(e.target.value as PgToken)}
            style={{ ...field, cursor: "pointer", appearance: "none" }}
          >
            {availableTokens.map((t) => (
              <option key={t} value={t} style={{ background: v2.panel }}>
                {t}
                {t === "RLUSD" ? " (Ethereum-only)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={fieldLabel}>Recipient</label>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="0x..."
            style={{ ...field, fontFamily: displayFont }}
          />
        </div>
        <div>
          <label style={fieldLabel}>Amount</label>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={field}
          />
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div
          style={{
            fontSize: fs.micro,
            letterSpacing: ".14em",
            textTransform: "uppercase",
            fontWeight: 700,
            color: v2.muted2,
            marginBottom: 7,
          }}
        >
          Request preview
        </div>
        <div
          style={{
            background: v2.inputFill,
            border: CODE_BLOCK_BORDER,
            borderRadius: 11,
            padding: 14,
            font: `500 ${fs.body}px/1.7 ${displayFont}`,
            color: v2.muted,
            whiteSpace: "pre-wrap",
          }}
        >
          {`const tx = await q402.pay({\n  to: "${to}",\n  amount: "${amount}",\n  token: "${token}"\n});`}
        </div>
      </div>

      <button
        type="button"
        className="v2-trans v2-press"
        onClick={simulate}
        disabled={loading}
        style={{
          marginTop: 14,
          minHeight: 44,
          border: 0,
          background: v2.yellow,
          color: v2.actionText,
          fontWeight: 700,
          fontSize: fs.body,
          padding: "0 22px",
          borderRadius: 11,
          cursor: loading ? "default" : "pointer",
          opacity: loading ? 0.6 : 1,
          boxShadow: loading ? "none" : "0 0 24px rgba(245,202,22,.2)",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {loading ? (
          "Sending…"
        ) : (
          <>
            <PlayGlyph size={12} color={v2.actionText} /> Run simulation
          </>
        )}
      </button>

      {result && (
        <div
          style={{
            marginTop: 12,
            ...subCard(11, 0.0),
            background: "rgba(85,230,165,.05)",
            borderColor: "rgba(85,230,165,.20)",
            padding: 14,
            font: `500 ${fs.body}px/1.7 ${displayFont}`,
          }}
        >
          <div
            style={{
              color: v2.mint,
              fontWeight: 700,
              marginBottom: 6,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <CheckIcon size={14} color={v2.mint} /> Simulated
          </div>
          <div style={{ color: v2.muted }}>
            hash: <span style={{ color: "#f0a35e" }}>{result.hash}</span>
          </div>
          <div style={{ color: v2.muted }}>
            gas by user:{" "}
            <span style={{ color: v2.yellow, fontWeight: 700 }}>$0.000000</span>
          </div>
          <div style={{ color: v2.muted }}>
            {token} sent: <span style={{ color: v2.mint }}>${amount}.00</span>
          </div>
        </div>
      )}

      <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${v2.line}` }}>
        <div style={{ color: v2.muted2, fontSize: fs.label, marginBottom: 7 }}>
          Your {trialView ? "Trial" : "Multichain"} API Key
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: v2.inputFill,
            border: `1px solid ${v2.line}`,
            borderRadius: 8,
            padding: "9px 13px",
            font: `500 ${fs.body}px ${displayFont}`,
            color: v2.muted,
          }}
        >
          <span style={{ flex: 1, overflowWrap: "anywhere" }}>
            {demo ? apiKey /* pre-masked sample */ : maskKey(apiKey)}
          </span>
          <button
            type="button"
            className="v2-trans"
            disabled={demo || !apiKey}
            title={demo ? DEMO_COPY_TOOLTIP : undefined}
            onClick={() => {
              if (demo || !apiKey) return;
              navigator.clipboard.writeText(apiKey);
              setKeyCopied(true);
              setTimeout(() => setKeyCopied(false), 1600);
            }}
            style={{
              border: 0,
              background: "none",
              color: keyCopied ? v2.yellow : v2.muted,
              fontSize: fs.label,
              fontWeight: 600,
              letterSpacing: ".12em",
              textTransform: "uppercase",
              cursor: demo ? "help" : apiKey ? "pointer" : "default",
              opacity: demo || !apiKey ? 0.5 : 1,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              transform: keyCopied ? "scale(1.08)" : "scale(1)",
            }}
          >
            {keyCopied ? (
              <>
                <CheckIcon size={12} color={v2.mint} /> Copied
              </>
            ) : (
              "Copy"
            )}
          </button>
        </div>
      </div>
    </Surface>
  );
}

// ── Integration guide (4 SDK snippets) ───────────────────────────────────────
// Ports the legacy STEPS quickstart into v2 chrome: each step is a numbered
// row + a read-only code block (dashed border, a small metadata label, and a
// copy button on the block header).
function IntegrationGuide() {
  const codeBlock: React.CSSProperties = {
    padding: 14,
    border: CODE_BLOCK_BORDER,
    borderRadius: 11,
    background: v2.inputFill,
    color: "#aeb8c6",
    font: `500 ${fs.body}px/1.65 ${displayFont}`,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    overflowX: "auto",
  };
  const blockHeader: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 7,
  };

  return (
    <Surface className="v2-lift" style={{ padding: 19, marginTop: 12 }} radius={15}>
      <SectionHead
        title="Integration guide"
        action={
          <a
            href="/docs"
            className="v2-trans"
            style={{ color: v2.cyan, fontSize: fs.label, fontWeight: 600, textDecoration: "none" }}
          >
            Full reference →
          </a>
        }
      />
      <div style={{ color: v2.muted, fontSize: fs.body, marginBottom: 14 }}>
        Script-load → init → pay → settlement. Gas paid by Q402 — the user
        spends $0.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {STEPS.map((s) => (
          <div key={s.n}>
            <div style={blockHeader}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <span
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 7,
                    flexShrink: 0,
                    background: "rgba(245,202,22,.10)",
                    border: "1px solid rgba(245,202,22,.22)",
                    color: v2.yellow,
                    fontSize: fs.micro,
                    fontWeight: 800,
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  {s.n}
                </span>
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <span style={{ font: `600 ${fs.base}px ${displayFont}`, color: v2.text }}>
                    {s.title}
                  </span>
                  <MetaLabel>{s.label}</MetaLabel>
                </span>
              </span>
              <InlineCopy value={s.code} label="Copy" />
            </div>
            <div style={codeBlock}>{s.code}</div>
          </div>
        ))}
      </div>
    </Surface>
  );
}

// ── MCP tool reference grid (27 tools) ───────────────────────────────────────
// The full @quackai/q402-mcp tool surface with one-line purposes + npm/GitHub
// source links. Grouped Core → Recurring → Bridge → Yield.
function McpToolGrid() {
  const groups = useMemo(() => {
    const order = ["Core", "Recurring", "Bridge", "Yield", "Requests"] as const;
    return order.map((g) => ({
      group: g,
      tools: MCP_TOOLS.filter((t) => t.group === g),
    }));
  }, []);

  const GROUP_META: Record<string, string> = {
    Core: "Quote · pay · receipts · delegation",
    Recurring: "Scheduled rules",
    Bridge: "Chainlink CCIP · eth/avax/arbitrum",
    Yield: "Aave V3 · BNB only today",
    Requests: "Invoices · agent-to-agent billing",
  };

  const sourceLink: React.CSSProperties = {
    color: v2.cyan,
    fontSize: fs.label,
    fontWeight: 600,
    textDecoration: "none",
  };

  return (
    <Surface className="v2-lift" style={{ padding: 19, marginTop: 12 }} radius={15}>
      <SectionHead
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
            <SparkIcon size={16} color={v2.yellow} /> MCP tool reference
          </span>
        }
        action={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 14 }}>
            <a href={MCP_NPM_URL} target="_blank" rel="noreferrer" className="v2-trans" style={sourceLink}>
              npm →
            </a>
            <a href={MCP_GITHUB_URL} target="_blank" rel="noreferrer" className="v2-trans" style={sourceLink}>
              GitHub →
            </a>
          </span>
        }
      />
      <div style={{ color: v2.muted, fontSize: fs.body, marginBottom: 14 }}>
        {MCP_TOOLS.length} tools exposed by{" "}
        <code style={{ color: v2.muted }}>@quackai/q402-mcp</code> ({MCP_VERSION}).
        Each is callable from any MCP client once the server is configured above.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {groups.map(({ group, tools }) => (
          <div key={group}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 9,
                marginBottom: 9,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontSize: fs.micro,
                  letterSpacing: ".14em",
                  textTransform: "uppercase",
                  fontWeight: 800,
                  color: v2.yellow,
                }}
              >
                {group}
              </span>
              <span style={{ color: v2.muted2, fontSize: fs.label }}>{GROUP_META[group]}</span>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(248px, 1fr))",
                gap: 9,
              }}
            >
              {tools.map((t) => (
                <div
                  key={t.name}
                  style={{
                    ...subCard(11, 0.012),
                    padding: "11px 13px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 5,
                  }}
                >
                  <code
                    style={{
                      color: v2.yellow,
                      fontSize: fs.body,
                      fontWeight: 700,
                      fontFamily: displayFont,
                      wordBreak: "break-all",
                    }}
                  >
                    {t.name}
                  </code>
                  <span style={{ color: v2.muted, fontSize: fs.label, lineHeight: 1.55 }}>
                    {t.purpose}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Surface>
  );
}

// ── Documentation card ───────────────────────────────────────────────────────
function DocsCard() {
  return (
    <Surface className="v2-lift" style={{ padding: 19, marginTop: 12 }} radius={15}>
      <SectionHead
        title="Documentation"
        action={
          <a
            href="/docs"
            className="v2-trans"
            style={{ color: v2.cyan, fontSize: fs.label, fontWeight: 600, textDecoration: "none" }}
          >
            Open docs →
          </a>
        }
      />
      <div style={{ color: v2.muted, fontSize: fs.body, lineHeight: 1.7 }}>
        API reference, gas-pool model, per-chain witness scheme, and the SDK
        integration guide live at{" "}
        <a href="/docs" className="v2-trans" style={{ color: v2.cyan, textDecoration: "none" }}>
          /docs
        </a>
        . MCP-specific walkthrough at{" "}
        <a href="/docs#claude-mcp" className="v2-trans" style={{ color: v2.cyan, textDecoration: "none" }}>
          /docs#claude-mcp
        </a>
        .
      </div>
    </Surface>
  );
}

// ── View ─────────────────────────────────────────────────────────────────────
export function DeveloperView({ ownerAddress, signMessage, scope }: DeveloperViewProps) {
  const [activeSection, setActiveSection] = useState<SectionId>("credentials");
  const {
    loading,
    dataLoaded,
    multichainKey,
    trialKey,
    hasPaid,
    isTrialActive,
    trialCredits,
    trialDaysLeft,
    sandboxKey,
    webhookUrl,
    setWebhookUrl,
    credsRef,
  } = useDeveloperData(ownerAddress, signMessage);

  // Identity bridge — published by the legacy page (key rotation, trial quota,
  // days-left, usage-alert modal). Reused so v2 never re-derives those facts.
  const identity = useDashboardIdentity();

  // Rotate handlers — the confirm step lives in the KeyCard; this just calls
  // the intent-bound /api/keys/rotate via identity.rotateKey(scope) and returns
  // the new key (null on cancel / expiry / failure). page.tsx scope: paid|trial.
  const rotateMultichain = useCallback(async () => {
    const { apiKey } = await identity.rotateKey("paid");
    return apiKey ?? null;
  }, [identity]);
  const rotateTrial = useCallback(async () => {
    const { apiKey } = await identity.rotateKey("trial");
    return apiKey ?? null;
  }, [identity]);

  // Demo (preview) mode: no wallet connected, OR a wallet is connected but the
  // signed provision read hasn't landed yet. In this mode the whole surface
  // renders the DEMO dataset so it reads as complete at a glance, with Copy
  // controls disabled (tooltip: "Connect your wallet"). The moment real data
  // loads, `dataLoaded` flips and the connected/real path below takes over.
  const demoMode = !ownerAddress || !dataLoaded;

  // Sandbox key fed to the MCP card: real one when loaded, else demo sample.
  const mcpSandboxKey = demoMode ? DEMO.sandboxKey : sandboxKey;

  // ── Trial credit gauge inputs ───────────────────────────────────────────
  // Prefer the canonical scoped quota the legacy page publishes (used/total/
  // pct); fall back to the provision-derived trial credits so the gauge still
  // renders in isolation. Days-left likewise prefers identity.daysLeft.
  const TRIAL_GRANT = 2000;
  const gaugeTotal = identity.quota?.total ?? TRIAL_GRANT;
  const gaugeUsed = identity.quota?.used ?? Math.max(0, gaugeTotal - trialCredits);
  const gaugePct =
    identity.quota?.pct ?? (gaugeTotal > 0 ? Math.round((gaugeUsed / gaugeTotal) * 100) : 0);
  const gaugeDaysLeft = identity.daysLeft ?? trialDaysLeft;
  // Only show the gauge on a real, active trial (never in demo / locked).
  const showTrialGauge = !demoMode && isTrialActive && !!trialKey;

  // Section anchors for the context-rail scroll-spy nav.
  const refs: Record<SectionId, React.RefObject<HTMLDivElement | null>> = {
    credentials: useRef<HTMLDivElement>(null),
    integration: useRef<HTMLDivElement>(null),
    mcp: useRef<HTMLDivElement>(null),
    tools: useRef<HTMLDivElement>(null),
    webhook: useRef<HTMLDivElement>(null),
    playground: useRef<HTMLDivElement>(null),
    docs: useRef<HTMLDivElement>(null),
  };

  const scrollTo = useCallback((id: SectionId) => {
    setActiveSection(id);
    refs[id].current?.scrollIntoView({ behavior: "smooth", block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Playground feeds off the scope-active key (trial vs multichain), matching
  // the v1 dashboard's Playground apiKey + trialView props.
  const trialView = scope === "trial";
  const playgroundKey = demoMode
    ? trialView
      ? DEMO.trialKey
      : DEMO.multichainKey
    : trialView
      ? trialKey
      : multichainKey;

  // Each scrollable section gets a staggered entrance. `i` drives the
  // animationDelay so the surface assembles top-to-bottom on mount.
  const section = (i: number): React.CSSProperties => ({
    scrollMarginTop: 80,
    animation: "v2-enter .34s cubic-bezier(.22,.61,.36,1) both",
    animationDelay: `${i * 0.08}s`,
  });

  return (
    <V2AccentScope className="v2-view-enter" style={{ paddingTop: 17 }}>
      <div
        className="v2-view-shell"
        style={{
          display: "grid",
          gridTemplateColumns: "230px minmax(0,1fr)",
          gap: 18,
        }}
      >
        <ContextRail active={activeSection} onSelect={scrollTo} />

        <main className="v2-view-main" style={{ ...glass(19), padding: 21 }}>
          <div style={{ font: `600 ${fs.h2}px ${displayFont}`, letterSpacing: "-.04em" }}>
            Developer access
          </div>
          <div style={{ color: v2.muted, fontSize: fs.body, marginTop: 6 }}>
            Scoped credentials and AI-client integration without mixing product
            economics.
            {loading && <span style={{ color: v2.muted2 }}> · Loading…</span>}
          </div>

          {/* ── Demo banner — full-width, animated, with a connect CTA ──── */}
          {demoMode && (
            <div
              className="animate-glow"
              style={{
                marginTop: 16,
                display: "flex",
                alignItems: "center",
                gap: 13,
                flexWrap: "wrap",
                padding: "13px 16px",
                borderRadius: 13,
                border: "1px solid rgba(245,202,22,.30)",
                background:
                  "linear-gradient(100deg, rgba(245,202,22,.10), rgba(245,202,22,.03))",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: v2.yellow,
                  boxShadow: `0 0 10px ${v2.yellow}`,
                  flexShrink: 0,
                }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    color: v2.yellow,
                    fontWeight: 700,
                    fontSize: fs.base,
                    letterSpacing: "-.01em",
                  }}
                >
                  Preview mode — showing sample data
                </div>
                <div style={{ color: v2.muted, fontSize: fs.label, marginTop: 2 }}>
                  Connect your wallet to provision live keys, configure webhooks,
                  and run real settlements.
                </div>
              </div>
              <button
                type="button"
                className="v2-trans v2-press"
                onClick={() =>
                  window.scrollTo({ top: 0, behavior: "smooth" })
                }
                style={{
                  flexShrink: 0,
                  border: 0,
                  background: v2.yellow,
                  color: v2.actionText,
                  fontWeight: 700,
                  fontSize: fs.label,
                  padding: "9px 16px",
                  borderRadius: 9,
                  cursor: "pointer",
                  boxShadow: "0 0 20px rgba(245,202,22,.22)",
                }}
              >
                Connect your wallet →
              </button>
            </div>
          )}

          {/* ── Credentials: BOTH keys as a 2-col hero row, webhook below ── */}
          <div ref={refs.credentials} style={section(0)}>
            <div
              style={{
                display: "flex",
                gap: 14,
                marginTop: 18,
                flexWrap: "wrap",
              }}
            >
              <KeyCard
                eyebrow="Multichain API Key"
                apiKey={demoMode ? DEMO.multichainKey : multichainKey}
                tag="LIVE"
                tagColor={v2.mint}
                sub={demoMode ? DEMO.multichainSub : "11 EVM chains · paid Gas Tank scope"}
                active={scope === "multichain"}
                demo={demoMode}
                locked={!hasPaid || !multichainKey}
                lockedNote={
                  ownerAddress ? "Upgrade to unlock" : "Connect wallet"
                }
                onRotate={rotateMultichain}
              />
              <KeyCard
                eyebrow="Trial API Key"
                apiKey={demoMode ? DEMO.trialKey : trialKey}
                tag="BNB"
                tagColor={v2.yellow}
                sub={
                  demoMode
                    ? DEMO.trialSub
                    : `2,000 sponsored TX · 30-day trial${
                        isTrialActive && !showTrialGauge ? ` · ${trialCredits.toLocaleString()} left` : ""
                      }${trialDaysLeft != null && !showTrialGauge ? ` · ${trialDaysLeft}d left` : ""}`
                }
                active={scope === "trial"}
                demo={demoMode}
                locked={!trialKey}
                lockedNote={
                  ownerAddress ? "Start a trial to unlock" : "Connect wallet"
                }
                onRotate={rotateTrial}
                footer={
                  showTrialGauge ? (
                    <TrialGauge
                      used={gaugeUsed}
                      total={gaugeTotal}
                      pct={gaugePct}
                      daysLeft={gaugeDaysLeft}
                    />
                  ) : undefined
                }
              />
            </div>
            <div style={{ marginTop: 14 }}>
              <WebhookStatusRow
                configured={demoMode ? false : !!webhookUrl}
                onConfigure={() => scrollTo("webhook")}
              />
            </div>
            {/* Usage alerts — only when a wallet is connected (the alert config
                endpoint requires a signed session). */}
            {ownerAddress && (
              <div style={{ marginTop: 14 }}>
                <UsageAlertsRow onOpen={identity.openUsageAlerts} />
              </div>
            )}
          </div>

          {/* ── Integration guide (4 SDK snippets) ──────────────────── */}
          <div ref={refs.integration} style={section(1)}>
            <IntegrationGuide />
          </div>

          {/* ── MCP setup ───────────────────────────────────────────── */}
          <div ref={refs.mcp} style={section(2)}>
            <McpSetupCard sandboxKey={mcpSandboxKey} demo={demoMode} />
          </div>

          {/* ── MCP tool reference grid (27 tools) ──────────────────── */}
          <div ref={refs.tools} style={section(3)}>
            <McpToolGrid />
          </div>

          {/* ── Webhook config ──────────────────────────────────────── */}
          <div ref={refs.webhook} style={section(4)}>
            <WebhookConfig
              address={ownerAddress}
              signMessage={signMessage}
              webhookUrl={webhookUrl}
              setWebhookUrl={setWebhookUrl}
              credsRef={credsRef}
            />
          </div>

          {/* ── API playground ──────────────────────────────────────── */}
          <div ref={refs.playground} style={section(5)}>
            <Playground apiKey={playgroundKey} trialView={trialView} demo={demoMode} />
          </div>

          {/* ── Documentation ───────────────────────────────────────── */}
          <div ref={refs.docs} style={section(6)}>
            <DocsCard />
          </div>
        </main>
      </div>
    </V2AccentScope>
  );
}
