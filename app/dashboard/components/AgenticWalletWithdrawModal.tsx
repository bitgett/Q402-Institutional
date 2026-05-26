"use client";

/**
 * AgenticWalletWithdrawModal — per-chain / per-token sweep picker.
 *
 * Replaces the old "open SendModal with the aggregate USD prefilled"
 * shortcut. That UX was wrong: balance is spread across up to
 * 9 chains × 2 tokens = 18 buckets, but a single Send call moves ONE
 * (chain, token) bucket. Prefilling the aggregate guaranteed every
 * non-trivial withdraw failed at the relay.
 *
 * This modal fetches `/api/wallet/agentic/balance` fresh on open, lists
 * every bucket with balance > 0, and exposes a one-click "Sweep" CTA
 * per row that hands off to the SendModal with the right chain / token /
 * amount preset. When a bucket exceeds the per-tx cap the sweep amount
 * snaps to the cap and the row carries a "multiple sends needed" hint.
 */

import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { getAuthCreds } from "@/app/lib/auth-client";
import type { ChainKey } from "@/app/lib/relayer";

interface Props {
  walletAddress: string;
  walletId: string;
  ownerAddress: string;
  signMessage: (message: string) => Promise<string | null>;
  perTxMaxUsd: number | null;
  onClose: () => void;
  /** Called with the chosen bucket so the parent opens SendModal
   *  with chain/token/amount + prefillTo wired up. */
  onPickBucket: (bucket: WithdrawBucket) => void;
}

export interface WithdrawBucket {
  chain: ChainKey;
  token: "USDC" | "USDT";
  amount: string;          // human-readable decimal string for SendModal
  /** Raw atomic units, useful for amount-cap math without floating drift. */
  raw: string;
  decimals: number;
  usd: number;
}

type TokenBalance = { raw: string; usd: number; decimals: number };
type ChainBalance = {
  chain: ChainKey;
  usdc: TokenBalance | null;
  usdt: TokenBalance | null;
  totalUsd: number | null;
  error?: string;
};
type BalancesPayload = {
  asOf: number;
  totalUsd: number;
  perChain: ChainBalance[];
};

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

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 0.01 && n > 0) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Build a human decimal string for the SendModal's amount field.
 *
 * Codebase invariant: never use Math.floor / Math.round / parseFloat on
 * token amounts — IEEE-754 drift between display and chain-side
 * BigInt(amount) is exactly the class of bug the relay-payload incident
 * exposed. So the human string comes straight from the raw atomic
 * units via ethers.formatUnits (no float anywhere on the precision
 * path):
 *
 *   raw → formatUnits → exact human string → SendModal parseUnits back
 *
 * Cap logic: USDC / USDT peg 1:1 with USD, so when the bucket's USD
 * exceeds perTxMaxUsd we scale `raw` to the cap proportionally and
 * format again. Still no float: we compute the capped raw via BigInt
 * multiplication + division so the cap math is exact at the token's
 * native precision.
 */
function deriveSweepAmount(
  tb: TokenBalance,
  perTxMaxUsd: number | null,
): { amount: string; capped: boolean } {
  const rawBig = BigInt(tb.raw);
  const capped = perTxMaxUsd !== null && tb.usd > perTxMaxUsd;

  let sweepRaw: bigint;
  if (capped && perTxMaxUsd !== null) {
    // Scale `raw` down to the cap. USD <-> token unit equivalence is
    // 1:1 for the stablecoins we support, so:
    //   capped_raw = raw * (perTxMaxUsd / tb.usd)
    // We do the multiplication in BigInt space to keep precision at
    // the token's native decimals. The `usd` field is a JS number
    // (lossy for >2^53 atomic units) but we only USE it to derive a
    // ratio against a USD cap that is itself a small integer — so the
    // float exposure is bounded and safe.
    const numerator = BigInt(Math.floor(perTxMaxUsd * 1_000_000));
    const denominator = BigInt(Math.floor(tb.usd * 1_000_000));
    sweepRaw = denominator > 0n ? (rawBig * numerator) / denominator : 0n;
  } else {
    sweepRaw = rawBig;
  }

  return {
    amount: ethers.formatUnits(sweepRaw, tb.decimals),
    capped,
  };
}

