"use client";

/**
 * AgenticWalletEarnSection — read-only "Earn" surface for an Agent Wallet.
 *
 * Phase 0 of Q402 Yield (Aave lending). Renders, for one wallet:
 *   - Each current supply position: asset, redeemable balance, supply APY,
 *     accrued yield (when the principal is tracked).
 *   - Total supplied USD across positions.
 *   - When the wallet has no positions, a subtle teaser pulled from the
 *     public markets feed ("Earn ~X% on idle USDC/USDT via Aave").
 *
 * READ-ONLY. No deposit/withdraw actions — those are Phase 1. The only
 * signing here is the cached SESSION read (getAuthCreds), mirroring the
 * Hooks modal's load path: positions are an authed read of your own
 * wallet state; markets are public (no auth).
 *
 * Data sources (already-built endpoints):
 *   GET /api/wallet/agentic/yield/positions?walletId&address&nonce&signature
 *   GET /api/wallet/agentic/yield/reserves?chain=bnb   (public)
 */

import { useEffect, useState } from "react";
import { getAuthCreds, clearAuthCache } from "@/app/lib/auth-client";

interface Position {
  protocol: string;
  chain: string;
  asset: string;
  marketAddress: string;
  balance: string;
  principal: string | null;
  accrued: string | null;
  supplyApy: number;
}

interface PositionsPayload {
  walletId: string;
  positions: Position[];
  totalSuppliedUsd: number;
  asOf: string;
}

interface Market {
  asset: string;
  supplyApy: number;
  label?: string;
  chain: string;
}

interface Props {
  ownerAddress: string;
  walletId: string;
  signMessage: (message: string) => Promise<string | null>;
}

function pct(fraction: number): string {
  if (!Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(2)}%`;
}

function amt(s: string | null): string {
  if (s == null) return "—";
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n === 0) return "0";
  if (Math.abs(n) < 0.0001) return "<0.0001";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "$—";
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function AgenticWalletEarnSection({ ownerAddress, walletId, signMessage }: Props) {
  const [positions, setPositions] = useState<PositionsPayload | null>(null);
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Positions — authed read with the cached session sig (no popup
        // if a session already exists), exactly like the Hooks modal.
        const creds = await getAuthCreds(ownerAddress, signMessage);
        if (!creds) {
          if (!cancelled) { setError("Sign in to load your Earn positions."); setLoading(false); }
          return;
        }
        const qs = new URLSearchParams({
          walletId,
          address: ownerAddress,
          nonce: creds.nonce,
          signature: creds.signature,
        });

        // Run both reads in parallel: positions (authed) + public markets.
        const [posRes, mktRes] = await Promise.all([
          fetch(`/api/wallet/agentic/yield/positions?${qs.toString()}`),
          fetch(`/api/wallet/agentic/yield/reserves?chain=bnb`),
        ]);

        if (cancelled) return;

        if (posRes.status === 401) {
          // Session sig expired — wipe it so the next surface mints a
          // fresh nonce instead of looping on stale creds.
          clearAuthCache(ownerAddress);
          setError("Session expired — refresh to reload Earn.");
          setLoading(false);
          return;
        }
        if (posRes.ok) {
          const data = (await posRes.json()) as PositionsPayload;
          if (!cancelled) {
            setPositions({
              walletId: data.walletId,
              positions: data.positions ?? [],
              totalSuppliedUsd: data.totalSuppliedUsd ?? 0,
              asOf: data.asOf,
            });
          }
        } else {
          const data = await posRes.json().catch(() => ({}));
          if (!cancelled) setError(data.error ?? `Couldn't load Earn positions (HTTP ${posRes.status}).`);
        }

        if (mktRes.ok) {
          const data = (await mktRes.json()) as { markets?: Market[] };
          if (!cancelled) setMarkets(data.markets ?? []);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerAddress, walletId]);

  const hasPositions = (positions?.positions.length ?? 0) > 0;

  // Best available supply APY across markets, for the teaser line.
  // Guard the empty/all-non-finite case: Math.max() of [] is -Infinity,
  // which would render "~—"; treat a non-finite max as "unknown" (null).
  const finiteApys = (markets ?? [])
    .map((m) => m.supplyApy)
    .filter((n) => Number.isFinite(n));
  const bestApyRaw = finiteApys.length > 0 ? Math.max(...finiteApys) : NaN;
  const bestApy = Number.isFinite(bestApyRaw) ? bestApyRaw : null;

  const labelCls = "text-[10px] text-white/65 uppercase tracking-widest font-medium";

  return (
    <div
      className="relative mt-4 rounded-xl border p-3"
      style={{ background: "rgba(74,222,128,0.04)", borderColor: "rgba(74,222,128,0.18)" }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={labelCls}>Earn · Q402 Yield</span>
          <span className="text-[9px] uppercase tracking-widest text-emerald-400/70 font-semibold">
            Read-only
          </span>
        </div>
        {hasPositions && positions && (
          <div className="text-[11px] text-emerald-300 font-mono">
            {formatUsd(positions.totalSuppliedUsd)} supplied
          </div>
        )}
      </div>

      {loading ? (
        <div className="text-white/50 text-[12px] py-3 text-center">Loading Earn positions…</div>
      ) : error ? (
        <div className="text-[11.5px] text-amber-300/80 py-1">{error}</div>
      ) : hasPositions && positions ? (
        <div className="space-y-1.5">
          {positions.positions.map((p) => (
            <div
              key={`${p.chain}-${p.marketAddress}-${p.asset}`}
              className="flex items-center justify-between text-[12.5px]"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-white/85 font-medium font-mono text-[12px]">{p.asset}</span>
                <span className="text-white/40">·</span>
                <span className="text-white/55 text-[11px] capitalize">{p.protocol}</span>
                <span className="text-white/40">·</span>
                <span className="text-emerald-300/90 text-[11px]">{pct(p.supplyApy)} APY</span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-emerald-300 font-mono text-[12px]">{amt(p.balance)}</span>
                {p.accrued !== null && (
                  <span className="text-white/45 font-mono text-[11px]" title="Accrued yield">
                    +{amt(p.accrued)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        // Teaser — subtle, no positions yet. Pulls the best live APY from
        // the public markets feed when available.
        <div className="text-[12px] text-white/55 leading-relaxed py-1">
          Earn{" "}
          <span className="text-emerald-300 font-medium">
            {bestApy !== null ? `~${pct(bestApy)}` : "yield"}
          </span>{" "}
          on idle USDC / USDT via Aave —{" "}
          <span className="text-white/40">coming soon</span>.
        </div>
      )}
    </div>
  );
}
