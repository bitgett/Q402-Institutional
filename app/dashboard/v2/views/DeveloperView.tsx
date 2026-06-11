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
 *          API keys render SIDE BY SIDE (Multichain · 10 chains · paid Gas
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
 *   - MCP card: install string for @quackai/q402-mcp (v0.8.19) — mirrors
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
import { v2, glass, subCard, type Scope } from "../theme";
import { getAuthCreds, clearAuthCache } from "@/app/lib/auth-client";

/** Published @quackai/q402-mcp version surfaced on the MCP setup card. */
const MCP_VERSION = "v0.8.19";
const MCP_INSTALL = "npx -y @quackai/q402-mcp";

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
  // Sandbox key — feeds the MCP setup card (safe to surface anywhere).
  const sandboxKey =
    prov?.multichainSandboxApiKey ?? prov?.sandboxApiKey ?? "";

  return {
    loading,
    multichainKey,
    trialKey,
    hasPaid,
    isTrialActive,
    trialCredits,
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
}: {
  value: string;
  label?: string;
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled || !value}
      onClick={() => {
        if (!value) return;
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
      style={{
        marginTop: 13,
        border: 0,
        background: "none",
        color: copied ? v2.mint : v2.yellow,
        fontSize: 9,
        cursor: disabled || !value ? "default" : "pointer",
        opacity: disabled || !value ? 0.4 : 1,
        padding: 0,
        textAlign: "left",
      }}
    >
      {copied ? "Copied!" : label}
    </button>
  );
}

// ── Context sub-nav (left rail) ──────────────────────────────────────────────
const SECTIONS = [
  { id: "credentials", label: "Credentials" },
  { id: "mcp", label: "MCP setup" },
  { id: "webhook", label: "Webhook" },
  { id: "playground", label: "API playground" },
  { id: "docs", label: "Documentation" },
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
    <aside style={{ ...glass(19), padding: 15, height: "fit-content" }}>
      <Eyebrow style={{ margin: "2px 9px 9px" }}>Developer</Eyebrow>
      {SECTIONS.map((s) => {
        const isActive = s.id === active;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            style={{
              width: "100%",
              border: 0,
              background: isActive ? "rgba(255,255,255,.05)" : "none",
              color: isActive ? v2.text : v2.muted,
              textAlign: "left",
              padding: 9,
              borderRadius: 9,
              fontSize: 10,
              cursor: "pointer",
            }}
          >
            {s.label}
          </button>
        );
      })}
    </aside>
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
}: {
  eyebrow: string;
  apiKey: string;
  tag: string;
  tagColor: string;
  sub: string;
  active: boolean;
  locked?: boolean;
  lockedNote?: string;
}) {
  return (
    <div
      style={{
        ...glass(13),
        padding: 16,
        borderColor: active ? "rgba(247,202,22,.45)" : v2.line,
        boxShadow: active
          ? "0 0 0 1px rgba(247,202,22,.30), 0 24px 80px rgba(0,0,0,.23)"
          : glass(13).boxShadow,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Eyebrow>{eyebrow}</Eyebrow>
        {active && (
          <span
            style={{
              fontSize: 7.5,
              letterSpacing: ".14em",
              textTransform: "uppercase",
              fontWeight: 700,
              color: v2.actionText,
              background: v2.yellow,
              borderRadius: 6,
              padding: "2px 6px",
            }}
          >
            Active scope
          </span>
        )}
      </div>

      <div
        style={{
          marginTop: 12,
          padding: 11,
          border: `1px solid ${v2.line}`,
          borderRadius: 10,
          background: v2.inputFill,
          color: locked ? v2.muted2 : "#aab5c4",
          font: `500 9px ${displayFont}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ overflowWrap: "anywhere" }}>
          {locked ? (lockedNote ?? "Locked") : maskKey(apiKey)}
        </span>
        <span style={{ color: tagColor, fontSize: 8, fontWeight: 700, flexShrink: 0 }}>
          {tag}
        </span>
      </div>

      <div style={{ color: v2.muted, fontSize: 9, marginTop: 8 }}>{sub}</div>

      <CopyButton value={locked ? "" : apiKey} label="Copy key" disabled={locked} />
    </div>
  );
}

// ── Webhook status card (in the grid) ────────────────────────────────────────
function WebhookStatusCard({
  configured,
  onConfigure,
}: {
  configured: boolean;
  onConfigure: () => void;
}) {
  return (
    <div style={{ ...glass(13), padding: 16 }}>
      <Eyebrow>Webhook</Eyebrow>
      <div
        style={{
          font: `600 16px ${displayFont}`,
          marginTop: 12,
          color: configured ? v2.mint : v2.text,
        }}
      >
        {configured ? "Configured" : "Not configured"}
      </div>
      <div style={{ color: v2.muted, fontSize: 9, marginTop: 8 }}>
        Signed POST after each settlement
      </div>
      <button
        type="button"
        onClick={onConfigure}
        style={{
          marginTop: 13,
          border: 0,
          background: "none",
          color: v2.yellow,
          fontSize: 9,
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

function McpSetupCard({ sandboxKey }: { sandboxKey: string }) {
  const [copied, setCopied] = useState(false);
  const [jsonCopied, setJsonCopied] = useState(false);
  const config = useMemo(() => buildMcpConfig(sandboxKey), [sandboxKey]);
  return (
    <div style={{ ...glass(13), padding: 16, marginTop: 12 }}>
      <SectionHead
        title={
          <div>
            <div style={{ font: `600 13px ${displayFont}` }}>MCP setup</div>
            <div style={{ color: v2.muted, fontSize: 9, marginTop: 2 }}>
              Claude · Codex · Cursor · Cline
            </div>
          </div>
        }
        action={
          <span style={{ color: v2.mint, fontSize: 8, fontWeight: 700 }}>
            {MCP_VERSION}
          </span>
        }
      />
      <div
        style={{
          marginTop: 12,
          padding: 13,
          border: `1px solid ${v2.line}`,
          borderRadius: 10,
          background: v2.inputFill,
          color: "#aeb8c6",
          font: `500 9px/1.6 ${displayFont}`,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {MCP_INSTALL}
      </div>
      <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 13 }}>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(MCP_INSTALL);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
          style={{
            border: 0,
            background: "none",
            color: copied ? v2.mint : v2.yellow,
            fontSize: 9,
            cursor: "pointer",
            padding: 0,
          }}
        >
          {copied ? "Copied!" : "Copy install"}
        </button>
        <a
          href="/claude"
          style={{ color: v2.muted, fontSize: 9, textDecoration: "none" }}
        >
          Full guide →
        </a>
      </div>

      {/* Config JSON pre-filled with the sandbox key (safe to paste). */}
      <div
        style={{
          marginTop: 12,
          fontSize: 8,
          letterSpacing: ".14em",
          textTransform: "uppercase",
          fontWeight: 700,
          color: v2.muted2,
        }}
      >
        Or paste this config{" "}
        <span style={{ color: "rgba(247,202,22,.7)", textTransform: "none", letterSpacing: 0 }}>
          (sandbox key)
        </span>
      </div>
      <div style={{ position: "relative", marginTop: 6 }}>
        <div
          style={{
            padding: 13,
            border: `1px solid ${v2.line}`,
            borderRadius: 10,
            background: v2.inputFill,
            color: "#aeb8c6",
            font: `500 9px/1.6 ${displayFont}`,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {config}
        </div>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(config);
            setJsonCopied(true);
            setTimeout(() => setJsonCopied(false), 1600);
          }}
          style={{
            position: "absolute",
            top: 9,
            right: 9,
            border: 0,
            background: "rgba(255,255,255,.05)",
            color: jsonCopied ? v2.mint : v2.muted,
            fontSize: 8,
            padding: "3px 7px",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          {jsonCopied ? "Copied!" : "Copy"}
        </button>
      </div>

      <div style={{ color: v2.muted2, fontSize: 9, marginTop: 10, lineHeight: 1.5 }}>
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
    padding: "9px 11px",
    fontSize: 10,
    color: v2.text,
    outline: "none",
  };

  return (
    <Surface style={{ padding: 18, marginTop: 12 }} radius={13}>
      <SectionHead
        title="Webhook"
        meta={
          <span style={{ color: v2.muted }}>
            Header <code style={{ color: "#cbd3dd" }}>X-Q402-Signature</code>
          </span>
        }
      />
      <div style={{ color: v2.muted, fontSize: 9, marginBottom: 12 }}>
        Signed POST after every relay.
        {webhookUrl && (
          <span style={{ color: v2.mint, marginLeft: 6 }}>· Active</span>
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
          onClick={saveWebhook}
          disabled={saving || !urlInput}
          style={{
            border: `1px solid rgba(247,202,22,.30)`,
            background: "rgba(247,202,22,.10)",
            color: v2.yellow,
            borderRadius: 10,
            padding: "0 16px",
            fontSize: 10,
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
              fontSize: 8,
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
              font: `500 10px ${displayFont}`,
              color: "#cbd3dd",
              wordBreak: "break-all",
              marginTop: 4,
            }}
          >
            {secret}
          </div>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(secret);
              setSecretCopied(true);
              setTimeout(() => setSecretCopied(false), 1600);
            }}
            style={{
              marginTop: 6,
              border: 0,
              background: "none",
              color: secretCopied ? v2.mint : v2.muted,
              fontSize: 9,
              cursor: "pointer",
              padding: 0,
            }}
          >
            {secretCopied ? "Copied!" : "Copy secret"}
          </button>
        </div>
      )}

      {webhookUrl && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
          <button
            type="button"
            onClick={testWebhook}
            disabled={testing}
            style={{
              border: `1px solid ${v2.line}`,
              background: "none",
              color: v2.muted,
              borderRadius: 8,
              padding: "6px 12px",
              fontSize: 9,
              cursor: testing ? "default" : "pointer",
              opacity: testing ? 0.4 : 1,
            }}
          >
            {testing ? "Sending…" : "▶ Test"}
          </button>
          {testResult && (
            <span
              style={{
                fontSize: 9,
                color: testResult.ok ? v2.mint : v2.red,
              }}
            >
              {testResult.ok ? "✓" : "✗"} {testResult.msg}
            </span>
          )}
        </div>
      )}
    </Surface>
  );
}

// ── API playground ───────────────────────────────────────────────────────────
// Ports the v1 <Playground/> simulate logic + per-chain token allowlist
// (app/dashboard/page.tsx:496) into v2 chrome. The simulate is a client-side
// preview (no relay) exactly as in v1 — same 1.8s fake settle + masked key.
type PgToken = "USDC" | "USDT" | "RLUSD";

function Playground({ apiKey, trialView }: { apiKey: string; trialView: boolean }) {
  const [chain, setChain] = useState(trialView ? "bnb" : "avax");
  const [token, setToken] = useState<PgToken>("USDC");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("5");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<null | { hash: string }>(null);

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
    fontSize: 8,
    letterSpacing: ".14em",
    textTransform: "uppercase",
    color: v2.muted2,
    display: "block",
    marginBottom: 6,
  };
  const field: React.CSSProperties = {
    width: "100%",
    background: v2.inputFill,
    border: `1px solid ${v2.line}`,
    borderRadius: 10,
    padding: "9px 11px",
    fontSize: 11,
    color: v2.text,
    outline: "none",
  };

  return (
    <Surface style={{ padding: 18, marginTop: 12 }} radius={13}>
      <SectionHead title="API playground" meta={trialView ? "Trial · BNB-only" : "Multichain"} />
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
            {trialView ? (
              <option value="bnb" style={{ background: v2.panel }}>
                BNB Chain ✓ (trial)
              </option>
            ) : (
              <>
                <option value="avax" style={{ background: v2.panel }}>Avalanche ✓</option>
                <option value="bnb" style={{ background: v2.panel }}>BNB Chain ✓</option>
                <option value="eth" style={{ background: v2.panel }}>Ethereum ✓</option>
                <option value="xlayer" style={{ background: v2.panel }}>X Layer ✓</option>
                <option value="stable" style={{ background: v2.panel }}>Stable ✓</option>
                <option value="mantle" style={{ background: v2.panel }}>Mantle ✓</option>
                <option value="injective" style={{ background: v2.panel }}>Injective ✓</option>
                <option value="monad" style={{ background: v2.panel }}>Monad ✓</option>
                <option value="scroll" style={{ background: v2.panel }}>Scroll ✓</option>
                <option value="arbitrum" style={{ background: v2.panel }}>Arbitrum ✓</option>
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

      <div
        style={{
          marginTop: 12,
          background: v2.inputFill,
          border: `1px solid ${v2.line}`,
          borderRadius: 10,
          padding: 13,
          font: `500 10px/1.7 ${displayFont}`,
          color: v2.muted,
          whiteSpace: "pre-wrap",
        }}
      >
        {`const tx = await q402.pay({\n  to: "${to}",\n  amount: "${amount}",\n  token: "${token}"\n});`}
      </div>

      <button
        type="button"
        onClick={simulate}
        disabled={loading}
        style={{
          marginTop: 12,
          border: 0,
          background: v2.yellow,
          color: v2.actionText,
          fontWeight: 700,
          fontSize: 11,
          padding: "10px 18px",
          borderRadius: 10,
          cursor: loading ? "default" : "pointer",
          opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? "Sending…" : "▶ Run simulation"}
      </button>

      {result && (
        <div
          style={{
            marginTop: 12,
            ...subCard(10, 0.0),
            background: "rgba(85,230,165,.05)",
            borderColor: "rgba(85,230,165,.20)",
            padding: 13,
            font: `500 10px/1.7 ${displayFont}`,
          }}
        >
          <div style={{ color: v2.mint, fontWeight: 700, marginBottom: 6 }}>
            ✓ Simulated
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

      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${v2.line}` }}>
        <div style={{ color: v2.muted2, fontSize: 9, marginBottom: 6 }}>
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
            padding: "7px 11px",
            font: `500 10px ${displayFont}`,
            color: v2.muted,
          }}
        >
          <span style={{ flex: 1, overflowWrap: "anywhere" }}>{maskKey(apiKey)}</span>
          <button
            type="button"
            onClick={() => apiKey && navigator.clipboard.writeText(apiKey)}
            style={{
              border: 0,
              background: "none",
              color: v2.muted2,
              fontSize: 8,
              letterSpacing: ".12em",
              textTransform: "uppercase",
              cursor: apiKey ? "pointer" : "default",
            }}
          >
            Copy
          </button>
        </div>
      </div>
    </Surface>
  );
}

