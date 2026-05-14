/**
 * GET /api/keys/email-sandbox
 *
 * Returns the sandbox API key bound to the caller's email session. Used by
 * the dashboard's email-only view ("you signed in with Google / a magic
 * link but haven't paired a wallet yet") to surface the sandbox key in one
 * click — that's the entire reason most trial users sign up.
 *
 * Auth: session cookie only. The email is read from the KV-backed session;
 * no client-supplied email is trusted. If the session has already paired a
 * wallet, the existing /api/keys/provision flow is the right call —
 * surface a 400 directing the caller there so the two paths don't drift.
 */
import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { getSession } from "@/app/lib/session";
import { getSubscription, generateSandboxKey, setSubscription } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

const emailToAddrKey = (email: string) => `email_to_addr:${email.toLowerCase()}`;

export async function GET(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "email-sandbox", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  // Lookup the pseudo-address that the Google / magic-link sign-in created.
  // If for some reason it's missing (KV eviction, manual deletion), recreate
  // it deterministically from the email so subsequent calls land on the same
  // subscription record.
  let pseudoAddr = await kv.get<string>(emailToAddrKey(session.email));
  if (!pseudoAddr) {
    pseudoAddr = `email:${session.email}`;
    await kv.set(emailToAddrKey(session.email), pseudoAddr);
  }

  const existing = await getSubscription(pseudoAddr);
  let sandboxApiKey = existing?.sandboxApiKey ?? null;
  if (!sandboxApiKey) {
    sandboxApiKey = await generateSandboxKey(pseudoAddr, "starter");
    await setSubscription(pseudoAddr, {
      ...(existing ?? {
        paidAt: "",
        apiKey: "",
        plan: "starter",
        txHash: "email",
        amountUSD: 0,
      }),
      sandboxApiKey,
      email: session.email,
    });
  }

  return NextResponse.json({
    email: session.email,
    sandboxApiKey,
    hasWallet: !!session.address,
  });
}
