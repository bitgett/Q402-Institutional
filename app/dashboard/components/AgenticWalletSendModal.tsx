"use client";

/**
 * AgenticWalletSendModal — single-recipient send form for the dashboard.
 *
 * Picks chain (BNB free, the remaining 8 require multichain scope on the
 * caller's subscription) + USDC/USDT, plus recipient + amount. The
 * actual signing happens server-side in /api/wallet/agentic/send — this
 * UI only forwards the user's intent + their EIP-191 session signature
 * for owner-auth.
 *
 * Friendly-error principle: every backend rejection is mapped to a
 * single-sentence headline + one next action ("Raise cap", "Upgrade
 * subscription", "Try again"). Raw API error codes never reach the user.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getActionAuth } from "@/app/lib/auth-client";
import {
  friendlyError,
  type FriendlyError,
  type BackendError,
} from "@/app/lib/agentic-wallet-friendly-error";
import { useModalEscape } from "./useModalEscape";
import { ThemedSelect } from "./ThemedSelect";
import { HexagonIcon } from "../v2/logos";

interface Props {
  walletAddress: string;
  /** Lowercased agentic wallet address — used as the walletId in API
   *  calls and bound into the intent challenge so a signature scoped
   *  to wallet A can't drain wallet B. */
  walletId: string;
  ownerAddress: string;
  signMessage: (message: string) => Promise<string | null>;
  onClose: () => void;
  onSent: () => void;
  /** Jump to the Hooks modal — surfaced as a CTA when a policy hook HELDS the
   *  payment, so the user can adjust the policy without hunting for it. */
  onOpenHooks?: () => void;
  /** Pre-fill the recipient field (e.g. owner EOA for the Withdraw flow). */
  prefillTo?: string;
  /** Pre-fill the amount field (e.g. bucket balance for the Withdraw flow). */
  prefillAmount?: string;
  /** Pre-fill the chain picker (e.g. picked sweep bucket). */
  prefillChain?: ChainKey;
  /** Pre-fill the token picker (e.g. picked sweep bucket). */
  prefillToken?: Token;
  /** Restrict the chain picker to this set (e.g. ["bnb"] under a Trial
   *  scope). Undefined = all chains. The picker is filtered to this set and
   *  the active chain is snapped into it, so a Trial session can't pick a
   *  chain the server would reject — no mode-confusion. */
  allowedChains?: ChainKey[];
  /** Override the modal title — Withdraw uses "Withdraw to your wallet". */
  titleOverride?: string;
  /** Wallet-level per-tx cap, used to soft-block before hitting backend. */
  perTxMaxUsd?: number | null;
  /** Wallet-level daily cap, used in the friendly error mapping. */
  dailyLimitUsd?: number | null;
}

type Token = "USDC" | "USDT" | "Q";

type ChainKey =
  | "bnb"
  | "eth"
  | "avax"
  | "xlayer"
  | "stable"
  | "mantle"
  | "injective"
  | "monad"
  | "scroll"
  | "arbitrum"
  | "base";

interface ChainMeta {
  key: ChainKey;
  label: string;
  multichainOnly?: boolean;
  /** Tokens this chain accepts. Used to disable the picker for tokens
   *  the chain doesn't actually support. */
  tokens: readonly Token[];
  explorerTxBase: string;
  explorerLabel: string;
}

