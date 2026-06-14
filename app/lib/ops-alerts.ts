// Server-only ops alerts. Wraps Telegram fan-out (TELEGRAM_BOT_TOKEN +
// TELEGRAM_CHAT_ID) so any code path that wants to wake an operator can
// just import sendOpsAlert(...) without re-implementing the fetch shape.
//
// Mirrors the inline copies that already live in app/api/gas-tank/route.ts
// and friends — those pre-date this helper and stay as-is to keep this
// commit focused; future cleanup can fold them in.
//
// Best-effort: env unset → no-op, fetch failure → swallow. The whole point
// is that an alert dispatch must never throw out of a critical relay path.

import { sendEmail } from "./email";

export type AlertSeverity = "warn" | "error" | "critical";

const SEV_PREFIX: Record<AlertSeverity, string> = {
  warn:     "⚠️",
  error:    "🚨",
  critical: "🆘 CRITICAL",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendOpsAlert(
  message:   string,
  severity:  AlertSeverity = "error",
): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  // Primary sink: Telegram (no-op if unconfigured).
  if (token && chatId) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          chat_id:    chatId,
          text:       `${SEV_PREFIX[severity]} ${message}`,
          parse_mode: "HTML",
        }),
      });
    } catch {
      /* fan-out failure must not propagate — caller is on a hot path */
    }
  }
  // Secondary sink for CRITICAL only — so a dead or misconfigured Telegram path
  // can't silently drop the alerts that matter most (a stuck cron, an uncertain
  // settlement, a compliance-screen outage). Best-effort, gated on
  // OPS_ALERT_EMAIL (no-op if unset). Uses Resend, same infra as usage-alert.
  if (severity === "critical" && process.env.OPS_ALERT_EMAIL) {
    try {
      await sendEmail({
        to:      process.env.OPS_ALERT_EMAIL,
        subject: "[Q402 CRITICAL] ops alert",
        html:    `<pre style="font-family:monospace;white-space:pre-wrap;word-break:break-word">${escapeHtml(message)}</pre>`,
        text:    message,
      });
    } catch {
      /* secondary sink must never throw out of a hot path */
    }
  }
}
