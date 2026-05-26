"use client";

/**
 * AgenticWalletDelegationModal — clear the user's EIP-7702 delegation.
 *
 * Q402's relay path delegates the user's EOA to the per-chain Q402 impl
 * the first time they pay through Q402 on that chain. That's the
 * "Smart account" badge MetaMask starts showing. The delegation has
 * three real-world side effects:
 *
 *   1. Incoming native gas (BNB / ETH / etc.) reverts because the impl
 *      has no `receive()`. So topping up the EOA from a CEX bounces.
 *   2. Some wallets refuse certain mint flows ("not safe for delegated
 *      account") even though the delegation doesn't strictly block them.
 *   3. The badge itself spooks users.
 *
 * Q402 sponsors the gas to clear the delegation — the user signs a
 * type-4 authorization with `address = 0x0`, server broadcasts it via
 * the relayer EOA, user pays $0. This modal is the dashboard surface
 * for that.
 *
 * Discovery: the parent (AgenticWalletCard) fetches the per-chain
 * delegation status on mount and only renders the entry point when at
 * least one chain is currently delegated to a Q402 impl. The modal
 * itself also re-fetches on open so stale state can't trigger an
 * unnecessary clear.
 */

import { useCallback, useEffect, useState } from "react";
import { BrowserProvider } from "ethers";
import type { ChainKey } from "@/app/lib/relayer";

interface Props {
  ownerAddress: string;
  onClose: () => void;
  onCleared: () => void;
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
};

const CHAIN_IDS: Partial<Record<ChainKey, number>> = {
  bnb: 56,
  eth: 1,
  avax: 43114,
  xlayer: 196,
  stable: 988,
  mantle: 5000,
  injective: 1776,
  monad: 143,
  scroll: 534352,
};

function getProvider(): { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { ethereum?: unknown; okxwallet?: unknown };
  return (w.ethereum ?? w.okxwallet) as ReturnType<typeof getProvider>;
}

