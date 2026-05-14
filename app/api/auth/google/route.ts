/**
 * POST /api/auth/google
 *
 * Exchange a Google ID token for a Q402 email session. The first time a
 * given email signs in, we ensure a "draft" subscription record + a sandbox
 * API key exists — that's what the "API key 받으러 온" trial users actually
 * want. No wallet is required for this path; a live key + trial credits
 * still need a wallet signature later (see /api/trial/activate).
 *
 * Body: { idToken }
 *   - idToken: Google ID token JWT issued to the Hero page's
 *     `accounts.google.com/gsi/client` button. We verify via Google's
 *     tokeninfo endpoint (see lib/google-auth.ts).
 *
 * Returns: { ok, email, sandboxApiKey, hasWallet }
 *   - `hasWallet` is true when a wallet address was previously paired with
 *     this email's draft account — the dashboard uses this to decide
 *     between "Welcome back" and "Connect wallet to start trial" prompts.
 *
 * Also sets the q402_sid HttpOnly cookie via attachSessionCookie().
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getSubscription,
  setSubscription,
  generateSandboxKey,
} from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { verifyGoogleIdToken } from "@/app/lib/google-auth";
import {
  createSession,
  attachSessionCookie,
} from "@/app/lib/session";
import { kv } from "@vercel/kv";

// KV index: email → draft subscription address. Draft accounts use a synthetic
// address (`email:<sha-style hash of email>` style won't work because the rest
// of the system keys by 0x address) — instead we store the email-to-address
// mapping here and create a real `email:` prefixed pseudo-address that the
// subscription record uses until a real wallet binds.
const emailToAddrKey = (email: string) => `email_to_addr:${email.toLowerCase()}`;

/**
 * Look up the draft pseudo-address for an email, creating one if absent.
 * Pseudo-addresses use the prefix "email:" so they never collide with real
 * 0x EVM addresses — the relay route's auth path only accepts real addresses,
 * so a pseudo-address is incapable of signing payments. This is intentional:
 * email-only accounts have an API key but cannot transact until a real
 * wallet is paired via /api/trial/activate.
 */
async function getOrCreatePseudoAddress(email: string, googleSub: string): Promise<string> {
  const existing = await kv.get<string>(emailToAddrKey(email));
  if (existing) return existing;
  // Use Google's stable `sub` as the pseudo-address suffix so two Google
  // logins for the same address always resolve to the same record.
  const pseudo = `email:${googleSub}`;
  await kv.set(emailToAddrKey(email), pseudo);
  return pseudo;
}

export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "auth-google", 20, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { idToken?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.idToken !== "string") {
    return NextResponse.json({ error: "idToken is required" }, { status: 400 });
  }

  const verify = await verifyGoogleIdToken(body.idToken);
  if (!verify.ok) {
    return NextResponse.json({ error: verify.error, code: "GOOGLE_VERIFY_FAILED" }, { status: 401 });
  }
  const { email, sub: googleSub, name, picture } = verify.identity;

  // Ensure the user has a draft subscription + sandbox API key — this is the
  // "API key 받으러 온 사용자" main path. We don't create a live key here
  // (that requires wallet sig); live key + trial credits arrive when the user
  // later calls /api/trial/activate from a connected wallet.
  const pseudoAddr = await getOrCreatePseudoAddress(email, googleSub);
  const existing = await getSubscription(pseudoAddr);
  let sandboxApiKey = existing?.sandboxApiKey ?? null;
  if (!sandboxApiKey) {
    sandboxApiKey = await generateSandboxKey(pseudoAddr, "starter");
  }
  if (!existing) {
    await setSubscription(pseudoAddr, {
      paidAt: "",
      apiKey: "",
      sandboxApiKey,
      plan: "starter",
      txHash: "google",
      amountUSD: 0,
      email,
    });
  } else if (existing.email !== email || !existing.sandboxApiKey) {
    await setSubscription(pseudoAddr, {
      ...existing,
      email,
      sandboxApiKey,
    });
  }

  // Detect whether this account has been paired with a real wallet yet —
  // the existing /api/auth/email/start (or a future wallet-bind endpoint)
  // sets the real 0x address on the same subscription record. For now,
  // a separate wallet-bind index isn't built, so this is always false on
  // the Google-only path.
  const hasWallet =
    !!existing?.apiKey && existing.apiKey.length > 0 && !pseudoAddr.startsWith("email:");

  const sid = await createSession(email, hasWallet ? existing!.apiKey : undefined);
  const resp = NextResponse.json({
    ok: true,
    email,
    name,
    picture,
    sandboxApiKey,
    hasWallet,
  });
  attachSessionCookie(resp, sid);
  return resp;
}
