"use client";

/**
 * AgenticWalletTab — Dashboard "Agent" tab.
 *
 * Server-managed signing wallet for AI agents. The trust model differs
 * from the canonical Q402 flow (server holds the encrypted private key),
 * so the surface is deliberately framed as a custody-lite product: an
 * always-available signer scoped by the wallet's per-tx and per-day
 * limits.
 *
 * Empty-state UX: rather than gate the entire UI behind a single
 * "Create" CTA, we render the whole wallet console as a *preview*
 * before activation. The viewer can read the stat tiles, the prompt
 * examples, and the "how it works" recap, then click Create from
 * inside that context — the act feels like activating something they
 * can already see, not starting from a blank slate.
 *
 * Surface today: create, view address, send single-recipient or batch
 * across 9 EVM chains (BNB free, the remaining 8 gated by multichain
 * scope), withdraw to the owner's EOA, edit spending limits, export
 * the private key behind step-up auth, soft-delete with a 7-day grace
 * window, and balance polling across all 9 chains via Multicall3.
 */

import { useCallback, useEffect, useState } from "react";
import { getAuthCreds, clearAuthCache } from "@/app/lib/auth-client";
import { AgenticWalletCard } from "./AgenticWalletCard";
import { AgenticWalletPreview } from "./AgenticWalletPreview";

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
  const [hasMultichainScope, setHasMultichainScope] = useState<boolean>(false);
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
      setHasMultichainScope(Boolean(data.hasMultichainScope));
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

      {wallet === null && <AgenticWalletPreview onCreate={create} creating={creating} />}

      {wallet && (
        <AgenticWalletCard
          wallet={wallet}
          address={address}
          signMessage={signMessage}
          hasMultichainScope={hasMultichainScope}
          onChanged={() => void reload()}
        />
      )}

      {wallet && <InstallSnippet />}
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
      className="rounded-xl border px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm"
      style={{ background: "rgba(255,255,255,0.015)", borderColor: "rgba(255,255,255,0.06)" }}
    >
      <span className="text-white/55">Connect this wallet to an AI client:</span>
      <code className="font-mono text-white/80 text-[13px]">{cmd}</code>
      <button
        type="button"
        onClick={copy}
        className="text-[12px] text-white/50 hover:text-emerald-300 transition-colors"
      >
        {copied ? "copied ✓" : "copy"}
      </button>
      <a
        href="/docs#claude-mcp"
        className="ml-auto text-[12px] text-emerald-400/85 hover:text-emerald-300"
      >
        Quickstart →
      </a>
    </div>
  );
}

