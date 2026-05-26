"use client";

/**
 * AgenticWalletTab — Dashboard "Agent" tab (multi-wallet Phase 3).
 *
 * Owners can hold up to MAX_WALLETS_PER_OWNER (10) Agent Wallets. The
 * dashboard renders a wallet selector (horizontal tabs) above the
 * active wallet's console; "+ New wallet" creates a fresh slot until
 * the per-plan cap is hit.
 *
 * Trust model: Q402 holds the AES-GCM-encrypted private key for each
 * wallet. Per-tx and per-day caps are scoped per-wallet so an
 * over-aggressive AI on one wallet can't drain budgets reserved on
 * another.
 *
 * Empty state: when the owner has zero wallets we render the marketing
 * preview (AgenticWalletPreview) so the value proposition lands before
 * they commit. The Create CTA inside the preview kicks off the first
 * wallet.
 */

import { useCallback, useEffect, useState } from "react";
import { getAuthCreds, clearAuthCache } from "@/app/lib/auth-client";
import { AgenticWalletCard } from "./AgenticWalletCard";
import { AgenticWalletPreview } from "./AgenticWalletPreview";
import { AgenticWalletFooter } from "./AgenticWalletFooter";
import { AgenticWalletDangerZone } from "./AgenticWalletDangerZone";

export interface AgenticWalletPublic {
  ownerAddr: string;
  address: string;
  /** Lowercased wallet address — used as the walletId throughout the API. */
  walletId: string;
  createdAt: number;
  deletedAt: number | null;
  dailyLimitUsd: number | null;
  perTxMaxUsd: number | null;
  erc8004AgentId: string | null;
  label: string | null;
}

interface Props {
  address: string;
  signMessage: (message: string) => Promise<string | null>;
}

interface ListResponse {
  wallets: AgenticWalletPublic[];
  hasMultichainScope: boolean;
  cap: number;
  max: number;
  trialCap: number;
}

export function AgenticWalletTab({ address, signMessage }: Props) {
  const [wallets, setWallets] = useState<AgenticWalletPublic[] | undefined>(undefined);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ cap: number; max: number; hasMultichainScope: boolean; trialCap: number }>({
    cap: 1,
    max: 10,
    hasMultichainScope: false,
    trialCap: 1,
  });
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /**
   * Counter the Card listens to via a useEffect — bumping it forces a
   * fresh on-chain balance fetch even when the wallet record itself is
   * unchanged. Closes audit P1 #5 (Holdings refresh): previously
   * onChanged just reloaded the wallet record, never the balance.
   */
  const [balanceRefreshTick, setBalanceRefreshTick] = useState(0);

  const reload = useCallback(async (): Promise<ListResponse | null> => {
    setError(null);
    const auth = await getAuthCreds(address, signMessage);
    if (!auth) {
      setError("Sign the auth challenge to load your Agent Wallets.");
      setWallets([]);
      return null;
    }
    const qs = new URLSearchParams({ address, nonce: auth.nonce, sig: auth.signature }).toString();
    try {
      const res = await fetch(`/api/wallet/agentic?${qs}`);
      const data = await res.json();
      if (res.status === 401 && data.code === "NONCE_EXPIRED") {
        clearAuthCache(address);
        setError("Session expired — sign in again to refresh.");
        setWallets([]);
        return null;
      }
      if (!res.ok) {
        setError(data.error ?? "Failed to load Agent Wallets.");
        setWallets([]);
        return null;
      }
      const list = (data.wallets ?? []) as AgenticWalletPublic[];
      setWallets(list);
      setMeta({
        cap: typeof data.cap === "number" ? data.cap : 1,
        max: typeof data.max === "number" ? data.max : 10,
        hasMultichainScope: Boolean(data.hasMultichainScope),
        trialCap: typeof data.trialCap === "number" ? data.trialCap : 1,
      });
      // Preserve active selection if still present; otherwise default to
      // the first active wallet, then any wallet.
      setActiveId((prev) => {
        if (prev && list.some((w) => w.walletId === prev)) return prev;
        const firstActive = list.find((w) => !w.deletedAt);
        return firstActive?.walletId ?? list[0]?.walletId ?? null;
      });
      return data as ListResponse;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWallets([]);
      return null;
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
      // Newly-created wallet returns { wallet: {...} }. Add it to the
      // list and select it.
      const fresh = data.wallet as AgenticWalletPublic;
      setWallets((prev) => (prev ? [...prev, fresh] : [fresh]));
      setActiveId(fresh.walletId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [address, signMessage]);

  // ── Loading + empty states ─────────────────────────────────────────────
  if (wallets === undefined) {
    return <div className="text-white/40 text-sm">Loading…</div>;
  }

  // No wallets yet — marketing preview + first-create CTA.
  if (wallets.length === 0) {
    return (
      <div className="space-y-6">
        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-200/85">
            {error}
          </div>
        )}
        <AgenticWalletPreview onCreate={create} creating={creating} />
      </div>
    );
  }

  const activeWallet =
    wallets.find((w) => w.walletId === activeId) ?? wallets[0];
  const activeCount = wallets.filter((w) => !w.deletedAt).length;
  const capReached = activeCount >= meta.cap;

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-200/85">
          {error}
        </div>
      )}

      <WalletSelector
        wallets={wallets}
        activeId={activeWallet.walletId}
        onSelect={setActiveId}
        onCreate={create}
        creating={creating}
        cap={meta.cap}
        max={meta.max}
        capReached={capReached}
        hasMultichainScope={meta.hasMultichainScope}
      />

      <AgenticWalletCard
        wallet={activeWallet}
        address={address}
        signMessage={signMessage}
        hasMultichainScope={meta.hasMultichainScope}
        balanceRefreshTick={balanceRefreshTick}
        onChanged={() => {
          void reload();
          setBalanceRefreshTick((t) => t + 1);
        }}
      />

      <InstallSnippet />

      <AgenticWalletFooter ownerAddress={address} walletAddress={activeWallet.address} />

      <AgenticWalletDangerZone
        wallet={activeWallet}
        address={address}
        signMessage={signMessage}
        onChanged={() => {
          void reload();
          setBalanceRefreshTick((t) => t + 1);
        }}
        balanceUsd={null}
        onRequestBalanceRefresh={() => setBalanceRefreshTick((t) => t + 1)}
      />
    </div>
  );
}

