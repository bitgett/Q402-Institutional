"use client";

/**
 * AgenticWalletHooksModal — configure Q402 Hooks 1.0 per Agent Wallet.
 *
 * Three opt-in policies (ComplianceGate is global, no config):
 *   - SpendCapPolicy    — recipient allowlist, UTC windows, soft per-call
 *                         approval threshold.
 *   - ReputationGate    — ERC-8004 minimum score + onUnknown policy.
 *   - MultiPayeeSplit    — default N-way split (bps sum to 10000).
 *
 * Reads the current config with the cached session sig (GET, low-
 * sensitivity). Writes are intent-bound (`agentic.hooks_config`) over
 * `{ walletId, configHash }` where configHash = keccak256(canonical
 * config) — same hash the server recomputes, so the signature is
 * provably tied to THIS exact policy. A leaked session sig can't change
 * a different wallet's policy, and a MITM can't swap the config.
 */

import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { getAuthCreds, getActionAuth } from "@/app/lib/auth-client";
import { canonicalHookConfig } from "@/app/lib/hooks/canonical";
import type { WalletHookConfig } from "@/app/lib/hooks/types";
import { useModalEscape } from "./useModalEscape";

interface Props {
  ownerAddress: string;
  walletId: string;
  signMessage: (message: string) => Promise<string | null>;
  onClose: () => void;
  onSaved: () => void;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function AgenticWalletHooksModal({ ownerAddress, walletId, signMessage, onClose, onSaved }: Props) {
  // SpendCapPolicy
  const [scEnabled, setScEnabled] = useState(false);
  const [allowedRecipients, setAllowedRecipients] = useState(""); // newline/comma separated
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [perCallApproval, setPerCallApproval] = useState("");
  // ReputationGate
  const [rgEnabled, setRgEnabled] = useState(false);
  const [minScore, setMinScore] = useState("");
  const [onUnknown, setOnUnknown] = useState<"allow" | "deny">("allow");
  // MultiPayeeSplit
  const [msEnabled, setMsEnabled] = useState(false);
  const [splitsRaw, setSplitsRaw] = useState(""); // "0xabc:7000\n0xdef:3000"

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  useModalEscape(onClose, saving);

  // ── Load current config (cached session sig, no fresh popup) ──────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const creds = await getAuthCreds(ownerAddress, signMessage);
        if (!creds) { if (!cancelled) { setError("Sign in to load hook config."); setLoading(false); } return; }
        const qs = new URLSearchParams({ walletId, address: ownerAddress, nonce: creds.nonce, signature: creds.signature });
        const res = await fetch(`/api/wallet/agentic/hooks?${qs.toString()}`);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && data.config) hydrate(data.config as WalletHookConfig);
        setLoading(false);
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function hydrate(cfg: WalletHookConfig) {
    if (cfg.spendCap) {
      setScEnabled(!!cfg.spendCap.enabled);
      setAllowedRecipients((cfg.spendCap.allowedRecipients ?? []).join("\n"));
      const w = cfg.spendCap.allowedWindowsUtc?.[0];
      setWindowStart(w ? String(w.startHour) : "");
      setWindowEnd(w ? String(w.endHour) : "");
      setPerCallApproval(cfg.spendCap.perCallApprovalUsd != null ? String(cfg.spendCap.perCallApprovalUsd) : "");
    }
    if (cfg.reputationGate) {
      setRgEnabled(!!cfg.reputationGate.enabled);
      setMinScore(cfg.reputationGate.minScore != null ? String(cfg.reputationGate.minScore) : "");
      setOnUnknown(cfg.reputationGate.onUnknown === "deny" ? "deny" : "allow");
    }
    if (cfg.multiPayeeSplit) {
      setMsEnabled(!!cfg.multiPayeeSplit.enabled);
      setSplitsRaw((cfg.multiPayeeSplit.defaultSplits ?? []).map((s) => `${s.recipient}:${s.bps}`).join("\n"));
    }
  }

