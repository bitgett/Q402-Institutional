import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { checkAdminSecret } from "@/app/lib/admin-auth";

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
  const MAX_SHORT = 200;
  const MAX_LONG  = 5000;
  if (
    projectName.length > MAX_SHORT || email.length > MAX_SHORT ||
    category.length > MAX_SHORT || targetChain.length > MAX_SHORT ||
    requestedCredit.length > MAX_SHORT || expectedMonthlyTx.length > MAX_SHORT ||
    description.length > MAX_LONG || useCase.length > MAX_LONG ||
    (body.website && body.website.length > MAX_SHORT) ||
    (body.telegram && body.telegram.length > MAX_SHORT) ||
    (body.twitter && body.twitter.length > MAX_SHORT)
  ) {
    return NextResponse.json({ error: "Field too long" }, { status: 400 });
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

  // Atomic RPUSH avoids the read-modify-write race between concurrent submissions.
  try {
    await kv.rpush("grant_applications", application);
  } catch {
    // Legacy fallback: prior versions stored the applications as a single JSON array.
    const existing = (await kv.get<GrantApplication[]>("grant_applications")) ?? [];
    await kv.set("grant_applications", [...existing, application]);
  }

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
  if (!checkAdminSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Prefer list reads; fall back to legacy JSON array for pre-migration data.
  let applications: GrantApplication[] = [];
  try {
    applications = await kv.lrange<GrantApplication>("grant_applications", 0, -1);
  } catch {
    applications = (await kv.get<GrantApplication[]>("grant_applications")) ?? [];
  }
  if (applications.length === 0) {
    applications = (await kv.get<GrantApplication[]>("grant_applications")) ?? [];
  }
  return NextResponse.json({ applications });
}
