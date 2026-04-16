import { kv } from "@vercel/kv";

export interface PaymentIntent {
  intentId:      string;
  chain:         string;       // payment chain id ("bnb", "eth", etc.)
  expectedUSD:   number;
  token:         string | null;
  address:       string;
  createdAt:     string;
  // Locked at intent creation — activate uses these instead of recalculating.
  // Eliminates drift between the price the user saw and what the server grants.
  // Selected relay chain. Drives plan/credit thresholds — `chain` is only
  // the payment rail. Defaults to `chain` on intent if omitted.
  planChain?:    string;
  quotedPlan:    string | null;
  quotedCredits: number;
}

export function intentKey(addr: string) {
  return `payment_intent:${addr.toLowerCase()}`;
}

/** Internal: read intent for an address (used by activate route). */
export async function getPaymentIntent(addr: string): Promise<PaymentIntent | null> {
  return kv.get<PaymentIntent>(intentKey(addr));
}

/** Internal: delete intent after successful activation. */
export async function clearPaymentIntent(addr: string): Promise<void> {
  await kv.del(intentKey(addr));
}
