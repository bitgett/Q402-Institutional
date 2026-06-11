"use client";

/**
 * ActivityView — settlement activity ledger (prototype id="activity",
 * .wide-view = 230px context rail + view-main table).
 *
 * REAL IMPLEMENTATION.
 *
 * ── Layout ──────────────────────────────────────────────────────────────
 *   .view-shell = grid 230px / 1fr
 *   Col 1  .context rail buttons: All settlements / Manual sends /
 *          Recurring fires / Bridge history / Trust Receipts
 *   Col 2  .view-main: title "Settlement activity", desc, .filters chips
 *          (All wallets / per-wallet, All networks / per-chain), then a
 *          .table of rows: Settlement (kind + receipt sub) · Wallet ·
 *          Network · Status · Amount.
 *
 * ── DATA (all REUSED, none reinvented) ──────────────────────────────────
 *   - Relayed tx history: GET /api/transactions?address&nonce&sig — the same
 *     auth'd endpoint the v1 dashboard's `relayedTxs` reads (page.tsx:1093).
 *     Shape mirrors app/lib/db.ts RelayedTx (chain/fromUser/toUser/
 *     tokenAmount/tokenSymbol/relayTxHash/relayedAt/receiptId?/source?/ruleId?).
 *   - Scope (trial|multichain): provisioned key sets from POST
 *     /api/keys/provision (page.tsx:986) build the trial vs paid key sets;
 *     txs are filtered by the apiKey used at relay time — identical logic to
 *     page.tsx:1503-1539 (trialKeySet / paidKeySet / scopedTxs).
 *   - Recurring fires: source === "recurring" rows (tagged by the recurring
 *     cron — AgenticWalletRecurringSection's data layer fires them).
 *   - Bridge history: GET /api/ccip/bridge-history?address&nonce&signature
 *     (BridgeHistoryRecord shape — app/lib/ccip-bridge-runner.ts:54).
 *   - Trust Receipts: rows with receiptId → /receipt/{id}.
 *   - Wallet filter: GET /api/wallet/agentic (AgenticWalletPublic list) — same
 *     fetch AgenticWalletTab uses; filters the table by the agent wallet that
 *     sent each settlement (fromUser === wallet.address).
 *   - Explorer links: explorerTxUrl/explorerLabel (app/lib/eip7702.ts).
 *   - Auth: getAuthCreds (app/lib/auth-client.ts).
 *
 * ── SCOPE semantics ─────────────────────────────────────────────────────
 *   `scope` filters which key's settlements are shown (trial vs multichain
 *   key) — same data shape, different key scope. Not a layout change.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { getAuthCreds, clearAuthCache } from "@/app/lib/auth-client";
import { explorerTxUrl, explorerLabel } from "@/app/lib/eip7702";
import type { ChainKey } from "@/app/lib/relayer";
import { Surface, Eyebrow, V2AccentScope, displayFont, shortAddr } from "../primitives";
import { v2 } from "../theme";
import type { Scope } from "../theme";

export interface ActivityViewProps {
  /** Connected owner address (null until wallet connects). */
  ownerAddress: string | null;
  /** Wallet message signer — needed to auth the tx-history fetch. */
  signMessage: (message: string) => Promise<string | null>;
  /** Active scope — selects which API key's settlements to show. */
  scope: Scope;
}

// ── Reused data shapes (mirror the server / v1 dashboard) ────────────────────
/** Mirrors app/lib/db.ts RelayedTx (the subset the ledger renders). */
interface RelayedTx {
  apiKey: string;
  address: string;
  chain: string;
  fromUser: string;
  toUser: string;
  tokenAmount: number | string;
  tokenSymbol: string;
  gasCostNative: number;
  relayTxHash: string;
  relayedAt: string;
  receiptId?: string;
  source?: "recurring" | "send" | "batch" | "api";
  ruleId?: string;
}

/** Mirrors app/lib/ccip-bridge-runner.ts BridgeHistoryRecord (render subset). */
interface BridgeRecord {
  messageId: string;
  txHash: string;
  owner: string;
  walletId: string;
  src: string;
  dst: string;
  amount: string; // raw 6-dec USDC
  feeToken: string;
  feeWhole: number;
  initiatedAt: number;
}

/** Mirrors AgenticWalletPublic (the fields the wallet filter needs). */
interface WalletRow {
  address: string;
  walletId: string;
  label: string | null;
}

type RailTab = "all" | "manual" | "recurring" | "bridge" | "receipts";

