"use client";

/**
 * AgenticWalletTab — Dashboard "Agent" tab.
 *
 * Server-managed signing wallet for AI agents. Trust model differs from
 * the canonical Q402 flow (server holds the AES-GCM-wrapped private key),
 * so the surface is deliberately framed as a custody-lite product: an
 * always-available signer scoped by the wallet's per-tx and per-day
 * limits.
 *
 * Phase 1 scope: create, view address, send single-recipient BNB-chain
 * USDC/USDT, soft-delete. Receive + Add Funds reveal the address with a
 * deposit notice. Multichain + export + MCP triple-mode ship in later
 * phases.
 */

import { useCallback, useEffect, useState } from "react";
import { getAuthCreds, clearAuthCache } from "@/app/lib/auth-client";
import { AgenticWalletCard } from "./AgenticWalletCard";

export interface AgenticWalletPublic {
  ownerAddr: string;
  address: string;
  createdAt: number;
  deletedAt: number | null;
  dailyLimitUsd: number | null;
  perTxMaxUsd: number | null;
  erc8004AgentId: string | null;
}

interface Props {
  address: string;
  signMessage: (message: string) => Promise<string | null>;
}

export function AgenticWalletTab({ address, signMessage }: Props) {
  const [wallet, setWallet] = useState<AgenticWalletPublic | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    const auth = await getAuthCreds(address, signMessage);
    if (!auth) {
      setError("Sign the auth challenge to load your Agent Wallet.");
      setWallet(null);
      return;
    }
    const qs = new URLSearchParams({ address, nonce: auth.nonce, sig: auth.signature }).toString();
    try {
      const res = await fetch(`/api/wallet/agentic?${qs}`);
      const data = await res.json();
      if (res.status === 401 && data.code === "NONCE_EXPIRED") {
        clearAuthCache(address);
        setError("Session expired — sign in again to refresh.");
        setWallet(null);
        return;
      }
      if (!res.ok) {
        setError(data.error ?? "Failed to load Agent Wallet.");
        setWallet(null);
        return;
      }
      setWallet(data.wallet ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWallet(null);
    }
  }, [address, signMessage]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const auth = await getAuthCreds(address, signMessage);
      if (!auth) {
        setError("Sign the auth challenge to create a wallet.");
        return;
      }
      const res = await fetch("/api/wallet/agentic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, nonce: auth.nonce, signature: auth.signature }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? "Failed to create wallet.");
        return;
      }
      setWallet(data.wallet);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [address, signMessage]);

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-200/85">
          {error}
        </div>
      )}

      {wallet === undefined && (
        <div className="text-white/40 text-sm">Loading…</div>
      )}

      {wallet === null && <EmptyHero onCreate={create} creating={creating} />}

      {wallet && (
        <AgenticWalletCard
          wallet={wallet}
          address={address}
          signMessage={signMessage}
          onChanged={() => void reload()}
        />
      )}

      {wallet && <InstallSnippet />}

      {wallet && <SubCards />}
    </div>
  );
}

// ── Empty hero (no wallet yet) ─────────────────────────────────────────────

function EmptyHero({ onCreate, creating }: { onCreate: () => void; creating: boolean }) {
  return (
    <div
      className="rounded-2xl border p-7 relative overflow-hidden"
      style={{
        background: "linear-gradient(135deg, #0F1929 0%, #0A1521 100%)",
        borderColor: "rgba(74,222,128,0.18)",
      }}
    >
      <DotPattern />
      <div className="relative space-y-5 max-w-2xl">
        <div className="text-[10px] uppercase tracking-[0.22em] text-emerald-400 font-bold">
          New
        </div>
        <h2 className="text-2xl font-semibold text-white">Create your Agent Wallet</h2>
        <p className="text-white/55 text-sm leading-relaxed">
          A Q402-managed wallet your AI signs through. Server holds the key (AES-256-GCM
          encrypted) so your agent runs without wallet popups. Per-tx and per-day limits
          bound the spend.
        </p>
        <button
          type="button"
          onClick={onCreate}
          disabled={creating}
          className="px-5 py-2 rounded-full text-sm font-semibold bg-emerald-400 text-slate-900 hover:bg-emerald-300 disabled:opacity-50 transition-colors"
        >
          {creating ? "Creating…" : "Create Agent Wallet"}
        </button>
      </div>
    </div>
  );
}

// ── Install snippet card ───────────────────────────────────────────────────

function InstallSnippet() {
  const [copied, setCopied] = useState(false);
  const cmd = "npx @quackai/q402-mcp";

  async function copy() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      className="rounded-2xl border p-5"
      style={{ background: "#0F1929", borderColor: "rgba(255,255,255,0.07)" }}
    >
      <div className="text-white font-semibold mb-1">Start using your Agent Wallet</div>
      <div className="text-white/45 text-xs mb-4">
        Install Q402 MCP in any AI client. Today the wallet signs via the dashboard;
        full agent triple-mode auth ships in the next phase.
      </div>
      <div
        className="rounded-md border px-3 py-2.5 flex items-center justify-between font-mono text-sm text-white/85"
        style={{ background: "rgba(74,222,128,0.06)", borderColor: "rgba(74,222,128,0.18)" }}
      >
        <span>
          <span className="text-emerald-400/70 mr-2">{">"}</span>
          {cmd}
        </span>
        <button
          type="button"
          onClick={copy}
          className="text-[11px] text-white/50 hover:text-emerald-300 transition-colors"
        >
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
      <a
        href="/docs#claude-mcp"
        className="inline-block mt-3 text-[12px] text-emerald-400 hover:text-emerald-300"
      >
        View quickstart guide →
      </a>
    </div>
  );
}

// ── Sub cards: Active Sessions + Recent Activity ───────────────────────────

function SubCards() {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div
        className="rounded-2xl border p-6 flex flex-col items-center text-center"
        style={{ background: "#0F1929", borderColor: "rgba(255,255,255,0.07)" }}
      >
        <div className="text-white font-semibold mb-3">Active Agents</div>
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center mb-2"
          style={{ background: "rgba(74,222,128,0.08)", color: "#86efac" }}
        >
          ⌬
        </div>
        <div className="text-[12px] text-white/40 leading-relaxed">
          No agents yet. Agent sessions appear here once the MCP triple-mode auth ships.
        </div>
      </div>

      <div
        className="rounded-2xl border p-6 flex flex-col items-center text-center"
        style={{ background: "#0F1929", borderColor: "rgba(255,255,255,0.07)" }}
      >
        <div className="text-white font-semibold mb-3">Recent Activity</div>
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center mb-2"
          style={{ background: "rgba(74,222,128,0.08)", color: "#86efac" }}
        >
          ◷
        </div>
        <div className="text-[12px] text-white/40 leading-relaxed">
          Transactions from this wallet will appear here. Check <span className="text-white/55">Transactions</span> tab for the full list.
        </div>
      </div>
    </div>
  );
}

// ── Decorative dot pattern (top-right of hero) ─────────────────────────────

function DotPattern() {
  return (
    <div
      aria-hidden
      className="absolute top-0 right-0 h-full w-1/2 pointer-events-none opacity-40"
      style={{
        background:
          "radial-gradient(circle, rgba(74,222,128,0.25) 1px, transparent 1.5px) 0 0 / 14px 14px",
        maskImage: "linear-gradient(to left, black 0%, black 30%, transparent 80%)",
        WebkitMaskImage: "linear-gradient(to left, black 0%, black 30%, transparent 80%)",
      }}
    />
  );
}
