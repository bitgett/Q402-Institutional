/**
 * Shared SSRF guard for webhook URLs.
 * Used by save (POST /api/webhook), test (POST /api/webhook/test),
 * and relay dispatch (POST /api/relay) so all three paths apply
 * identical rules. Any rule change here propagates everywhere.
 *
 * Returns `null` when the URL is acceptable, or an error object
 * with a 400-safe message when it is not.
 *
 * The sync validator checks host string patterns. The async variant
 * additionally resolves DNS and verifies the resulting IPs are public,
 * closing DNS-rebinding / nip.io-style bypasses.
 */
import { promises as dns } from "node:dns";
import net from "node:net";

export type WebhookValidationError = {
  error: string;
};

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast + reserved
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fe80:") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("::ffff:") ||
    lower.startsWith("fd00:ec2:")
  );
}

export function isPrivateIP(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true; // unparseable → treat as blocked
}

export function validateWebhookUrl(url: string): WebhookValidationError | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "Invalid webhook URL" };
  }

  if (!["https:", "http:"].includes(parsed.protocol)) {
    return { error: "Invalid webhook URL" };
  }

  // Strip IPv6 brackets — URL.hostname keeps them for `[::1]`-style hosts.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

  // Block DNS-wildcard services that resolve arbitrary strings to private IPs
  // (nip.io, sslip.io, xip.io, traefik.me, localtest.me, etc.)
  if (/\.(nip\.io|sslip\.io|xip\.io|traefik\.me|localtest\.me)$/i.test(host)) {
    return { error: "Webhook URL must be a public endpoint" };
  }

  // If host IS a literal IP, check privacy directly (handles 2-octet `127.1`,
  // IPv4-mapped IPv6, etc. that Node's net.isIP normalizes).
  if (net.isIP(host)) {
    if (isPrivateIP(host)) {
      return { error: "Webhook URL must be a public endpoint" };
    }
  } else {
    const blocked =
      /^(localhost|127\.|0\.0\.0\.0|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(host) ||
      /^(::1$|::ffff:|fe80:|fc00:|fd[0-9a-f]{2}:)/i.test(host) ||
      /^(metadata\.google\.internal|169\.254\.169\.254|fd00:ec2::254)/.test(host) ||
      /^0[0-7]+\./.test(host) ||
      /^\d{8,10}$/.test(host) ||
      /^0x[0-9a-f]+$/i.test(host) ||
      // 2-/3-octet IPv4 shorthand (e.g. 127.1, 10.1.1)
      /^\d+\.\d+$/.test(host) ||
      /^\d+\.\d+\.\d+$/.test(host);

    if (blocked) {
      return { error: "Webhook URL must be a public endpoint" };
    }
  }

  if (parsed.protocol === "http:" && process.env.NODE_ENV === "production") {
    return { error: "Webhook URL must use HTTPS in production" };
  }

  return null;
}

/**
 * Full-resolution variant: validates the URL AND resolves the host
 * to block DNS rebinding / wildcard-DNS bypasses. Use this at the
 * moment of dispatch, not just at save time.
 */
export async function validateWebhookUrlResolved(
  url: string,
): Promise<WebhookValidationError | null> {
  const syncErr = validateWebhookUrl(url);
  if (syncErr) return syncErr;

  const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (net.isIP(host)) return null; // already validated above

  try {
    const addrs = await dns.lookup(host, { all: true, verbatim: true });
    if (!addrs.length) return { error: "Webhook host did not resolve" };
    for (const a of addrs) {
      if (isPrivateIP(a.address)) {
        return { error: "Webhook URL must be a public endpoint" };
      }
    }
    return null;
  } catch {
    return { error: "Webhook host did not resolve" };
  }
}
