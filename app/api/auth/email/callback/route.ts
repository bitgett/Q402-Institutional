/**
 * GET /api/auth/email/callback?token=...
 *
 * Completes the magic-link flow:
 *   1. Atomically claim the token (SET NX on a consumed marker) — first
 *      concurrent request wins; later attempts on the same link get 410.
 *   2. Read the {address, email} payload that /api/auth/email/start stored.
 *   3. Write the verified email onto the subscription record. If no
 *      subscription exists yet (e.g. user verified email before activating
 *      trial), we create a minimal stub so the email is preserved across
 *      the eventual activation — the trial route's setSubscription spread
 *      will keep it.
 *   4. Redirect to /dashboard?email=verified so the UI can surface a toast.
 *
 * No state-changing side effects beyond writing the email. The link expires
 * after 15 minutes regardless of click — the TTL is enforced by KV, no
 * additional logic needed here.
 */
import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { getSubscription, setSubscription } from "@/app/lib/db";

const TOKEN_TTL_SEC = 15 * 60;
const tokenKvKey = (token: string) => `email_magic:${token}`;
const consumedKey = (token: string) => `email_magic_consumed:${token}`;

function htmlResponse(status: number, message: string): NextResponse {
  // Minimal, framework-free HTML so this endpoint works even if /dashboard
  // is down. Inline style only — no external assets touch the response.
  const body = `<!doctype html>
<meta charset="utf-8" />
<title>Q402 — Email confirmation</title>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#080E1C;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">
  <div style="max-width:480px;padding:32px;border:1px solid rgba(255,255,255,0.08);border-radius:16px;background:rgba(255,255,255,0.02);">
    <h1 style="font-size:18px;margin:0 0 12px;color:#F5C518;">Email confirmation</h1>
    <p style="font-size:14px;color:rgba(255,255,255,0.7);margin:0 0 24px;">${message}</p>
    <a href="/dashboard" style="display:inline-block;background:#F5C518;color:#0d1422;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Go to dashboard →</a>
  </div>
</body>`;
  return new NextResponse(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return htmlResponse(400, "This confirmation link is malformed. Please request a new one from the dashboard.");
  }

  // Step 1 — atomic claim. SET NX returns falsy if the marker already exists,
  // meaning the link has been used (or another concurrent click is mid-flight).
  const claimed = await kv.set(consumedKey(token), "1", { nx: true, ex: TOKEN_TTL_SEC });
  if (!claimed) {
    return htmlResponse(410, "This confirmation link has already been used or has expired. Request a new one from the dashboard.");
  }

  const payload = await kv.get<{ address: string; email: string }>(tokenKvKey(token));
  if (!payload || typeof payload.address !== "string" || typeof payload.email !== "string") {
    return htmlResponse(410, "This confirmation link has expired. Request a new one from the dashboard.");
  }

  // Best-effort token cleanup — the consumed marker is the canonical block.
  kv.del(tokenKvKey(token)).catch(() => {});

  const addr = payload.address.toLowerCase();
  const email = payload.email.toLowerCase();

  const existing = await getSubscription(addr);
  // If no subscription exists, write a stub so the verified email isn't lost
  // before the user activates a trial / paid plan. The stub uses paidAt=now
  // but plan="" and amountUSD=0, so isSubscriptionActive returns false —
  // this stub doesn't grant any product capability, it's just an email store.
  await setSubscription(addr, {
    ...(existing ?? {
      paidAt: new Date().toISOString(),
      apiKey: "",
      plan: "",
      txHash: "",
      amountUSD: 0,
    }),
    email,
  });

  // Redirect to the dashboard with a confirmation flag the UI can read.
  const proto =
    req.headers.get("x-forwarded-proto") ??
    (req.url.startsWith("https") ? "https" : "http");
  const host = req.headers.get("host") ?? "q402.quackai.ai";
  return NextResponse.redirect(`${proto}://${host}/dashboard?email=verified`, 302);
}
