"use client";

/**
 * AgenticWalletSendModal — single-recipient send form, Command-deck system.
 *
 * Picks chain (BNB free, the remaining 8 require multichain scope on the
 * caller's subscription) + USDC/USDT, plus recipient + amount. The actual
 * signing happens server-side in /api/wallet/agentic/send — this UI only
 * forwards the user's intent + their EIP-191 session signature for owner-auth.
 *
 * Friendly-error principle: every backend rejection is mapped to a
 * single-sentence headline + one next action ("Raise cap", "Upgrade
 * subscription", "Try again"). Raw API error codes never reach the user.
 */

import { useEffect, useRef, useState } from "react";
import { getActionAuth } from "@/app/lib/auth-client";
import {
  friendlyError,
  type FriendlyError,
  type BackendError,
} from "@/app/lib/agentic-wallet-friendly-error";
import { ThemedSelect } from "./ThemedSelect";
import { HexagonIcon } from "../v2/logos";
import { SendGlyph } from "./action-icons";
import { ModalShell, Field, Segmented, PrimaryCTA, GhostButton, AlertBox, inputStyle, MonoAddr, GOLD, GOLD_TEXT } from "./modal-kit";

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

type Token = "USDC" | "USDT" | "Q" | "USDG";

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
  | "base"
  | "robinhood";

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
  { key: "stable",    label: "Stable",     multichainOnly: true, tokens: ["USDT"], explorerTxBase: "https://stablescan.xyz/tx/",                 explorerLabel: "StableScan" },
  { key: "mantle",    label: "Mantle",     multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://explorer.mantle.xyz/tx/",            explorerLabel: "Mantle Explorer" },
  { key: "injective", label: "Injective",  multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://blockscout.injective.network/tx/",   explorerLabel: "Blockscout" },
  { key: "monad",     label: "Monad",      multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://monadscan.com/tx/",                  explorerLabel: "MonadScan" },
  { key: "scroll",    label: "Scroll",     multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://scrollscan.com/tx/",                 explorerLabel: "ScrollScan" },
  { key: "arbitrum",  label: "Arbitrum",   multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://arbiscan.io/tx/",                    explorerLabel: "Arbiscan" },
  { key: "base",      label: "Base",       multichainOnly: true, tokens: ["USDT", "USDC"], explorerTxBase: "https://basescan.org/tx/",                   explorerLabel: "Basescan" },
  { key: "robinhood", label: "Robinhood Chain", multichainOnly: true, tokens: ["USDG"], explorerTxBase: "https://robinhoodchain.blockscout.com/tx/",  explorerLabel: "Blockscout" },
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

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [success, setSuccess] = useState<{ txHash: string } | null>(null);
  // A 2xx that did NOT settle: a Hook held the payment for approval (HTTP
  // 202 approval_required). Distinct from success — funds did not move.
  const [held, setHeld] = useState<{ code?: string; message?: string } | null>(null);
  /**
   * Double-click guard — checked + flipped synchronously at the top of
   * submit() so a rapid second click can't slip through before
   * setSubmitting(true) renders.
   */
  const inFlightRef = useRef(false);

  const recipientValid = recipient === "" || isAddress(recipient);
  const amountValid = amount === "" || isDecimalAmount(amount);

  // Soft per-tx cap check — surface the issue before the user signs.
  const amountNum = isDecimalAmount(amount) ? Number(amount) : 0;
  // Q is exempt from USD limits (it's the owner's own token, not USD-valued) —
  // the server treats Q's amountUsd as 0, so the UI must NOT apply the per-tx
  // cap to Q either, or the two policies disagree and block a valid Q send.
  const overPerTxCap = token !== "Q" && typeof perTxMaxUsd === "number" && amountNum > perTxMaxUsd;

  const canSubmit = !submitting && isAddress(recipient) && isDecimalAmount(amount) && !overPerTxCap;

  async function submit() {
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
      // `(walletId, chain, token, recipient, amount)`.
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
      // (HTTP 202 approval_required). Funds did NOT move.
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

  // ── render: three states share the shell, differ in body + footer ──────────
  let body: React.ReactNode;
  let footer: React.ReactNode;

  if (held) {
    body = (
      <AlertBox variant="warn">
        <div style={{ fontWeight: 700 }}>Held by a policy hook. Not sent.</div>
        <div style={{ marginTop: 4 }}>
          {held.message ?? "A Hook on this wallet held this payment for approval."}
          {held.code ? ` (${held.code})` : ""}
        </div>
        <div style={{ marginTop: 8, color: "rgba(255,255,255,.55)", lineHeight: 1.5 }}>
          No funds moved. To send it, open{" "}
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, verticalAlign: "text-bottom" }}>
            <HexagonIcon size={12} /> Hooks
          </span>{" "}
          and adjust the policy that held it — e.g. raise the Spend Cap hold threshold above this amount, or turn Spend Cap off — then try again.
        </div>
      </AlertBox>
    );
    footer = (
      <div style={{ display: "flex", gap: 8 }}>
        {onOpenHooks && <div style={{ flex: 1 }}><PrimaryCTA onClick={() => onOpenHooks()}>Open Hooks</PrimaryCTA></div>}
        <div style={{ flex: 1 }}><GhostButton onClick={onClose}><span style={{ display: "block", textAlign: "center" }}>Close</span></GhostButton></div>
      </div>
    );
  } else if (success) {
    body = (
      <>
        <AlertBox variant="success">Sent.</AlertBox>
        {success.txHash !== "(pending)" && (
          <a
            href={`${chainMeta.explorerTxBase}${success.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 12, color: GOLD_TEXT, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", wordBreak: "break-all", textDecoration: "underline" }}
          >
            {success.txHash} · {chainMeta.explorerLabel}
          </a>
        )}
      </>
    );
    footer = <PrimaryCTA onClick={onSent}>Done</PrimaryCTA>;
  } else {
    body = (
      <>
        {/* Source-of-funds primer — clears "is this my MetaMask?" + the gas model. */}
        <div style={{ borderRadius: 10, border: "1px solid rgba(247,202,22,.26)", background: "rgba(247,202,22,.05)", padding: "10px 12px", fontSize: 12, lineHeight: 1.5, color: "rgba(226,232,240,0.78)" }}>
          Sending from your <span style={{ color: GOLD_TEXT }}>Agent Wallet</span>, not your MetaMask. Only the selected token moves from your Agent Wallet balance.
          <div style={{ marginTop: 7, paddingTop: 7, borderTop: "1px solid rgba(247,202,22,.15)", color: "rgba(255,255,255,.55)" }}>
            Gas: <span style={{ color: GOLD_TEXT }}>Trial</span> = Q402 sponsors <span style={{ color: GOLD_TEXT }}>BNB Chain only</span>.{" "}
            <span style={{ color: GOLD_TEXT }}>Multichain</span> = relay gas debits from your Gas Tank on the selected chain. Top up via the Treasury.
          </div>
        </div>

        <Field label="Chain">
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
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.35)", marginTop: 6 }}>Non-BNB chains require an active multichain subscription.</div>
          )}
        </Field>

        <Field label="Token">
          <Segmented
            cols={allowedTokens.length >= 3 ? 3 : 2}
            value={token}
            onChange={setToken}
            options={allowedTokens.map((t) => ({ value: t, label: t }))}
          />
        </Field>

        {railAvailable && (
          <Field label="Rail">
            <Segmented
              cols={2}
              value={rail}
              onChange={setRail}
              options={[
                { value: "q402", label: "Q402", sub: "EIP-7702" },
                { value: "x402", label: "x402", sub: "EIP-3009" },
              ]}
            />
            {rail === "x402" ? (
              <div style={{ marginTop: 8 }}>
                <AlertBox variant="warn">
                  <span style={{ fontWeight: 700 }}>x402 needs a wallet that has not used the Q402 rail.</span> Coinbase x402 standard (USDC transferWithAuthorization); Q402 still sponsors gas. An Agent Wallet that already sent on the Q402 rail is EIP-7702 delegated and will be rejected here. Use Q402, or clear the delegation first.
                </AlertBox>
              </div>
            ) : (
              <div style={{ fontSize: 11, color: "rgba(255,255,255,.35)", marginTop: 6, lineHeight: 1.5 }}>Q402 gasless default. Works for any wallet state and supports Hooks.</div>
            )}
          </Field>
        )}

        <Field label="Recipient">
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
            className="placeholder-white/25"
            style={inputStyle({ mono: true, invalid: !recipientValid })}
          />
        </Field>

        <Field
          label="Amount"
          hint={
            token !== "Q" && (typeof perTxMaxUsd === "number" || typeof dailyLimitUsd === "number") ? (
              <>
                {typeof perTxMaxUsd === "number" && <>per-tx ${perTxMaxUsd}</>}
                {typeof perTxMaxUsd === "number" && typeof dailyLimitUsd === "number" && <> · </>}
                {typeof dailyLimitUsd === "number" && <>daily ${dailyLimitUsd}</>}
              </>
            ) : undefined
          }
        >
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1.50"
            inputMode="decimal"
            className="placeholder-white/25"
            style={inputStyle({ mono: true, invalid: !(amountValid && !overPerTxCap) })}
          />
          {overPerTxCap && (
            <div style={{ fontSize: 11, color: "rgba(252,165,165,.85)", marginTop: 6 }}>
              Over per-tx cap (${perTxMaxUsd}). Raise it in Spending limits or send less.
            </div>
          )}
        </Field>

        {error && (
          <AlertBox
            variant="error"
            action={error.next ? <a href={error.next.href} style={{ color: GOLD_TEXT, textDecoration: "underline", textUnderlineOffset: 2 }}>{error.next.label}</a> : undefined}
          >
            {error.headline}
          </AlertBox>
        )}
      </>
    );
    footer = (
      <PrimaryCTA onClick={submit} disabled={!canSubmit} busy={submitting}>
        Send {amount || "—"} {token}
      </PrimaryCTA>
    );
  }

  return (
    <ModalShell
      icon={<SendGlyph size={19} color={GOLD} />}
      title={titleOverride ?? "Send from Agent Wallet"}
      subtitle={<MonoAddr>{walletAddress.slice(0, 10)}…{walletAddress.slice(-6)}</MonoAddr>}
      size="md"
      onClose={onClose}
      closeDisabled={submitting}
      footer={footer}
    >
      {body}
    </ModalShell>
  );
}
