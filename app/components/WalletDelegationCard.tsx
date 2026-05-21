"use client";

/**
 * Dashboard widget — per-chain EIP-7702 delegation status + per-chain
 * "Clear delegation" action.
 *
 * Lifecycle:
 *   1. Mount → GET /api/wallet/delegation-status?address=... → render rows
 *   2. User clicks "Clear" on a delegated chain
 *      a. Switch wallet to the target chain via wallet_switchEthereumChain
 *      b. Read the EOA's current nonce from the wallet's RPC
 *      c. Ask the wallet to sign an EIP-7702 authorization with address=0x0
 *         (ethers v6.16+'s `signer.authorize()` — same pattern used by the
 *         Q402 SDK for normal payments)
 *      d. POST signed authorization to /api/wallet/clear-delegation
 *      e. On 200, optimistically flip the row to "Not delegated", surface
 *         the explorer TX link, and refresh the whole card after a beat
 *         so the result is grounded in a fresh RPC read.
 */

import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { useWallet } from "../context/WalletContext";
import { getActiveProvider } from "../lib/wallet";

// ─── Static metadata mirror — kept local so the component is self-contained.
// Source of truth lives in contracts.manifest.json + app/lib/eip7702.ts; this
// is the minimum the UI needs to render and switch chains.

type ChainKey =
  | "avax" | "bnb" | "eth" | "xlayer" | "stable"
  | "mantle" | "injective" | "monad" | "scroll";

const CHAINS: { key: ChainKey; name: string; chainId: number; img: string }[] = [
  { key: "bnb",       name: "BNB Chain",   chainId: 56,     img: "/bnb.png" },
  { key: "eth",       name: "Ethereum",    chainId: 1,      img: "/eth.png" },
  { key: "avax",      name: "Avalanche",   chainId: 43114,  img: "/avax.png" },
  { key: "xlayer",    name: "X Layer",     chainId: 196,    img: "/xlayer.png" },
  { key: "mantle",    name: "Mantle",      chainId: 5000,   img: "/mantle.png" },
  { key: "injective", name: "Injective",   chainId: 1776,   img: "/injective.png" },
  { key: "stable",    name: "Stable",      chainId: 988,    img: "/stable.jpg" },
  { key: "monad",     name: "Monad",       chainId: 143,    img: "/monad.png" },
  { key: "scroll",    name: "Scroll",      chainId: 534352, img: "/scroll.png" },
];

interface ChainRow {
  delegated: boolean;
  impl?:     string;
  error?:    string;
}

type StatusMap = Partial<Record<ChainKey, ChainRow>>;

// Per-row UI state for an in-flight "Clear" action.
type ClearStatus =
  | { phase: "idle" }
  | { phase: "switching" }      // chain switch in progress
  | { phase: "signing" }         // wallet popup open for authorize()
  | { phase: "broadcasting" }    // server is broadcasting type-4 TX
  | { phase: "success"; txHash: string; explorerUrl: string }
  | { phase: "error";   message: string };

