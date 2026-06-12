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

import { useCallback, useEffect, useState } from "react";
import { getAuthCreds, getActionAuth, clearAuthCache } from "@/app/lib/auth-client";

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
  // Set by the route when one or more chains' on-chain reads failed this
  // cycle. When present, `positions`/`totalSuppliedUsd` cover ONLY the
  // chains that read cleanly — the figures are PARTIAL, not authoritative.
  unavailable?: boolean;
  unavailableChains?: string[];
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
  /** Yield deposit is paid-only — gate the deposit control before signing so a
   *  trial user doesn't sign an Earn challenge only to receive a 402. Optional;
   *  defaults to allowed (the server still enforces paid-only) so a caller
   *  without a plan signal doesn't regress, but the dashboard passes the real
   *  hasPaid so trial users see the gate BEFORE signing. */
  canDeposit?: boolean;
}

// Human chain label for the partial-read notice. Yield is BNB-only today;
// the map mirrors the dashboard's CHAIN_LABEL convention so added chains
// read cleanly (uppercased key as the fallback for anything unmapped).
const CHAIN_LABEL: Record<string, string> = {
  bnb: "BNB Chain",
  base: "Base",
  arbitrum: "Arbitrum",
  ethereum: "Ethereum",
  avalanche: "Avalanche",
  scroll: "Scroll",
};
function chainLabel(c: string): string {
  return CHAIN_LABEL[c] ?? c.toUpperCase();
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

export function AgenticWalletEarnSection({ ownerAddress, walletId, signMessage, canDeposit = true }: Props) {
  const [positions, setPositions] = useState<PositionsPayload | null>(null);
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load positions (authed) + public markets. Reused on mount and after a
  // successful deposit/withdraw so the supplied total reflects the new
  // on-chain state.
  const loadPositions = useCallback(async () => {
    try {
      setError(null);
      // Positions — authed read with the cached session sig (no popup
      // if a session already exists), exactly like the Hooks modal.
      const creds = await getAuthCreds(ownerAddress, signMessage);
      if (!creds) {
        setError("Sign in to load your Earn positions.");
        setLoading(false);
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
        setPositions({
          walletId: data.walletId,
          positions: data.positions ?? [],
          totalSuppliedUsd: data.totalSuppliedUsd ?? 0,
          asOf: data.asOf,
          unavailable: data.unavailable === true || (data.unavailableChains?.length ?? 0) > 0,
          unavailableChains: data.unavailableChains ?? [],
        });
      } else if (posRes.status === 503) {
        // Every requested chain's read failed — the route 503s so we don't
        // render an empty wallet as "no positions". Treat as a read failure,
        // not a confirmed-empty wallet.
        const data = await posRes.json().catch(() => ({}) as Partial<PositionsPayload>);
        const chains = data.unavailableChains ?? [];
        setError(
          `Couldn't read your Earn positions${
            chains.length ? ` on ${chains.map(chainLabel).join(", ")}` : ""
          } — RPC unavailable. Refresh to retry; this is not a confirmed empty position.`,
        );
      } else {
        const data = await posRes.json().catch(() => ({}));
        setError(data.error ?? `Couldn't load Earn positions (HTTP ${posRes.status}).`);
      }

      if (mktRes.ok) {
        const data = (await mktRes.json()) as { markets?: Market[] };
        setMarkets(data.markets ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [ownerAddress, walletId, signMessage]);

  useEffect(() => {
    void loadPositions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerAddress, walletId]);

  const hasPositions = (positions?.positions.length ?? 0) > 0;

  // Partial read: at least one chain's on-chain balances couldn't be read, so
  // the position list + total cover only the chains that read cleanly. Surface
  // this loudly — a partial sum must not be presented as the authoritative
  // total (mirrors the AgenticWalletCard "RPC failed" notice).
  const unreadableChains = positions?.unavailableChains ?? [];
  const partialRead = (positions?.unavailable ?? false) && unreadableChains.length > 0;

  // Best available supply APY across markets, for the teaser line.
  // Guard the empty/all-non-finite case: Math.max() of [] is -Infinity,
  // which would render "~—"; treat a non-finite max as "unknown" (null).
  const finiteApys = (markets ?? [])
    .map((m) => m.supplyApy)
    .filter((n) => Number.isFinite(n));
  const bestApyRaw = finiteApys.length > 0 ? Math.max(...finiteApys) : NaN;
  const bestApy = Number.isFinite(bestApyRaw) ? bestApyRaw : null;

  const labelCls = "text-[10px] text-white/80 uppercase tracking-widest font-medium";

  return (
    <div className="relative">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={labelCls}>Earn · Q402 Yield</span>
          <span className="inline-flex items-center gap-1 text-[9px] uppercase tracking-widest text-emerald-400/80 font-semibold">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/aave.svg" alt="Aave" width={13} height={13} className="rounded-full" />
            Aave V3
          </span>
        </div>
        {hasPositions && positions && (
          <div className="text-[11px] text-emerald-300 font-mono">
            {formatUsd(positions.totalSuppliedUsd)}
            {partialRead ? "+ supplied" : " supplied"}
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
                <span className="text-white/72 text-[11px] capitalize">{p.protocol}</span>
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
        <div className="text-[12.5px] text-white/80 leading-relaxed py-1">
          Earn{" "}
          <span className="text-emerald-300 font-medium">
            {bestApy !== null ? `~${pct(bestApy)}` : "yield"}
          </span>{" "}
          on idle USDC / USDT via Aave.
        </div>
      )}

      {/* Partial read — some chains' on-chain balances couldn't be read this
          cycle, so the list + total above are incomplete. Surface it instead
          of passing a partial sum off as the full total. */}
      {!loading && !error && partialRead && (
        <div className="text-[11px] text-amber-300/80 mt-2 pt-2 border-t" style={{ borderColor: "rgba(247,202,22,0.12)" }}>
          Couldn&apos;t read {unreadableChains.length} chain
          {unreadableChains.length === 1 ? "" : "s"} ({unreadableChains.map(chainLabel).join(", ")}) —
          total may be incomplete. Refresh to retry.
        </div>
      )}

      {/* Deposit / Withdraw — gasless, owner session-sig auth. Hidden
          loudly: if the v2 contract isn't deployed the first action gets a
          503 yield_not_enabled and the controls collapse to "Coming soon"
          instead of throwing at the user. */}
      {!loading && (
        <AgenticWalletEarnActions
          ownerAddress={ownerAddress}
          walletId={walletId}
          signMessage={signMessage}
          onChanged={() => { void loadPositions(); }}
          canDeposit={canDeposit}
        />
      )}
    </div>
  );
}

// ── AgenticWalletEarnActions ────────────────────────────────────────────────
//
// Deposit / Withdraw controls for one Agent Wallet's Aave V3 position.
// Both writes are intent-bound: getActionAuth mints a single-use challenge
// over the exact { walletId, chain, token, amount } tuple, the wallet signs
// it, and the route rebuilds the same canonical bytes to verify. Mirrors
// the Hooks modal's write path exactly.
//
// "Coming soon" state: the v2 yield contract isn't live on every chain yet.
// The route returns 503 { error: "yield_not_enabled" }; we catch that, flip
// the section to a disabled "coming soon" notice, and remember it for the
// rest of the session so the controls don't keep prompting wallet popups
// against a feature that can't settle.

function AgenticWalletEarnActions({
  ownerAddress,
  walletId,
  signMessage,
  onChanged,
  canDeposit,
}: {
  ownerAddress: string;
  walletId: string;
  signMessage: (message: string) => Promise<string | null>;
  onChanged: () => void;
  canDeposit: boolean;
}) {
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [token, setToken] = useState<"USDC" | "USDT">("USDC");
  const [amount, setAmount] = useState("");
  const [maxWithdraw, setMaxWithdraw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<{ action: string; txHash: string } | null>(null);
  // Flips to true once a route returns 503 yield_not_enabled — disables the
  // controls for the rest of the session (the contract isn't deployed).
  const [comingSoon, setComingSoon] = useState(false);

  const action = mode === "deposit" ? "agentic.yield_deposit" : "agentic.yield_withdraw";
  const endpoint =
    mode === "deposit"
      ? "/api/wallet/agentic/yield/deposit"
      : "/api/wallet/agentic/yield/withdraw";

  const isMax = mode === "withdraw" && maxWithdraw;
  // amount string sent to BOTH the intent (signed) and the body — must match
  // the server's canonical rebuild. "max" is only valid for withdraw.
  const amountValue = isMax ? "max" : amount.trim();
  const amountValid = isMax || (/^\d+(\.\d+)?$/.test(amountValue) && Number(amountValue) > 0);

  async function submit() {
    if (busy || comingSoon) return;
    setErr(null);
    setOkMsg(null);
    if (!amountValid) {
      setErr("Enter a positive amount.");
      return;
    }
    if (mode === "deposit" && !canDeposit) {
      // Yield is paid-only. Block BEFORE the wallet signature so a trial user
      // doesn't sign an Earn challenge only to get a 402 back. Withdraw stays
      // available (the server always allows it).
      setErr("Yield deposits need a paid Multichain plan — upgrade at /payment. Withdraw is always available.");
      return;
    }
    setBusy(true);
    try {
      // Intent MUST be { walletId, chain, token, amount } as string values —
      // the server's requireIntentAuth rebuilds this exact tuple.
      const intent: Record<string, string> = {
        walletId,
        chain: "bnb",
        token,
        amount: amountValue,
      };
      const auth = await getActionAuth(ownerAddress, action, intent, signMessage);
      if (!auth) {
        setErr("Sign the Earn challenge in your wallet to authorize.");
        return;
      }
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerAddress,
          nonce: auth.challenge,
          signature: auth.signature,
          walletId,
          chain: "bnb",
          token,
          amount: amountValue,
        }),
      });
      if (res.status === 401) {
        clearAuthCache(ownerAddress);
        setErr("Session expired — refresh and retry.");
        return;
      }
      const data = await res.json().catch(() => ({}));
      // Deploy-gated: contract not live on this chain yet. Collapse the
      // controls into a soft "coming soon" rather than erroring loudly.
      if (res.status === 503 && data.error === "yield_not_enabled") {
        setComingSoon(true);
        return;
      }
      if (!res.ok) {
        setErr(data.message ?? data.error ?? `Action failed (HTTP ${res.status}).`);
        return;
      }
      setOkMsg({ action: mode === "deposit" ? "Deposited" : "Withdrew", txHash: String(data.txHash ?? "") });
      setAmount("");
      setMaxWithdraw(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const labelCls = "text-[10px] text-white/80 uppercase tracking-widest font-medium";
  const inputStyle = { background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.08)" } as const;

  if (comingSoon) {
    return (
      <div className="mt-3 pt-3 border-t" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
        <div className="text-[11.5px] text-white/45">
          Deposit / Withdraw —{" "}
          <span className="text-emerald-300/70 font-medium">coming soon</span>. Q402 Yield isn&apos;t
          enabled on this chain yet.
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 pt-3 border-t space-y-2" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
      {/* Deposit / Withdraw tab toggle */}
      <div className="flex items-center gap-1.5">
        {(["deposit", "withdraw"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); setErr(null); setOkMsg(null); }}
            className="px-2.5 py-1 rounded-md text-[11px] font-medium capitalize transition-colors"
            style={
              mode === m
                ? { background: "rgba(247,202,22,0.14)", color: "#f9d64a", border: "1px solid rgba(247,202,22,0.35)" }
                : { background: "rgba(255,255,255,0.02)", color: "rgba(255,255,255,0.55)", border: "1px solid rgba(255,255,255,0.07)" }
            }
          >
            {m}
          </button>
        ))}
      </div>

      <div className="flex items-stretch gap-1.5">
        {/* Amount */}
        <div className="flex-1">
          <input
            value={isMax ? "" : amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy || isMax}
            inputMode="decimal"
            placeholder={isMax ? "max (full position)" : "0.00"}
            aria-label="Amount"
            className="w-full rounded-md border px-2.5 py-1.5 text-[12.5px] font-mono text-white placeholder-white/25 disabled:opacity-50"
            style={inputStyle}
          />
        </div>
        {/* Token select */}
        <select
          value={token}
          onChange={(e) => setToken(e.target.value === "USDT" ? "USDT" : "USDC")}
          disabled={busy}
          aria-label="Token"
          className="rounded-md border px-2 py-1.5 text-[12px] font-mono text-white disabled:opacity-50"
          style={inputStyle}
        >
          <option value="USDC" style={{ background: "#0F1929", color: "#EAF2EC" }}>USDC</option>
          <option value="USDT" style={{ background: "#0F1929", color: "#EAF2EC" }}>USDT</option>
        </select>
        {/* Submit */}
        <button
          type="button"
          onClick={submit}
          disabled={busy || !amountValid || (mode === "deposit" && !canDeposit)}
          className="px-3 py-1.5 rounded-md text-[12px] font-semibold bg-emerald-400 text-slate-900 hover:bg-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed capitalize"
        >
          {busy ? "…" : mode}
        </button>
      </div>

      {/* Max toggle — withdraw only */}
      {mode === "withdraw" && (
        <label className={`flex items-center gap-1.5 cursor-pointer ${labelCls} normal-case`}>
          <input
            type="checkbox"
            checked={maxWithdraw}
            onChange={(e) => { setMaxWithdraw(e.target.checked); setErr(null); }}
            disabled={busy}
            className="accent-emerald-400 w-3.5 h-3.5"
          />
          <span className="text-[11px] text-white/55 tracking-normal normal-case">Withdraw full position (max)</span>
        </label>
      )}

      {err && <div className="text-[11px] text-red-300/85">{err}</div>}
      {okMsg && (
        <div className="text-[11px] text-emerald-300/90">
          {okMsg.action}.{" "}
          {okMsg.txHash ? (
            <a
              href={`https://bscscan.com/tx/${okMsg.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-emerald-300 hover:text-emerald-200 underline-offset-2 hover:underline"
            >
              {okMsg.txHash.slice(0, 10)}…{okMsg.txHash.slice(-6)} ↗
            </a>
          ) : null}
        </div>
      )}
    </div>
  );
}
