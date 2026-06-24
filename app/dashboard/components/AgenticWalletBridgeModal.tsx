"use client";

/**
 * AgenticWalletBridgeModal — Cross-chain USDC bridge via Chainlink CCIP.
 *
 * Mode C only: the user picks src / dst / amount / feeToken, signs an
 * intent-bound challenge (`ccip.bridge`), and the server signs ccipSend
 * as the Agent Wallet. Token arrives on the same EOA on the destination
 * chain. Q402 markup is zero — user only pays the actual CCIP fee out
 * of their Gas Tank LINK or native bucket.
 *
 * The 3-chain triangle is eth / avax / arbitrum. Source/destination
 * pickers stay in lockstep with /api/ccip/lanes; if a future deploy
 * adds a chain the manifest is the single source of truth.
 *
 * UX shape:
 *   1. Pick source chain → destination chain picker filters to that
 *      source's supported destinations.
 *   2. Type a USDC amount (human decimal). We convert to 6-dec raw on
 *      submit, just like the on-chain pool expects.
 *   3. Pick fee token (LINK is cheaper, native is simpler).
 *   4. "Get quote" hits /api/ccip/quote — both fees come back so the user
 *      sees the trade-off before signing.
 *   5. "Bridge" prompts a single wallet popup for the intent challenge,
 *      then the server submits ccipSend (and a one-time USDC approve if
 *      the Sender's allowance is unset). We surface both tx hashes.
 *   6. After submit we poll /api/ccip/confirm every ~12s for up to ~6
 *      minutes to flip "Bridging…" → "Delivered".
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { getActionAuth } from "@/app/lib/auth-client";
import { ThemedSelect } from "./ThemedSelect";
import { ChainIcon } from "../v2/logos";
import { ModalShell, Field, Segmented, PrimaryCTA, AlertBox, inputStyle, MonoAddr, GOLD_TEXT } from "./modal-kit";

type CCIPChainKey = "eth" | "avax" | "arbitrum";
type FeeTokenKind = "LINK" | "native";

interface ChainMeta {
  key: CCIPChainKey;
  label: string;
  native: string;
  explorer: string;
  explorerLabel: string;
}

const CHAINS: ChainMeta[] = [
  { key: "eth",      label: "Ethereum",  native: "ETH",  explorer: "https://etherscan.io",          explorerLabel: "Etherscan" },
  { key: "avax",     label: "Avalanche", native: "AVAX", explorer: "https://snowtrace.io",          explorerLabel: "Snowtrace" },
  { key: "arbitrum", label: "Arbitrum",  native: "ETH",  explorer: "https://arbiscan.io",           explorerLabel: "Arbiscan" },
];

// Lane matrix mirrors the manifest (3-chain triangle, both directions on
// each edge). Kept inline so the modal can render the dest picker before
// /api/ccip/lanes resolves. Static drift is caught by ccip-config.test.ts.
const LANES: Record<CCIPChainKey, CCIPChainKey[]> = {
  eth:      ["avax", "arbitrum"],
  avax:     ["eth",  "arbitrum"],
  arbitrum: ["eth",  "avax"],
};

interface FeeSlice {
  raw: string;
  whole: number;
  usd: number;
}

interface QuoteResponse {
  src: CCIPChainKey;
  dst: CCIPChainKey;
  amount: string;
  destReceiver: string;
  fee: { link: FeeSlice; native: FeeSlice };
  recommended: FeeTokenKind | "link" | "native";
}

interface SendResponse {
  success?:       boolean;
  messageId?:     string;
  txHash?:        string;
  feeRaw?:        string;
  feeWhole?:      number;
  feeToken?:      FeeTokenKind;
  ccipExplorer?:  string;
  srcExplorer?:   string;
  approveTxHash?: string;
  error?:         string;
  message?:       string;
  code?:          string;
  detail?:        string;
  required?:      number;
  available?:     number;
  chain?:         string;
  // AGENT_WALLET_GAS_LOW / AGENT_WALLET_DELEGATED companion fields
  address?:        string;
  requiredEth?:    number;
  availableEth?:   number;
  delegateTarget?: string;
  // Auto-fund (Gas Tank → Agent Wallet) companion fields. Present iff the
  // route had to top up the Agent Wallet's source-chain gas before the
  // bridge call.
  agentFundTxHash?: string;
  agentFundEth?:    number;
}

interface ConfirmResponse {
  status?:       "pending" | "delivered" | "failed" | "unknown";
  dstTxHash?:    string;
  dstBlock?:     number;
  dstExplorer?:  string;
  ccipExplorer?: string;
}

interface Props {
  walletAddress: string;
  walletId:      string;
  ownerAddress:  string;
  signMessage:   (msg: string) => Promise<string | null>;
  onClose:       () => void;
  onSent:        () => void;
  hasMultichainScope: boolean;
}

function isDecimalAmount(s: string): boolean {
  return /^\d+(\.\d{1,6})?$/.test(s.trim()) && Number(s) > 0;
}

// Human "1.50" → raw 6-dec "1500000". Mirrors USDC's 6 decimals. Avoids
// Number / parseFloat round-trip so 18-dec mental drift can't bite us.
function toUsdcRaw(human: string): string {
  const [whole = "0", frac = ""] = human.trim().split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  const joined = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, "");
  return joined === "" ? "0" : joined;
}

function chainMeta(k: CCIPChainKey): ChainMeta {
  return CHAINS.find(c => c.key === k) ?? CHAINS[0];
}

function shortHash(h: string): string {
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

export function AgenticWalletBridgeModal({
  walletAddress,
  walletId,
  ownerAddress,
  signMessage,
  onClose,
  onSent,
  hasMultichainScope,
}: Props) {
  const [src, setSrc] = useState<CCIPChainKey>("eth");
  const [dst, setDst] = useState<CCIPChainKey>("avax");
  const [amount, setAmount] = useState("");
  const [feeToken, setFeeToken] = useState<FeeTokenKind>("LINK");

  // Quote state — cleared whenever any of (src/dst/amount) changes so the
  // user can't sign against a stale quote.
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracks the discrete server error code (NOT the rendered message) so
  // the modal can attach inline recovery affordances — currently the
  // "Clear delegation & retry" button for AGENT_WALLET_DELEGATED.
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [clearing, setClearing] = useState<"idle" | "signing" | "broadcasting" | "propagating" | "ok" | "failed">("idle");
  // Live elapsed-seconds counter while the clear tx is mining. Drives
  // the countdown text on the recovery button so the user has something
  // to watch instead of a static label — Ethereum block time + propagation
  // means a 25–35s wait is the norm, and a frozen UI for that long reads
  // as "the app hung."
  const [clearElapsedSec, setClearElapsedSec] = useState(0);
  const [result, setResult] = useState<SendResponse | null>(null);
  const [confirmStatus, setConfirmStatus] = useState<ConfirmResponse["status"]>(undefined);
  const [confirmTxHash, setConfirmTxHash] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  // Mirror of confirmStatus that the polling loop reads. Without this,
  // the poll() closure captures the value of confirmStatus at effect
  // mount time (always "pending" because we set it right before
  // setResult) and re-schedules itself for all 30 ticks even after the
  // bridge settles. The ref is updated by an effect on every render so
  // the next setTimeout iteration sees the freshest value.
  const confirmStatusRef = useRef(confirmStatus);
  useEffect(() => { confirmStatusRef.current = confirmStatus; }, [confirmStatus]);

  // Mirror the form state into a ref so the drift detector inside
  // handleClearDelegation reads CURRENT React state, not the closure-
  // captured values from the render that produced the handler. Without
  // this, snapshot.src vs src is always equal-to-itself inside one
  // invocation (the local `src` is the captured const, not whatever
  // setSrc set it to during the await). The ref is the only escape
  // hatch back to "current" state inside an async function body.
  const formStateRef = useRef({ src, dst, amount, feeToken });
  useEffect(() => {
    formStateRef.current = { src, dst, amount, feeToken };
  }, [src, dst, amount, feeToken]);

  // Auto-pick a compatible destination if the user flips src to a chain
  // that doesn't support the currently-selected dst (can't happen with
  // the 3-triangle but the guard keeps the picker honest for any future
  // 4th-chain addition).
  useEffect(() => {
    if (!LANES[src].includes(dst)) {
      setDst(LANES[src][0]);
    }
    setQuote(null);
    setQuoteError(null);
    // Stale error + errorCode would otherwise keep the "Clear
    // delegation" CTA visible after the user flips chains. The CTA
    // applies to whichever chain was active when the error fired;
    // clicking it after a chain flip would clear the WRONG chain's
    // delegation and confuse the user.
    setError(null);
    setErrorCode(null);
  }, [src, dst]);

  // Amount changed → the quote (and any quote error) no longer applies.
  // feeToken is deliberately NOT a dep: the quote returns BOTH the LINK and
  // native fees, so flipping fee token only re-highlights the chosen one.
  // Discarding the quote there forced a pointless re-fetch ("why did my quote
  // vanish when I just compared LINK vs native?"). submit() reads the live
  // feeToken at sign time, so a retained quote can't sign a stale fee.
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
  }, [amount]);

  // Stale send error → clear when amount OR fee token changes. A prior error
  // (e.g. "not enough native gas — switch fee to LINK") referred to the old
  // intent, so switching fee token should dismiss it.
  useEffect(() => {
    setError(null);
    setErrorCode(null);
  }, [amount, feeToken]);

  const amountValid = isDecimalAmount(amount);
  // Lock the form while a clear-delegation tx is mid-flight. Without
  // this the user can flip src/dst/amount/feeToken while the SIGNED
  // clear authorization is still landing on chain — clearing="ok" then
  // fires submit() against the new chain, where the wallet is STILL
  // delegated, and the auto-fund block reverts again. The snapshot
  // inside handleClearDelegation is the second line of defense; this
  // is the first.
  const clearInFlight =
    clearing === "signing" || clearing === "broadcasting" || clearing === "propagating";
  const formLocked = submitting || clearInFlight;
  const canQuote = !quoteLoading && amountValid && src !== dst && !formLocked;
  const canSubmit = !submitting && quote !== null && amountValid && src !== dst && !clearInFlight;

  async function fetchQuote() {
    if (!amountValid) return;
    setQuoteLoading(true);
    setQuoteError(null);
    try {
      const res = await fetch("/api/ccip/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          src,
          dst,
          amount: toUsdcRaw(amount),
          destReceiver: walletAddress,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as QuoteResponse & { error?: string };
      if (!res.ok || data.error) {
        setQuoteError(data.error ?? `Quote failed (HTTP ${res.status}).`);
        return;
      }
      setQuote(data);
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : "Quote request failed.");
    } finally {
      setQuoteLoading(false);
    }
  }

  async function submit() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    if (!amountValid) {
      setError("Amount must be a positive USDC decimal (e.g. 1.50).");
      inFlightRef.current = false;
      return;
    }
    if (!quote) {
      setError("Fetch a quote first so we can show the exact fee before signing.");
      inFlightRef.current = false;
      return;
    }
    setSubmitting(true);
    try {
      const rawAmount = toUsdcRaw(amount);
      const intent: Record<string, string> = {
        walletId,
        src,
        dst,
        amount: rawAmount,
        feeToken,
      };
      const auth = await getActionAuth(ownerAddress, "ccip.bridge", intent, signMessage);
      if (!auth) {
        setError(
          "Sign the bridge challenge in your wallet to authorize. " +
          "The signature is bound to this exact src → dst + amount + fee token."
        );
        return;
      }
      const res = await fetch("/api/ccip/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: ownerAddress,
          nonce:   auth.challenge,
          signature: auth.signature,
          walletId,
          src,
          dst,
          amount: rawAmount,
          feeToken,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as SendResponse;
      if (!res.ok || !data.success) {
        setError(friendlyBridgeError(res.status, data));
        // Read `code` BEFORE `error` — auth-derived failures
        // (NONCE_EXPIRED, SIG_MISMATCH) put the machine code in `code`
        // and a human-readable sentence in `error`. The "Clear
        // delegation" CTA's `errorCode === "AGENT_WALLET_DELEGATED"`
        // check would otherwise miss any code whose route emits the
        // (error, code) shape instead of stuffing the code into the
        // error field.
        const rawCode =
          typeof data.code === "string" ? data.code :
          typeof data.error === "string" ? data.error :
          null;
        setErrorCode(rawCode);
        return;
      }
      setResult(data);
      setConfirmStatus("pending");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setErrorCode(null);
    } finally {
      setSubmitting(false);
      inFlightRef.current = false;
    }
  }

  /**
   * Handle the "Clear delegation & retry" path when the bridge route
   * returns 409 AGENT_WALLET_DELEGATED. We:
   *   1. Mint a fresh action challenge for `agentic.clear_delegation`
   *      bound to (walletId, chain=src) so the server-side route knows
   *      exactly which Agent Wallet on which chain to act on.
   *   2. POST it to /api/wallet/agentic/clear-delegation. The server
   *      decrypts the Agent Wallet PK, signs the EIP-7702 auth with
   *      address=0x0, and broadcasts a type-4 tx via the relayer.
   *   3. On success, auto-re-fire submit() — the inline reconciliation
   *      block in /api/ccip/send picks up the now-undelegated wallet
   *      and the bridge runs through end-to-end.
   * On failure we surface the underlying detail so the user can either
   * retry the clear or fall back to the dashboard's wallet-status flow.
   */
  async function handleClearDelegation() {
    if (clearing === "signing" || clearing === "broadcasting" || clearing === "propagating") return;
    // Snapshot the form state at click-time. If the user changes src
    // between starting the clear and the post-clear submit() retry,
    // we'd otherwise clear delegation on chain A and re-fire submit()
    // against chain B — which leaves chain B still delegated and
    // wastes the clear gas. The snapshot pins the entire intent.
    const snapshot = { src, dst, amount, feeToken };
    if (snapshot.src !== src) return; // paranoia — already captured
    setError(null);
    setErrorCode(null);
    setClearing("signing");
    try {
      const intent: Record<string, string> = {
        walletId,
        chain: snapshot.src,
      };
      const auth = await getActionAuth(ownerAddress, "agentic.clear_delegation", intent, signMessage);
      if (!auth) {
        setError("Couldn't get the clear-delegation challenge signed. Try again.");
        setClearing("failed");
        return;
      }
      setClearing("broadcasting");
      setClearElapsedSec(0);
      // Drive the visible elapsed counter while the tx is mining. The
      // interval is cleared in `finally` so an exception path doesn't
      // leak a ticking timer onto the page.
      const tickStart = Date.now();
      const tickInterval = setInterval(() => {
        setClearElapsedSec(Math.floor((Date.now() - tickStart) / 1000));
      }, 250);
      try {
        const res = await fetch("/api/wallet/agentic/clear-delegation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address:   ownerAddress,
            nonce:     auth.challenge,
            signature: auth.signature,
            walletId,
            chain: snapshot.src,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          alreadyCleared?: boolean;
          txHash?: string;
          error?: string;
          detail?: string;
          message?: string;
        };
        if (!res.ok || (!data.success && !data.alreadyCleared)) {
          setError(data.message ?? data.detail ?? data.error ?? `Clear failed (HTTP ${res.status}).`);
          setClearing("failed");
          return;
        }
        // Propagation wait — the post-clear bytecode (0x) needs a moment
        // to reach the RPC node the bridge route will probe. Drop into
        // the "propagating" phase so the button text reflects what
        // we're actually waiting on (visible countdown 4 → 0).
        setClearing("propagating");
        for (let s = 4; s > 0; s--) {
          setClearElapsedSec(s);
          await new Promise(r => setTimeout(r, 1_000));
        }
        // If the user changed src/dst/amount/feeToken during the clear
        // (form was unlocked, or formLocked got bypassed in a refactor),
        // refuse to auto-resubmit — clearing="ok" would otherwise drive
        // a submit() against the WRONG chain pair, double-spending.
        // Read the ref, NOT the closure-captured locals — those are
        // pinned to the render that produced this handler. The ref is
        // the only path to current state inside this async body.
        const current = formStateRef.current;
        const drifted =
          snapshot.src !== current.src ||
          snapshot.dst !== current.dst ||
          snapshot.amount !== current.amount ||
          snapshot.feeToken !== current.feeToken;
        if (drifted) {
          setClearing("ok");
          setError(
            "Delegation cleared, but you changed the bridge form during the wait. " +
            "Review the new values and click Send to bridge.",
          );
          return;
        }
        setClearing("ok");
        // submit() catches its own errors and surfaces them via
        // setError; it never throws. We intentionally do NOT wrap this
        // in try/catch — a hypothetical future throw should propagate
        // to the outer catch (line ~408) which rolls clearing back to
        // "failed". Wrapping here would silently shadow that path.
        await submit();
      } finally {
        clearInterval(tickInterval);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setClearing("failed");
    }
  }

  // Polling: once we have a messageId, ping /api/ccip/confirm every ~12s
  // until status flips to delivered or failed. Stops after ~6 minutes
  // (30 polls) — anything slower is on the user to refresh CCIP Explorer
  // manually; we don't want to chew their browser indefinitely.
  useEffect(() => {
    if (!result?.messageId) return;
    if (confirmStatus === "delivered" || confirmStatus === "failed") return;

    let cancelled = false;
    let polls = 0;
    const maxPolls = 30;

    async function poll() {
      polls += 1;
      try {
        const res = await fetch("/api/ccip/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageId: result!.messageId, dst }),
        });
        if (cancelled) return;
        if (!res.ok) return;
        const data = (await res.json()) as ConfirmResponse;
        if (cancelled) return;
        if (data.status && data.status !== "pending") {
          setConfirmStatus(data.status);
          if (data.dstTxHash) setConfirmTxHash(data.dstTxHash);
        }
      } catch {
        /* swallow — retry on next tick */
      }
      if (cancelled) return;
      const liveStatus = confirmStatusRef.current;
      if (polls < maxPolls && liveStatus !== "delivered" && liveStatus !== "failed") {
        setTimeout(poll, 12_000);
      } else if (polls >= maxPolls && (liveStatus === "pending" || liveStatus === undefined)) {
        // Polling budget exhausted (~6 min) without a terminal state.
        // Flip to "unknown" so the UI renders a clear "still in flight —
        // track on CCIP Explorer" line instead of looking permanently
        // "Bridging…". CCIP delivery can take 20+ min on busy lanes;
        // we don't want to chew the browser, but the user needs an
        // explicit handoff to the explorer link.
        setConfirmStatus("unknown");
      }
    }
    const t = setTimeout(poll, 6_000);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.messageId]);

  const srcMeta = chainMeta(src);
  const dstMeta = chainMeta(dst);

  const footer = !result ? (
    <PrimaryCTA onClick={submit} disabled={!canSubmit || !hasMultichainScope} busy={submitting}>
      Bridge {amount || "—"} USDC · {srcMeta.label} → {dstMeta.label}
    </PrimaryCTA>
  ) : (
    <PrimaryCTA onClick={onSent}>Done</PrimaryCTA>
  );

  // eslint-disable-next-line @next/next/no-img-element
  const ccipIcon = <img src="/link.jpg" alt="" width={34} height={34} style={{ borderRadius: 8, display: "block" }} />;

  return (
    <ModalShell
      icon={ccipIcon}
      iconBare
      title="Bridge USDC · CCIP"
      subtitle={<MonoAddr>{walletAddress.slice(0, 10)}…{walletAddress.slice(-6)}</MonoAddr>}
      size="md"
      onClose={onClose}
      closeDisabled={submitting}
      footer={footer}
    >
      {!hasMultichainScope && !result && (
        <AlertBox variant="warn" action={<a href="/payment" style={{ color: GOLD_TEXT, textDecoration: "underline" }}>View plans →</a>}>
          Cross-chain USDC bridging needs an active Multichain subscription.
        </AlertBox>
      )}

      {!result ? (
        <>
          <div style={{ borderRadius: 10, border: "1px solid rgba(245,197,24,.2)", background: "rgba(245,197,24,.05)", padding: "10px 12px", fontSize: 12, lineHeight: 1.5, color: "rgba(226,232,240,0.78)" }}>
            Same EOA on the destination chain. Q402 markup is zero — you only pay the actual CCIP fee out of your Gas Tank{" "}
            <span style={{ color: GOLD_TEXT }}>{feeToken === "LINK" ? "LINK" : srcMeta.native}</span> bucket on {srcMeta.label}.
            <div style={{ marginTop: 7, paddingTop: 7, borderTop: "1px solid rgba(245,197,24,.15)", color: "rgba(255,255,255,.6)" }}>
              Q402 auto-funds source-chain bridge gas (~$0.05–$0.50 {srcMeta.native}) from your Gas Tank {srcMeta.native} bucket — you never have to touch the Agent Wallet directly. The Gas Tank deposit covers everything.
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="From">
              <ThemedSelect<CCIPChainKey>
                value={src}
                onChange={setSrc}
                options={CHAINS.map((c) => ({ value: c.key, label: c.label, icon: <ChainIcon chain={c.key} size={16} /> }))}
                ariaLabel="Source chain"
                disabled={formLocked}
              />
            </Field>
            <Field label="To">
              <ThemedSelect<CCIPChainKey>
                value={dst}
                onChange={setDst}
                options={LANES[src].map((k) => ({ value: k, label: chainMeta(k).label, icon: <ChainIcon chain={k} size={16} /> }))}
                ariaLabel="Destination chain"
                disabled={formLocked}
              />
            </Field>
          </div>

          <Field label="Amount (USDC)">
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="1.50"
              inputMode="decimal"
              disabled={formLocked}
              className="placeholder-white/25"
              style={{ ...inputStyle({ mono: true, invalid: !(amount === "" || amountValid) }), ...(formLocked ? { opacity: 0.5, cursor: "not-allowed" } : {}) }}
            />
            <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", marginTop: 6 }}>USDC has 6 decimals — max precision 0.000001 USDC.</div>
          </Field>

          <Field label="Pay fee in">
            <Segmented
              cols={2}
              value={feeToken}
              onChange={setFeeToken}
              options={(["LINK", "native"] as FeeTokenKind[]).map((t) => ({
                value: t,
                label: t === "LINK" ? "LINK · ~10% cheaper" : `${srcMeta.native} native`,
                disabled: formLocked,
              }))}
            />
          </Field>

          <button
            type="button"
            disabled={!canQuote}
            onClick={fetchQuote}
            className="transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: "1px solid rgba(255,255,255,.16)", background: "rgba(255,255,255,.04)", color: "#e2e8f0", fontSize: 13, fontWeight: 600, cursor: canQuote ? "pointer" : "not-allowed" }}
          >
            {quoteLoading ? "Quoting…" : quote ? "Refresh quote" : "Get quote"}
          </button>

          {quoteError && <div style={{ fontSize: 12, color: "rgba(252,165,165,.85)" }}>{quoteError}</div>}

          {quote && (
            <div style={{ borderRadius: 12, border: "1px solid rgba(247,202,22,.3)", background: "rgba(247,202,22,.06)", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".09em", fontWeight: 600, color: GOLD_TEXT }}>CCIP fee quote</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FeeCell label="LINK" whole={quote.fee.link.whole} usd={quote.fee.link.usd} highlighted={feeToken === "LINK"} recommended={quote.recommended === "link"} />
                <FeeCell label={srcMeta.native} whole={quote.fee.native.whole} usd={quote.fee.native.usd} highlighted={feeToken === "native"} recommended={quote.recommended === "native"} />
              </div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,.45)" }}>Quote is on-chain at this block. Server caps slippage at +10% before rejecting — re-quote if more than a minute has passed.</div>
            </div>
          )}

          {error && (
            <AlertBox variant="error">
              <div>{error}</div>
              {errorCode === "AGENT_WALLET_DELEGATED" && clearing !== "ok" && (
                <button
                  type="button"
                  onClick={handleClearDelegation}
                  disabled={clearing === "signing" || clearing === "broadcasting" || clearing === "propagating"}
                  className="transition-colors disabled:opacity-70 disabled:cursor-not-allowed"
                  style={{ width: "100%", marginTop: 8, padding: "8px 12px", borderRadius: 9, border: "none", background: GOLD_TEXT, color: "#101722", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                >
                  {clearing === "signing"
                    ? "Waiting for wallet signature…"
                    : clearing === "broadcasting"
                      ? `Clearing delegation on chain · ${clearElapsedSec}s elapsed (≈25–35s typical)`
                      : clearing === "propagating"
                        ? `Propagation buffer · ${clearElapsedSec}s left, then bridge fires`
                        : clearing === "failed"
                          ? "Clear delegation & retry bridge"
                          : `Clear delegation & retry bridge (~25s, debits Gas Tank ${srcMeta.native})`}
                </button>
              )}
              {errorCode === "AGENT_WALLET_DELEGATED" && (
                <div style={{ marginTop: 8, fontSize: 10.5, color: "rgba(255,255,255,.55)", lineHeight: 1.5 }}>
                  One tap clears the EIP-7702 delegation on your Agent Wallet, then re-fires this bridge automatically. The clear-tx gas (~$0.05–$0.20) debits from your Gas Tank {srcMeta.native} bucket on {srcMeta.label}. A future Q402 send will re-delegate the wallet — so bridge first if you have both to do.
                </div>
              )}
            </AlertBox>
          )}
        </>
      ) : (
        <BridgeResult result={result} confirmStatus={confirmStatus} confirmTxHash={confirmTxHash} srcMeta={srcMeta} dstMeta={dstMeta} />
      )}
    </ModalShell>
  );
}

