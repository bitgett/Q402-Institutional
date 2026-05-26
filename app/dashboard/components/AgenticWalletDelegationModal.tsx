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
import { getActiveProvider, ensureWalletChain } from "@/app/lib/wallet";
import type { WalletChainKey } from "@/app/lib/wallet";
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

// Delegation clearing must reuse the same provider selection the rest
// of the dashboard uses (`getActiveProvider`) — otherwise an OKX-only
// user who has MetaMask also installed would have us calling the
// wrong EIP-1193 instance, with the wrong active account, on the
// wrong chain. The naive `window.ethereum ?? window.okxwallet`
// fallback misses the user's persisted wallet-type preference.

/** Shape any of the known wallet_signAuthorization response variants. */
type RawAuthResult =
  | { r: string; s: string; yParity: number | string }
  | { r: string; s: string; v: number | string }
  | { signature: { r: string; s: string; yParity: number | string } }
  | string;

interface ProviderRequest {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
}

async function getOwnerTxNonce(provider: ProviderRequest, owner: string): Promise<number> {
  const result = await provider.request({
    method: "eth_getTransactionCount",
    params: [owner, "pending"],
  });
  if (typeof result === "string" && result.startsWith("0x")) return parseInt(result, 16);
  if (typeof result === "number") return result;
  throw new Error(`unexpected getTransactionCount response: ${String(result)}`);
}

/**
 * Normalise the wallet_signAuthorization response. The EIP-7702 wallet
 * RPC is draft-stage, so different builds return slightly different
 * shapes:
 *
 *   - MetaMask returns `{ r, s, yParity }` directly
 *   - OKX returns `{ r, s, v }` (where v = yParity + 27)
 *   - Some return nested under `signature: {...}`
 *   - A few return a packed 65-byte hex string
 *
 * Server-side only needs `{ yParity, r, s }`, so this collapses all
 * variants to that shape.
 */
function normaliseAuthSig(raw: RawAuthResult): { yParity: number; r: string; s: string } {
  if (typeof raw === "string") {
    if (!/^0x[0-9a-fA-F]{130}$/.test(raw)) {
      throw new Error("packed authorization signature must be 65 bytes hex");
    }
    const r = "0x" + raw.slice(2, 66);
    const s = "0x" + raw.slice(66, 130);
    const vNum = parseInt(raw.slice(130, 132), 16);
    return { yParity: vNum === 27 || vNum === 0 ? 0 : 1, r, s };
  }
  const inner = "signature" in raw ? raw.signature : raw;
  const r = (inner as { r: string }).r;
  const s = (inner as { s: string }).s;
  let yParity: number;
  if ("yParity" in inner) {
    const yp = (inner as { yParity: number | string }).yParity;
    yParity = typeof yp === "string" ? (yp === "0x0" || yp === "0x00" ? 0 : 1) : yp;
  } else if ("v" in inner) {
    const v = (inner as { v: number | string }).v;
    const vNum = typeof v === "string" ? parseInt(v, 16) : v;
    // v = 27 → yParity 0, v = 28 → yParity 1, raw v = 0/1 stays as-is.
    yParity = vNum === 1 || vNum === 28 ? 1 : 0;
  } else {
    throw new Error("authorization signature missing yParity / v");
  }
  return { yParity, r, s };
}

export function AgenticWalletDelegationModal({ ownerAddress, onClose, onCleared }: Props) {
  const [status, setStatus] = useState<DelegationStatusBody | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Distinguishes between "status fetch failed" (re-fetch is the cure)
   *  vs "clear flow failed mid-way" (re-click the Clear button is the
   *  cure). Without this distinction the error blurb shows a useless
   *  "retry status" link when the user simply rejected the wallet
   *  prompt and the only sensible next action is "press Clear again." */
  const [errorKind, setErrorKind] = useState<"status" | "clear" | null>(null);
  const [clearing, setClearing] = useState<ChainKey | null>(null);
  const [clearedTxs, setClearedTxs] = useState<Partial<Record<ChainKey, string>>>({});

  const load = useCallback(async () => {
    setError(null);
    setErrorKind(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/wallet/delegation-status?address=${ownerAddress}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Status fetch failed (HTTP ${res.status}).`);
        setErrorKind("status");
        return;
      }
      const data = (await res.json()) as DelegationStatusBody;
      setStatus(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setErrorKind("status");
    } finally {
      setLoading(false);
    }
  }, [ownerAddress]);

  useEffect(() => {
    void load();
  }, [load]);

  async function clearChain(chain: ChainKey) {
    setError(null);
    setErrorKind(null);
    setClearing(chain);
    try {
      const provider = getActiveProvider();
      if (!provider) {
        setError("No wallet provider found. Connect your wallet and retry.");
        setErrorKind("clear");
        return;
      }
      const chainId = CHAIN_IDS[chain];
      if (!chainId) {
        setError(`Unknown chain ${chain}`);
        setErrorKind("clear");
        return;
      }

      // Make sure the user's wallet is actually on the chain we're
      // clearing. Without this, OKX / MetaMask might be on Ethereum
      // mainnet and reject the BNB Chain authorization request as
      // "unrecognized" rather than honouring the chainId param —
      // which surfaces to us as a vague rejection.
      try {
        await ensureWalletChain(chain as WalletChainKey);
      } catch (switchErr) {
        // Surface a clean "switch first" error instead of letting it
        // get classified as a generic rejection below.
        const m = switchErr instanceof Error ? switchErr.message : String(switchErr);
        setError(`Could not switch your wallet to ${CHAIN_LABEL[chain]}. ${m}`);
        setErrorKind("clear");
        return;
      }

      // Direct wallet_signAuthorization RPC. ethers v6.16's
      // JsonRpcSigner doesn't implement `.authorize()` (the base class
      // throws "authorization not implemented for this signer"), so we
      // skip the ethers wrapper and call the EIP-7702 wallet RPC by
      // hand. MetaMask 12.x+ and OKX Wallet (latest) both expose it.
      const nonce = await getOwnerTxNonce(provider, ownerAddress);

      const rpcParams = {
        chainId: "0x" + chainId.toString(16),
        address: "0x0000000000000000000000000000000000000000",
        nonce: "0x" + nonce.toString(16),
      };
      const signed = await provider.request({
        method: "wallet_signAuthorization",
        params: [rpcParams],
      }) as RawAuthResult;

      const sig = normaliseAuthSig(signed);
      const body = {
        chain,
        address: ownerAddress,
        authorization: {
          chainId,
          address: "0x0000000000000000000000000000000000000000",
          nonce,
          yParity: sig.yParity,
          r: sig.r,
          s: sig.s,
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
        setErrorKind("clear");
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
        setError("You rejected the clear authorization in your wallet. Click Clear again when ready.");
      } else if (/eip[-_ ]?7702|wallet_signAuthorization|authorize is not a function|signer\.authorize/i.test(msg)) {
        setError(
          "Your wallet doesn't expose EIP-7702 signing. Update MetaMask to 12.x+ " +
            "or OKX Wallet to the latest version. (Some older wallet builds reject " +
            "the request silently — try a recent build.)",
        );
      } else {
        setError(`${msg} (code ${code ?? "n/a"})`);
      }
      setErrorKind("clear");
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
            {errorKind === "status" && (
              <button onClick={load} className="ml-3 underline underline-offset-2 hover:text-red-200">
                retry status
              </button>
            )}
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
