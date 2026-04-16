/**
 * Shared SSRF guard for webhook URLs.
 * Used by save (POST /api/webhook), test (POST /api/webhook/test),
 * and relay dispatch (POST /api/relay) so all three paths apply
 * identical rules. Any rule change here propagates everywhere.
 *
 * Returns `null` when the URL is acceptable, or an error object
 * with a 400-safe message when it is not.
 */
export type WebhookValidationError = {
  error: string;
};

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
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  const blocked =
    // IPv4 loopback / link-local / RFC-1918
    /^(localhost|127\.|0\.0\.0\.0|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(host) ||
    // IPv6 loopback, IPv4-mapped, link-local, unique-local
    /^(::1$|::ffff:|fe80:|fc00:|fd[0-9a-f]{2}:)/i.test(host) ||
    // Cloud metadata endpoints (GCP / AWS / Azure)
    /^(metadata\.google\.internal|169\.254\.169\.254|fd00:ec2::254)/.test(host) ||
    // Octal/hex encoded IPs (e.g. 0177.0.0.1)
    /^0[0-7]+\./.test(host);

  if (blocked) {
    return { error: "Webhook URL must be a public endpoint" };
  }

  if (parsed.protocol === "http:" && process.env.NODE_ENV === "production") {
    return { error: "Webhook URL must use HTTPS in production" };
  }

  return null;
}