const RAIL: { id: RailTab; label: string; hint: string }[] = [
  { id: "all", label: "All settlements", hint: "Every relayed payment" },
  { id: "manual", label: "Manual sends", hint: "Send · batch · API" },
  { id: "recurring", label: "Recurring fires", hint: "Scheduled payouts" },
  { id: "bridge", label: "Bridge history", hint: "CCIP cross-chain" },
  { id: "receipts", label: "Trust Receipts", hint: "Verifiable receipts" },
];

// ── Chain meta — colour + display name (matches v1 CHAIN_META) ───────────────
const CHAIN_META: Record<string, { name: string; color: string }> = {
  bnb: { name: "BNB Chain", color: "#F0B90B" },
  eth: { name: "Ethereum", color: "#627EEA" },
  avax: { name: "Avalanche", color: "#E84142" },
  xlayer: { name: "X Layer", color: "#8993a6" },
  stable: { name: "Stable", color: v2.mint },
  mantle: { name: "Mantle", color: "#FFFFFF" },
  injective: { name: "Injective", color: "#0082FA" },
  monad: { name: "Monad", color: "#836EF9" },
  scroll: { name: "Scroll", color: "#EEB431" },
  arbitrum: { name: "Arbitrum", color: "#28A0F0" },
};

function chainName(chain: string): string {
  return CHAIN_META[chain]?.name ?? chain.toUpperCase();
}
function chainColor(chain: string): string {
  return CHAIN_META[chain]?.color ?? v2.muted;
}

const SOURCE_LABEL: Record<NonNullable<RelayedTx["source"]>, string> = {
  recurring: "Recurring fire",
  send: "Manual send",
  batch: "Batch send",
  api: "API settlement",
};

function settlementKind(tx: RelayedTx): string {
  return tx.source ? SOURCE_LABEL[tx.source] : "Settlement";
}

