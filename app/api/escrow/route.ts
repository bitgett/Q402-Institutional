import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/app/lib/auth";
import { getApiKeyRecord } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { ESCROW_ENABLED, getEscrowChain, isEscrowChain } from "@/app/lib/escrow-contracts";
import { createEscrow, listEscrowsPage, toPublicEscrow } from "@/app/lib/escrow";
import { getActiveAgenticWallet } from "@/app/lib/agentic-wallet";

/**
 * /api/escrow - Gasless Escrow collection.
 *
 *   POST  create an escrow record (status `pending`). Auth = apiKey (MCP Mode C)
 *         OR session-sig (dashboard owner). Creating the record MOVES NO FUNDS —
 *         the buyer funds it later by signing an EscrowLock that the relayer
 *         broadcasts into Q402EscrowVault — so the low-friction auth path is fine.
 *   GET   list the authed owner's escrows (session-sig via query params).
 *
 * The buyer (who locks + releases) defaults to the creator's own owner address.
 * The fund-moving actions (lock / release / refund / dispute) live under
 * /api/escrow/[id]/* and require the on-chain vault to be deployed on the chain.
 */

export const runtime = "nodejs";

const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT_RE = /^\d+(\.\d+)?$/;

export async function POST(req: NextRequest) {
  // Escrow create and the fund-moving actions gate on the SAME switch + chain
  // set, so a record can never be created on a chain the action route can't act
  // on (no deployed vault). Off unless ESCROW_ENABLED and the chain has a vault.
  if (!ESCROW_ENABLED) {
    return NextResponse.json({ error: "Escrow is not enabled" }, { status: 503 });
  }
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "escrow-create", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // ── Auth: apiKey (MCP) OR session-sig (dashboard) ──────────────────────
  let creatorOwner: string;
  let sandbox = false;
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : null;
  if (apiKey) {
    const rec = await getApiKeyRecord(apiKey);
    if (!rec || !rec.active) {
      return NextResponse.json({ error: "Invalid or inactive API key" }, { status: 401 });
    }
    creatorOwner = rec.address;
    sandbox = !!rec.isSandbox;
  } else {
    const authed = await requireAuth(
      typeof body.address === "string" ? body.address : null,
      typeof body.nonce === "string" ? body.nonce : null,
      typeof body.signature === "string" ? body.signature : null,
    );
    if (typeof authed !== "string") {
      return NextResponse.json({ error: authed.error, code: authed.code }, { status: authed.status });
    }
    creatorOwner = authed;
  }

  // ── Validate ───────────────────────────────────────────────────────────
  const { chain, token } = body;
  const seller = typeof body.seller === "string" ? body.seller : "";
  // Buyer resolution. Default: the authenticated creator (owner EOA) — they fund
  // + release with their own signature. A client-supplied `body.buyer` is ignored
  // (else an attacker could name a victim as buyer). OPTION: an Agent Wallet the
  // creator OWNS can be the buyer/funder — the server signs the lock/release on
  // its behalf (like agentic send). We resolve `walletId` against the creator's
  // OWN active wallets, so buyer is still always {creator | a wallet the creator
  // provably owns}, never an arbitrary address. `getActiveAgenticWallet` enforces
  // owner-list membership + rejects soft-deleted wallets.
  let buyer = creatorOwner;
  let fundingWalletId: string | undefined;
  const walletId = typeof body.walletId === "string" && body.walletId ? body.walletId : null;
  if (walletId) {
    const wallet = await getActiveAgenticWallet(creatorOwner, walletId);
    if (!wallet) {
      return NextResponse.json({ error: "walletId is not one of your active Agent Wallets" }, { status: 400 });
    }
    buyer = wallet.address.toLowerCase();
    fundingWalletId = wallet.address.toLowerCase();
  }
  const arbiter = typeof body.arbiter === "string" && body.arbiter ? body.arbiter : undefined;
  const amount = typeof body.amount === "string" ? body.amount : "";
  const memo = typeof body.memo === "string" && body.memo.trim().length > 0
    ? body.memo.trim().slice(0, 200)
    : undefined;

  if (!isEscrowChain(chain)) {
    return NextResponse.json({ error: "Escrow is not live on that chain" }, { status: 400 });
  }
  const chainCfg = getEscrowChain(chain)!;
  if (token !== "USDC" && token !== "USDT") {
    return NextResponse.json({ error: "token must be USDC or USDT" }, { status: 400 });
  }
  if (!chainCfg.tokens[token]) {
    return NextResponse.json({ error: `${token} is not allowlisted on ${chain}` }, { status: 400 });
  }
  if (!ETH_ADDR.test(seller)) {
    return NextResponse.json({ error: "Invalid seller address" }, { status: 400 });
  }
  if (!ETH_ADDR.test(buyer)) {
    return NextResponse.json({ error: "Invalid buyer address" }, { status: 400 });
  }
  if (buyer.toLowerCase() === seller.toLowerCase()) {
    return NextResponse.json({ error: "buyer and seller must differ" }, { status: 400 });
  }
  if (arbiter !== undefined && !ETH_ADDR.test(arbiter)) {
    return NextResponse.json({ error: "Invalid arbiter address" }, { status: 400 });
  }
  if (
    arbiter !== undefined &&
    (arbiter.toLowerCase() === buyer.toLowerCase() || arbiter.toLowerCase() === seller.toLowerCase())
  ) {
    return NextResponse.json({ error: "arbiter must be a neutral third party" }, { status: 400 });
  }
  if (!AMOUNT_RE.test(amount) || !(Number(amount) > 0)) {
    return NextResponse.json({ error: "amount must be a positive decimal string" }, { status: 400 });
  }
  // Reject over-precision the chain's token can't represent (parseUnits would
  // throw at lock time, bricking the escrow). Mirrors the request-create guard.
  const maxDecimals = chainCfg.decimals;
  const dot = amount.indexOf(".");
  if (dot !== -1 && amount.length - dot - 1 > maxDecimals) {
    return NextResponse.json(
      { error: `amount has more decimals than ${token} supports on ${chain} (max ${maxDecimals})` },
      { status: 400 },
    );
  }
  if (Number(amount) > 1_000_000) {
    return NextResponse.json({ error: "amount exceeds the maximum of 1,000,000 per escrow" }, { status: 400 });
  }

  const releaseDays =
    typeof body.releaseDays === "number" && body.releaseDays > 0 && body.releaseDays <= 90
      ? body.releaseDays
      : undefined;

  const record = await createEscrow({
    creatorOwner, buyer, fundingWalletId, seller, chain, token, amount, arbiter, memo, releaseDays, sandbox,
  });

  return NextResponse.json(
    {
      escrowId: record.id,
      onchainEscrowId: record.onchainEscrowId,
      escrow: toPublicEscrow(record),
    },
    { status: 201 },
  );
}

export async function GET(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "escrow-list", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const authed = await requireAuth(
    req.nextUrl.searchParams.get("address"),
    req.nextUrl.searchParams.get("nonce"),
    req.nextUrl.searchParams.get("sig"),
  );
  if (typeof authed !== "string") {
    return NextResponse.json({ error: authed.error, code: authed.code }, { status: authed.status });
  }

  const limitParam = Number(req.nextUrl.searchParams.get("limit"));
  const offsetParam = Number(req.nextUrl.searchParams.get("offset"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 50;
  const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? offsetParam : 0;

  const { records, hasMore } = await listEscrowsPage(authed, { limit, offset });
  return NextResponse.json({ escrows: records.map(toPublicEscrow), hasMore });
}
