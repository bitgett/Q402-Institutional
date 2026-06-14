/**
 * POST /api/wallet/clear-delegation
 *
 * Sponsored "clear my EIP-7702 delegation" endpoint. The caller (browser
 * MetaMask / OKX, MCP server, CLI script) submits a user-signed
 * EIP-7702 authorization with `address = 0x0`. Q402's relayer EOA
 * broadcasts a type-0x04 transaction carrying that authorization, paying
 * gas from its hot balance.
 *
 * Auth model: the authorization itself is the auth. Only the EOA holding
 * the matching private key can produce a valid signature, and the chain
 * rejects invalid sigs at TX submission time. We add a few cheap server-
 * side guards (shape, chain match, rate limit, pre-flight `eth_getCode`)
 * so abuse can't grind down the relayer's BNB/ETH balance.
 *
 * Idempotency: no special handling. A second clear on the same EOA simply
 * reverts because the authorization nonce is one-shot. Rate limit caps
 * the sponsor's exposure to a few cents per hour per address per chain
 * in the worst case.
 *
 * Sandbox bypass: none — this endpoint is on-chain by definition.
 * Sandbox MCP usage is handled by the MCP tool returning a mock receipt
 * BEFORE calling this endpoint, not by the endpoint itself.
 */

import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/app/lib/ratelimit";
import {
  broadcastClear,
  getDelegationState,
  isClearableQ402Impl,
  recoverAuthorizationAddress,
  CHAIN_IDS,
  Q402_IMPL_PER_CHAIN,
  type SignedAuthorization,
} from "@/app/lib/eip7702";
import type { ChainKey } from "@/app/lib/relayer";