function FeeCell({
  label,
  whole,
  usd,
  highlighted,
  recommended,
}: {
  label: string;
  whole: number;
  usd: number;
  highlighted: boolean;
  recommended: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-2.5 py-2 ${highlighted ? "" : "border-white/10"}`}
      style={{
        background: highlighted ? "rgba(245,197,24,0.08)" : "rgba(255,255,255,0.02)",
        ...(highlighted ? { borderColor: "rgba(245,197,24,0.55)" } : {}),
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-white/65 text-[10px] uppercase tracking-widest font-medium">{label}</span>
        {recommended && (
          <span className="text-[9px] uppercase tracking-widest font-semibold" style={{ color: "rgba(143,214,247,.9)" }}>
            best
          </span>
        )}
      </div>
      <div className="text-white text-sm font-mono mt-0.5">
        {whole.toLocaleString("en-US", { maximumFractionDigits: 6 })}
      </div>
      <div className="text-[11px] font-mono" style={{ color: "rgba(143,214,247,.85)" }}>
        ≈ ${usd.toFixed(usd < 1 ? 4 : 2)}
      </div>
    </div>
  );
}

function BridgeResult({
  result,
  confirmStatus,
  confirmTxHash,
  srcMeta,
  dstMeta,
}: {
  result: SendResponse;
  confirmStatus: ConfirmResponse["status"];
  confirmTxHash: string | null;
  srcMeta: ChainMeta;
  dstMeta: ChainMeta;
}) {
  const statusLabel =
    confirmStatus === "delivered" ? "Delivered"
    : confirmStatus === "failed"  ? "Failed"
    : confirmStatus === "unknown" ? "Still in flight — check CCIP Explorer ↗"
    : "Bridging…";
  const statusTone =
    confirmStatus === "failed"  ? "text-red-300 border-red-400/30 bg-red-400/5"
    : confirmStatus === "unknown" ? "text-white/70 border-white/15 bg-white/[0.02]"
    : "";
  const statusInlineStyle: CSSProperties =
    confirmStatus === "delivered" ? { color: "#8fd6f7", borderColor: "rgba(88,199,244,.34)", background: "rgba(88,199,244,.06)" }
    : confirmStatus === "failed" || confirmStatus === "unknown" ? {}
    : { color: "#f9d64a", borderColor: "rgba(245,197,24,0.30)", background: "rgba(245,197,24,0.05)" };

  return (
    <div className="space-y-3">
      <div className={`rounded-md border px-3 py-2 text-sm ${statusTone}`} style={statusInlineStyle}>
        {statusLabel} · {srcMeta.label} → {dstMeta.label}
        {confirmStatus === "pending" && (
          <div className="text-[10.5px] text-white/55 mt-1">
            CCIP usually settles in 8–25 min depending on lane. We&apos;ll keep checking;
            you can also follow the message on CCIP Explorer below.
          </div>
        )}
      </div>

      {result.agentFundTxHash && (
        <ResultRow
          label="Gas Tank → Agent Wallet (auto-fund)"
          href={`${srcMeta.explorer}/tx/${result.agentFundTxHash}`}
          value={shortHash(result.agentFundTxHash)}
          hint={
            typeof result.agentFundEth === "number"
              ? `${result.agentFundEth.toFixed(5)} ${srcMeta.native} debited from your Gas Tank to cover source-chain bridge gas.`
              : "Source-chain gas debited from your Gas Tank to cover the bridge tx."
          }
        />
      )}
      {result.approveTxHash && (
        <ResultRow
          label="USDC approve"
          href={`${srcMeta.explorer}/tx/${result.approveTxHash}`}
          value={shortHash(result.approveTxHash)}
          hint="One-time per wallet per chain — future bridges skip this."
        />
      )}
      {result.txHash && (
        <ResultRow
          label={`Source tx · ${srcMeta.explorerLabel}`}
          href={result.srcExplorer ?? `${srcMeta.explorer}/tx/${result.txHash}`}
          value={shortHash(result.txHash)}
        />
      )}
      {result.messageId && (
        <ResultRow
          label="CCIP messageId"
          href={result.ccipExplorer ?? `https://ccip.chain.link/msg/${result.messageId}`}
          value={shortHash(result.messageId)}
          hint="Click to open Chainlink CCIP Explorer."
        />
      )}
      {confirmTxHash && (
        <ResultRow
          label={`Dest tx · ${dstMeta.explorerLabel}`}
          href={`${dstMeta.explorer}/tx/${confirmTxHash}`}
          value={shortHash(confirmTxHash)}
        />
      )}
      {typeof result.feeWhole === "number" && (
        <div className="text-[11px] text-white/55">
          Fee paid: {result.feeWhole.toLocaleString("en-US", { maximumFractionDigits: 6 })}{" "}
          {result.feeToken === "LINK" ? "LINK" : srcMeta.native} · debited from your Gas Tank.
        </div>
      )}
    </div>
  );
}

