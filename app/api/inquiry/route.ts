import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

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