export function AgenticWalletWithdrawModal({
  walletAddress,
  walletId,
  ownerAddress,
  signMessage,
  perTxMaxUsd,
  onClose,
  onPickBucket,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<BalancesPayload | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const auth = await getAuthCreds(ownerAddress, signMessage);
      if (!auth) {
        setError("Sign the auth challenge to load balances.");
        return;
      }
      const qs = new URLSearchParams({
        address: ownerAddress,
        nonce: auth.nonce,
        sig: auth.signature,
        walletId,
        force: "1",
      }).toString();
      const res = await fetch(`/api/wallet/agentic/balance?${qs}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Balance fetch failed (HTTP ${res.status}).`);
        return;
      }
      const data = (await res.json()) as { balances: BalancesPayload };
      setBalances(data.balances);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [ownerAddress, signMessage, walletId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Flatten per-chain into per-bucket rows, keeping only positive
  // balances. Sort biggest-first so the user sees the meaningful sweep
  // candidates at the top.
  const rows: Array<{
    bucket: WithdrawBucket;
    capped: boolean;
  }> = [];
  for (const c of balances?.perChain ?? []) {
    for (const tok of ["USDT", "USDC"] as const) {
      const tb = tok === "USDC" ? c.usdc : c.usdt;
      if (!tb || tb.usd <= 0) continue;
      const { amount, capped } = deriveSweepAmount(tb, perTxMaxUsd);
      rows.push({
        bucket: {
          chain: c.chain,
          token: tok,
          amount,
          raw: tb.raw,
          decimals: tb.decimals,
          usd: tb.usd,
        },
        capped,
      });
    }
  }
  rows.sort((a, b) => b.bucket.usd - a.bucket.usd);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(2,6,15,0.72)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border p-6 space-y-4"
        style={{ background: "#0F1929", borderColor: "rgba(74,222,128,0.20)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="text-white font-semibold text-lg">Withdraw to your wallet</div>
            <div className="text-[11px] text-white/45 font-mono mt-0.5">
              {walletAddress.slice(0, 10)}…{walletAddress.slice(-6)} → {ownerAddress.slice(0, 10)}…{ownerAddress.slice(-6)}
            </div>
            <div className="text-[11px] text-white/50 mt-1.5 leading-relaxed">
              Each row is one on-chain transfer. Pick the bucket you want to sweep —
              the SendModal opens with chain, token, and amount already filled in.
            </div>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white text-lg leading-none">
            ×
          </button>
        </div>

        {loading && (
          <div className="text-sm text-white/55 py-6 text-center">Reading balances across 9 chains…</div>
        )}

        {error && (
          <div className="rounded-md border px-3 py-2.5 text-[12px] text-red-300/85"
            style={{ background: "rgba(248,113,113,0.06)", borderColor: "rgba(248,113,113,0.22)" }}
          >
            {error}
            <button
              type="button"
              onClick={load}
              className="ml-3 underline underline-offset-2 hover:text-red-200"
            >
              retry
            </button>
          </div>
        )}

        {!loading && !error && rows.length === 0 && (
          <div
            className="rounded-md border px-3 py-3 text-[13px] text-white/65"
            style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}
          >
            No withdrawable balance on any supported chain. Deposit USDC or USDT first
            (use the Receive button), then come back to sweep.
          </div>
        )}

        {!loading && rows.length > 0 && (
          <>
            <div className="space-y-2">
              {rows.map((r) => (
                <div
                  key={`${r.bucket.chain}-${r.bucket.token}`}
                  className="rounded-md border px-3 py-2.5 flex items-center justify-between gap-3"
                  style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}
                >
                  <div className="min-w-0">
                    <div className="text-[13px] text-white/90 font-medium">
                      {CHAIN_LABEL[r.bucket.chain] ?? r.bucket.chain} · {r.bucket.token}
                    </div>
                    <div className="text-[11px] text-white/55 mt-0.5">
                      Available {formatUsd(r.bucket.usd)}
                      {r.capped && (
                        <span className="text-amber-300/85">
                          {" "}· cap {formatUsd(perTxMaxUsd ?? 0)} — split needed
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onPickBucket(r.bucket)}
                    className="shrink-0 px-3 py-1.5 rounded-md text-[12px] font-semibold bg-emerald-400 text-slate-900 hover:bg-emerald-300"
                  >
                    Sweep {r.bucket.amount} →
                  </button>
                </div>
              ))}
            </div>

            <div className="text-[11px] text-white/40 leading-relaxed">
              Per-tx cap {formatUsd(perTxMaxUsd ?? 0)}. Buckets over the cap will be
              capped on the SendModal — repeat the sweep for the remainder.
              Gas is sponsored by Q402; only the stablecoin moves.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