// ── Wallet selector ───────────────────────────────────────────────────────

/**
 * Horizontal tab strip over the owner's wallets. When the owner has just
 * one wallet the tab strip is suppressed entirely — only the
 * "+ New wallet" affordance shows up — because a single-wallet selector
 * is just visual noise.
 *
 * Soft-deleted wallets still render as tabs but with a muted style so
 * the user can find them to restore. The trailing tab is the "+ New"
 * action, disabled at the per-plan cap with a tooltip explaining why.
 */
function WalletSelector({
  wallets,
  activeId,
  onSelect,
  onCreate,
  creating,
  cap,
  max,
  capReached,
  hasMultichainScope,
}: {
  wallets: AgenticWalletPublic[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  creating: boolean;
  cap: number;
  max: number;
  capReached: boolean;
  hasMultichainScope: boolean;
}) {
  const onlyOne = wallets.length === 1;
  const capCopy = capReached
    ? hasMultichainScope
      ? `Cap reached (${wallets.length}/${max}). Archive a wallet to create a new one.`
      : `Trial cap (1). Upgrade to Multichain for up to ${max}.`
    : `Up to ${cap === max ? cap : `${cap} on this plan`} wallets`;

  // Hide the strip entirely when there's a single wallet AND no head-
  // room — nothing actionable for the user to see.
  if (onlyOne && capReached) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {wallets.map((w) => {
          const isActive = w.walletId === activeId;
          const archived = !!w.deletedAt;
          return (
            <button
              key={w.walletId}
              type="button"
              onClick={() => onSelect(w.walletId)}
              className={`shrink-0 px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors border ${
                isActive
                  ? "bg-emerald-400/15 text-emerald-200 border-emerald-400/40"
                  : archived
                    ? "bg-white/[0.015] text-white/30 border-white/[0.06] hover:text-white/55"
                    : "bg-white/[0.015] text-white/65 border-white/[0.08] hover:text-white"
              }`}
              title={`${w.address}${archived ? " (archived)" : ""}`}
            >
              <span className="font-mono">
                {w.label ?? `${w.address.slice(0, 6)}…${w.address.slice(-4)}`}
              </span>
              {archived && <span className="ml-1.5 text-[10px] opacity-70">archived</span>}
            </button>
          );
        })}

        <button
          type="button"
          onClick={onCreate}
          disabled={creating || capReached}
          className="shrink-0 px-3 py-1.5 rounded-md text-[12px] font-medium border border-dashed border-white/15 text-white/50 hover:text-emerald-300 hover:border-emerald-400/40 disabled:opacity-30 disabled:cursor-not-allowed"
          title={capReached ? capCopy : "Create a new Agent Wallet"}
        >
          {creating ? "Creating…" : "+ New wallet"}
        </button>
      </div>
      <div className="text-[10.5px] text-white/35 px-0.5">
        {capCopy}
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