// Wire shape from the client (browser / MCP / CLI). We accept the
// canonical ethers-style authorization triple plus the target address +
// chain key so the server doesn't have to do address-from-signature
// recovery to know which EOA the delegation lives on.
interface RequestBody {
  chain:         ChainKey;
  address:       string;          // target EOA — the wallet being cleared
  authorization: SignedAuthorization;
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function isValidChainKey(s: unknown): s is ChainKey {
  return typeof s === "string" && s in CHAIN_IDS;
}

function isValidAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

function isValidHexSignaturePart(s: unknown, expectedBytes: number): s is string {
  // r and s are 32-byte values — 0x + 64 hex chars
  return typeof s === "string" && new RegExp(`^0x[0-9a-fA-F]{${expectedBytes * 2}}$`).test(s);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Shape validation ────────────────────────────────────────────────────
  // Each check produces a specific error code so callers can branch on the
  // failure mode (e.g. CLI shows a different hint than the MCP tool).
  if (!isValidChainKey(body.chain)) {
    return NextResponse.json(
      { error: "INVALID_CHAIN", supported: Object.keys(CHAIN_IDS) },
      { status: 400 },
    );
  }
  if (!isValidAddress(body.address)) {
    return NextResponse.json({ error: "INVALID_ADDRESS" }, { status: 400 });
  }
  const auth = body.authorization;
  if (!auth || typeof auth !== "object") {
    return NextResponse.json({ error: "MISSING_AUTHORIZATION" }, { status: 400 });
  }
  if (auth.address?.toLowerCase() !== ZERO_ADDR) {
    return NextResponse.json(
      {
        error:  "INVALID_AUTHORIZATION_TARGET",
        reason: "This endpoint only accepts delegation-clearing authorizations (address=0x0).",
      },
      { status: 400 },
    );
  }
  if (auth.chainId !== CHAIN_IDS[body.chain]) {
    return NextResponse.json(
      {
        error:    "CHAIN_ID_MISMATCH",
        expected: CHAIN_IDS[body.chain],
        received: auth.chainId,
      },
      { status: 400 },
    );
  }
  if (typeof auth.nonce !== "number" || auth.nonce < 0) {
    return NextResponse.json({ error: "INVALID_AUTHORIZATION_NONCE" }, { status: 400 });
  }
  if (auth.yParity !== 0 && auth.yParity !== 1) {
    return NextResponse.json({ error: "INVALID_AUTHORIZATION_YPARITY" }, { status: 400 });
  }
  if (!isValidHexSignaturePart(auth.r, 32) || !isValidHexSignaturePart(auth.s, 32)) {
    return NextResponse.json({ error: "INVALID_AUTHORIZATION_SIGNATURE" }, { status: 400 });
  }

  // ── Signature recovery — auth MUST be signed by body.address ──────────
  // Runs BEFORE rate-limit and pre-flight RPC so:
  //   (1) malformed sigs don't burn the victim's hourly clear quota
  //   (2) the sponsor relayer doesn't broadcast type-0x04 TXs carrying
  //       authorizations the chain will silently skip (EIP-7702 ignores
  //       bad auths instead of reverting — sponsor gas is wasted either
  //       way, so we have to verify here).
  let recovered: string;
  try {
    recovered = recoverAuthorizationAddress(auth);
  } catch {
    return NextResponse.json({ error: "INVALID_AUTHORIZATION_SIGNATURE" }, { status: 400 });
  }
  if (recovered.toLowerCase() !== body.address.toLowerCase()) {
    return NextResponse.json(
      {
        error:  "AUTHORIZATION_SIGNER_MISMATCH",
        reason: "Recovered signer does not match the claimed target address. Only the EOA that holds the matching private key can sign a valid authorization.",
      },
      { status: 401 },
    );
  }

  // ── Rate limit: 1 clear per (address, chain) per hour ─────────────────
  // Sig recovery already proved the caller controls the EOA, so the
  // quota is keyed on the legitimate owner. Earlier order (limit before
  // recovery) let a malicious caller burn a victim's quota by submitting
  // garbage sigs targeting the victim's address.
  const rlKey = `${body.address.toLowerCase()}:${body.chain}`;
  // PEEK only (consume=false): reject if the owner already used their 1/hour, but
  // do NOT burn the quota here — a failed / zero-cost attempt (stale nonce, RPC
  // error, wrong impl) must not block an immediate retry. The quota is consumed
  // only after a clear actually lands (below).
  const allowed = await rateLimit(rlKey, "wallet-clear-delegation", 1, 3600, false, false);
  if (!allowed) {
    return NextResponse.json(
      { error: "RATE_LIMITED", retryAfterSec: 3600 },
      { status: 429 },
    );
  }

  // ── Pre-flight: is this EOA actually delegated to OUR impl? ───────────
  // Two checks here. (a) The EOA must have a non-empty 7702 delegation —
  // no point burning sponsor gas on a no-op. (b) That delegation must
  // point at the Q402 impl for the chain, NOT some other 7702-using
  // service's impl. Otherwise our sponsor relayer becomes a free 7702-
  // cleanup utility for any unrelated delegation a caller wants gone.
  const state = await getDelegationState(body.chain, body.address);
  if (!state.delegated) {
    return NextResponse.json(
      {
        error:  "NOT_DELEGATED",
        reason: `EOA ${body.address} on chain ${body.chain} is already a plain EOA (eth_getCode = 0x).`,
      },
      { status: 409 },
    );
  }
  // Accept the CURRENT impl OR any known RETIRED Q402 impl. Clearing is always
  // the EOA owner's own action (sig recovery proved it above), so sponsoring the
  // un-delegation of an older Q402 impl is legitimate — and necessary, since
  // EOAs delegated to a retired impl are exactly the ones that need migrating.
  // (Settlement still requires the CURRENT impl elsewhere; this is clear-only.)
  if (!isClearableQ402Impl(body.chain, state.impl)) {
    return NextResponse.json(
      {
        error:    "NOT_Q402_DELEGATION",
        reason:   `EOA is delegated to ${state.impl}, which is not a Q402 impl (current or known-retired) on ${body.chain}. This endpoint only sponsors cleanup of Q402 delegations.`,
        expected: Q402_IMPL_PER_CHAIN[body.chain],
        actual:   state.impl,
      },
      { status: 409 },
    );
  }

  // ── Broadcast ───────────────────────────────────────────────────────────
  // broadcastClear handles the type-4 envelope + sponsor signing. On
  // chain-level rejection (bad sig, stale nonce, etc.) the underlying
  // ethers tx promise rejects — we surface a generic 502 + log details
  // to stderr so we don't leak internal error shape to abusers.
  try {
    const result  = await broadcastClear(body.chain, body.address, auth);
    const cleared = result.finalCode === "0x";
    const responseBody = {
      ok:          cleared,
      chain:       body.chain,
      address:     body.address,
      txHash:      result.txHash,
      blockNumber: result.blockNumber,
      gasUsed:     result.gasUsed,
      finalCode:   result.finalCode,
      cleared,
      explorerUrl: result.explorerUrl,
    };
    // When the TX confirmed but the on-chain state didn't update (stale
    // authorization nonce is the typical cause — user's nonce moved
    // between our `eth_getTransactionCount` read and broadcast), return
    // 422 Unprocessable Entity rather than 200. Callers branch on status,
    // not on a payload flag they might miss.
    if (!cleared) {
      console.warn(`[wallet/clear-delegation] tx confirmed but delegation NOT cleared`, {
        chain:     body.chain,
        address:   body.address,
        txHash:    result.txHash,
        finalCode: result.finalCode,
      });
      return NextResponse.json(
        {
          ...responseBody,
          error:  "CLEAR_DID_NOT_APPLY",
          reason: "Sponsored TX confirmed but the EOA's code is still non-empty. Most likely the authorization nonce was stale; refresh and retry.",
        },
        { status: 422 },
      );
    }
    // Clear landed — consume the 1/hour quota now (only a successful clear counts).
    await rateLimit(rlKey, "wallet-clear-delegation", 1, 3600);
    return NextResponse.json(responseBody, { status: 200 });
  } catch (e) {
    console.error(`[wallet/clear-delegation] broadcast failed`, {
      chain:   body.chain,
      address: body.address,
      error:   e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      {
        error:  "BROADCAST_FAILED",
        reason: "Sponsored broadcast failed — common causes: stale authorization nonce, insufficient sponsor balance, or RPC failure. Try again in a moment.",
      },
      { status: 502 },
    );
  }
}
