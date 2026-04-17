/**
 * SSRF-safe fetch for webhook delivery.
 *
 * Node's global `fetch()` defaults to `redirect: "follow"`. Even when the
 * original URL passed our validator, a 30x Location header can redirect
 * into IMDS (169.254.169.254), loopback, or any private range — and the
 * HMAC-signed payload still ships. This wrapper:
 *
 *  1. Re-validates the URL *with DNS resolution* before dispatch.
 *  2. Sets `redirect: "manual"` so the client never transparently follows.
 *  3. Treats any 30x response as a delivery failure (logged, not followed).
 *
 * All webhook dispatch paths (user-triggered test + relay fan-out) MUST
 * use this helper instead of calling `fetch()` directly.
 */
import { validateWebhookUrlResolved } from "./webhook-validator";

export type SafeFetchResult =
  | { ok: true; status: number }
  | { ok: false; status?: number; error: string };

export async function safeWebhookFetch(
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    timeoutMs?: number;
  },
): Promise<SafeFetchResult> {
  const pre = await validateWebhookUrlResolved(url);
  if (pre) return { ok: false, error: pre.error };

  try {
    const res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: "manual",
      signal: AbortSignal.timeout(init.timeoutMs ?? 8_000),
    });

    // A manual redirect surfaces as status 0 in the browser fetch spec and
    // as 3xx with `type: "opaqueredirect"` in Node. Treat any redirect
    // attempt as a failure; we will not chase cross-host targets.
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      return { ok: false, status: res.status, error: "Webhook redirected — refusing to follow" };
    }

    return res.ok
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "fetch failed" };
  }
}
