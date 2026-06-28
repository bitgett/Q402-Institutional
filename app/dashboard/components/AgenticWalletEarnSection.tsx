"use client";

/**
 * AgenticWalletEarnSection — the "Earn" surface for an Agent Wallet.
 *
 * Q402 Yield (Aave V3 on BNB, Morpho on Base). Renders, for one wallet:
 *   - Each current supply position per (chain, asset): redeemable balance,
 *     supply APY, accrued yield (when the principal is tracked).
 *   - Total supplied USD across positions.
 *   - When the wallet has no positions, a subtle teaser pulled from the
 *     public markets feed ("Earn ~X% on idle USDC/USDT via Aave or Morpho").
 *   - Deposit/withdraw controls (AgenticWalletEarnActions), per chain.
 *
 * The position/market reads use the cached SESSION sig (getAuthCreds);
 * markets are public (no auth). Deposit/withdraw are intent-bound writes.
 *
 * Data sources:
 *   GET /api/wallet/agentic/yield/positions?walletId&address&nonce&signature
 *   GET /api/wallet/agentic/yield/reserves   (public, all supported chains)
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
  /** Deposit venue (aave | morpho | lista) from the reserves feed; drives the
   *  chain selector's venue label so it tracks the real venue at flip time. */
  protocol?: string;
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

// Human chain label for the partial-read notice. Yield spans BNB (Aave) and
// Base (Morpho); the map mirrors the dashboard's CHAIN_LABEL convention so
// added chains read cleanly (uppercased key as the fallback for anything unmapped).
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

// Yield venue (lending protocol) brand metadata. Data-driven so the card shows
// whatever venues the markets/positions feed reports — a NEW venue only needs a
// row here + its logo in /public, and it surfaces in the header + per-row chip
// automatically (no hardcoded "Aave · Morpho" to update at flip time).
const VENUE_META: Record<string, { label: string; logo: string }> = {
  aave: { label: "Aave V3", logo: "/aave.svg" },
  morpho: { label: "Morpho", logo: "/logos/morpho.png" },
  lista: { label: "Lista", logo: "/lista.svg" },
};
function venueMeta(p?: string): { label: string; logo: string | null } {
  if (p && VENUE_META[p]) return VENUE_META[p];
  return { label: p ? p.charAt(0).toUpperCase() + p.slice(1) : "Lending", logo: null };
}