function fmtDate(iso: string | number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function shortHash(h: string): string {
  return h ? `${h.slice(0, 8)}…${h.slice(-6)}` : "—";
}

// ── view ─────────────────────────────────────────────────────────────────────
export function ActivityView({ ownerAddress, signMessage, scope }: ActivityViewProps) {
  const [tab, setTab] = useState<RailTab>("all");
  const [txs, setTxs] = useState<RelayedTx[]>([]);
  const [bridges, setBridges] = useState<BridgeRecord[]>([]);
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  // Scope key sets — built from the provision response (trial vs paid).
  const [trialKeys, setTrialKeys] = useState<Set<string>>(new Set());
  const [paidKeys, setPaidKeys] = useState<Set<string>>(new Set());
  const [walletFilter, setWalletFilter] = useState<string>("all"); // walletId | "all"
  const [chainFilter, setChainFilter] = useState<string>("all"); // chain | "all"
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ── Provision → key sets (mirrors page.tsx:1503-1525 scoping logic) ──────
  const loadProvision = useCallback(async () => {
    if (!ownerAddress) return;
    const auth = await getAuthCreds(ownerAddress, signMessage);
    if (!auth) return;
    try {
      const res = await fetch("/api/keys/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: ownerAddress, nonce: auth.nonce, signature: auth.signature }),
      });
      const d = (await res.json()) as Record<string, unknown>;
      if (res.status === 401 && d.code === "NONCE_EXPIRED") {
        clearAuthCache(ownerAddress);
        return;
      }
      const isTrialOnly = d.plan === "trial";
      const hasPaid = d.hasPaid === true;
      const multichainKey = (d.multichainApiKey ?? d.apiKey) as string | undefined;
      const multichainSandbox = (d.multichainSandboxApiKey ?? d.sandboxApiKey) as string | undefined;
      const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

      setTrialKeys(
        new Set(
          [
            d.trialApiKey,
            d.trialSandboxApiKey,
            // legacy: trial activations wrote into apiKey/sandboxApiKey
            isTrialOnly ? d.apiKey : null,
            isTrialOnly ? d.sandboxApiKey : null,
          ].filter(str),
        ),
      );
      setPaidKeys(
        new Set([hasPaid ? multichainKey : null, hasPaid ? multichainSandbox : null].filter(str)),
      );
    } catch {
      /* non-fatal — table simply shows nothing in scope */
    }
  }, [ownerAddress, signMessage]);

  // ── Transactions (mirrors page.tsx:1089-1098) ───────────────────────────
  const loadTxs = useCallback(async () => {
    if (!ownerAddress) return;
    const auth = await getAuthCreds(ownerAddress, signMessage);
    if (!auth) return;
    const res = await fetch(
      `/api/transactions?address=${ownerAddress}&nonce=${encodeURIComponent(auth.nonce)}&sig=${encodeURIComponent(auth.signature)}`,
    );
    if (res.status === 401) {
      const d = await res.json();
      if (d.code === "NONCE_EXPIRED") clearAuthCache(ownerAddress);
      return;
    }
    const data = await res.json();
    if (Array.isArray(data.txs)) setTxs(data.txs as RelayedTx[]);
  }, [ownerAddress, signMessage]);

  // ── Bridge history (GET /api/ccip/bridge-history; param `signature`) ─────
  const loadBridges = useCallback(async () => {
    if (!ownerAddress) return;
    const auth = await getAuthCreds(ownerAddress, signMessage);
    if (!auth) return;
    const url = new URL("/api/ccip/bridge-history", window.location.origin);
    url.searchParams.set("address", ownerAddress);
    url.searchParams.set("nonce", auth.nonce);
    url.searchParams.set("signature", auth.signature);
    const res = await fetch(url.toString());
    if (res.status === 401) {
      const d = await res.json().catch(() => null);
      if (d?.code === "NONCE_EXPIRED") clearAuthCache(ownerAddress);
      return;
    }
    const data = await res.json().catch(() => null);
    if (data && Array.isArray(data.records)) setBridges(data.records as BridgeRecord[]);
  }, [ownerAddress, signMessage]);

  // ── Agent wallet list (for the wallet filter; same fetch as the Tab) ─────
  const loadWallets = useCallback(async () => {
    if (!ownerAddress) return;
    const auth = await getAuthCreds(ownerAddress, signMessage);
    if (!auth) return;
    const qs = new URLSearchParams({
      address: ownerAddress,
      nonce: auth.nonce,
      sig: auth.signature,
    }).toString();
    const res = await fetch(`/api/wallet/agentic?${qs}`);
    if (res.status === 401) {
      const d = await res.json().catch(() => null);
      if (d?.code === "NONCE_EXPIRED") clearAuthCache(ownerAddress);
      return;
    }
    const data = await res.json().catch(() => null);
    if (data && Array.isArray(data.wallets)) {
      setWallets(
        (data.wallets as WalletRow[]).map((w) => ({
          address: w.address,
          walletId: w.walletId,
          label: w.label,
        })),
      );
    }
  }, [ownerAddress, signMessage]);

  useEffect(() => {
    if (!ownerAddress) {
      setTxs([]);
      setBridges([]);
      setWallets([]);
      setTrialKeys(new Set());
      setPaidKeys(new Set());
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    (async () => {
      try {
        await Promise.all([loadProvision(), loadTxs(), loadBridges(), loadWallets()]);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load activity.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerAddress, loadProvision, loadTxs, loadBridges, loadWallets]);

  // ── Derived: scope + rail-tab + filter chips ─────────────────────────────
  const scopeKeys = scope === "trial" ? trialKeys : paidKeys;

  // Scope-filtered settlements (trial vs multichain key set), mirroring
  // page.tsx scopedTxsAllSources. If the scope key set is empty (no
  // provisioned keys for this scope yet) nothing matches — same as v1.
  const scopedTxs = useMemo(
    () => txs.filter((tx) => scopeKeys.has(tx.apiKey)),
    [txs, scopeKeys],
  );

  // Chains present across the scoped settlements + bridges (for chips).
  const availableChains = useMemo(() => {
    const s = new Set<string>();
    for (const tx of scopedTxs) if (tx.chain) s.add(tx.chain);
    return [...s];
  }, [scopedTxs]);

  // Rail-tab settlement subset.
  const railTxs = useMemo(() => {
    if (tab === "manual")
      return scopedTxs.filter(
        (tx) => tx.source === "send" || tx.source === "batch" || tx.source === "api",
      );
    if (tab === "recurring") return scopedTxs.filter((tx) => tx.source === "recurring");
    if (tab === "receipts") return scopedTxs.filter((tx) => !!tx.receiptId);
    return scopedTxs; // "all"
  }, [scopedTxs, tab]);

  // Apply wallet + chain filter chips, newest first.
  const visibleTxs = useMemo(() => {
    const selectedWalletAddr =
      walletFilter === "all"
        ? null
        : wallets.find((w) => w.walletId === walletFilter)?.address.toLowerCase() ?? null;
    return [...railTxs]
      .filter((tx) => {
        if (selectedWalletAddr && tx.fromUser.toLowerCase() !== selectedWalletAddr) return false;
        if (chainFilter !== "all" && tx.chain !== chainFilter) return false;
        return true;
      })
      .reverse();
  }, [railTxs, walletFilter, chainFilter, wallets]);

  // Bridge rows respect the wallet + chain filter (chain matches src or dst).
  const visibleBridges = useMemo(() => {
    if (walletFilter === "all" && chainFilter === "all") return bridges;
    return bridges.filter((b) => {
      if (walletFilter !== "all" && b.walletId.toLowerCase() !== walletFilter.toLowerCase())
        return false;
      if (chainFilter !== "all" && b.src !== chainFilter && b.dst !== chainFilter) return false;
      return true;
    });
  }, [bridges, walletFilter, chainFilter]);

  const showBridge = tab === "bridge";
  const totalInView = showBridge ? visibleBridges.length : visibleTxs.length;

  return (
    <V2AccentScope style={{ paddingTop: 17 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "230px 1fr",
          gap: 18,
          alignItems: "start",
        }}
      >
        {/* ── Col 1 · context rail ─────────────────────────────────── */}
        <Surface style={{ padding: 14, position: "sticky", top: 84 }}>
          <Eyebrow style={{ marginBottom: 10 }}>Activity</Eyebrow>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {RAIL.map((r) => {
              const active = r.id === tab;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setTab(r.id)}
                  style={{
                    textAlign: "left",
                    border: active ? `1px solid ${v2.line}` : "1px solid transparent",
                    background: active ? "rgba(247,202,22,.06)" : "transparent",
                    borderRadius: 10,
                    padding: "9px 11px",
                    cursor: "pointer",
                  }}
                >
                  <div
                    style={{
                      fontSize: 11.5,
                      fontWeight: active ? 700 : 500,
                      color: active ? v2.yellow : v2.text,
                    }}
                  >
                    {r.label}
                  </div>
                  <div style={{ fontSize: 9, color: v2.muted2, marginTop: 1 }}>{r.hint}</div>
                </button>
              );
            })}
          </div>

          <div
            style={{
              marginTop: 14,
              paddingTop: 12,
              borderTop: `1px solid ${v2.line}`,
              fontSize: 9,
              color: v2.muted2,
              lineHeight: 1.5,
            }}
          >
            Scope <span style={{ color: v2.yellow }}>{scope}</span> ·{" "}
            <span style={{ color: v2.muted }}>{scopedTxs.length}</span> settlements
            {bridges.length > 0 && (
              <>
                {" "}· <span style={{ color: v2.muted }}>{bridges.length}</span> bridges
              </>
            )}
          </div>
        </Surface>

        {/* ── Col 2 · view-main ────────────────────────────────────── */}
        <Surface style={{ padding: 21 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ font: `600 21px ${displayFont}`, letterSpacing: "-.04em" }}>
                Settlement activity
              </div>
              <div style={{ color: v2.muted, fontSize: 10, marginTop: 4, maxWidth: 460 }}>
                Manual, scheduled, and cross-chain execution. Filtered to the{" "}
                <span style={{ color: v2.yellow }}>{scope}</span> key scope.
              </div>
            </div>
            <div style={{ color: v2.muted, fontSize: 9, fontFamily: displayFont }}>
              {totalInView} in view
            </div>
          </div>

          {/* Filter chips — wallet + chain. Hidden for the receipts/bridge
              special cases where they still apply but read identically. */}
          <div
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              marginTop: 14,
              marginBottom: 4,
            }}
          >
            <FilterChip
              label="All wallets"
              active={walletFilter === "all"}
              onClick={() => setWalletFilter("all")}
            />
            {wallets.map((w) => (
              <FilterChip
                key={w.walletId}
                label={w.label?.trim() || shortAddr(w.address)}
                active={walletFilter === w.walletId}
                onClick={() => setWalletFilter(w.walletId)}
              />
            ))}
            {(availableChains.length > 0 || chainFilter !== "all") && (
              <span style={{ width: 1, background: v2.line, margin: "2px 4px" }} aria-hidden />
            )}
            {availableChains.length > 0 && (
              <FilterChip
                label="All networks"
                active={chainFilter === "all"}
                onClick={() => setChainFilter("all")}
              />
            )}
            {availableChains.map((c) => (
              <FilterChip
                key={c}
                label={chainName(c)}
                dot={chainColor(c)}
                active={chainFilter === c}
                onClick={() => setChainFilter(c)}
              />
            ))}
          </div>

          {/* ── Table ─────────────────────────────────────────────── */}
          <div style={{ marginTop: 12 }}>
            {!ownerAddress ? (
              <Empty text="Connect a wallet to load settlement activity." />
            ) : loading ? (
              <Empty text="Loading activity…" />
            ) : err ? (
              <Empty text={err} tone="red" />
            ) : showBridge ? (
              <BridgeTable bridges={visibleBridges} />
            ) : (
              <SettlementTable txs={visibleTxs} emptyFor={tab} />
            )}
          </div>
        </Surface>
      </div>
    </V2AccentScope>
  );
}

