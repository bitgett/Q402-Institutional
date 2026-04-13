import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

function escapeMd(text: string): string {
  return text.replace(/[_*`[]/g, "\\$&");
}

interface GrantApplication {
  id: string;
  projectName: string;
  website?: string;
  email: string;
  telegram?: string;
  twitter?: string;
  category: string;
  targetChain: string;
  requestedCredit: string;
  expectedMonthlyTx: string;
  description: string;
  useCase: string;
  submittedAt: string;
}

export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "grant", 3, 600))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await req.json();
  const { projectName, email, category, targetChain, requestedCredit, expectedMonthlyTx, description, useCase } = body;

  if (!projectName || !email || !category || !targetChain || !requestedCredit || !expectedMonthlyTx || !description || !useCase) {
    return NextResponse.json({ error: "Required fields missing" }, { status: 400 });
  }

  const id = `grant_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const application: GrantApplication = {
    id,
    projectName,
    website:            body.website || undefined,
    email,
    telegram:           body.telegram || undefined,
    twitter:            body.twitter || undefined,
    category,
    targetChain,
    requestedCredit,
    expectedMonthlyTx,
    description,
    useCase,
    submittedAt: new Date().toISOString(),
  };

  const existing = (await kv.get<GrantApplication[]>("grant_applications")) ?? [];
  await kv.set("grant_applications", [...existing, application]);

  // Telegram alert
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  if (botToken && chatId) {
    const lines = [
      `🌱 *New Q402 Grant Application*`,
      ``,
      `*Project:* ${escapeMd(application.projectName)}`,
      `*Email:* ${escapeMd(application.email)}`,
      application.telegram ? `*Telegram:* ${escapeMd(application.telegram)}` : null,
      application.twitter  ? `*Twitter:* ${escapeMd(application.twitter)}`   : null,
      application.website  ? `*Website:* ${escapeMd(application.website)}`   : null,
      `*Category:* ${escapeMd(application.category)}`,
      `*Chain:* ${escapeMd(application.targetChain)}`,
      `*Credit Requested:* ${escapeMd(application.requestedCredit)}`,
      `*Monthly TX Est.:* ${escapeMd(application.expectedMonthlyTx)}`,
      `*Use Case:* ${escapeMd(application.useCase)}`,
      `*Description:* ${escapeMd(application.description)}`,
      ``,
      `🔔 cc @kwanyeonglee`,
    ].filter(Boolean).join("\n");

    fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: lines, parse_mode: "Markdown" }),
    }).catch(() => {});
  }

  return NextResponse.json({ success: true, id });
}

export async function GET(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "admin-grant", 5, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  const secret = req.headers.get("x-admin-secret");
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const applications = (await kv.get<GrantApplication[]>("grant_applications")) ?? [];
  return NextResponse.json({ applications });
}
