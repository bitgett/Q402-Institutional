/**
 * /api/wallet/agentic/hooks — per-wallet Q402 Hook configuration.
 *
 *   GET  — read the wallet's hook config.
 *   PUT  — replace the wallet's hook config (validated).
 *
 * Auth (both verbs):
 *   - Mode C: `apiKey` (q402_live_…). The key holder is the wallet
 *     authority; we resolve owner from the key and verify ownership.
 *   - Owner-sig: an intent-bound EIP-191 signature. For PUT the intent
 *     binds `{ walletId, configHash }` so a man-in-the-middle can't swap
 *     the policy after the owner signs — same posture as the limits
 *     PATCH. For GET the intent binds just `{ walletId }`.
 *
 * The config shape + validation live in app/lib/hooks/config.ts; this
 * route is a thin auth + persistence layer. ComplianceGate is global
 * and has NO per-wallet config, so it never appears here.
 */

import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { requireIntentAuth, requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getApiKeyRecord } from "@/app/lib/db";
import { resolveWallet } from "@/app/lib/agentic-wallet";
import {
  getWalletHookConfig,
  setWalletHookConfig,
  validateWalletHookConfig,
  canonicalHookConfig,
  type WalletHookConfig,
} from "@/app/lib/hooks";

export const runtime = "nodejs";

interface Body {
  walletId?: string;
  apiKey?: string;
  address?: string;
  nonce?: string;
  signature?: string;
  config?: WalletHookConfig;
}

function isLiveKey(k: string): boolean {
  return k.startsWith("q402_live_");
}

/** Resolve owner from a Mode C apiKey, or null if not a Mode C request. */
async function ownerFromApiKey(apiKey: string | undefined): Promise<string | NextResponse | null> {
  if (!apiKey || apiKey.length === 0) return null;
  if (apiKey.startsWith("q402_test_") || apiKey.startsWith("q402_sandbox_") || !isLiveKey(apiKey)) {
    return NextResponse.json(
      { error: "SANDBOX_KEY_REJECTED", message: "Use a live apiKey for hook config." },
      { status: 401 },
    );
  }
  const rec = await getApiKeyRecord(apiKey);
  // Reject inactive AND sandbox-flagged records (defense in depth beyond
  // the prefix check — a sandbox key must never write real payment policy).
  if (!rec || !rec.active || rec.isSandbox) {
    return NextResponse.json({ error: "INVALID_API_KEY" }, { status: 401 });
  }
  return rec.address.toLowerCase();
}

// ── GET ──────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-hooks", 60, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const url = new URL(req.url);
  const walletId = url.searchParams.get("walletId");
  // apiKey comes from the x-api-key HEADER, never the query string — a
  // live apiKey is a long-lived secret and query strings leak into access
  // logs, proxies, and browser history. (PUT carries it in the JSON body,
  // which doesn't have that problem.)
  const apiKey = req.headers.get("x-api-key") ?? undefined;
  if (!walletId) {
    return NextResponse.json({ error: "walletId_required" }, { status: 400 });
  }

  // Auth: Mode C apiKey, OR the dashboard's cached SESSION sig (reading
  // your own policy is low-sensitivity — no secrets — so a session nonce
  // is enough; we don't pop a fresh intent signature just to read).
  let owner: string;
  const fromKey = await ownerFromApiKey(apiKey);
  if (fromKey instanceof NextResponse) return fromKey;
  if (typeof fromKey === "string") {
    owner = fromKey;
  } else {
    const auth = await requireAuth(
      url.searchParams.get("address"),
      url.searchParams.get("nonce"),
      url.searchParams.get("signature"),
    );
    if (typeof auth !== "string") {
      return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
    }
    owner = auth;
  }

  // Ownership check — resolveWallet refuses cross-owner reads.
  const wallet = await resolveWallet(owner, walletId);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }

  // getWalletHookConfig throws on a genuine KV error (vs null for "no
  // config set"). For this read/display path we surface a 503 rather
  // than a misleading empty config — the dashboard can retry.
  let config: WalletHookConfig | null;
  try {
    config = await getWalletHookConfig(wallet.address.toLowerCase());
  } catch (e) {
    console.error("[api/wallet/agentic/hooks GET] config read failed:", e);
    return NextResponse.json({ error: "hooks_read_failed" }, { status: 503 });
  }
  return NextResponse.json({ walletId: wallet.address.toLowerCase(), config: config ?? {} });
}

// ── PUT ──────────────────────────────────────────────────────────────────
export async function PUT(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-hooks", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.walletId || typeof body.walletId !== "string") {
    return NextResponse.json({ error: "walletId_required" }, { status: 400 });
  }
  const config = body.config ?? {};

  // Validate BEFORE auth so a malformed config is rejected the same way
  // regardless of auth mode, and the rebuilt intent hashes a known-good
  // config.
  try {
    validateWalletHookConfig(config);
  } catch (e) {
    return NextResponse.json(
      { error: "INVALID_HOOK_CONFIG", message: e instanceof Error ? e.message : "invalid config" },
      { status: 400 },
    );
  }

  // Auth: Mode C apiKey OR owner-sig intent-bound on { walletId, configHash }.
  let owner: string;
  const fromKey = await ownerFromApiKey(body.apiKey);
  if (fromKey instanceof NextResponse) return fromKey;
  if (typeof fromKey === "string") {
    owner = fromKey;
  } else {
    const configHash = ethers.keccak256(ethers.toUtf8Bytes(canonicalHookConfig(config)));
    const auth = await requireIntentAuth({
      address: body.address ?? null,
      challenge: body.nonce ?? null,
      signature: body.signature ?? null,
      action: "agentic.hooks_config",
      intent: { walletId: body.walletId.toLowerCase(), configHash },
    });
    if (typeof auth !== "string") {
      return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
    }
    owner = auth;
  }

  // Ownership check.
  const wallet = await resolveWallet(owner, body.walletId);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }

  try {
    await setWalletHookConfig(wallet.address.toLowerCase(), config);
  } catch (e) {
    // validateWalletHookConfig already ran; this is a KV write failure.
    console.error("[api/wallet/agentic/hooks PUT] write failed:", e);
    return NextResponse.json({ error: "hooks_write_failed" }, { status: 500 });
  }

  return NextResponse.json({ walletId: wallet.address.toLowerCase(), config });
}