function pct(fraction: number): string {
  if (!Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(2)}%`;
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
        fetch(`/api/wallet/agentic/yield/reserves`),
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

  // One row per (chain, asset, VENUE) so two venues on a chain (a legacy Aave and a
  // new Lista USDC position on BNB) never merge under one row and silently hide a
  // balance. Union the public markets (APY) with the wallet's positions (balance),
  // keyed by chain+asset+protocol.
  type EarnRow = { chain: string; asset: string; protocol?: string; apy?: number; balance: number | null };
  const rowMap = new Map<string, EarnRow>();
  for (const m of markets ?? []) {
    const k = `${m.chain}:${m.asset}:${m.protocol ?? ""}`;
    rowMap.set(k, { chain: m.chain, asset: m.asset, protocol: m.protocol, apy: m.supplyApy, balance: null });
  }
  for (const p of positions?.positions ?? []) {
    const k = `${p.chain}:${p.asset}:${p.protocol ?? ""}`;
    const r = rowMap.get(k);
    if (r) { r.balance = Number(p.balance); if (r.apy == null) r.apy = p.supplyApy; }
    else rowMap.set(k, { chain: p.chain, asset: p.asset, protocol: p.protocol, apy: p.supplyApy, balance: Number(p.balance) });
  }
  const marketRows = [...rowMap.values()].filter(
    (r): r is EarnRow & { apy: number } => typeof r.apy === "number" && Number.isFinite(r.apy),
  );
  // Distinct venues present, first-seen order — drives the header logos/subtitle
  // and the teaser, all data-driven (no hardcoded venue list to update at flip).
  const venues = marketRows.reduce<string[]>((acc, r) => {
    if (r.protocol && !acc.includes(r.protocol)) acc.push(r.protocol);
    return acc;
  }, []);
  // Group rows under a chain header so venues stack per chain (scales as more
  // venues/chains land; the chain then drops out of each row). First-seen order.
  const chainGroups = new Map<string, typeof marketRows>();
  for (const row of marketRows) {
    const g = chainGroups.get(row.chain);
    if (g) g.push(row);
    else chainGroups.set(row.chain, [row]);
  }

  return (
    <div className="relative">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          {/* Venues are DATA-DRIVEN from the markets feed — overlapping logos +
              a subtitle that auto-tracks whatever venues are live (Aave/Morpho
              today; Lista appears on BNB the moment its deposit flag flips, and a
              future venue just needs a VENUE_META row + a logo). */}
          <div className="flex items-center shrink-0">
            {(venues.length ? venues : ["aave", "morpho"]).slice(0, 4).map((v, i) => {
              const meta = venueMeta(v);
              if (!meta.logo) return null;
              return (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={v}
                  src={meta.logo}
                  alt={meta.label}
                  width={26}
                  height={26}
                  className="rounded-full"
                  style={{ marginLeft: i === 0 ? 0 : -9, boxShadow: "0 0 0 2px #0c1626" }}
                />
              );
            })}
          </div>
          <div className="min-w-0 leading-tight">
            <div className="text-[15px] font-semibold text-white/90">Q402 Yield</div>
            <div className="text-[12px] text-white/55 mt-0.5 truncate">
              {venues.length === 0
                ? "Lending vaults"
                : venues.length <= 3
                  ? venues.map((v) => venueMeta(v).label).join(" · ")
                  : `${venues.length} venues`}
            </div>
          </div>
        </div>
        <div className="text-[19px] font-semibold font-mono shrink-0 leading-none">
          {hasPositions && positions ? (
            <span className="text-emerald-300">
              {formatUsd(positions.totalSuppliedUsd)}
              {partialRead ? "+" : ""}
            </span>
          ) : (
            <span className="text-white/30">$0.00</span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="text-white/50 text-[12px] py-3 text-center">Loading Earn positions…</div>
      ) : error ? (
        <div className="text-[11.5px] text-amber-300/80 py-1">{error}</div>
      ) : marketRows.length > 0 ? (
        <div className="space-y-2.5">
          {[...chainGroups.entries()].map(([chain, rows]) => (
            <div key={chain}>
              {/* Chain header — venues for this chain stack beneath it. */}
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[9.5px] font-semibold uppercase tracking-wider text-white/35 shrink-0">{chainLabel(chain)}</span>
                <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
              </div>
              <div className="space-y-2">
                {rows.map((row) => {
                  const vm = venueMeta(row.protocol);
                  return (
                    <div key={`${row.chain}:${row.asset}:${row.protocol ?? ""}`} className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/${row.asset.toLowerCase()}.svg`} alt={row.asset} width={18} height={18} className="rounded-full shrink-0" />
                        <div className="min-w-0 leading-tight">
                          <div className="flex items-center gap-1.5">
                            <span className="text-white/90 font-medium font-mono text-[12.5px]">{row.asset}</span>
                            <span className="text-emerald-300/90 text-[11px]">{pct(row.apy)} APY</span>
                          </div>
                          <div className="flex items-center gap-1 mt-0.5 min-w-0">
                            {vm.logo && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={vm.logo} alt={vm.label} width={11} height={11} className="rounded-full shrink-0" />
                            )}
                            <span className="text-white/55 text-[10px] truncate">{vm.label}</span>
                          </div>
                        </div>
                      </div>
                      {row.balance != null ? (
                        <span className="text-emerald-300 font-mono text-[13px] shrink-0">{formatUsd(row.balance)}</span>
                      ) : (
                        <span className="text-white/30 font-mono text-[13px] shrink-0">—</span>
                      )}
                    </div>
                  );
                })}
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
          on idle USDC / USDT via {venues.length ? venues.map((v) => venueMeta(v).label).join(", ") : "vetted lending vaults"}.
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
          defaultToken={positions?.positions?.[0]?.asset === "USDT" ? "USDT" : "USDC"}
          // Seed the chain tab to where the wallet actually holds a position so
          // a withdraw doesn't default to BNB-Aave (empty) and revert on-chain
          // when the only position is Base-Morpho. Falls back to bnb (deposit).
          defaultChain={positions?.positions?.[0]?.chain === "base" ? "base" : "bnb"}
          // chain -> deposit venue from the (de-duped) public markets, so the
          // selector shows the REAL venue (BNB shows Lista once the flag flips).
          venueByChain={Object.fromEntries((markets ?? []).filter((m) => m.protocol).map((m) => [m.chain, m.protocol as string]))}
          // `${chain}:${asset}` -> venues the wallet actually holds, so a withdraw
          // can disambiguate when the same token sits in two venues on one chain.
          withdrawVenues={(() => {
            const m: Record<string, string[]> = {};
            for (const p of positions?.positions ?? []) {
              if (!(Number(p.balance) > 0) || !p.protocol) continue;
              const k = `${p.chain}:${p.asset}`;
              (m[k] ??= []).push(p.protocol);
            }
            return m;
          })()}
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
  defaultToken,
  defaultChain,
  venueByChain,
  withdrawVenues,
}: {
  ownerAddress: string;
  walletId: string;
  signMessage: (message: string) => Promise<string | null>;
  onChanged: () => void;
  canDeposit: boolean;
  /** Seeds the deposit/withdraw token to the wallet's supplied asset so the
   *  control doesn't default to USDC while the position is USDT (and vice versa). */
  defaultToken: "USDC" | "USDT";
  /** Seeds the chain tab to the wallet's position chain so a withdraw targets
   *  where the funds actually are (BNB-Aave vs Base-Morpho) instead of always
   *  defaulting to BNB and reverting when the position lives on Base. */
  defaultChain: "bnb" | "base";
  /** chain -> live deposit venue (protocol) from the public markets feed, so the
   *  selector label tracks the actual venue (BNB flips Aave->Lista at flip time)
   *  instead of a hardcoded "Aave". */
  venueByChain?: Record<string, string>;
  /** `${chain}:${asset}` -> protocols the wallet holds a position in. When a
   *  withdraw selection maps to >1 venue, the user picks which to pull from (the
   *  server otherwise replies AMBIGUOUS_POSITION). */
  withdrawVenues?: Record<string, string[]>;
}) {
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [chain, setChain] = useState<"bnb" | "base">(defaultChain);
  const [token, setToken] = useState<"USDC" | "USDT">(defaultToken);
  const [amount, setAmount] = useState("");
  const [maxWithdraw, setMaxWithdraw] = useState(false);
  const [venue, setVenue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<{ action: string; txHash: string; chain: "bnb" | "base" } | null>(null);
  // Chains whose route returned 503 yield_not_enabled (the v2 impl isn't
  // deployed there yet). Tracked per chain: BNB can be live while Base is not,
  // so a coming-soon chain disables only its own controls.
  const [comingSoonChains, setComingSoonChains] = useState<Set<string>>(new Set());

  // Base settles into Morpho and the curated vault is USDC-only, so force USDC
  // there: the user can't pick an unsupported token.
  const baseOnly = chain === "base";
  const effToken: "USDC" | "USDT" = baseOnly ? "USDC" : token;
  const comingSoon = comingSoonChains.has(chain);

  // Withdraw venue disambiguation: if the wallet holds this (chain, token) in more
  // than one venue (e.g. legacy Aave + Lista on BNB), the user must choose which to
  // pull from; otherwise the server replies AMBIGUOUS_POSITION. Deposits never need
  // this (one deposit venue per chain).
  const venuesForSel = withdrawVenues?.[`${chain}:${effToken}`] ?? [];
  const ambiguousVenue = mode === "withdraw" && venuesForSel.length > 1;
  const effProtocol = ambiguousVenue
    ? (venue && venuesForSel.includes(venue) ? venue : venuesForSel[0])
    : undefined;

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
      // Intent is { walletId, chain, token, amount } (+ protocol on a multi-venue
      // withdraw) as string values — the server's requireIntentAuth rebuilds the same
      // tuple, so the signature binds the venue the user approved.
      const intent: Record<string, string> = {
        walletId,
        chain,
        token: effToken,
        amount: amountValue,
      };
      // Bind the chosen venue into the SIGNED intent when a venue was chosen
      // (multi-venue withdraw); single-venue / deposit omit it (and the server omits
      // it too, so the canonical bytes still match).
      if (effProtocol) intent.protocol = effProtocol;
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
          chain,
          token: effToken,
          amount: amountValue,
          // Venue choice for a multi-venue withdraw. NOT part of the signed intent
          // (server reads it only to route), so it needs no re-sign.
          ...(effProtocol ? { protocol: effProtocol } : {}),
        }),
      });
      if (res.status === 401) {
        clearAuthCache(ownerAddress);
        setErr("Session expired — refresh and retry.");
        return;
      }
      const data = await res.json().catch(() => ({}));
      // Deploy-gated: contract not live on THIS chain yet. Mark only this
      // chain coming-soon (the other may be live) instead of erroring loudly.
      if (res.status === 503 && data.error === "yield_not_enabled") {
        setComingSoonChains((s) => new Set(s).add(chain));
        return;
      }
      if (!res.ok) {
        setErr(data.message ?? data.error ?? `Action failed (HTTP ${res.status}).`);
        return;
      }
      setOkMsg({ action: mode === "deposit" ? "Deposited" : "Withdrew", txHash: String(data.txHash ?? ""), chain });
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

  // Segmented-button styles shared by the chain + mode toggles.
  const segSel = { background: "rgba(247,202,22,0.14)", color: "#f9d64a", border: "1px solid rgba(247,202,22,0.35)" } as const;
  const segUnsel = { background: "rgba(255,255,255,0.02)", color: "rgba(255,255,255,0.55)", border: "1px solid rgba(255,255,255,0.07)" } as const;

  return (
    <div className="mt-3 pt-3 border-t space-y-2" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
      {/* Chain selector: BNB (Aave V3) / Base (Morpho). Base is USDC-only. */}
      <div className="flex items-center gap-1.5">
        {(["bnb", "base"] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => { setChain(c); setErr(null); setOkMsg(null); }}
            className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors"
            style={chain === c ? segSel : segUnsel}
          >
            {(() => {
              const chainLabel = c === "bnb" ? "BNB" : "Base";
              const venue = venueByChain?.[c];
              const venueLabel = venue ? venue.charAt(0).toUpperCase() + venue.slice(1) : null;
              return venueLabel ? `${chainLabel} · ${venueLabel}` : chainLabel;
            })()}
          </button>
        ))}
      </div>

      {/* Deposit / Withdraw tab toggle */}
      <div className="flex items-center gap-1.5">
        {(["deposit", "withdraw"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); setErr(null); setOkMsg(null); }}
            className="px-2.5 py-1 rounded-md text-[11px] font-medium capitalize transition-colors"
            style={mode === m ? segSel : segUnsel}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Venue selector — only when a withdraw is ambiguous (same token in >1 venue
          on this chain, e.g. legacy Aave + Lista on BNB). */}
      {ambiguousVenue && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-white/40 mr-0.5 uppercase tracking-widest">From</span>
          {venuesForSel.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => { setVenue(v); setErr(null); setOkMsg(null); }}
              className="px-2.5 py-1 rounded-md text-[11px] font-medium capitalize transition-colors"
              style={effProtocol === v ? segSel : segUnsel}
            >
              {v}
            </button>
          ))}
        </div>
      )}

      {comingSoon ? (
        <div className="text-[11.5px] text-white/45">
          Deposit / Withdraw on {chain === "base" ? "Base" : "BNB Chain"}:{" "}
          <span className="text-emerald-300/70 font-medium">coming soon</span>. Q402 Yield isn&apos;t
          enabled on this chain yet.
        </div>
      ) : (
        <>
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
            {/* Token select. Base routes to the Morpho USDC vault, so USDT is
                hidden + the control is locked to USDC there. */}
            <select
              value={effToken}
              onChange={(e) => setToken(e.target.value === "USDT" ? "USDT" : "USDC")}
              disabled={busy || baseOnly}
              aria-label="Token"
              className="rounded-md border px-2 py-1.5 text-[12px] font-mono text-white disabled:opacity-50"
              style={inputStyle}
            >
              <option value="USDC" style={{ background: "#0F1929", color: "#EAF2EC" }}>USDC</option>
              {!baseOnly && (
                <option value="USDT" style={{ background: "#0F1929", color: "#EAF2EC" }}>USDT</option>
              )}
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

          {/* Max toggle: withdraw only */}
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
        </>
      )}

      {err && <div className="text-[11px] text-red-300/85">{err}</div>}
      {okMsg && (
        <div className="text-[11px] text-emerald-300/90">
          {okMsg.action}.{" "}
          {okMsg.txHash ? (
            <a
              href={`${okMsg.chain === "base" ? "https://basescan.org" : "https://bscscan.com"}/tx/${okMsg.txHash}`}
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
