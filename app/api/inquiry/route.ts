import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

/**
 * Escape Telegram MarkdownV1 special characters in user-supplied strings.
 * Prevents formatting injection via appName, description, etc.
 */
function escapeMd(text: string): string {
  return text.replace(/[_*`[]/g, "\\$&");
}

interface Inquiry {
  id: string;
  appName: string;
  website?: string;
  email: string;
  telegram?: string;
  category: string;
  targetChain: string;
  expectedVolume: string;
  description?: string;
  submittedAt: string;
}

export async function POST(req: NextRequest) {
  // ── Rate limit: 3 inquiries / 10 min per IP ───────────────────────────────
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "inquiry", 3, 600))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await req.json();
  const { appName, email, category, targetChain, expectedVolume } = body;

  if (!appName || !email || !category || !targetChain || !expectedVolume) {
    return NextResponse.json({ error: "Required fields missing" }, { status: 400 });
  }

  const id = `inq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const inquiry: Inquiry = {
    id,
    appName,
    website: body.website || undefined,
    email,
    telegram: body.telegram || undefined,
    category,
    targetChain,
    expectedVolume,
    description: body.description || undefined,
    submittedAt: new Date().toISOString(),
  };

  const existing = (await kv.get<Inquiry[]>("inquiries")) ?? [];
  await kv.set("inquiries", [...existing, inquiry]);

  // Telegram alert
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (botToken && chatId) {
    // Escape all user-supplied strings to prevent Telegram Markdown injection
    const lines = [
      `📩 *New Q402 Inquiry*`,
      ``,
      `*App:* ${escapeMd(inquiry.appName)}`,
      `*Email:* ${escapeMd(inquiry.email)}`,
      inquiry.telegram    ? `*Telegram:* ${escapeMd(inquiry.telegram)}`    : null,
      inquiry.website     ? `*URL:* ${escapeMd(inquiry.website)}`           : null,
      `*Category:* ${escapeMd(inquiry.category)}`,
      `*Chain:* ${escapeMd(inquiry.targetChain)}`,
      `*Volume:* ${escapeMd(inquiry.expectedVolume)}`,
      inquiry.description ? `*Notes:* ${escapeMd(inquiry.description)}`    : null,
    ].filter(Boolean).join("\n");

    fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: lines, parse_mode: "Markdown" }),
    }).catch(() => {}); // fire-and-forget, don't block response
  }

  return NextResponse.json({ success: true, id });
}

// Admin-only: list all inquiries
export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-admin-secret");
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inquiries = (await kv.get<Inquiry[]>("inquiries")) ?? [];
  return NextResponse.json({ inquiries });
}
