/**
 * auth-client.ts — browser-side nonce + signature management
 *
 * Keeps the wallet popup count to 1 per session by caching {nonce, signature}
 * in sessionStorage with a 7.5-hour TTL (slightly shorter than the server's 8h).
 *
 * Usage in a component:
 *   import { getAuthCreds, clearAuthCache } from "@/app/lib/auth-client";
 *   const auth = await getAuthCreds(address, signMessage);
 *   if (!auth) return; // user rejected
 *   // use auth.nonce + auth.signature in all protected API calls
 *
 *   // On 401 NONCE_EXPIRED from server:
 *   clearAuthCache(address);
 *   const auth2 = await getAuthCreds(address, signMessage); // re-prompts wallet
 */

// Must stay in sync with auth.ts on the server
const CACHE_TTL_MS = 7.5 * 60 * 60 * 1000; // 7.5 hours

interface AuthCache {
  nonce:     string;
  signature: string;
  cachedAt:  number; // Date.now() ms
}

function cacheKey(addr: string) {
  return `q402_auth_${addr.toLowerCase()}`;
}

function loadCache(addr: string): AuthCache | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(addr));
    if (!raw) return null;
    const c: AuthCache = JSON.parse(raw);
    if (Date.now() - c.cachedAt > CACHE_TTL_MS) {
      sessionStorage.removeItem(cacheKey(addr));
      return null;
    }
    return c;
  } catch {
    return null;
  }
}

function saveCache(addr: string, nonce: string, signature: string) {
  try {
    const payload: AuthCache = { nonce, signature, cachedAt: Date.now() };
    sessionStorage.setItem(cacheKey(addr), JSON.stringify(payload));
  } catch { /* storage full or unavailable — non-fatal */ }
}

/**
 * Clear cached credentials for `addr`.
 * Also removes the old `q402_sig_*` format written by previous versions.
 */
export function clearAuthCache(addr: string) {
  try {
    sessionStorage.removeItem(cacheKey(addr));
    // Purge legacy format from prior versions
    sessionStorage.removeItem(`q402_sig_${addr.toLowerCase()}`);
  } catch { /* ignore */ }
}

/**
 * Fetch a fresh nonce from the server for `addr`.
 * Returns null if the request fails (e.g. KV unavailable).
 */
export async function fetchNonce(addr: string): Promise<string | null> {
  try {
    const resp = await fetch(`/api/auth/nonce?address=${encodeURIComponent(addr)}`);
    if (!resp.ok) return null;
    const json = await resp.json();
    return typeof json.nonce === "string" ? json.nonce : null;
  } catch {
    return null;
  }
}

/**
 * Returns a valid { nonce, signature } pair for `addr`.
 *
 * 1. Returns cached pair if still fresh.
 * 2. Otherwise fetches a new nonce, asks the wallet to sign, caches result.
 * 3. Returns null if the user rejects the signature request or on network error.
 *
 * @param addr        - wallet address (checksummed or lowercase, normalised internally)
 * @param signMessage - async function that prompts wallet and returns signature string, or null on rejection
 */
export async function getAuthCreds(
  addr: string,
  signMessage: (msg: string) => Promise<string | null>,
): Promise<{ nonce: string; signature: string } | null> {
  const cached = loadCache(addr);
  if (cached) return { nonce: cached.nonce, signature: cached.signature };

  const nonce = await fetchNonce(addr);
  if (!nonce) return null;

  const msg = `Q402 Auth\nAddress: ${addr.toLowerCase()}\nNonce: ${nonce}`;
  const signature = await signMessage(msg);
  if (!signature) return null;

  saveCache(addr, nonce, signature);
  return { nonce, signature };
}