const CHAIN_META: ChainMeta[] = [
  { key: "bnb",       label: "BNB Chain",  tokens: ["USDT", "USDC", "Q"], explorerTxBase: "https://bscscan.com/tx/",                    explorerLabel: "BscScan" },
  { key: "eth",       label: "Ethereum",   multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://etherscan.io/tx/",                   explorerLabel: "Etherscan" },
  { key: "avax",      label: "Avalanche",  multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://snowtrace.io/tx/",                   explorerLabel: "Snowtrace" },
  { key: "xlayer",    label: "X Layer",    multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://www.oklink.com/xlayer/tx/",          explorerLabel: "OKLink" },
  { key: "stable",    label: "Stable",     multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://stablescan.xyz/tx/",                 explorerLabel: "StableScan" },
  { key: "mantle",    label: "Mantle",     multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://explorer.mantle.xyz/tx/",            explorerLabel: "Mantle Explorer" },
  { key: "injective", label: "Injective",  multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://blockscout.injective.network/tx/",   explorerLabel: "Blockscout" },
  { key: "monad",     label: "Monad",      multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://monadscan.com/tx/",                  explorerLabel: "MonadScan" },
  { key: "scroll",    label: "Scroll",     multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://scrollscan.com/tx/",                 explorerLabel: "ScrollScan" },
  { key: "arbitrum",  label: "Arbitrum",   multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://arbiscan.io/tx/",                    explorerLabel: "Arbiscan" },
  { key: "base",      label: "Base",       multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://basescan.org/tx/",                   explorerLabel: "Basescan" },
];

function chainMetaFor(key: ChainKey): ChainMeta {
  return CHAIN_META.find((c) => c.key === key) ?? CHAIN_META[0];
}

function isAddress(s: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(s.trim());
}

function isDecimalAmount(s: string) {
  return /^\d+(\.\d+)?$/.test(s.trim()) && Number(s) > 0;
}

export function AgenticWalletSendModal({
  walletAddress,
  walletId,
  ownerAddress,
  signMessage,
  onClose,
  onSent,
  onOpenHooks,
  prefillTo,
  prefillAmount,
  prefillChain,
  prefillToken,
  allowedChains,
  titleOverride,
  perTxMaxUsd,
  dailyLimitUsd,
}: Props) {
  const [chain, setChain] = useState<ChainKey>(prefillChain ?? allowedChains?.[0] ?? "bnb");
  const chainMeta = chainMetaFor(chain);
  const allowedTokens = chainMeta.tokens;
  const [token, setToken] = useState<Token>(prefillToken ?? "USDT");
  const [recipient, setRecipient] = useState(prefillTo ?? "");
  const [amount, setAmount] = useState(prefillAmount ?? "");
  // Settlement rail. Only Base USDC exposes a choice: q402 (default, EIP-7702
  // gasless) or x402 (Coinbase EIP-3009 standard, Q402 still sponsors gas).
  // Everywhere else the picker is hidden and the rail stays q402.
  const [rail, setRail] = useState<"q402" | "x402">("q402");
  const railAvailable = chain === "base" && token === "USDC";

  // Keep token consistent with the selected chain — if the highlighted
  // token isn't supported on the picked chain, snap to a supported one.
  // Migrated from `queueMicrotask(setState)`-in-render to a proper
  // effect so React 19 doesn't warn about setState during render.
  useEffect(() => {
    if (!allowedTokens.includes(token)) setToken(allowedTokens[0]);
  }, [allowedTokens, token]);

  // Snap the chain into the allowed set (e.g. Trial scope → BNB only) so a
  // session can never sit on a chain the server would reject.
  useEffect(() => {
    if (allowedChains && allowedChains.length > 0 && !allowedChains.includes(chain)) {
      setChain(allowedChains[0]);
    }
  }, [allowedChains, chain]);

  // The x402 rail only exists for Base USDC. If the chain/token moves off that
  // combo, fall back to q402 so we never POST rail:x402 for a pairing the
  // server (and the EIP-3009 path) would reject.
  useEffect(() => {
    if (!railAvailable && rail !== "q402") setRail("q402");
  }, [railAvailable, rail]);

  // Portal mount guard — these modals render only after a client
  // interaction, but keep the SSR-safe check so we never touch
  // document.body during server render / hydration.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [submitting, setSubmitting] = useState(false);
  useModalEscape(onClose, submitting);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [success, setSuccess] = useState<{ txHash: string } | null>(null);
  // A 2xx that did NOT settle: a Hook held the payment for approval (HTTP
  // 202 approval_required). Distinct from success — funds did not move.
  const [held, setHeld] = useState<{ code?: string; message?: string } | null>(null);
  /**
   * Double-click guard — checked + flipped synchronously at the top of
   * submit() so a rapid second click can't slip through before
   * setSubmitting(true) renders. Without this, two parallel wallet
   * popups + two POSTs (second NONCE_EXPIRED) confuse users.
   */
  const inFlightRef = useRef(false);

  const recipientValid = recipient === "" || isAddress(recipient);
  const amountValid = amount === "" || isDecimalAmount(amount);

  // Soft per-tx cap check — surface the issue before the user signs.
  const amountNum = isDecimalAmount(amount) ? Number(amount) : 0;
  const overPerTxCap =
    typeof perTxMaxUsd === "number" && amountNum > perTxMaxUsd;

  const canSubmit =
    !submitting && isAddress(recipient) && isDecimalAmount(amount) && !overPerTxCap;

  async function submit() {
    // Synchronous double-click guard. Setting state alone isn't enough
    // — React batches and the second click can see canSubmit=true
    // before the first paint with submitting=true.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    setHeld(null);
    if (!isAddress(recipient)) {
      setError({ headline: "Recipient must be a 0x-prefixed 20-byte address." });
      inFlightRef.current = false;
      return;
    }
    if (!isDecimalAmount(amount)) {
      setError({ headline: "Amount must be a positive decimal (e.g. 1.50)." });
      inFlightRef.current = false;
      return;
    }
    setSubmitting(true);
    try {
      // Intent-bound auth — server rebuilds the canonical message from
      // `(walletId, chain, token, recipient, amount)`. Server's
      // separate fingerprint cache makes the actual payment idempotent
      // on a fresh-challenge retry.
      const to = recipient.trim();
      const intent: Record<string, string> = {
        walletId,
        chain,
        token,
        recipient: to.toLowerCase(),
        amount: amount.trim(),
      };
      const auth = await getActionAuth(ownerAddress, "agentic.send", intent, signMessage);
      if (!auth) {
        setError({
          headline:
            "Sign the payment challenge in your wallet to authorize this send. " +
            "The signature is bound to this exact recipient + amount.",
        });
        return;
      }
      const res = await fetch("/api/wallet/agentic/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletId,
          chain,
          token,
          to,
          amount: amount.trim(),
          ownerAddress,
          nonce: auth.challenge,
          signature: auth.signature,
          // Only forwarded when the user opted into x402 on Base USDC; the
          // server treats an absent rail as the default q402 (EIP-7702).
          ...(rail === "x402" ? { rail: "x402" } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as BackendError;
      if (!res.ok) {
        setError(friendlyError(res.status, data));
        return;
      }
      const body = data as { status?: string; code?: string; message?: string; txHash?: string };
      // A 2xx that did NOT settle: a Hook held the payment for approval
      // (HTTP 202 approval_required). Funds did NOT move — surface the hook
      // + reason instead of a false "Sent." (a sweep over the Spend Cap
      // threshold lands here; it was not withdrawn).
      if (body.status === "approval_required") {
        setHeld({ code: body.code, message: body.message });
        return;
      }
      if (!body.txHash) {
        setError({ headline: `The payment did not settle${body.message ? `: ${body.message}` : "."}` });
        return;
      }
      setSuccess({ txHash: body.txHash });
    } catch (e) {
      setError({ headline: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
      inFlightRef.current = false;
    }
  }

  if (!mounted) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(2,6,15,0.72)" }}
      onClick={submitting ? undefined : onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border p-6 space-y-4"
        style={{ background: "#0F1929", borderColor: "rgba(247,202,22,.30)" }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="text-white font-semibold text-lg">{titleOverride ?? "Send from Agent Wallet"}</div>
            <div className="text-[11px] text-white/40 font-mono mt-0.5">
              {walletAddress.slice(0, 10)}…{walletAddress.slice(-6)}
            </div>
          </div>
          <button
            type="button"
            onClick={submitting ? undefined : onClose}
            disabled={submitting}
            className="text-white/40 hover:text-white text-lg leading-none disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {held ? (
          <div className="space-y-3">
            <div
              className="rounded-md border px-3 py-2.5 text-sm"
              style={{ background: "rgba(251,191,36,0.06)", borderColor: "rgba(251,191,36,0.30)", color: "rgb(253,224,71)" }}
            >
              <div className="font-semibold">Held by a policy hook. Not sent.</div>
              <div className="text-[12px] mt-1" style={{ color: "rgba(253,224,71,0.85)" }}>
                {held.message ?? "A Hook on this wallet held this payment for approval."}
                {held.code ? ` (${held.code})` : ""}
              </div>
              <div className="text-[11px] mt-2 text-white/55 leading-relaxed">
                No funds moved. To send it, open{" "}
                <span className="inline-flex items-center gap-1 align-text-bottom"><HexagonIcon size={12} /> Hooks</span>{" "}
                and adjust the policy
                that held it — e.g. raise the Spend Cap hold threshold above
                this amount, or turn Spend Cap off — then try again.
              </div>
            </div>
            <div className="flex gap-2">
              {onOpenHooks && (
                <button
                  type="button"
                  onClick={() => onOpenHooks()}
                  className="flex-1 px-3 py-2 rounded-md text-sm font-semibold bg-amber-400 text-black hover:bg-amber-300"
                >
                  Open Hooks
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-3 py-2 rounded-md text-sm font-semibold border border-white/15 text-white/80 hover:bg-white/5"
              >
                Close
              </button>
            </div>
          </div>
        ) : success ? (
          <div className="space-y-3">
            <div
              className="rounded-md border px-3 py-2 text-sm"
              style={{ border: "1px solid rgba(85,230,165,.30)", background: "rgba(85,230,165,.06)", color: "#9af0c9" }}
            >
              Sent.
            </div>
            {success.txHash !== "(pending)" && (
              <a
                href={`${chainMeta.explorerTxBase}${success.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-emerald-400 hover:underline font-mono break-all"
              >
                {success.txHash} ↗ {chainMeta.explorerLabel}
              </a>
            )}
            <button
              type="button"
              onClick={onSent}
              className="w-full px-3 py-2 rounded-md text-sm font-semibold bg-emerald-400 text-slate-900 hover:bg-emerald-300"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {/* Source-of-funds primer — clears the #1 confusion: "wait, is
                this signing with my MetaMask?" + the #2 confusion: "wait,
                Q402 doesn't actually pay my ETH gas on paid plans?" */}
            <div
              className="rounded-md border px-3 py-2.5 text-[11.5px] leading-relaxed"
              style={{
                background: "rgba(247,202,22,.06)",
                borderColor: "rgba(247,202,22,.30)",
                color: "rgba(226,232,240,0.78)",
              }}
            >
              Sending from your <span style={{ color: "#f9d64a" }}>Agent Wallet</span>,
              not your MetaMask. Only the stablecoin moves from your Agent Wallet balance.
              <div className="mt-1.5 pt-1.5 border-t text-white/55" style={{ borderColor: "rgba(247,202,22,.15)" }}>
                Gas: <span style={{ color: "#f9d64a" }}>Trial</span> = Q402 sponsors{" "}
                <span style={{ color: "#f9d64a" }}>BNB Chain only</span>.{" "}
                <span style={{ color: "#f9d64a" }}>Multichain</span> = relay gas debits
                from your Gas Tank on the selected chain. Top up via the Treasury.
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">Chain</div>
                <ThemedSelect<ChainKey>
                  value={chain}
                  onChange={setChain}
                  options={CHAIN_META.filter((c) => !allowedChains || allowedChains.includes(c.key)).map((c) => ({
                    value: c.key,
                    label: c.label,
                    meta: c.multichainOnly ? "multichain" : undefined,
                  }))}
                  ariaLabel="Chain"
                />
                {chain !== "bnb" && (
                  <div className="text-[10px] text-white/35 mt-1">
                    Non-BNB chains require an active multichain subscription.
                  </div>
                )}
              </div>

              <div>
                <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">Token</div>
                <div className={`grid gap-2 ${allowedTokens.length >= 3 ? "grid-cols-3" : "grid-cols-2"}`}>
                  {allowedTokens.map(t => {
                    const enabled = allowedTokens.includes(t);
                    const active = token === t;
                    return (
                      <button
                        key={t}
                        type="button"
                        disabled={!enabled}
                        onClick={() => enabled && setToken(t)}
                        title={enabled ? undefined : `${chainMeta.label} does not support ${t}`}
                        className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                          !enabled
                            ? "border-white/5 text-white/25 cursor-not-allowed"
                            : active
                              ? "border-emerald-400 text-emerald-300 bg-emerald-400/8"
                              : "border-white/10 text-white/55 hover:text-white"
                        }`}
                      >
                        {t}
                        {!enabled && <span className="ml-1 text-[9px]">N/A</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              {railAvailable && (
                <div>
                  <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">Rail</div>
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      { key: "q402", label: "Q402", sub: "EIP-7702" },
                      { key: "x402", label: "x402", sub: "EIP-3009" },
                    ] as { key: "q402" | "x402"; label: string; sub: string }[]).map(r => {
                      const active = rail === r.key;
                      return (
                        <button
                          key={r.key}
                          type="button"
                          onClick={() => setRail(r.key)}
                          className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors flex items-baseline justify-center gap-1.5 ${
                            active
                              ? "border-emerald-400 text-emerald-300 bg-emerald-400/8"
                              : "border-white/10 text-white/55 hover:text-white"
                          }`}
                        >
                          {r.label}
                          <span className="text-[9px] text-white/40 font-mono">{r.sub}</span>
                        </button>
                      );
                    })}
                  </div>
                  {rail === "x402" ? (
                    <div
                      className="mt-2 rounded-md border px-3 py-2 text-[11px] leading-relaxed"
                      style={{ background: "rgba(245,197,24,0.06)", borderColor: "rgba(245,197,24,0.30)", color: "rgba(253,224,71,0.9)" }}
                    >
                      <span className="font-semibold">x402 needs a wallet that has not used the Q402 rail.</span>{" "}
                      Coinbase x402 standard (USDC transferWithAuthorization); Q402 still sponsors gas. An
                      Agent Wallet that already sent on the Q402 rail is EIP-7702 delegated and will be
                      rejected here. Use Q402, or clear the delegation first.
                    </div>
                  ) : (
                    <div className="text-[10px] text-white/35 mt-1 leading-relaxed">
                      Q402 gasless default. Works for any wallet state and supports Hooks.
                    </div>
                  )}
                </div>
              )}

              <div>
                <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">Recipient</div>
                <input
                  type="text"
                  value={recipient}
                  onChange={e => setRecipient(e.target.value)}
                  placeholder="0x…"
                  spellCheck={false}
                  className="w-full rounded-md border px-3 py-2 text-sm font-mono text-white placeholder-white/25"
                  style={{
                    background: "rgba(255,255,255,0.02)",
                    borderColor: recipientValid ? "rgba(255,255,255,0.05)" : "rgba(248,113,113,0.45)",
                  }}
                />
              </div>

              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <div className="text-[11px] text-white/45 uppercase tracking-widest">Amount</div>
                  {(typeof perTxMaxUsd === "number" || typeof dailyLimitUsd === "number") && (
                    <div className="text-[10px] text-white/35">
                      {typeof perTxMaxUsd === "number" && <>per-tx ${perTxMaxUsd}</>}
                      {typeof perTxMaxUsd === "number" && typeof dailyLimitUsd === "number" && <> · </>}
                      {typeof dailyLimitUsd === "number" && <>daily ${dailyLimitUsd}</>}
                    </div>
                  )}
                </div>
                <input
                  type="text"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder="1.50"
                  inputMode="decimal"
                  className="w-full rounded-md border px-3 py-2 text-sm font-mono text-white placeholder-white/25"
                  style={{
                    background: "rgba(255,255,255,0.02)",
                    borderColor: amountValid && !overPerTxCap ? "rgba(255,255,255,0.05)" : "rgba(248,113,113,0.45)",
                  }}
                />
                {overPerTxCap && (
                  <div className="text-[11px] text-red-300/85 mt-1">
                    Over per-tx cap (${perTxMaxUsd}). Raise it in Spending limits or send less.
                  </div>
                )}
              </div>
            </div>

            {error && (
              <div
                className="rounded-md border px-3 py-2.5 text-[12px] leading-relaxed flex items-start justify-between gap-3"
                style={{
                  background: "rgba(248,113,113,0.06)",
                  borderColor: "rgba(248,113,113,0.22)",
                  color: "#fecaca",
                }}
              >
                <span>{error.headline}</span>
                {error.next && (
                  <a
                    href={error.next.href}
                    className="shrink-0 text-emerald-300 hover:text-emerald-200 underline underline-offset-2"
                  >
                    {error.next.label}
                  </a>
                )}
              </div>
            )}

            <button
              type="button"
              disabled={!canSubmit}
              onClick={submit}
              className="w-full px-3 py-2 rounded-md text-sm font-semibold bg-emerald-400 text-slate-900 hover:bg-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? "Sending…" : `Send ${amount || "—"} ${token}`}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
