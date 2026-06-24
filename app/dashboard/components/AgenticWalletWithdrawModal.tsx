"use client";

/**
 * AgenticWalletWithdrawModal — per-chain / per-token sweep picker, Command-deck
 * system.
 *
 * Balance is spread across up to 11 chains × 2 tokens = 22 buckets, but a
 * single Send call moves ONE (chain, token) bucket. This modal fetches
 * `/api/wallet/agentic/balance` fresh on open, lists every bucket with
 * balance > 0, and exposes a one-click "Sweep" per row that hands off to the
 * SendModal with the right chain / token / amount preset. When a bucket
 * exceeds the per-tx cap the sweep amount snaps to the cap and the row carries
 * a "split needed" hint.
 */

import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { getAuthCreds } from "@/app/lib/auth-client";
import type { ChainKey } from "@/app/lib/relayer";
import { ModalShell, AlertBox, MonoAddr, GOLD } from "./modal-kit";
import { WithdrawGlyph } from "./action-icons";

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
  arbitrum: "Arbitrum",
  base: "Base",
};

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 0.01 && n > 0) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Build a human decimal string for the SendModal's amount field. Never use
 * Math.floor / parseFloat on token amounts — IEEE-754 drift between display
 * and chain-side BigInt(amount) is exactly the bug we avoid. The human string
 * comes straight from raw atomic units via ethers.formatUnits.
 */
function deriveSweepAmount(
  tb: TokenBalance,
  perTxMaxUsd: number | null,
): { amount: string; capped: boolean } {
  const rawBig = BigInt(tb.raw);
  const capped = perTxMaxUsd !== null && tb.usd > perTxMaxUsd;

  let sweepRaw: bigint;
  if (capped && perTxMaxUsd !== null) {
    // capped_raw = raw * (perTxMaxUsd / tb.usd), in BigInt space (1:1 USD peg).
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

  // Flatten per-chain into per-bucket rows, positive balances only, biggest first.
  const rows: Array<{ bucket: WithdrawBucket; capped: boolean }> = [];
  for (const c of balances?.perChain ?? []) {
    for (const tok of ["USDT", "USDC"] as const) {
      const tb = tok === "USDC" ? c.usdc : c.usdt;
      if (!tb || tb.usd <= 0) continue;
      const { amount, capped } = deriveSweepAmount(tb, perTxMaxUsd);
      rows.push({ bucket: { chain: c.chain, token: tok, amount, raw: tb.raw, decimals: tb.decimals, usd: tb.usd }, capped });
    }
  }
  rows.sort((a, b) => b.bucket.usd - a.bucket.usd);

  return (
    <ModalShell
      icon={<WithdrawGlyph size={19} color={GOLD} />}
      title="Withdraw to your wallet"
      subtitle={<MonoAddr>{walletAddress.slice(0, 10)}…{walletAddress.slice(-6)} → {ownerAddress.slice(0, 10)}…{ownerAddress.slice(-6)}</MonoAddr>}
      size="md"
      onClose={onClose}
    >
      <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", lineHeight: 1.5 }}>
        Each row is one on-chain transfer. Pick the bucket to sweep — Send opens with chain, token, and amount already filled in.
      </div>

      {loading && <div style={{ fontSize: 13, color: "rgba(255,255,255,.55)", padding: "20px 0", textAlign: "center" }}>Reading balances across 11 chains…</div>}

      {error && (
        <AlertBox variant="error" action={<button type="button" onClick={load} style={{ color: "#fecaca", textDecoration: "underline", textUnderlineOffset: 2 }}>retry</button>}>
          {error}
        </AlertBox>
      )}

      {!loading && !error && rows.length === 0 && (
        <AlertBox variant="info">No withdrawable balance on any supported chain. Deposit USDC or USDT first (Receive), then come back to sweep.</AlertBox>
      )}

      {!loading && rows.length > 0 && (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rows.map((r) => (
              <div
                key={`${r.bucket.chain}-${r.bucket.token}`}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, borderRadius: 11, border: "1px solid rgba(255,255,255,.07)", background: "rgba(255,255,255,.02)", padding: "10px 12px" }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,.9)" }}>{CHAIN_LABEL[r.bucket.chain] ?? r.bucket.chain} · {r.bucket.token}</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,.55)", marginTop: 2 }}>
                    Available {formatUsd(r.bucket.usd)}
                    {r.capped && <span style={{ color: "rgba(252,211,77,.85)" }}> · cap {formatUsd(perTxMaxUsd ?? 0)} — split needed</span>}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onPickBucket(r.bucket)}
                  className="transition-opacity"
                  style={{ flexShrink: 0, padding: "7px 12px", borderRadius: 9, border: "none", background: GOLD, color: "#101722", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                >
                  Sweep {r.bucket.amount} →
                </button>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 11, color: "rgba(255,255,255,.4)", lineHeight: 1.5 }}>
            Per-tx cap {formatUsd(perTxMaxUsd ?? 0)}. Buckets over the cap are capped on Send — repeat the sweep for the remainder. Gas is sponsored by Q402; only the stablecoin moves.
          </div>
        </>
      )}
    </ModalShell>
  );
}