export default function WalletDelegationCard() {
  const { address, isConnected } = useWallet();
  const [statuses, setStatuses]     = useState<StatusMap>({});
  const [loading,  setLoading]      = useState(false);
  const [perChain, setPerChain]     = useState<Record<ChainKey, ClearStatus>>({} as Record<ChainKey, ClearStatus>);

  const refresh = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/wallet/delegation-status?address=${address}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setStatuses(json.chains as StatusMap);
    } catch (e) {
      console.error("[WalletDelegationCard] refresh failed:", e);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function handleClear(chainKey: ChainKey, chainId: number) {
    if (!address) return;
    const setPhase = (s: ClearStatus) => setPerChain(prev => ({ ...prev, [chainKey]: s }));

    try {
      const injected = getActiveProvider() as
        | { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }
        | null;
      if (!injected) {
        setPhase({ phase: "error", message: "No connected wallet found. Reconnect and try again." });
        return;
      }

      // 1) Switch chain. wallet_switchEthereumChain throws code 4902 when
      //    the chain isn't added — we don't attempt to add it here; users
      //    targeting a chain Q402 supports are expected to already have it
      //    in their wallet. The Clear button only shows when the chain
      //    reports delegated, which already implies the wallet has seen
      //    that chain before.
      setPhase({ phase: "switching" });
      try {
        await injected.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x" + chainId.toString(16) }],
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setPhase({ phase: "error", message: `Couldn't switch wallet to chain ${chainId}: ${msg}` });
        return;
      }

      // 2) Sign EIP-7702 authorization. ethers v6.16+ exposes
      //    `signer.authorize()` which routes to wallet_signAuthorization
      //    on injected wallets that support EIP-7702.
      setPhase({ phase: "signing" });
      const browserProvider = new ethers.BrowserProvider(injected as ethers.Eip1193Provider);
      const signer          = await browserProvider.getSigner(address);
      const nonce           = await browserProvider.getTransactionCount(address);

      const auth = await signer.authorize({
        chainId,
        address: "0x0000000000000000000000000000000000000000",
        nonce,
      });

      // 3) Broadcast via Q402 (sponsored).
      setPhase({ phase: "broadcasting" });
      const body = {
        chain:   chainKey,
        address,
        authorization: {
          chainId: Number(auth.chainId),
          address: auth.address,
          nonce:   Number(auth.nonce),
          yParity: auth.signature.yParity as 0 | 1,
          r:       auth.signature.r,
          s:       auth.signature.s,
        },
      };
      const res = await fetch("/api/wallet/clear-delegation", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setPhase({ phase: "error", message: json.error ?? `HTTP ${res.status}` });
        return;
      }

      setPhase({ phase: "success", txHash: json.txHash, explorerUrl: json.explorerUrl });
      // Refresh after a beat so the post-broadcast eth_getCode has time to
      // propagate via RPC fan-out. The optimistic UI update above already
      // flipped the row's visual state via this phase.
      setTimeout(() => { void refresh(); }, 2500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPhase({ phase: "error", message: msg });
    }
  }

  // ── Render ────────────────────────────────────────────────────────────
  if (!isConnected || !address) {
    return (
      <div className="rounded-2xl border p-6" style={{ borderColor: "rgba(255,255,255,0.07)", background: "rgba(10,16,30,0.5)" }}>
        <div className="text-yellow text-[10px] font-mono uppercase tracking-[0.22em] mb-2">Wallet · EIP-7702 delegation</div>
        <p className="text-white/55 text-sm leading-relaxed">
          Connect a wallet to see delegation status across all 9 Q402 chains.
        </p>
      </div>
    );
  }

  const delegatedChains = (CHAINS).filter(c => statuses[c.key]?.delegated);

  return (
    <div
      className="rounded-2xl border p-6"
      style={{ borderColor: "rgba(255,255,255,0.07)", background: "rgba(10,16,30,0.6)" }}
    >
      <div className="flex items-start justify-between mb-4 gap-4">
        <div>
          <div className="text-yellow text-[10px] font-mono uppercase tracking-[0.22em] mb-2">
            Wallet · EIP-7702 delegation
          </div>
          <p className="text-white/55 text-sm leading-relaxed max-w-2xl">
            Q402 delegates your EOA to a vetted implementation contract for gasless settlement.
            Clearing a delegation returns your wallet to a plain EOA on that chain — your next
            Q402 payment will create a fresh delegation automatically.
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="flex-shrink-0 px-3 py-1.5 rounded-lg border border-white/10 text-xs text-white/55 hover:text-white hover:border-white/25 transition-colors disabled:opacity-40"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Connected wallet header */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.05] mb-4">
        <span className="w-1.5 h-1.5 rounded-full bg-yellow flex-shrink-0" style={{ boxShadow: "0 0 4px #F5C518" }} />
        <span className="text-white/60 text-xs font-mono truncate">{address}</span>
        <span className="ml-auto text-white/35 text-[10px] font-mono uppercase tracking-widest">
          {delegatedChains.length} of {CHAINS.length} delegated
        </span>
      </div>

      {/* Per-chain rows */}
      <div className="divide-y" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
        {CHAINS.map(c => {
          const row    = statuses[c.key];
          const phase  = perChain[c.key]?.phase ?? "idle";
          const isWorking = phase === "switching" || phase === "signing" || phase === "broadcasting";
          const isDelegated = !!row?.delegated;

          return (
            <div key={c.key} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <span className="w-5 h-5 rounded-full overflow-hidden border border-white/10 flex-shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.img} alt={c.name} className="w-full h-full object-cover" />
              </span>
              <span className="text-white/85 text-sm flex-shrink-0 w-32">{c.name}</span>

              {/* Status indicator */}
              <span className="flex items-center gap-1.5 text-xs flex-1">
                {row?.error ? (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-white/20" />
                    <span className="text-white/40">RPC error — try refresh</span>
                  </>
                ) : isDelegated ? (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-yellow" style={{ boxShadow: "0 0 4px #F5C518" }} />
                    <span className="text-white/65">Delegated</span>
                    {row?.impl && (
                      <span className="text-white/30 font-mono text-[10px] ml-1 truncate">
                        → {row.impl.slice(0, 6)}…{row.impl.slice(-4)}
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-white/15" />
                    <span className="text-white/40">Not delegated</span>
                  </>
                )}
              </span>

              {/* Action / phase feedback */}
              <div className="flex-shrink-0 min-w-[140px] text-right">
                {phase === "success" ? (
                  <a
                    href={(perChain[c.key] as { phase: "success"; txHash: string; explorerUrl: string }).explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-green-400 text-xs hover:text-green-300 transition-colors"
                  >
                    Cleared ↗
                  </a>
                ) : phase === "error" ? (
                  <span className="text-red-400 text-[11px] truncate inline-block max-w-[150px]" title={(perChain[c.key] as { phase: "error"; message: string }).message}>
                    Failed
                  </span>
                ) : isDelegated ? (
                  <button
                    onClick={() => void handleClear(c.key, c.chainId)}
                    disabled={isWorking || !isConnected}
                    className="px-3 py-1.5 rounded-lg border border-yellow/30 bg-yellow/5 text-yellow text-xs font-medium hover:bg-yellow/10 hover:border-yellow/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {phase === "switching"     ? "Switching…"
                     : phase === "signing"     ? "Sign in wallet…"
                     : phase === "broadcasting"? "Broadcasting…"
                     :                            "Clear delegation"}
                  </button>
                ) : (
                  <span className="text-white/15 text-xs">—</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-white/35 text-[11px] mt-5 leading-relaxed">
        Gas is covered by Q402 (sponsored). The clear takes one signature in your wallet and
        ~1-3 seconds on chain. <a href="/docs#eip-7702-delegation" className="text-yellow/80 hover:text-yellow underline underline-offset-2">Read more in docs</a>.
      </p>
    </div>
  );
}
