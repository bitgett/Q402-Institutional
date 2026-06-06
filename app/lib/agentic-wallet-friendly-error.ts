/**
 * agentic-wallet-friendly-error.ts — backend error → UI mapping.
 *
 * Pure data transform: takes the HTTP status and parsed body from a
 * /api/wallet/agentic/* failure and returns a single-sentence headline
 * + one optional next action the UI surfaces.
 *
 * Kept out of the SendModal component so vitest can import it without
 * pulling in the `"use client"` React tree.
 */

export interface FriendlyError {
  headline: string;
  next?: { label: string; href: string };
}

export interface BackendError {
  error?: string;
  message?: string;
  limit?: number;
  spent?: number;
  requested?: number;
}

export function friendlyError(status: number, body: BackendError): FriendlyError {
  const code = body.error ?? "";

  // Subscription gate — must come BEFORE the generic 402 fallback so
  // only this specific code surfaces the "View plans" CTA.
  if (code === "SUBSCRIPTION_REQUIRED") {
    return {
      headline:
        "Sending on this chain needs a Multichain subscription. BNB Chain is free with the trial.",
      next: { label: "View plans →", href: "/payment" },
    };
  }
  if (code === "TRIAL_BNB_ONLY") {
    return {
      headline:
        "Trial key only works on BNB Chain. Use your Multichain key (or omit apiKey + owner-sign) for other chains.",
      next: { label: "View plans →", href: "/payment" },
    };
  }
  if (code === "NO_API_KEY") {
    return {
      headline: "Activate a Q402 trial or subscription before sending.",
      next: { label: "View plans →", href: "/payment" },
    };
  }

  // Relay-level gas-tank exhaustion. The relay returns a free-form
  // error string ("Insufficient gas tank on eth. Deposit …") with no
  // discrete code — match on the prefix.
  if (code.startsWith("Insufficient gas tank")) {
    const m = /on ([a-z0-9]+)/i.exec(code);
    const chain = m?.[1] ?? "this chain";
    return {
      headline:
        `Your Gas Tank is empty on ${chain}. Paid plans pay relay gas from the Gas Tank; ` +
        `trial-tier gas sponsorship covers BNB only.`,
      next: { label: "Top up Gas Tank", href: "#gas-tank" },
    };
  }

  if (code === "DAILY_LIMIT_EXCEEDED") {
    const lim = body.limit ?? "—";
    return {
      headline: `Daily cap of $${lim} reached. Resets at 00:00 UTC, or raise the cap below.`,
      next: { label: "Raise limits", href: "#raise-limits" },
    };
  }
  if (code === "PER_TX_LIMIT_EXCEEDED") {
    const lim = body.limit ?? "—";
    return {
      headline: `This send exceeds the per-tx cap of $${lim}. Send a smaller amount, or raise the cap.`,
      next: { label: "Raise limits", href: "#raise-limits" },
    };
  }
  if (code === "AGENTIC_WALLET_NOT_FOUND") {
    return { headline: "Agent Wallet not found — try reloading the page." };
  }
  if (code === "AGENTIC_WALLET_ARCHIVED" || code === "WALLET_ARCHIVED") {
    return { headline: "This wallet is archived. Restore it before sending." };
  }

  // ── CCIP bridge / delegation lifecycle ────────────────────────────────
  // These codes come from /api/ccip/send and the bridge auto-fund block.
  // Without these maps the user sees a generic 5xx "Send failed on our
  // side" which is misleading — these are recoverable user-actionable
  // states (delegated wallet, in-flight fund, etc), not Q402 outages.
  if (code === "AGENT_WALLET_DELEGATED") {
    // Bridge auto-fund refused because the Agent Wallet IS delegated to
    // Q402 impl (which has no `receive()`), so a native transfer to
    // the wallet reverts. Recovery = run clear-delegation; the bridge
    // modal exposes the button inline.
    return {
      headline:
        "Your Agent Wallet's EIP-7702 delegation is blocking native funds. Clear it from the " +
        "bridge modal before retrying.",
      next: { label: "Clear delegation", href: "/dashboard#clear-delegation" },
    };
  }
  if (code === "AGENT_WALLET_NOT_DELEGATED") {
    // Distinct semantics from AGENT_WALLET_DELEGATED above: this comes
    // back when the user invoked clear-delegation against a wallet
    // that is ALREADY undelegated. Telling them to "clear it" is
    // exactly backwards — they tried to clear and it's already clear.
    return {
      headline:
        "This Agent Wallet is already undelegated on this chain — nothing to clear. Retry the bridge.",
    };
  }
  if (code === "AGENT_WALLET_AUTOFUND_PENDING") {
    return {
      headline:
        "Auto-fund tx is still mining for your Agent Wallet. Wait ~30s and retry — the bridge will " +
        "pick up the new balance automatically.",
    };
  }
  if (code === "AGENT_WALLET_AUTOFUND_FAILED") {
    return {
      headline:
        "Auto-fund couldn't deliver native gas to your Agent Wallet. Top up directly from the " +
        "dashboard or wait for the reconciliation cron to retry.",
      // Absolute URL — modal-context CTAs to in-page anchors don't
      // resolve when the anchor lives on the parent dashboard, not
      // inside the modal viewport. The bridge modal's onClose hook
      // fires when a CTA navigates away.
      next: { label: "Top up Gas Tank", href: "/dashboard#gas-tank" },
    };
  }
  if (code === "AUTOFUND_DEBIT_FAILED") {
    return {
      headline:
        "Bridge auto-fund went through on-chain but the Gas Tank debit didn't record. Ops is paged; " +
        "a reconciliation cron will fix the bucket — your balance is safe.",
    };
  }
  if (code === "CLEAR_IN_FLIGHT") {
    return {
      headline:
        "A clear-delegation tx is already running for this wallet. Wait ~60s for it to finish before retrying.",
    };
  }
  if (code === "CLEAR_DID_NOT_APPLY") {
    return {
      headline:
        "Clear-delegation tx confirmed but the wallet is still delegated. Ops is paged; try again " +
        "in a few minutes.",
    };
  }
  if (code === "AUTH_SIG_MISMATCH" || code === "AUTH_SIG_RECOVERY_FAILED") {
    return {
      headline:
        "Couldn't verify the clear-delegation signature locally. Reload the dashboard and retry — " +
        "no gas was spent.",
    };
  }
  if (code === "CLEAR_FAILED") {
    return {
      headline:
        "Couldn't broadcast the clear-delegation tx. Check the chain status and retry; no Gas Tank " +
        "balance was deducted.",
    };
  }
  if (code === "relay_unavailable" || code === "keystore_unavailable") {
    return {
      headline:
        "Q402's signer is briefly offline. Wait a moment and try again — your balance is safe.",
    };
  }
  if (code === "NONCE_EXPIRED") {
    return {
      headline: "Your session signature expired. Re-sign the auth challenge to continue.",
    };
  }
  if (code === "AMOUNT_PRECISION_TOO_HIGH") {
    return { headline: "Amount has more decimals than the token supports. Round it off and retry." };
  }
  if (code === "RELAYER_LOW") {
    return {
      headline:
        "Q402 relay is refilling on this chain. Try again in a few minutes — your quota and Gas Tank are untouched.",
    };
  }
  if (code === "relay_forward_failed") {
    return { headline: "Couldn't reach the relayer. Try again in a moment — your balance is safe." };
  }

  // Relay's generic on-chain failure — usually means the Agent Wallet's
  // stablecoin balance on this chain is 0 (signature is valid but the
  // contract revert is masked). Surface it instead of "HTTP 400".
  if (code === "Relay failed. Check your signature and parameters.") {
    return {
      headline:
        "Relay couldn't settle this transfer. Most common cause: the Agent Wallet has 0 balance " +
        "of this token on this chain. Verify the chain + token + amount.",
    };
  }

  if (status >= 500) {
    return { headline: "Send failed on our side. Try again in a moment." };
  }

  // Generic fallback chain — prefer message, then the raw error string,
  // then the HTTP status. The raw `body.error` is much more useful than
  // a bare "HTTP 400" when the route surfaces a free-form description.
  if (body.message) return { headline: body.message };
  if (code)         return { headline: code };
  return { headline: `Send failed (HTTP ${status}).` };
}