export function AgenticWalletDelegationModal({ ownerAddress, onClose, onCleared }: Props) {
  const [status, setStatus] = useState<DelegationStatusBody | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState<ChainKey | null>(null);
  const [clearedTxs, setClearedTxs] = useState<Partial<Record<ChainKey, string>>>({});

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/wallet/delegation-status?address=${ownerAddress}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Status fetch failed (HTTP ${res.status}).`);
        return;
      }
      const data = (await res.json()) as DelegationStatusBody;
      setStatus(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [ownerAddress]);

  useEffect(() => {
    void load();
  }, [load]);

  async function clearChain(chain: ChainKey) {
    setError(null);
    setClearing(chain);
    try {
      const provider = getProvider();
      if (!provider) {
        setError("No wallet provider found.");
        return;
      }
      const chainId = CHAIN_IDS[chain];
      if (!chainId) {
        setError(`Unknown chain ${chain}`);
        return;
      }

      // ethers v6 BrowserProvider → signer → signer.authorize() emits a
      // protocol-correct EIP-7702 authorization. MetaMask 12.x+ forwards
      // to its native `wallet_signAuthorization` RPC; older wallets
      // throw, which surfaces as a clean "wallet needs EIP-7702 support"
      // error here.
      const browserProvider = new BrowserProvider(provider as never);
      const signer = await browserProvider.getSigner(ownerAddress);
      const tx = await signer.populateTransaction({});
      const nonce = tx.nonce ?? (await browserProvider.getTransactionCount(ownerAddress, "pending"));

      const auth = await signer.authorize({
        chainId,
        address: "0x0000000000000000000000000000000000000000",
        nonce,
      });

      const body = {
        chain,
        address: ownerAddress,
        authorization: {
          chainId: Number(auth.chainId),
          address: auth.address,
          nonce: Number(auth.nonce),
          yParity: auth.signature.yParity,
          r: auth.signature.r,
          s: auth.signature.s,
        },
      };
      const res = await fetch("/api/wallet/clear-delegation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { txHash?: string; error?: string; message?: string };
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Clear failed (HTTP ${res.status}).`);
        return;
      }
      if (typeof data.txHash === "string") {
        setClearedTxs((prev) => ({ ...prev, [chain]: data.txHash }));
        // Re-fetch status so the row drops out of the "still delegated"
        // list. Cron-free state, single round-trip.
        await load();
        onCleared();
      }
    } catch (e) {
      // Same EIP-1193 normalisation as the agent modal — wallets throw
      // plain objects so naive String(e) collapses everything to
      // "[object Object]".
      let msg = "Unexpected error.";
      let code: number | undefined;
      if (e instanceof Error) msg = e.message;
      else if (e && typeof e === "object") {
        const o = e as { message?: unknown; code?: unknown };
        if (typeof o.message === "string") msg = o.message;
        if (typeof o.code === "number") code = o.code;
      }
      if (code === 4001 || /user rejected|User denied/i.test(msg)) {
        setError("You rejected the clear authorization in your wallet.");
      } else if (/eip[-_ ]?7702|wallet_signAuthorization/i.test(msg)) {
        setError("Your wallet doesn't support EIP-7702 signing. Update MetaMask to 12.x+ or use OKX Wallet.");
      } else {
        setError(msg);
      }
    } finally {
      setClearing(null);
    }
  }

  const rows = status
    ? (Object.entries(status.chains) as Array<[ChainKey, DelegationState]>).filter(
        ([, s]) => s.delegated,
      )
    : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(2,6,15,0.72)" }}
      onClick={clearing ? undefined : onClose}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border p-6 space-y-4"
        style={{ background: "#0F1929", borderColor: "rgba(74,222,128,0.20)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-emerald-400/85 font-semibold">
              EIP-7702
            </div>
            <div className="text-white font-semibold text-lg">Clear wallet delegation</div>
            <div className="text-[11px] text-white/50 mt-0.5 leading-relaxed">
              Removes Q402&apos;s impl from your EOA on the chosen chain. After clearing,
              MetaMask drops the &quot;Smart account&quot; badge and native gas top-ups (e.g.
              BNB from a CEX) stop reverting. Q402 sponsors the on-chain clear — you
              pay $0.
            </div>
          </div>
          {!clearing && (
            <button onClick={onClose} className="text-white/40 hover:text-white text-lg leading-none">
              ×
            </button>
          )}
        </div>

        {loading && (
          <div className="text-sm text-white/55 py-6 text-center">Reading delegation state across 9 chains…</div>
        )}

        {error && (
          <div
            className="rounded-md border px-3 py-2.5 text-[12px]"
            style={{ background: "rgba(248,113,113,0.06)", borderColor: "rgba(248,113,113,0.22)", color: "#fecaca" }}
          >
            {error}
            <button onClick={load} className="ml-3 underline underline-offset-2 hover:text-red-200">retry status</button>
          </div>
        )}

        {!loading && !error && rows.length === 0 && (
          <div
            className="rounded-md border px-3 py-3 text-[13px] text-white/65"
            style={{ background: "rgba(74,222,128,0.05)", borderColor: "rgba(74,222,128,0.22)" }}
          >
            ✓ Your wallet is not delegated on any supported chain. Nothing to clear.
          </div>
        )}

        {!loading && rows.length > 0 && (
          <div className="space-y-2">
            {rows.map(([chain, s]) => {
              const txHash = clearedTxs[chain];
              const isClearing = clearing === chain;
              return (
                <div
                  key={chain}
                  className="rounded-md border px-3 py-2.5 flex items-center justify-between gap-3"
                  style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}
                >
                  <div className="min-w-0">
                    <div className="text-[13px] text-white/90 font-medium">{CHAIN_LABEL[chain] ?? chain}</div>
                    <div className="text-[11px] text-white/50 mt-0.5 font-mono break-all">
                      impl {s.impl?.slice(0, 10)}…{s.impl?.slice(-6)}
                    </div>
                    {txHash && (
                      <div className="text-[10.5px] text-emerald-300 mt-1 font-mono break-all">
                        cleared · {txHash.slice(0, 10)}…{txHash.slice(-6)}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => clearChain(chain)}
                    disabled={!!clearing}
                    className="shrink-0 px-3 py-1.5 rounded-md text-[12px] font-semibold bg-emerald-400 text-slate-900 hover:bg-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {isClearing ? "Clearing…" : txHash ? "Re-clear" : "Clear"}
                  </button>
                </div>
              );
            })}
            <div className="text-[10.5px] text-white/40 leading-relaxed pt-2">
              Each clear is one wallet signature (no gas — Q402&apos;s relayer pays). After clearing,
              MetaMask will stop showing &quot;Smart account&quot; on that chain and native
              gas transfers in will no longer revert.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
