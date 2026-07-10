"use client";

/**
 * AgenticWalletEarnSection — the "Earn" surface for an Agent Wallet.
 *
 * Q402 Yield (Aave V3 + Lista on BNB, Morpho on Base). Renders, for one wallet:
 *   - Each current supply position per (chain, asset): redeemable balance,
 *     supply APY, accrued yield (when the principal is tracked).
 *   - Total supplied USD across positions.
 *   - A selectable market list that IS the deposit/withdraw selector: tap a
 *     market to set chain + venue + token with its live APY in view.
 *   - Deposit/withdraw controls (AgenticWalletEarnActions) bound to the tapped row.
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

// Human chain label for the partial-read notice. Yield spans BNB (Aave + Lista) and
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
// automatically (no hardcoded "Aave · Lista · Morpho" to update at flip time).
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

  return (
    <div className="relative">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          {/* Venues are DATA-DRIVEN from the markets feed. Logos are NOT overlapped —
              three small distinct badges so Aave / Lista / Morpho stay individually
              identifiable; the subtitle names them and auto-tracks live venues. */}
          <div className="flex items-center gap-1 shrink-0">
            {(venues.length ? venues : ["aave", "lista", "morpho"]).slice(0, 4).map((v) => {
              const meta = venueMeta(v);
              if (!meta.logo) return null;
              return (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={v}
                  src={meta.logo}
                  alt={meta.label}
                  width={22}
                  height={22}
                  className="rounded-full"
                  style={{ boxShadow: "0 0 0 1.5px #0c1626" }}
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
      ) : (
        <>
          {/* Partial read — some chains' on-chain balances couldn't be read this
              cycle, so the position balances + total are incomplete. Surface it
              instead of passing a partial sum off as the full total. */}
          {partialRead && (
            <div className="text-[11px] text-amber-300/80 mb-2 pb-2 border-b" style={{ borderColor: "rgba(247,202,22,0.12)" }}>
              Couldn&apos;t read {unreadableChains.length} chain
              {unreadableChains.length === 1 ? "" : "s"} ({unreadableChains.map(chainLabel).join(", ")}) —
              total may be incomplete. Refresh to retry.
            </div>
          )}
          {/* The market list IS the selector: tap a row to set chain + venue + token
              with the APY in view, then enter an amount — no separate chain/venue/token
              control. Deposit lists every venue (choose where); withdraw lists only
              what the wallet holds. Hidden loudly via 503 -> per-chain "coming soon". */}
          <AgenticWalletEarnActions
            ownerAddress={ownerAddress}
            walletId={walletId}
            signMessage={signMessage}
            onChanged={() => { void loadPositions(); }}
            canDeposit={canDeposit}
            rows={marketRows}
          />
        </>
      )}
    </div>
  );
}

// ── AgenticWalletEarnActions ────────────────────────────────────────────────
//
// Deposit / Withdraw controls for one Agent Wallet's yield positions across venues.
// Both writes are intent-bound: getActionAuth mints a single-use challenge over the
// exact { walletId, chain, token, amount, protocol? } tuple, the wallet signs it, and
// the route rebuilds the same canonical bytes to verify. Mirrors the Hooks modal's
// write path exactly.
//
// "Coming soon" state: the v2 yield contract isn't live on every chain yet.
// The route returns 503 { error: "yield_not_enabled" }; we catch that, flip
// the section to a disabled "coming soon" notice, and remember it for the
// rest of the session so the controls don't keep prompting wallet popups
// against a feature that can't settle.

type EarnMarketRow = { chain: string; asset: string; protocol?: string; apy: number; balance: number | null };