// ── Filter chip ──────────────────────────────────────────────────────────────
function FilterChip({
  label,
  active,
  onClick,
  dot,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  dot?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        border: `1px solid ${active ? "rgba(247,202,22,.30)" : v2.line}`,
        background: active ? "rgba(247,202,22,.10)" : "rgba(255,255,255,.02)",
        color: active ? v2.yellow : v2.muted,
        fontSize: 9.5,
        fontWeight: active ? 700 : 500,
        padding: "6px 10px",
        borderRadius: 8,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {dot && (
        <span
          style={{ width: 6, height: 6, borderRadius: 999, background: dot, flexShrink: 0 }}
        />
      )}
      {label}
    </button>
  );
}

// ── Settlement table (relayed txs) ───────────────────────────────────────────
function SettlementTable({ txs, emptyFor }: { txs: RelayedTx[]; emptyFor: RailTab }) {
  if (txs.length === 0) {
    const msg =
      emptyFor === "recurring"
        ? "No recurring fires in this scope yet. Scheduled payouts appear here once the cron fires them."
        : emptyFor === "manual"
          ? "No manual sends (send / batch / API) in this scope yet."
          : emptyFor === "receipts"
            ? "No Trust Receipts yet. Settlements with a verifiable receipt show a View link."
            : "No settlements in this scope yet.";
    return <Empty text={msg} />;
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", minWidth: 620, borderCollapse: "collapse" }}>
        <thead>
          <Tr head>
            <Th>Settlement</Th>
            <Th>Wallet</Th>
            <Th>Network</Th>
            <Th>Status</Th>
            <Th align="right">Amount</Th>
          </Tr>
        </thead>
        <tbody>
          {txs.map((tx, i) => {
            // tx.chain is a freeform string; explorerTxUrl returns "" for
            // unknown chains, so we gate the link on a real http URL.
            const txUrl = explorerTxUrl(tx.chain as ChainKey, tx.relayTxHash);
            const hasExplorer = txUrl.startsWith("http");
            return (
              <Tr key={`${tx.relayTxHash}-${i}`}>
                <Td>
                  <div style={{ fontSize: 11.5, color: v2.text, fontWeight: 500 }}>
                    {settlementKind(tx)}
                  </div>
                  <div style={{ fontSize: 9, color: v2.muted2, marginTop: 2 }}>
                    {fmtDate(tx.relayedAt)} ·{" "}
                    {hasExplorer ? (
                      <a
                        href={txUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Open on ${explorerLabel(tx.chain as ChainKey)}`}
                        style={{
                          color: v2.yellow,
                          fontFamily: displayFont,
                          textDecoration: "none",
                        }}
                      >
                        {shortHash(tx.relayTxHash)} ↗
                      </a>
                    ) : (
                      <span style={{ fontFamily: displayFont }}>{shortHash(tx.relayTxHash)}</span>
                    )}
                    {tx.receiptId && (
                      <>
                        {" · "}
                        <a
                          href={`/receipt/${tx.receiptId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: v2.mint, textDecoration: "none" }}
                        >
                          Receipt ↗
                        </a>
                      </>
                    )}
                  </div>
                </Td>
                <Td>
                  <span
                    style={{ fontSize: 10.5, color: v2.muted, fontFamily: displayFont }}
                    title={`${tx.fromUser} → ${tx.toUser}`}
                  >
                    {shortAddr(tx.fromUser)}
                  </span>
                </Td>
                <Td>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 10.5,
                      color: v2.muted,
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 999,
                        background: chainColor(tx.chain),
                        flexShrink: 0,
                      }}
                    />
                    {chainName(tx.chain)}
                  </span>
                </Td>
                <Td>
                  <StatusPill kind="success" label="Settled" />
                </Td>
                <Td align="right">
                  <span style={{ fontSize: 12, fontWeight: 600, fontFamily: displayFont }}>
                    {Number(tx.tokenAmount).toFixed(2)}{" "}
                    <span style={{ color: v2.muted2, fontWeight: 400 }}>{tx.tokenSymbol}</span>
                  </span>
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Bridge table (CCIP records) ──────────────────────────────────────────────
function BridgeTable({ bridges }: { bridges: BridgeRecord[] }) {
  if (bridges.length === 0) {
    return <Empty text="No CCIP bridges yet. Cross-chain transfers appear here once initiated." />;
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", minWidth: 620, borderCollapse: "collapse" }}>
        <thead>
          <Tr head>
            <Th>Bridge</Th>
            <Th>Lane</Th>
            <Th>Fee</Th>
            <Th>Status</Th>
            <Th align="right">Amount</Th>
          </Tr>
        </thead>
        <tbody>
          {bridges.map((b, i) => {
            const usdc = Number(b.amount) / 1e6; // raw 6-dec USDC
            const txUrl = explorerTxUrl(b.src as ChainKey, b.txHash);
            const hasExplorer = txUrl.startsWith("http");
            return (
              <Tr key={`${b.messageId}-${i}`}>
                <Td>
                  <div style={{ fontSize: 11.5, color: v2.text, fontWeight: 500 }}>CCIP bridge</div>
                  <div style={{ fontSize: 9, color: v2.muted2, marginTop: 2 }}>
                    {fmtDate(b.initiatedAt)} ·{" "}
                    {hasExplorer ? (
                      <a
                        href={txUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Open on ${explorerLabel(b.src as ChainKey)}`}
                        style={{
                          color: v2.yellow,
                          fontFamily: displayFont,
                          textDecoration: "none",
                        }}
                      >
                        {shortHash(b.txHash)} ↗
                      </a>
                    ) : (
                      <span style={{ fontFamily: displayFont }}>{shortHash(b.txHash)}</span>
                    )}
                  </div>
                </Td>
                <Td>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 10.5,
                      color: v2.muted,
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 999,
                        background: chainColor(b.src),
                        flexShrink: 0,
                      }}
                    />
                    {chainName(b.src)} <span style={{ color: v2.muted2 }}>→</span>{" "}
                    {chainName(b.dst)}
                  </span>
                </Td>
                <Td>
                  <span style={{ fontSize: 10.5, color: v2.muted, fontFamily: displayFont }}>
                    {b.feeWhole.toFixed(4)} {b.feeToken}
                  </span>
                </Td>
                <Td>
                  <StatusPill kind="pending" label="In flight" />
                </Td>
                <Td align="right">
                  <span style={{ fontSize: 12, fontWeight: 600, fontFamily: displayFont }}>
                    {usdc.toFixed(2)} <span style={{ color: v2.muted2, fontWeight: 400 }}>USDC</span>
                  </span>
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Table primitives ─────────────────────────────────────────────────────────
function Tr({ children, head }: { children: React.ReactNode; head?: boolean }) {
  return (
    <tr style={{ borderBottom: `1px solid ${head ? v2.line : "rgba(255,255,255,.05)"}` }}>
      {children}
    </tr>
  );
}
function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      style={{
        textAlign: align,
        fontSize: 9,
        letterSpacing: ".12em",
        textTransform: "uppercase",
        fontWeight: 700,
        color: v2.muted2,
        padding: "0 12px 9px",
      }}
    >
      {children}
    </th>
  );
}
function Td({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return <td style={{ textAlign: align, padding: "12px", verticalAlign: "middle" }}>{children}</td>;
}

function StatusPill({ kind, label }: { kind: "success" | "pending"; label: string }) {
  const color = kind === "success" ? v2.mint : v2.yellow;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 9,
        fontWeight: 700,
        color,
        background: `${color}14`,
        border: `1px solid ${color}33`,
        padding: "4px 9px",
        borderRadius: 999,
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: 999, background: color }} />
      {label}
    </span>
  );
}

function Empty({ text, tone }: { text: string; tone?: "red" }) {
  return (
    <div
      style={{
        padding: "44px 16px",
        textAlign: "center",
        fontSize: 11,
        color: tone === "red" ? v2.red : v2.muted,
        border: `1px dashed ${v2.line}`,
        borderRadius: 12,
        marginTop: 6,
      }}
    >
      {text}
    </div>
  );
}
