/**
 * email.ts — outbound transactional email via Resend's HTTP API.
 *
 * No SDK dependency: a single fetch() call against api.resend.com keeps the
 * surface tiny and avoids pinning to a Resend client version. Returns
 * `{ ok: false }` on every failure — callers treat email as best-effort and
 * never block on it.
 *
 * Required env:
 *   RESEND_API_KEY          — server key (re_*)
 *   RESEND_FROM_ADDRESS     — verified sender, e.g. "Q402 <alerts@quackai.ai>"
 *
 * If either is unset we no-op with a structured warn so a missing config in
 * staging doesn't surface as a 500 to the user.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export async function sendEmail(opts: {
  to:      string;
  subject: string;
  html:    string;
  text?:   string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from   = process.env.RESEND_FROM_ADDRESS;
  if (!apiKey || !from) {
    console.warn("[email] RESEND_API_KEY or RESEND_FROM_ADDRESS missing — email skipped");
    return { ok: false, error: "email not configured" };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opts.to)) {
    return { ok: false, error: "invalid recipient address" };
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to:      [opts.to],
        subject: opts.subject,
        html:    opts.html,
        text:    opts.text,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Render the usage-alert email body. Threshold is the percent-remaining
 * tier that triggered the send (20 or 10).
 */
export function renderUsageAlertHtml(opts: {
  address:        string;
  threshold:      number;     // 20 | 10
  remainingTxs:   number;
  totalTxs:       number;
  dashboardUrl:   string;
  paymentUrl:     string;
}): { subject: string; html: string; text: string } {
  const pct = Math.round((opts.remainingTxs / Math.max(1, opts.totalTxs)) * 100);
  const subject =
    opts.threshold === 10
      ? `Q402 — only ${pct}% TX credits left`
      : `Q402 — ${pct}% TX credits remaining`;

  const text = [
    `Q402 usage alert`,
    ``,
    `Wallet:    ${opts.address}`,
    `Remaining: ${opts.remainingTxs.toLocaleString()} of ${opts.totalTxs.toLocaleString()} TX credits (${pct}%)`,
    ``,
    `Top up before relay is suspended:`,
    opts.paymentUrl,
    ``,
    `Dashboard: ${opts.dashboardUrl}`,
  ].join("\n");

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="font-size:18px;margin:0 0 8px;">Q402 usage alert</h2>
  <p style="font-size:14px;color:#555;margin:0 0 16px;">
    Your TX credit balance has dropped below ${opts.threshold}%.
  </p>
  <table style="border-collapse:collapse;font-size:13px;color:#333;margin-bottom:20px;">
    <tr><td style="padding:4px 12px 4px 0;color:#888;">Wallet</td><td style="font-family:monospace;">${opts.address}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#888;">Remaining</td><td><strong>${opts.remainingTxs.toLocaleString()}</strong> of ${opts.totalTxs.toLocaleString()} (${pct}%)</td></tr>
  </table>
  <p style="font-size:14px;margin:0 0 20px;">
    Relay calls will be suspended once your credits reach zero. Top up to keep traffic flowing:
  </p>
  <p>
    <a href="${opts.paymentUrl}" style="background:#F5C518;color:#0d1422;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Top up credits →</a>
  </p>
  <p style="font-size:12px;color:#888;margin-top:24px;">
    Dashboard: <a href="${opts.dashboardUrl}" style="color:#888;">${opts.dashboardUrl}</a><br/>
    To stop receiving these emails, remove your alert email in the dashboard.
  </p>
</div>
`.trim();

  return { subject, html, text };
}

/**
 * Render the email magic-link confirmation message. Used by the
 * /api/auth/email/start route to confirm a user's email address before
 * binding it to a wallet's trial subscription record.
 *
 * The link target is /api/auth/email/callback?token=... — the token is a
 * 32-byte random opaque string with a 15-minute TTL. We render the URL
 * directly (no shortener / tracker) so the recipient can audit it.
 */
export function renderMagicLinkHtml(opts: {
  email: string;
  magicLinkUrl: string;
  ttlMinutes: number;
}): { subject: string; html: string; text: string } {
  const subject = "Q402 — confirm your email";
  const text = [
    `Q402 — confirm your email`,
    ``,
    `Click the link below to confirm ${opts.email} as your Q402 contact.`,
    `The link expires in ${opts.ttlMinutes} minutes and can be used once.`,
    ``,
    opts.magicLinkUrl,
    ``,
    `If you didn't request this email, you can safely ignore it — no account`,
    `was created and no further messages will be sent to this address.`,
  ].join("\n");

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="font-size:18px;margin:0 0 8px;">Confirm your email</h2>
  <p style="font-size:14px;color:#555;margin:0 0 16px;">
    Click the button below to confirm <strong>${opts.email}</strong> as your Q402 contact address.
    The link expires in ${opts.ttlMinutes} minutes and can only be used once.
  </p>
  <p>
    <a href="${opts.magicLinkUrl}" style="background:#F5C518;color:#0d1422;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Confirm email →</a>
  </p>
  <p style="font-size:12px;color:#888;margin-top:24px;">
    If the button doesn't work, copy this URL into your browser:<br/>
    <span style="font-family:monospace;font-size:11px;word-break:break-all;">${opts.magicLinkUrl}</span>
  </p>
  <p style="font-size:12px;color:#888;margin-top:16px;">
    If you didn't request this email, you can safely ignore it — no account was created and no further messages will be sent to this address.
  </p>
</div>
`.trim();

  return { subject, html, text };
}