function ResultRow({
  label,
  value,
  href,
  hint,
}: {
  label: string;
  value: string;
  href: string;
  hint?: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-widest text-white/45 font-medium">{label}</div>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs font-mono break-all"
        style={{ color: GOLD_TEXT }}
      >
        {value} ↗
      </a>
      {hint && <div className="text-[10px] text-white/40">{hint}</div>}
    </div>
  );
}

// Tiny inline error map — CCIP send returns a discrete set of codes we
// can map to one-sentence guidance. Kept inline (not in
// agentic-wallet-friendly-error) because the failure modes here
// (gas-tank-low, fee-spike, CCIP-quote-failed, sender-not-deployed) don't
// overlap with the agentic-send route's vocabulary.
function friendlyBridgeError(status: number, body: SendResponse): string {
  // Read `code` first, then fall back to `error`. The send route emits
  // both shapes: some failure paths put the machine code in `error`
  // (and surface a friendly message in `message`); others (auth-
  // derived: NONCE_EXPIRED, SIG_MISMATCH) put a sentence in `error`
  // and the code in `code`. Reading `error` only — the previous
  // behavior — silently broke every `code === "X"` branch for the
  // latter shape and left "Clear delegation" CTA fragile.
  const code = body.code ?? body.error ?? "";
  if (code === "CCIP_SENDER_NOT_DEPLOYED") {
    return "Bridge is temporarily disabled on this lane (sender contract pending redeploy).";
  }
  if (code === "INSUFFICIENT_LINK_BALANCE") {
    return `Not enough LINK on ${body.chain ?? "source chain"} — need ${body.required ?? "?"}, have ${body.available ?? 0}. Top up Gas Tank or switch fee to native.`;
  }
  if (code === "INSUFFICIENT_NATIVE_BALANCE") {
    return `Not enough native gas on ${body.chain ?? "source chain"} — need ${body.required ?? "?"}, have ${body.available ?? 0}. Top up Gas Tank or switch fee to LINK.`;
  }
  if (code === "FEE_EXCEEDS_MAX") {
    return "CCIP fee spiked above the slippage cap. Refresh the quote and try again.";
  }
  if (code === "CCIP_QUOTE_FAILED") {
    return "Couldn't reach the CCIP router to quote the fee. Wait a moment and retry.";
  }
  if (code === "AGENT_WALLET_DELEGATED") {
    return (
      "Your Agent Wallet is EIP-7702 delegated to the Q402 payment contract, which doesn't accept " +
      "native transfers. Clear the delegation first (Agent Wallet tab → Clear delegation, or " +
      "`q402_clear_delegation` from any MCP client) and retry the bridge. Heads-up: the next Q402 " +
      "send re-delegates the wallet, so bridge before /send when you can."
    );
  }
  if (code === "AGENT_WALLET_NOT_DELEGATED") {
    return "Agent Wallet is already undelegated on this chain — nothing to clear. Retry the bridge.";
  }
  if (code === "AGENT_WALLET_GAS_LOW") {
    // Safety-net path. Normally the route auto-funds the Agent Wallet
    // from the user's Gas Tank ETH bucket, so the user never has to
    // manage the Agent Wallet's gas directly. This message only fires
    // if the auto-fund probe blipped on the RPC and the actual bridge
    // tx then reverted — instructions intentionally point at the Gas
    // Tank, NOT at the Agent Wallet address, because that's the
    // canonical UX.
    return (
      "Q402 couldn't auto-fund the Agent Wallet's source-chain gas this attempt. " +
      "Make sure your Gas Tank native bucket has a small buffer on the source chain and retry."
    );
  }
  if (code === "AGENT_WALLET_AUTOFUND_PENDING") {
    return (
      "Q402 just topped up the Agent Wallet's source-chain gas — the funding tx is still confirming. " +
      "Retry in ~30 seconds and the bridge will go through."
    );
  }
  if (code === "AGENT_WALLET_AUTOFUND_FAILED") {
    return (
      "Auto-fund couldn't deliver native gas to your Agent Wallet. Top up the Gas Tank directly " +
      "from the dashboard or wait for the reconciliation cron to retry."
    );
  }
  if (code === "AUTOFUND_DEBIT_FAILED") {
    return (
      "Bridge auto-fund went through on-chain but the Gas Tank debit didn't record. Ops is paged; " +
      "a reconciliation cron will fix the bucket — your balance is safe. Retry in a moment."
    );
  }
  if (code === "CCIP_BRIDGE_BUSY") {
    return "Another bridge is already in flight for this Agent Wallet on this lane. Wait ~30s and retry.";
  }
  if (code === "RELAYER_LOW") {
    return "Q402 relay infrastructure is refilling on this chain. Try again in a few minutes — your Gas Tank and quota are untouched.";
  }
  if (code === "CLEAR_IN_FLIGHT") {
    return "A clear-delegation tx is already running for this wallet. Wait ~60s before retrying.";
  }
  if (code === "CLEAR_DID_NOT_APPLY") {
    return "Clear-delegation tx confirmed but the wallet is still delegated. Ops is paged; try again in a few minutes.";
  }
  if (code === "AUTH_SIG_MISMATCH" || code === "AUTH_SIG_RECOVERY_FAILED") {
    return "Couldn't verify the bridge signature locally. Reload the dashboard and re-sign.";
  }
  if (code === "CCIP_BRIDGE_FAILED") {
    return `Bridge tx reverted on source chain. ${body.detail ? `Detail: ${body.detail.slice(0, 140)}` : ""}`.trim();
  }
  if (code === "AGENTIC_WALLET_NOT_FOUND") {
    return "Agent Wallet not found on this source chain — reload the page.";
  }
  if (code === "NONCE_EXPIRED" || code === "SIG_MISMATCH" || code === "BAD_SIGNATURE") {
    return "Your bridge challenge expired or didn't verify. Re-sign and try again.";
  }
  if (status === 402) {
    return "Cross-chain bridging needs an active Multichain subscription.";
  }
  return body.message ?? body.detail ?? body.error ?? `Bridge failed (HTTP ${status}).`;
}