  // ── Build config from the form (returns string error or the object) ───
  function buildConfig(): WalletHookConfig | string {
    const config: WalletHookConfig = {};

    if (scEnabled) {
      const sc: NonNullable<WalletHookConfig["spendCap"]> = { enabled: true };
      const recips = allowedRecipients.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      if (recips.length > 0) {
        for (const r of recips) if (!ADDR_RE.test(r)) return `Allowed recipient is not a 0x address: ${r}`;
        sc.allowedRecipients = recips.map((r) => r.toLowerCase());
      }
      if (windowStart.trim() !== "" || windowEnd.trim() !== "") {
        const s = Number(windowStart), e = Number(windowEnd);
        if (!Number.isInteger(s) || s < 0 || s > 23) return "Window start must be 0–23.";
        if (!Number.isInteger(e) || e < 1 || e > 24) return "Window end must be 1–24.";
        if (e <= s) return "Window end must be after start.";
        sc.allowedWindowsUtc = [{ startHour: s, endHour: e }];
      }
      if (perCallApproval.trim() !== "") {
        const n = Number(perCallApproval);
        if (!Number.isFinite(n) || n <= 0) return "Per-call approval threshold must be a positive number.";
        sc.perCallApprovalUsd = n;
      }
      config.spendCap = sc;
    }

    if (rgEnabled) {
      const n = Number(minScore);
      if (minScore.trim() === "" || !Number.isFinite(n)) return "Reputation min score must be a number.";
      config.reputationGate = { enabled: true, minScore: n, onUnknown };
    }

    if (msEnabled) {
      const legs = splitsRaw.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const [recipient, bps] = l.split(":").map((x) => x.trim());
        return { recipient, bps: Number(bps) };
      });
      if (legs.length === 0) return "Add at least one split leg (format: 0xADDRESS:BPS).";
      let total = 0;
      for (const leg of legs) {
        if (!ADDR_RE.test(leg.recipient)) return `Split recipient is not a 0x address: ${leg.recipient}`;
        if (!Number.isInteger(leg.bps) || leg.bps <= 0) return `Split bps must be a positive integer: ${leg.bps}`;
        total += leg.bps;
      }
      if (total !== 10000) return `Split bps must sum to 10000 (got ${total}).`;
      config.multiPayeeSplit = { enabled: true, defaultSplits: legs.map((l) => ({ recipient: l.recipient.toLowerCase(), bps: l.bps })) };
    }

    return config;
  }

  async function submit() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    const built = buildConfig();
    if (typeof built === "string") {
      setError(built);
      inFlightRef.current = false;
      return;
    }
    setSaving(true);
    try {
      const configHash = ethers.keccak256(ethers.toUtf8Bytes(canonicalHookConfig(built)));
      const auth = await getActionAuth(ownerAddress, "agentic.hooks_config", { walletId, configHash }, signMessage);
      if (!auth) { setError("Sign the hook-config challenge in your wallet to save."); return; }
      const res = await fetch("/api/wallet/agentic/hooks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: ownerAddress, walletId, nonce: auth.challenge, signature: auth.signature, config: built }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? data.message ?? `Save failed (HTTP ${res.status}).`); return; }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
      inFlightRef.current = false;
    }
  }

  const labelCls = "text-[11px] text-white/45 uppercase tracking-widest mb-1";
  const inputCls = "w-full rounded-md border px-3 py-2 text-sm font-mono text-white placeholder-white/25";
  const inputStyle = { background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" } as const;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(2,6,15,0.72)" }}
      onClick={saving ? undefined : onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="hooks-modal-title"
    >
      <div
        className="w-full max-w-lg rounded-2xl border p-6 space-y-4 max-h-[88vh] overflow-y-auto"
        style={{ background: "#0F1929", borderColor: "rgba(74,222,128,0.20)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div id="hooks-modal-title" className="text-white font-semibold text-lg">Q402 Hooks</div>
            <div className="text-[11px] text-white/45 mt-0.5">Programmable payment policies. Compliance screening is always on.</div>
          </div>
          <button type="button" onClick={saving ? undefined : onClose} disabled={saving}
            className="text-white/40 hover:text-white text-lg leading-none disabled:opacity-30 disabled:cursor-not-allowed" aria-label="Close">×</button>
        </div>

        {loading ? (
          <div className="text-white/50 text-sm py-8 text-center">Loading current policy…</div>
        ) : (
          <>
            {/* SpendCapPolicy */}
            <Section title="Spend Cap" enabled={scEnabled} onToggle={setScEnabled}>
              <div>
                <div className={labelCls}>Allowed recipients (one per line; empty = no whitelist)</div>
                <textarea value={allowedRecipients} onChange={(e) => setAllowedRecipients(e.target.value)} rows={2}
                  placeholder={"0xabc...\n0xdef..."} className={inputCls} style={inputStyle} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className={labelCls}>Window start (UTC h)</div>
                  <input value={windowStart} onChange={(e) => setWindowStart(e.target.value)} inputMode="numeric" placeholder="9" className={inputCls} style={inputStyle} />
                </div>
                <div>
                  <div className={labelCls}>Window end (UTC h)</div>
                  <input value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} inputMode="numeric" placeholder="17" className={inputCls} style={inputStyle} />
                </div>
              </div>
              <div>
                <div className={labelCls}>Approval threshold (USD; ≥ this needs human approval)</div>
                <input value={perCallApproval} onChange={(e) => setPerCallApproval(e.target.value)} inputMode="decimal" placeholder="100" className={inputCls} style={inputStyle} />
              </div>
            </Section>

            {/* ReputationGate */}
            <Section title="Reputation Gate" enabled={rgEnabled} onToggle={setRgEnabled}>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className={labelCls}>Min ERC-8004 score</div>
                  <input value={minScore} onChange={(e) => setMinScore(e.target.value)} inputMode="decimal" placeholder="5" className={inputCls} style={inputStyle} />
                </div>
                <div>
                  <div className={labelCls}>If unverifiable</div>
                  <select value={onUnknown} onChange={(e) => setOnUnknown(e.target.value === "deny" ? "deny" : "allow")}
                    className={inputCls} style={inputStyle}>
                    <option value="allow">allow</option>
                    <option value="deny">deny</option>
                  </select>
                </div>
              </div>
            </Section>

            {/* MultiPayeeSplit */}
            <Section title="Multi-Payee Split" enabled={msEnabled} onToggle={setMsEnabled}>
              <div>
                <div className={labelCls}>Default split — one leg per line, 0xADDRESS:BPS (sum 10000)</div>
                <textarea value={splitsRaw} onChange={(e) => setSplitsRaw(e.target.value)} rows={3}
                  placeholder={"0xRoyalty...:7000\n0xRevenue...:2500\n0xFee...:500"} className={inputCls} style={inputStyle} />
              </div>
            </Section>

            {error && <div className="text-[12px] text-red-300/85">{error}</div>}

            <button type="button" onClick={submit} disabled={saving}
              className="w-full px-3 py-2 rounded-md text-sm font-semibold bg-emerald-400 text-slate-900 hover:bg-emerald-300 disabled:opacity-40">
              {saving ? "Saving…" : "Save hook policy"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, enabled, onToggle, children }: {
  title: string; enabled: boolean; onToggle: (v: boolean) => void; children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: "rgba(255,255,255,0.07)" }}>
      <label className="flex items-center justify-between cursor-pointer">
        <span className="text-sm font-medium text-white">{title}</span>
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} className="accent-emerald-400 w-4 h-4" />
      </label>
      {enabled && <div className="space-y-2 pt-1">{children}</div>}
    </div>
  );
}
