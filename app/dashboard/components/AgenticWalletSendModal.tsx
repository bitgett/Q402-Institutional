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

import { useState } from "react";
import { getAuthCreds } from "@/app/lib/auth-client";
import {
  friendlyError,
  type FriendlyError,
  type BackendError,
} from "@/app/lib/agentic-wallet-friendly-error";

interface Props {
  walletAddress: string;
  ownerAddress: string;
  signMessage: (message: string) => Promise<string | null>;
  onClose: () => void;
  onSent: () => void;
  /** Pre-fill the recipient field (e.g. owner EOA for the Withdraw flow). */
  prefillTo?: string;
  /** Pre-fill the amount field (e.g. bucket balance for the Withdraw flow). */
  prefillAmount?: string;
  /** Pre-fill the chain picker (e.g. picked sweep bucket). */
  prefillChain?: ChainKey;
  /** Pre-fill the token picker (e.g. picked sweep bucket). */
  prefillToken?: Token;
  /** Override the modal title — Withdraw uses "Withdraw to your wallet". */
  titleOverride?: string;
  /** Wallet-level per-tx cap, used to soft-block before hitting backend. */
  perTxMaxUsd?: number | null;
  /** Wallet-level daily cap, used in the friendly error mapping. */
  dailyLimitUsd?: number | null;
}

type Token = "USDC" | "USDT";

type ChainKey =
  | "bnb"
  | "eth"
  | "avax"
  | "xlayer"
  | "stable"
  | "mantle"
  | "injective"
  | "monad"
  | "scroll";

interface ChainMeta {
  key: ChainKey;
  label: string;
  multichainOnly?: boolean;
  /** Tokens this chain accepts. Used to disable the picker for tokens
   *  the chain doesn't actually support (e.g. Injective USDT-only). */
  tokens: readonly Token[];
  explorerTxBase: string;
  explorerLabel: string;
}

const CHAIN_META: ChainMeta[] = [
  { key: "bnb",       label: "BNB Chain",  tokens: ["USDT", "USDC"], explorerTxBase: "https://bscscan.com/tx/",                    explorerLabel: "BscScan" },
  { key: "eth",       label: "Ethereum",   multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://etherscan.io/tx/",                   explorerLabel: "Etherscan" },
  { key: "avax",      label: "Avalanche",  multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://snowtrace.io/tx/",                   explorerLabel: "Snowtrace" },
  { key: "xlayer",    label: "X Layer",    multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://www.oklink.com/xlayer/tx/",          explorerLabel: "OKLink" },
  { key: "stable",    label: "Stable",     multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://stablescan.org/tx/",                 explorerLabel: "StableScan" },
  { key: "mantle",    label: "Mantle",     multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://explorer.mantle.xyz/tx/",            explorerLabel: "Mantle Explorer" },
  { key: "injective", label: "Injective",  multichainOnly: true, tokens: ["USDT"],         explorerTxBase: "https://blockscout.injective.network/tx/",   explorerLabel: "Blockscout" },
  { key: "monad",     label: "Monad",      multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://monadscan.com/tx/",                  explorerLabel: "MonadScan" },
  { key: "scroll",    label: "Scroll",     multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://scrollscan.com/tx/",                 explorerLabel: "ScrollScan" },
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
  ownerAddress,
  signMessage,
  onClose,
  onSent,
  prefillTo,
  prefillAmount,
  prefillChain,
  prefillToken,
  titleOverride,
  perTxMaxUsd,
  dailyLimitUsd,
}: Props) {
  const [chain, setChain] = useState<ChainKey>(prefillChain ?? "bnb");
  const chainMeta = chainMetaFor(chain);
  const allowedTokens = chainMeta.tokens;
  const [token, setToken] = useState<Token>(prefillToken ?? "USDT");
  const [recipient, setRecipient] = useState(prefillTo ?? "");
  const [amount, setAmount] = useState(prefillAmount ?? "");

  // Keep token consistent with the selected chain — if the user picks
  // Injective (USDT-only) while USDC is highlighted, snap to USDT.
  if (!allowedTokens.includes(token)) {
    queueMicrotask(() => setToken(allowedTokens[0]));
  }
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [success, setSuccess] = useState<{ txHash: string } | null>(null);

  const recipientValid = recipient === "" || isAddress(recipient);
  const amountValid = amount === "" || isDecimalAmount(amount);

  // Soft per-tx cap check — surface the issue before the user signs.
  const amountNum = isDecimalAmount(amount) ? Number(amount) : 0;
  const overPerTxCap =
    typeof perTxMaxUsd === "number" && amountNum > perTxMaxUsd;

  const canSubmit =
    !submitting && isAddress(recipient) && isDecimalAmount(amount) && !overPerTxCap;

  async function submit() {
    setError(null);
    if (!isAddress(recipient)) {
      setError({ headline: "Recipient must be a 0x-prefixed 20-byte address." });
      return;
    }
    if (!isDecimalAmount(amount)) {
      setError({ headline: "Amount must be a positive decimal (e.g. 1.50)." });
      return;
    }
    setSubmitting(true);
    try {
      const auth = await getAuthCreds(ownerAddress, signMessage);
      if (!auth) {
        setError({ headline: "Sign the auth challenge to authorize this send." });
        return;
      }
      const res = await fetch("/api/wallet/agentic/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chain,
          token,
          to: recipient.trim(),
          amount: amount.trim(),
          ownerAddress,
          nonce: auth.nonce,
          signature: auth.signature,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as BackendError;
      if (!res.ok) {
        setError(friendlyError(res.status, data));
        return;
      }
      const txHash = (data as { txHash?: string }).txHash;
      setSuccess({ txHash: txHash ?? "(pending)" });
    } catch (e) {
      setError({ headline: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(2,6,15,0.72)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border p-6 space-y-4"
        style={{ background: "#0F1929", borderColor: "rgba(74,222,128,0.20)" }}
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
            onClick={onClose}
            className="text-white/40 hover:text-white text-lg leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {success ? (
          <div className="space-y-3">
            <div className="rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2 text-sm text-green-200">
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
                this signing with my MetaMask?" */}
            <div
              className="rounded-md border px-3 py-2.5 text-[11.5px] leading-relaxed"
              style={{
                background: "rgba(74,222,128,0.05)",
                borderColor: "rgba(74,222,128,0.18)",
                color: "rgba(226,232,240,0.78)",
              }}
            >
              Sending from your <span className="text-emerald-300">Agent Wallet</span>,
              not your MetaMask. Q402 sponsors the gas; only the stablecoin moves
              from your Agent Wallet balance.
            </div>

            <div className="space-y-3">
              <div>
                <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">Chain</div>
                <select
                  value={chain}
                  onChange={(e) => setChain(e.target.value as ChainKey)}
                  className="w-full rounded-md border px-3 py-2 text-sm text-white"
                  style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.05)" }}
                >
                  {CHAIN_META.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}{c.multichainOnly ? " — multichain" : ""}
                    </option>
                  ))}
                </select>
                {chain !== "bnb" && (
                  <div className="text-[10px] text-white/35 mt-1">
                    Non-BNB chains require an active multichain subscription.
                  </div>
                )}
              </div>

              <div>
                <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">Token</div>
                <div className="grid grid-cols-2 gap-2">
                  {(["USDT", "USDC"] as Token[]).map(t => {
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
    </div>
  );
}
