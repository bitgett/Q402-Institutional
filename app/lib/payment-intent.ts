import { kv } from "@vercel/kv";

export interface PaymentIntent {
  intentId:      string;
  chain:         string;       // payment chain id ("bnb", "eth", etc.)
  expectedUSD:   number;
  token:         string | null;
  address:       string;
  createdAt:     string;
  // Selected relay chain. Drives plan/credit thresholds — `chain` is only
  // the payment rail. Defaults to `chain` on intent if omitted.
  planChain?:    string;
  quotedPlan:    string | null;
  quotedCredits: number;
}

// ── Storage layout ──────────────────────────────────────────────────────────
// Primary record:  payment_intent:id:{intentId}      → PaymentIntent
// Latest pointer:  payment_intent:latest:{address}   → intentId string
// Legacy record:   payment_intent:{address}          → PaymentIntent (read-only)
//
// Multiple concurrent intents per address are supported: each lives under its
// own intentId key. The latest pointer is used when the client activates
// without passing an intentId (legacy flow / single-tab default).
//
// The legacy address-keyed record is retained only as a read fallback for
// intents created before this layout landed. New writes never populate it.

export function intentByIdKey(intentId: string) {
  return `payment_intent:id:${intentId}`;
}

export function intentLatestKey(addr: string) {
  return `payment_intent:latest:${addr.toLowerCase()}`;
}

/** @deprecated read-only — retained for legacy intents written under the address-keyed layout. */
export function intentKey(addr: string) {
  return `payment_intent:${addr.toLowerCase()}`;
}

/**
 * Read a payment intent.
 *
 * - With intentId: look up by id directly (cross-tab safe).
 * - Without intentId: follow the latest pointer for the address.
 * - Falls back to the legacy address-keyed record if neither resolves.
 */
export async function getPaymentIntent(
  addr: string,
  intentId?: string | null,
): Promise<PaymentIntent | null> {
  if (intentId) {
    const direct = await kv.get<PaymentIntent>(intentByIdKey(intentId));
    if (direct) return direct;
  } else {
    const latestId = await kv.get<string>(intentLatestKey(addr));
    if (latestId) {
      const latest = await kv.get<PaymentIntent>(intentByIdKey(latestId));
      if (latest) return latest;
    }
  }
  return kv.get<PaymentIntent>(intentKey(addr));
}

/**
 * Delete a payment intent after successful activation.
 *
 * Removes the id-keyed record and the legacy address-keyed record, and clears
 * the latest pointer when it still points at this intent (avoids wiping a
 * pointer that has since advanced to a newer intent).
 */
export async function clearPaymentIntent(
  addr: string,
  intentId: string,
): Promise<void> {
  await Promise.all([
    kv.del(intentByIdKey(intentId)),
    kv.del(intentKey(addr)),
  ]);
  const latestId = await kv.get<string>(intentLatestKey(addr));
  if (latestId === intentId) {
    await kv.del(intentLatestKey(addr));
  }
}
