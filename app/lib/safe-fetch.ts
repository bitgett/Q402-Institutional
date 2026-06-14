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

export type SafeJsonResult =
  | { ok: true; status: number; json: unknown }
  | { ok: false; status?: number; error: string };

/**
 * SSRF-safe GET that returns a (size-capped) JSON body. Use this for fetching
 * any attacker-influenceable URL — e.g. the on-chain ERC-8004 `agentURI`
 * metadata, which a user controls when minting their agent. Forces HTTPS,
 * re-validates with DNS resolution (blocks loopback / link-local / IMDS /
 * private ranges / DNS-rebind), refuses redirects, and caps body size + time.
 */
export async function safeMetadataFetch(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<SafeJsonResult> {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, error: "invalid URL" }; }
  if (u.protocol !== "https:") return { ok: false, error: "only https URLs are allowed" };
  const pre = await validateWebhookUrlResolved(url);
  if (pre) return { ok: false, error: pre.error };

  const maxBytes = opts.maxBytes ?? 64 * 1024;
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
    });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      return { ok: false, status: res.status, error: "redirected — refusing to follow" };
    }
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) return { ok: false, status: res.status, error: "response too large" };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) return { ok: false, status: res.status, error: "response too large" };
    try {
      return { ok: true, status: res.status, json: JSON.parse(new TextDecoder().decode(buf)) };
    } catch {
      return { ok: false, status: res.status, error: "invalid JSON" };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "fetch failed" };
  }
}
