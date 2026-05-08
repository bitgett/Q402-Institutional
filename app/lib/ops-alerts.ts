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

export type AlertSeverity = "warn" | "error" | "critical";

const SEV_PREFIX: Record<AlertSeverity, string> = {
  warn:     "⚠️",
  error:    "🚨",
  critical: "🆘 CRITICAL",
};

export async function sendOpsAlert(
  message:   string,
  severity:  AlertSeverity = "error",
): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
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
