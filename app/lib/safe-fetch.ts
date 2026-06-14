/**
 * SSRF-safe fetch for webhook delivery + attacker-influenceable metadata.
 *
 * Two layers of defence:
 *  1. Pre-flight: validate the URL AND resolve its host, blocking private /
 *     loopback / link-local / IMDS ranges (validateWebhookUrlResolved).
 *  2. Connect-time: the request runs on an http/https Agent with a custom DNS
 *     `lookup` that re-checks the resolved IP and refuses to dial a non-public
 *     address. Because this check happens inside the SAME lookup that opens the
 *     socket, a host whose DNS flips between the pre-flight and the connection
 *     (public-then-private) can't slip through — the address actually dialed is
 *     the one vetted.
 *  3. Redirects are never followed (a 30x Location could point inward); any 30x
 *     is treated as a delivery failure.
 *
 * Implemented on node:http(s) rather than global fetch so the custom lookup can
 * be attached without pulling in undici (which the webpack server build can't
 * resolve as a bare import).
 *
 * All webhook dispatch + metadata-fetch paths MUST use these helpers instead of
 * calling fetch() directly.
 */
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { request as httpRequest, Agent as HttpAgent } from "node:http";
import { lookup as dnsLookup } from "node:dns";
import { validateWebhookUrlResolved, isPrivateIP } from "./webhook-validator";

// Custom DNS lookup that refuses to resolve to a non-public address. Attached
// to the connection Agent, so the IP it vets is the IP the socket dials.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeLookup(hostname: string, options: any, callback: any): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dnsLookup as any)(hostname, options, (err: NodeJS.ErrnoException | null, address: unknown, family: number) => {
    if (err) return callback(err, address, family);
    const list = Array.isArray(address)
      ? (address as Array<{ address: string }>)
      : [{ address: address as string }];
    for (const a of list) {
      if (isPrivateIP(a.address)) {
        return callback(new Error("SSRF: host resolved to a non-public address"));
      }
    }
    callback(null, address, family);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const httpsAgent = new HttpsAgent({ lookup: safeLookup as any });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const httpAgent = new HttpAgent({ lookup: safeLookup as any });

interface RawResult {
  redirected: boolean;
  status: number;
  body: Buffer;
}

function rawSafeRequest(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; timeoutMs: number; maxBytes: number },
): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { return reject(new Error("invalid URL")); }
    const isHttps = u.protocol === "https:";
    const doRequest = isHttps ? httpsRequest : httpRequest;
    const agent = isHttps ? httpsAgent : httpAgent;

    const req = doRequest(
      url,
      {
        method: init.method,
        headers: init.headers,
        agent,
        // Bounds the WHOLE request incl. the DNS lookup + connect, which
        // req.setTimeout (socket-inactivity only) does not — a slow resolver
        // can't hang us past timeoutMs.
        signal: AbortSignal.timeout(init.timeoutMs),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // Never follow redirects — a 30x could point at an internal host.
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ redirected: true, status, body: Buffer.alloc(0) });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > init.maxBytes) {
            req.destroy(new Error("response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ redirected: false, status, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(init.timeoutMs, () => req.destroy(new Error("request timed out")));
    if (init.body) req.write(init.body);
    req.end();
  });
}

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
    const res = await rawSafeRequest(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      timeoutMs: init.timeoutMs ?? 8_000,
      maxBytes: 64 * 1024,
    });
    if (res.redirected) {
      return { ok: false, status: res.status, error: "Webhook redirected — refusing to follow" };
    }
    return res.status >= 200 && res.status < 300
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
 * validates + pins the resolved IP, refuses redirects, and caps body size + time.
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
    const res = await rawSafeRequest(url, {
      method: "GET",
      timeoutMs: opts.timeoutMs ?? 8_000,
      maxBytes,
    });
    if (res.redirected) {
      return { ok: false, status: res.status, error: "redirected — refusing to follow" };
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    try {
      return { ok: true, status: res.status, json: JSON.parse(res.body.toString("utf8")) };
    } catch {
      return { ok: false, status: res.status, error: "invalid JSON" };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "fetch failed" };
  }
}