// ── Documentation card ───────────────────────────────────────────────────────
function DocsCard() {
  return (
    <Surface style={{ padding: 18, marginTop: 12 }} radius={13}>
      <SectionHead
        title="Documentation"
        action={
          <a href="/docs" style={{ color: v2.yellow, fontSize: 9, textDecoration: "none" }}>
            Open docs →
          </a>
        }
      />
      <div style={{ color: v2.muted, fontSize: 10, lineHeight: 1.6 }}>
        API reference, gas-pool model, per-chain witness scheme, and the SDK
        integration guide live at{" "}
        <a href="/docs" style={{ color: v2.yellow, textDecoration: "none" }}>
          /docs
        </a>
        . MCP-specific walkthrough at{" "}
        <a href="/docs#claude-mcp" style={{ color: v2.yellow, textDecoration: "none" }}>
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
    multichainKey,
    trialKey,
    hasPaid,
    isTrialActive,
    trialCredits,
    sandboxKey,
    webhookUrl,
    setWebhookUrl,
    credsRef,
  } = useDeveloperData(ownerAddress, signMessage);

  // Section anchors for the context-rail scroll-spy nav.
  const refs: Record<SectionId, React.RefObject<HTMLDivElement | null>> = {
    credentials: useRef<HTMLDivElement>(null),
    mcp: useRef<HTMLDivElement>(null),
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
  const playgroundKey = trialView ? trialKey : multichainKey;

  return (
    <V2AccentScope style={{ paddingTop: 17 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "230px minmax(0,1fr)",
          gap: 16,
        }}
      >
        <ContextRail active={activeSection} onSelect={scrollTo} />

        <main style={{ ...glass(19), padding: 21 }}>
          <div style={{ font: `600 21px ${displayFont}`, letterSpacing: "-.04em" }}>
            Developer access
          </div>
          <div style={{ color: v2.muted, fontSize: 10, marginTop: 4 }}>
            Scoped credentials and AI-client integration without mixing product
            economics.
            {loading && <span style={{ color: v2.muted2 }}> · Loading…</span>}
          </div>

          {/* ── Credentials: BOTH keys side by side + webhook status ──── */}
          <div ref={refs.credentials} style={{ scrollMarginTop: 80 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(230px,1fr))",
                gap: 11,
                marginTop: 17,
              }}
            >
              <KeyCard
                eyebrow="Multichain API Key"
                apiKey={multichainKey}
                tag="LIVE"
                tagColor={v2.mint}
                sub="10 EVM chains · paid Gas Tank scope"
                active={scope === "multichain"}
                locked={!hasPaid || !multichainKey}
                lockedNote={
                  ownerAddress ? "Upgrade to unlock" : "Connect wallet"
                }
              />
              <KeyCard
                eyebrow="Trial API Key"
                apiKey={trialKey}
                tag="BNB"
                tagColor={v2.yellow}
                sub={`2,000 sponsored TX · 30-day trial${
                  isTrialActive ? ` · ${trialCredits.toLocaleString()} left` : ""
                }`}
                active={scope === "trial"}
                locked={!trialKey}
                lockedNote={
                  ownerAddress ? "Start a trial to unlock" : "Connect wallet"
                }
              />
              <WebhookStatusCard
                configured={!!webhookUrl}
                onConfigure={() => scrollTo("webhook")}
              />
            </div>
          </div>

          {/* ── MCP setup ───────────────────────────────────────────── */}
          <div ref={refs.mcp} style={{ scrollMarginTop: 80 }}>
            <McpSetupCard sandboxKey={sandboxKey} />
          </div>

          {/* ── Webhook config ──────────────────────────────────────── */}
          <div ref={refs.webhook} style={{ scrollMarginTop: 80 }}>
            <WebhookConfig
              address={ownerAddress}
              signMessage={signMessage}
              webhookUrl={webhookUrl}
              setWebhookUrl={setWebhookUrl}
              credsRef={credsRef}
            />
          </div>

          {/* ── API playground ──────────────────────────────────────── */}
          <div ref={refs.playground} style={{ scrollMarginTop: 80 }}>
            <Playground apiKey={playgroundKey} trialView={trialView} />
          </div>

          {/* ── Documentation ───────────────────────────────────────── */}
          <div ref={refs.docs} style={{ scrollMarginTop: 80 }}>
            <DocsCard />
          </div>
        </main>
      </div>
    </V2AccentScope>
  );
}
