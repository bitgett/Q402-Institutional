"use client";

/**
 * AgenticWalletFooter — wallet identity + utilities surface.
 *
 * Sits at the bottom of the Agent tab and consolidates the two
 * addresses a user has to track: their MetaMask EOA (signing identity)
 * and the Q402-managed Agent Wallet (spending identity). The two are
 * deliberately styled differently so a glance can tell them apart:
 *
 *   • Owner EOA   — sky tint, "you sign with this"
 *   • Agent Wallet — emerald tint, "your AI spends with this"
 *
 * Below the address pair, a small Utilities row surfaces EIP-7702
 * delegation status as read-only info. Clearing it is intentionally
 * NOT exposed as a UI button — the in-browser `wallet_signAuthorization`
 * RPC isn't supported uniformly (OKX, older MetaMask), so we route the
 * action through `scripts/clear-delegation.mjs` (CLI) or the
 * `q402_clear_delegation` MCP tool. Both sign locally and POST to
 * `/api/wallet/clear-delegation` where the relayer sponsors the gas.
 */

import { useEffect, useState } from "react";
import type { ChainKey } from "@/app/lib/relayer";

interface Props {
  ownerAddress: string;
  walletAddress: string;
}

interface DelegationState {
  delegated: boolean;
  impl?: string;
  error?: string;
}

interface DelegationStatusBody {
  address: string;
  chains: Partial<Record<ChainKey, DelegationState>>;
  summary: string;
}

const CHAIN_LABEL: Partial<Record<ChainKey, string>> = {
  bnb: "BNB Chain",
  eth: "Ethereum",
  avax: "Avalanche",
  xlayer: "X Layer",
  stable: "Stable",
  mantle: "Mantle",
  injective: "Injective",
  monad: "Monad",
  scroll: "Scroll",
  base: "Base",
};

export function AgenticWalletFooter({ ownerAddress, walletAddress }: Props) {
  const [ownerCopied, setOwnerCopied] = useState(false);
  const [agentCopied, setAgentCopied] = useState(false);
  const [delegationStatus, setDelegationStatus] = useState<DelegationStatusBody | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/wallet/delegation-status?address=${ownerAddress}`);
        if (!res.ok || !alive) return;
        const data = (await res.json()) as DelegationStatusBody;
        if (alive) setDelegationStatus(data);
      } catch {
        /* non-fatal — status row stays hidden if read fails */
      }
    })();
    return () => { alive = false; };
  }, [ownerAddress]);

  const delegatedChains = delegationStatus
    ? (Object.entries(delegationStatus.chains) as Array<[ChainKey, DelegationState]>).filter(
        ([, s]) => s.delegated,
      )
    : [];
  // Chains whose delegation lookup ERRORED (RPC failure) — distinct from "clean,
  // not delegated". Without this, an all-RPC-failure read collapses to
  // delegatedChains.length === 0 and we'd falsely claim "not delegated anywhere".
  const erroredChains = delegationStatus
    ? (Object.entries(delegationStatus.chains) as Array<[ChainKey, DelegationState]>).filter(
        ([, s]) => !!s.error,
      )
    : [];

  async function copy(text: string, setter: (v: boolean) => void) {
    try {
      await navigator.clipboard.writeText(text);
      setter(true);
      setTimeout(() => setter(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      className="rounded-2xl border p-5 space-y-4"
      style={{ background: "rgba(255,255,255,0.012)", borderColor: "rgba(255,255,255,0.06)" }}
    >
        <div className="text-[10px] uppercase tracking-[0.22em] text-white/70 font-semibold">
          Wallet Identities
        </div>

        <div className="grid md:grid-cols-2 gap-3">
          {/* Owner EOA — sky-blue tint */}
          <div
            className="rounded-xl border p-4"
            style={{
              background: "rgba(56,189,248,0.04)",
              borderColor: "rgba(56,189,248,0.22)",
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-widest font-semibold" style={{ color: "#7dd3fc" }}>
                Owner EOA
              </div>
              <span className="text-[10px] text-white/60">you sign with this</span>
            </div>
            <div className="font-mono text-[13px] text-white/90 break-all leading-relaxed mb-2">
              {ownerAddress}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => copy(ownerAddress, setOwnerCopied)}
                className="text-[11px] px-2 py-1 rounded-md font-medium transition-colors"
                style={{
                  background: "rgba(56,189,248,0.10)",
                  color: "#7dd3fc",
                  border: "1px solid rgba(56,189,248,0.25)",
                }}
              >
                {ownerCopied ? "Copied ✓" : "Copy"}
              </button>
              <a
                href={`https://bscscan.com/address/${ownerAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-white/70 hover:text-white transition-colors"
              >
                BscScan ↗
              </a>
            </div>
          </div>

          {/* Agent Wallet — emerald tint */}
          <div
            className="rounded-xl border p-4"
            style={{
              background: "rgba(74,222,128,0.04)",
              borderColor: "rgba(74,222,128,0.22)",
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-widest font-semibold text-emerald-300">
                Agent Wallet
              </div>
              <span className="text-[10px] text-white/60">your AI spends with this</span>
            </div>
            <div className="font-mono text-[13px] text-white/90 break-all leading-relaxed mb-2">
              {walletAddress}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => copy(walletAddress, setAgentCopied)}
                className="text-[11px] px-2 py-1 rounded-md font-medium transition-colors bg-emerald-400/10 text-emerald-300 border border-emerald-400/25"
              >
                {agentCopied ? "Copied ✓" : "Copy"}
              </button>
              <a
                href={`https://bscscan.com/address/${walletAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-white/70 hover:text-white transition-colors"
              >
                BscScan ↗
              </a>
            </div>
          </div>
        </div>

        {delegatedChains.length > 0 && (
          <div
            className="rounded-md border px-3 py-2.5 space-y-1.5"
            style={{
              background: "rgba(252,211,77,0.05)",
              borderColor: "rgba(252,211,77,0.22)",
              color: "#fde68a",
            }}
          >
            <div className="text-[12px] leading-relaxed">
              <span className="font-semibold">EIP-7702 delegation active</span> on{" "}
              {delegatedChains.map(([c]) => CHAIN_LABEL[c] ?? c).join(", ")}.
            </div>
            <div className="text-[11px] text-amber-200/80 leading-relaxed">
              Clear via CLI: <code className="font-mono">node scripts/clear-delegation.mjs</code>
              {" "}— or use the <code className="font-mono">q402_clear_delegation</code> MCP tool
              from Claude / Codex. Gas is sponsored.
            </div>
          </div>
        )}

      {delegationStatus && delegatedChains.length === 0 && erroredChains.length === 0 && (
        <div className="text-[11px] text-white/60">
          ✓ Owner EOA is not EIP-7702-delegated on any supported chain.
        </div>
      )}

      {delegationStatus && erroredChains.length > 0 && (
        <div className="text-[11px] text-amber-200/70">
          Could not check delegation on{" "}
          {erroredChains.map(([c]) => CHAIN_LABEL[c] ?? c).join(", ")} (RPC error) — status unknown for those chains.
        </div>
      )}
    </div>
  );
}
