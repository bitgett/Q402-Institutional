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
