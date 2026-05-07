// Server-only owner whitelist for the dashboard paywall bypass.
//
// Owners are loaded from the OWNER_WALLETS env var (no NEXT_PUBLIC_ prefix)
// so the address list never reaches the client bundle. Clients learn their
// own isOwner flag only via authenticated server endpoints
// (/api/keys/provision), never as a static array embedded in JS.
//
// The relayer hot wallet stays inline as a public production identifier
// (already referenced in docs and on-chain payout history).
//
// Lookup is true runtime: every isOwnerWallet() call re-reads process.env
// and re-parses only when the raw string changes (string-equality cache).
// That means a Vercel env edit is picked up by the next request handled
// by a function instance with the new env, with no rebuild required.
//
// Invalid entries surface a console.warn (once per distinct raw env value)
// and are dropped — they do not fail the request, since a misconfigured
// preview deploy shouldn't take down the dashboard, but the warning makes
// the misconfiguration visible in Vercel function logs.

const RELAYER_HOT_LC = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466";

const ADDR_RE = /^0x[0-9a-f]{40}$/;

/**
 * Parse a comma-separated owner list string into validated lowercase
 * addresses. Exported separately so tests can exercise edge cases without
 * mutating process.env. Invalid entries are dropped and surfaced via the
 * `warn` callback (defaults to console.warn).
 */
export function parseOwnerList(
  raw: string,
  warn: (msg: string) => void = console.warn,
): string[] {
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .reduce<string[]>((acc, entry) => {
      const lc = entry.toLowerCase();
      if (ADDR_RE.test(lc)) {
        acc.push(lc);
      } else {
        warn(
          `[owners] dropping invalid OWNER_WALLETS entry: ${JSON.stringify(entry)} ` +
          "(must match /^0x[0-9a-fA-F]{40}$/). Owner-bypass will not apply for this address.",
        );
      }
      return acc;
    }, []);
}

let _cachedRaw: string | null = null;
let _cached: readonly string[] = [];

function ownersFromEnv(): readonly string[] {
  const raw = process.env.OWNER_WALLETS ?? "";
  if (raw === _cachedRaw) return _cached;
  _cachedRaw = raw;
  _cached = parseOwnerList(raw);
  return _cached;
}

/**
 * Returns true if `address` should bypass the dashboard paywall — either
 * the public relayer hot wallet, or one of the configured owner EOAs.
 * Case-insensitive. Empty/null/malformed input returns false.
 */
export function isOwnerWallet(address: string | undefined | null): boolean {
  if (!address) return false;
  const lc = address.toLowerCase();
  if (lc === RELAYER_HOT_LC) return true;
  return ownersFromEnv().includes(lc);
}
