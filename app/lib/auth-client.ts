/**
 * auth-client.ts — browser-side nonce + signature management
 *
 * Two-tier auth:
 *
 * SESSION (low-risk — getAuthCreds):
 *   Caches {nonce, signature} in sessionStorage for 55 min (server TTL: 1h).
 *   One wallet popup per session.  Reused for: read, webhook, provision.
 *
 * FRESH CHALLENGE (high-risk — getFreshChallenge):
 *   One-time challenge, 5-min TTL, consumed after first use.
 *   Always prompts the wallet.  Used for: key rotation, payment activation.
 *
 * Usage:
 *   import { getAuthCreds, clearAuthCache, getFreshChallenge } from "@/app/lib/auth-client";
 *   const auth = await getAuthCreds(address, signMessage);      // session
 *   const chal = await getFreshChallenge(address, signMessage); // fresh challenge
 */

// Must stay in sync with auth.ts on the server
const CACHE_TTL_MS = 55 * 60 * 1000; // 55 minutes (server TTL: 1h)

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

  const msg = `Q402 Institutional\nSign in to prove wallet ownership.\n\nAddress: ${addr.toLowerCase()}\nNonce: ${nonce}`;
  const signature = await signMessage(msg);
  if (!signature) return null;

  saveCache(addr, nonce, signature);
  return { nonce, signature };
}

/**
 * Bind a wallet to the caller's email session — Phase 1 of the identity
 * model (see docs/sprint-bnb-focus.md §10). Mints a fresh challenge,
 * prompts the wallet for a signature, POSTs the signed payload to
 * /api/auth/wallet-bind. Returns a tagged result so the caller can render
 * the right UX for each failure mode without parsing error strings.
 *
 *   { ok: true, address }                          — bound, idempotent or first-time
 *   { ok: false, code: "WALLET_ALREADY_BOUND",
 *     boundAddress }                               — different wallet already claimed
 *                                                    (UI should show hard-block / recovery)
 *   { ok: false, code: "SIGNATURE_CANCELLED" }     — user rejected wallet prompt
 *   { ok: false, code: "NETWORK", error }          — fetch / parse failed
 *   { ok: false, code: "REJECTED", error }         — server returned non-ok with no
 *                                                    bind-specific code (rate limit etc.)
 */
export type BindWalletResult =
  | { ok: true; address: string; idempotent?: boolean }
  | { ok: false; code: "WALLET_ALREADY_BOUND"; boundAddress: string }
  | { ok: false; code: "SIGNATURE_CANCELLED"; error: string }
  | { ok: false; code: "NETWORK"; error: string }
  | { ok: false; code: "REJECTED"; error: string };

export async function bindWallet(
  address: string,
  signMessage: (msg: string) => Promise<string | null>,
): Promise<BindWalletResult> {
  const chal = await getFreshChallenge(address, signMessage);
  if (!chal) {
    return {
      ok: false,
      code: "SIGNATURE_CANCELLED",
      error: "Wallet signature was cancelled.",
    };
  }

  try {
    const res = await fetch("/api/auth/wallet-bind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        address,
        challenge: chal.challenge,
        signature: chal.signature,
      }),
    });
    const data = await res.json();

    if (res.status === 409 && data.code === "WALLET_ALREADY_BOUND") {
      return {
        ok: false,
        code: "WALLET_ALREADY_BOUND",
        boundAddress: typeof data.boundAddress === "string" ? data.boundAddress : "",
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        code: "REJECTED",
        error: typeof data.error === "string" ? data.error : "Wallet bind rejected.",
      };
    }
    return {
      ok: true,
      address: typeof data.address === "string" ? data.address : address.toLowerCase(),
      idempotent: data.idempotent === true,
    };
  } catch {
    return { ok: false, code: "NETWORK", error: "Network error." };
  }
}

/**
 * Obtain and sign a fresh one-time challenge for high-risk operations.
 * Always prompts the wallet (no caching).
 * Returns { challenge, signature } or null if the user rejects / network error.
 */
export async function getFreshChallenge(
  addr: string,
  signMessage: (msg: string) => Promise<string | null>,
): Promise<{ challenge: string; signature: string } | null> {
  try {
    const resp = await fetch(`/api/auth/challenge?address=${encodeURIComponent(addr)}`);
    if (!resp.ok) return null;
    const json = await resp.json();
    const challenge: string = json.challenge;
    if (typeof challenge !== "string") return null;

    const msg = `Q402 Institutional\nAuthorize sensitive action (key rotation / payment activation).\n\nAddress: ${addr.toLowerCase()}\nChallenge: ${challenge}`;
    const signature = await signMessage(msg);
    if (!signature) return null;

    return { challenge, signature };
  } catch {
    return null;
  }
}