function AgenticWalletEarnActions({
  ownerAddress,
  walletId,
  signMessage,
  onChanged,
  canDeposit,
  rows,
}: {
  ownerAddress: string;
  walletId: string;
  signMessage: (message: string) => Promise<string | null>;
  onChanged: () => void;
  canDeposit: boolean;
  /** Unified market+position rows (chain, asset, venue, APY, balance). The list
   *  below IS the selector: tapping a row sets the chain + token + venue for the
   *  action, so there's no separate chain/venue/token control and the rate you're
   *  choosing is in view. */
  rows: EarnMarketRow[];
}) {
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [maxWithdraw, setMaxWithdraw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<{ action: string; txHash: string; chain: string } | null>(null);
  // Chains whose route returned 503 yield_not_enabled (the v2 impl isn't
  // deployed there yet). Tracked per chain: BNB can be live while Base is not,
  // so a coming-soon chain disables only its own row's action.
  const [comingSoonChains, setComingSoonChains] = useState<Set<string>>(new Set());

  const rowKey = (r: { chain: string; asset: string; protocol?: string }) => `${r.chain}:${r.asset}:${r.protocol ?? ""}`;
  const CHAIN_ORDER: Record<string, number> = { bnb: 0, base: 1 };

  // DEPOSIT lists every market (choose where to put funds); WITHDRAW lists only the
  // venues the wallet actually holds a balance in (you can't pull from an empty
  // market). Both grouped by chain, best-rate-first within a chain.
  const listRows = (mode === "deposit" ? rows : rows.filter((r) => (r.balance ?? 0) > 0))
    .slice()
    .sort((a, b) => (CHAIN_ORDER[a.chain] ?? 9) - (CHAIN_ORDER[b.chain] ?? 9) || b.apy - a.apy);

  // The chosen row: the user's pick if still in the current list, else the default
  // (highest APY for deposit / first held position for withdraw — list is sorted).
  const selectedRow: EarnMarketRow | null = listRows.find((r) => rowKey(r) === selectedKey) ?? listRows[0] ?? null;

  // chain / token / venue are DERIVED from the selected row — no separate controls.
  const chain = selectedRow?.chain ?? "bnb";
  const effToken: "USDC" | "USDT" = selectedRow?.asset === "USDT" ? "USDT" : "USDC";
  const effProtocol = selectedRow?.protocol;
  const comingSoon = comingSoonChains.has(chain);

  const action = mode === "deposit" ? "agentic.yield_deposit" : "agentic.yield_withdraw";
  const endpoint =
    mode === "deposit"
      ? "/api/wallet/agentic/yield/deposit"
      : "/api/wallet/agentic/yield/withdraw";

  const isMax = mode === "withdraw" && maxWithdraw;
  // amount string sent to BOTH the intent (signed) and the body — must match the
  // server's canonical rebuild. "max" is only valid for withdraw.
  const amountValue = isMax ? "max" : amount.trim();
  const amountValid = isMax || (/^\d+(\.\d+)?$/.test(amountValue) && Number(amountValue) > 0);

  function selectRow(r: EarnMarketRow) {
    setSelectedKey(rowKey(r));
    setErr(null);
    setOkMsg(null);
  }

  async function submit() {
    if (busy || comingSoon) return;
    setErr(null);
    setOkMsg(null);
    if (!selectedRow) {
      setErr(mode === "withdraw" ? "No position to withdraw." : "Pick a market to deposit into.");
      return;
    }
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
      // Intent is { walletId, chain, token, amount } (+ protocol) as string values —
      // the server's requireIntentAuth rebuilds the same tuple, so the signature
      // binds the EXACT chain/token/venue of the row the user tapped.
      const intent: Record<string, string> = {
        walletId,
        chain,
        token: effToken,
        amount: amountValue,
      };
      // Bind the chosen venue into the SIGNED intent (server rebuilds the same, so a
      // swapped venue fails verification). Every row carries a venue, so deposit and
      // withdraw both bind it; omitted only if somehow unresolved (server omits then too).
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
          // Venue (deposit target / withdraw source). Also bound into the SIGNED
          // intent above, so the server verifies the venue you approved.
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

  const inputStyle = { background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.08)" } as const;
  const segSel = { background: "rgba(247,202,22,0.14)", color: "#f9d64a", border: "1px solid rgba(247,202,22,0.35)" } as const;
  const segUnsel = { background: "rgba(255,255,255,0.02)", color: "rgba(255,255,255,0.55)", border: "1px solid rgba(255,255,255,0.07)" } as const;

  // Chain groups for the selectable list (one compact row per market).
  const groups: [string, EarnMarketRow[]][] = [];
  for (const r of listRows) {
    const g = groups.find(([c]) => c === r.chain);
    if (g) g[1].push(r);
    else groups.push([r.chain, [r]]);
  }

  return (
    <div className="mt-3 pt-3 border-t space-y-2" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
      {/* Mode toggle — governs the list (deposit = all markets to choose from;
          withdraw = only the venues this wallet holds). */}
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

      {/* Selectable market list. Tap a row to set chain + venue + token; the APY is
          right there so the choice is made by rate, not by a blind selector. */}
      {listRows.length === 0 ? (
        <div className="text-[11.5px] text-white/45 py-1">
          {mode === "withdraw"
            ? "No positions to withdraw yet. Deposit to start earning."
            : "No markets available right now. Refresh to retry."}
        </div>
      ) : (
        <div className="space-y-1">
          {groups.map(([c, rs], gi) => (
            <div key={c} className={gi === 0 ? "" : "pt-0.5"}>
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[9.5px] font-semibold uppercase tracking-wider text-white/35 shrink-0">{chainLabel(c)}</span>
                <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
              </div>
              <div className="space-y-0.5">
                {rs.map((r) => {
                  const vm = venueMeta(r.protocol);
                  const sel = selectedRow != null && rowKey(r) === rowKey(selectedRow);
                  return (
                    <button
                      key={rowKey(r)}
                      type="button"
                      onClick={() => selectRow(r)}
                      className="w-full flex items-center gap-2 px-2.5 py-1 rounded-lg border transition-colors text-left"
                      style={sel
                        ? { background: "rgba(247,202,22,0.12)", borderColor: "rgba(247,202,22,0.38)" }
                        : { background: "transparent", borderColor: "transparent" }}
                    >
                      {/* radio */}
                      <span
                        className="w-3 h-3 rounded-full shrink-0 grid place-items-center"
                        style={{ border: sel ? "1.5px solid #f9d64a" : "1.5px solid rgba(255,255,255,0.25)" }}
                      >
                        {sel && <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#f9d64a" }} />}
                      </span>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/${r.asset.toLowerCase()}.svg`} alt={r.asset} width={17} height={17} className="rounded-full shrink-0" />
                      <span className="text-white/90 font-medium font-mono text-[12.5px] w-[40px] shrink-0">{r.asset}</span>
                      <span className="flex items-center gap-1.5 min-w-0 flex-1">
                        {vm.logo && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={vm.logo} alt={vm.label} width={14} height={14} className="rounded-full shrink-0" />
                        )}
                        <span className="text-white/65 text-[11px] truncate">{vm.label}</span>
                      </span>
                      {/* APY + balance are FIXED-WIDTH right-aligned columns so they line
                          up vertically across every row (venue flex-1 absorbs the slack);
                          otherwise a wider balance pushes that row's APY out of column. */}
                      <span className="w-[46px] text-right text-emerald-300 font-mono text-[12.5px] font-semibold shrink-0">{pct(r.apy)}</span>
                      <span
                        className="w-[52px] text-right whitespace-nowrap font-mono text-[12px] shrink-0"
                        style={{ color: r.balance != null ? "#6ee7b7" : "rgba(255,255,255,0.28)" }}
                      >
                        {r.balance != null ? formatUsd(r.balance) : "—"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Action row — amount + the selected token (read-only chip) + submit. The
          "where" is the row tapped above, so no chain/venue/token control here. */}
      {selectedRow && (comingSoon ? (
        <div className="text-[11.5px] text-white/45">
          Deposit / Withdraw on {chainLabel(chain)}:{" "}
          <span className="text-emerald-300/70 font-medium">coming soon</span>. Q402 Yield isn&apos;t
          enabled on this chain yet.
        </div>
      ) : (
        <>
          <div className="flex items-stretch gap-1.5">
            <div className="flex-1">
              <input
                value={isMax ? "" : amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={busy || isMax}
                inputMode="decimal"
                placeholder={isMax ? "max (currently redeemable)" : "0.00"}
                aria-label="Amount"
                className="w-full rounded-md border px-2.5 py-1.5 text-[12.5px] font-mono text-white placeholder-white/25 disabled:opacity-50"
                style={inputStyle}
              />
            </div>
            {/* Token is fixed by the tapped market (read-only chip) */}
            <div className="flex items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-mono text-white shrink-0" style={inputStyle}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/${effToken.toLowerCase()}.svg`} alt={effToken} width={15} height={15} className="rounded-full" />
              {effToken}
            </div>
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
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={maxWithdraw}
                onChange={(e) => { setMaxWithdraw(e.target.checked); setErr(null); }}
                disabled={busy}
                className="accent-emerald-400 w-3.5 h-3.5"
              />
              <span className="text-[11px] text-white/55">Withdraw max currently redeemable</span>
            </label>
          )}
        </>
      ))}

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
