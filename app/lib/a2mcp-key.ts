import { kv } from "@vercel/kv";
import { ethers } from "ethers";

/**
 * Self-refreshing relay key for the free A2MCP /pay endpoint.
 *
 * The only way to relay gas-FREE (Q402-sponsored, no funded gas-tank) is an
 * ACTIVE trial key — but trial keys expire after 30 days. To keep the public
 * /pay endpoint alive indefinitely with zero manual steps and zero cost, a daily
 * cron re-provisions a fresh trial key (fresh throwaway EOA -> the audited
 * /api/trial/activate) shortly before the current one expires, and stores it in
 * KV. getActiveRelayKey() reads that KV key, falling back to the A2MCP_RELAY_KEY
 * env var — so even if KV or the cron ever fails, /pay keeps working on the env
 * key until its own expiry. Fail-safe in every direction.
 */

const KV_KEY = "a2mcp:relaykey";
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // refresh once < 7 days to expiry

interface StoredKey { apiKey: string; expiresAt: string; owner: string }

/** The active relay key: KV-stored (auto-refreshed) with env fallback. */
export async function getActiveRelayKey(): Promise<string> {
  try {
    const stored = await kv.get<StoredKey>(KV_KEY);
    if (stored?.apiKey) return stored.apiKey;
  } catch { /* KV down -> env fallback below */ }
  return process.env.A2MCP_RELAY_KEY ?? "";
}

/**
 * Provision + store a fresh trial key IF the current one is missing or within the
 * refresh window of expiry. On ANY failure the existing key is left untouched.
 */
export async function refreshRelayKeyIfNeeded(baseUrl: string): Promise<{ refreshed: boolean; reason: string }> {
  let stored: StoredKey | null = null;
  try { stored = await kv.get<StoredKey>(KV_KEY); } catch { /* treat as missing */ }
  if (stored?.expiresAt) {
    const msLeft = new Date(stored.expiresAt).getTime() - Date.now();
    if (msLeft > REFRESH_WINDOW_MS) return { refreshed: false, reason: `key valid ~${Math.round(msLeft / 86_400_000)}d` };
  }

  // Fresh throwaway EOA -> challenge -> sign -> the audited trial-activate route.
  const wallet = ethers.Wallet.createRandom();
  const addr = wallet.address.toLowerCase();
  const chRes = await fetch(`${baseUrl}/api/auth/challenge?address=${addr}`);
  const ch = await chRes.json().catch(() => null);
  if (!ch?.challenge) return { refreshed: false, reason: "challenge failed" };
  const msg = `Q402 Institutional\nAuthorize sensitive action (key rotation / payment activation).\n\nAddress: ${addr}\nChallenge: ${ch.challenge}`;
  const signature = await wallet.signMessage(msg);
  const actRes = await fetch(`${baseUrl}/api/trial/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: addr, challenge: ch.challenge, signature }),
  });
  const act = await actRes.json().catch(() => null);
  if (!actRes.ok || !act?.trialApiKey || !act?.trialExpiresAt) {
    return { refreshed: false, reason: `activate failed (${actRes.status})` };
  }
  await kv.set(KV_KEY, { apiKey: act.trialApiKey, expiresAt: act.trialExpiresAt, owner: addr } satisfies StoredKey);
  return { refreshed: true, reason: `new key expires ${String(act.trialExpiresAt).slice(0, 10)}` };
}
