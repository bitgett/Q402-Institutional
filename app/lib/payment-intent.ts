import { kv } from "@vercel/kv";

export interface PaymentIntent {
  intentId: string;
  chain: string;
  expectedUSD: number;
  token: string | null;
  address: string;
  createdAt: string;
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
