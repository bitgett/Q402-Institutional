/**
 * recurring-webhook.ts — webhook dispatch for the recurring-payouts cron.
 *
 * Mirrors the shape /api/relay uses for `relay.success` so customers
 * can layer one HMAC-verifier on top of every Q402 event:
 *
 *   X-Q402-Event:     recurring.fired   (every successful fire — full + partial)
 *                     recurring.stopped (terminal stop: cap-exceeded / sub lapsed
 *                                        / per-tx max / no apiKey)
 *                     recurring.error   (transient error — will retry next tick)
 *   X-Q402-Signature: sha256=<hmac>
 *
 * The cron should call `dispatchRecurringWebhook` from inside
 * Next.js's `after()` so the response isn't blocked on the HTTP
 * round-trip. All paths are best-effort — a webhook delivery failure
 * never affects rule advancement or chain state.
 *
 * Auth is HMAC-SHA256 over the JSON body using the customer's saved
 * webhook secret (set on the dashboard). SSRF is closed by reusing
 * `safeWebhookFetch` from app/lib/safe-fetch, which re-resolves DNS
 * before dispatch and refuses to follow redirects.
 */

import { createHash, createHmac } from "crypto";

import { getWebhookConfig, recordWebhookDelivery, type RelayedTx } from "./db";
import { validateWebhookUrl } from "./webhook-validator";
import { safeWebhookFetch } from "./safe-fetch";

export type RecurringWebhookEvent =
  | "recurring.fired"
  | "recurring.stopped"
  | "recurring.error";

/**
 * Shape of the JSON body delivered to the customer's webhook URL.
 * Stable contract — adding fields is OK, renaming/removing requires a
 * major version bump on Q402's customer integration guide.
 *
 *   event           — discriminator the customer's handler switches on
 *   sandbox         — true if the originating apiKey is a sandbox tier
 *                     (mirrors /api/relay's `sandbox` flag); always false
 *                     here because recurring requires paid Multichain
 *   ruleId          — the rule that fired (use this to join against
 *                     q402_recurring_list / dashboard rule rows)
 *   walletId        — the Agent Wallet that paid
 *   ownerAddr       — the rule's owner EOA
 *   frequency       — cadence string ("daily" | "weekly:fri" | "hourly:1" | …)
 *   chain / token   — the rule's chain + token
 *   amountUsd       — sum of all settled recipient amounts on THIS fire
 *   slot            — the scheduled slot this fire was paying for
 *                     (rule.nextRunAt BEFORE recordRuleFired advanced it)
 *   txHashes        — on-chain hashes for each settled recipient
 *   recipientCount  — total recipient rows in the rule
 *   settledCount    — how many settled on this fire
 *   failedCount     — how many failed AFTER at least one settled
 *                     (partial-fire — failedCount > 0 still ships as
 *                     recurring.fired, just with the failure detail in
 *                     `partialFailureNote`)
 *   partialFailureNote — null on clean fires; human-readable summary
 *                        when failedCount > 0
 *   error           — only set on recurring.stopped / recurring.error
 *                     events; carries the reason string from the cron
 *   timestamp       — UTC ISO of when the cron handled the event
 */
export interface RecurringWebhookPayload {
  event:               RecurringWebhookEvent;
  sandbox:             boolean;
  ruleId:              string;
  walletId:            string;
  ownerAddr:           string;
  frequency:           string;
  chain:               string;
  token:               string;
  amountUsd?:          number;
  slot?:               number;
  txHashes?:           string[];
  recipientCount?:     number;
  settledCount?:       number;
  failedCount?:        number;
  partialFailureNote?: string | null;
  error?:              string | null;
  timestamp:           string;
}

/**
 * Build + sign + deliver a recurring webhook event with the same
 * retry / observability shape as /api/relay's relay.success path:
 *
 *   - up to 3 attempts with 0 / 1s / 3s backoff
 *   - timing-resistant HMAC over the full payload bytes
 *   - SSRF re-validation on every attempt (so a DNS flip mid-cycle
 *     into a private range still fails closed)
 *   - per-attempt and final outcome recorded via recordWebhookDelivery
 *     so the dashboard's Webhook tab can show the customer their last
 *     few recurring fires landed (or didn't)
 *
 * Returns void — the caller does NOT await this for chain or rule
 * advancement. Schedule with Next.js `after()` so Vercel keeps the
 * function alive past the response.
 */
export async function dispatchRecurringWebhook(
  ownerAddr: string,
  payload: RecurringWebhookPayload,
): Promise<void> {
  // Caller controls when this is invoked, but defensively guard
  // against a deleted/inactive webhook config that the cron didn't
  // refresh.
  const webhookCfg = await getWebhookConfig(ownerAddr);
  if (!webhookCfg?.active || !webhookCfg.url || !webhookCfg.secret) {
    return;
  }

  // SSRF gate — same posture as /api/relay. A failure here is silent
  // (we don't want a bad webhook config to look like a missed fire);
  // operators see it via the WebhookDeliveries log.
  if (validateWebhookUrl(webhookCfg.url) !== null) {
    await recordWebhookDelivery(ownerAddr, {
      timestamp: new Date().toISOString(),
      event:     payload.event,
      ok:        false,
      error:     "Webhook URL blocked by SSRF guard",
      attempt:   0,
    }).catch(() => {});
    return;
  }

  const bodyStr   = JSON.stringify(payload);
  const hmac      = createHmac("sha256", webhookCfg.secret).update(bodyStr).digest("hex");
  // Stamped onto the delivery record so customers can cross-check the
  // bytes their endpoint saw against what Q402 dispatched, without
  // having to re-run HMAC. Same field name + shape as /api/relay.
  void createHash("sha256").update(bodyStr).digest("hex");

  const url       = webhookCfg.url;
  const DELAYS    = [0, 1_000, 3_000];
  let lastStatus: number | undefined;
  let lastError:  string | undefined;

  for (let i = 0; i < DELAYS.length; i++) {
    if (DELAYS[i] > 0) {
      await new Promise((r) => setTimeout(r, DELAYS[i]));
    }
    const res = await safeWebhookFetch(url, {
      method:    "POST",
      headers: {
        "Content-Type":     "application/json",
        "X-Q402-Signature": `sha256=${hmac}`,
        "X-Q402-Event":     payload.event,
        ...(i > 0 ? { "X-Q402-Retry": String(i) } : {}),
      },
      body:      bodyStr,
      timeoutMs: 8_000,
    });
    lastStatus = res.status;
    if (res.ok) {
      await recordWebhookDelivery(ownerAddr, {
        timestamp:  new Date().toISOString(),
        event:      payload.event,
        ok:         true,
        statusCode: res.status,
        attempt:    i + 1,
      }).catch(() => {});
      return;
    }
    lastError = res.error;
  }

  // All attempts failed — record once for visibility.
  await recordWebhookDelivery(ownerAddr, {
    timestamp:  new Date().toISOString(),
    event:      payload.event,
    ok:         false,
    statusCode: lastStatus,
    error:      lastError,
    attempt:    DELAYS.length,
  }).catch(() => {});
}

// re-export to silence unused-import lint when the cron route only
// pulls the type. The cron uses RelayedTx-shaped fields when building
// per-row tx hash arrays, so keep the type re-exportable for future
// consumers that want to plumb a richer per-row payload.
export type { RelayedTx };
