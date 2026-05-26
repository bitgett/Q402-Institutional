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

  if (code === "SUBSCRIPTION_REQUIRED" || status === 402) {
    return {
      headline:
        "Sending on this chain needs a Multichain subscription. BNB Chain is free with the trial.",
      next: { label: "View plans →", href: "/payment" },
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
  if (status >= 500) {
    return {
      headline: "Send failed on our side. Try again in a moment.",
    };
  }
  if (body.message) {
    return { headline: body.message };
  }
  return { headline: `Send failed (HTTP ${status}).` };
}
