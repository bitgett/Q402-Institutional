/**
 * x402 (OKX Agent Payments Protocol) layer for the A2MCP service endpoints.
 *
 * OKX requires an A2MCP service to be an x402-gated resource: accessed without a
 * payment, it returns HTTP 402 with the payment requirements ("accepts"); the
 * caller then pays the nominal service fee via x402 v2 `exact` (EIP-3009) and
 * replays the request with a PAYMENT-SIGNATURE header. This module builds the
 * 402 challenge AND settles the fee on-chain.
 *
 * Fee: 0.0001 USDT (USD₮0) on X Layer, OKX's own L2 (chainId 196) where ASP
 * #2831 lives. USD₮0 supports EIP-3009 (verified on-chain: transferWithAuthorization
 * typehash 0x7c7c…, DOMAIN_SEPARATOR name "USD₮0" version "1"), 6 decimals =>
 * 0.0001 = 100 atomic. payTo == the relayer (0xfc77), which also submits the
 * settlement tx and sponsors the (tiny) X Layer gas. Nominal by design: the point
 * is protocol compliance, not revenue.
 */

import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { loadRelayerKey } from "./relayer-key";

export const X402_NETWORK = "eip155:196"; // X Layer (CAIP-2)
export const X402_CHAIN_ID = 196;
export const X402_ASSET = "0x779ded0c9e1022225f8e0630b35a9b54be713736"; // USD₮0 on X Layer
export const X402_DECIMALS = 6;
export const X402_FEE_ATOMIC = "100"; // 0.0001 USDT (6 decimals)
// EIP-712 domain (verified to match the on-chain DOMAIN_SEPARATOR).
export const X402_TOKEN_NAME = "USD₮0"; // "USD₮0"
export const X402_TOKEN_VERSION = "1";
export const X402_PAY_TO = (
  process.env.A2MCP_X402_PAY_TO ?? "0xfc77ff29178b7286a8ba703d7a70895ca74ff466"
).toLowerCase();
export const X402_MAX_TIMEOUT = 300;
const XLAYER_RPC = process.env.XLAYER_RPC_URL ?? "https://rpc.xlayer.tech";

const USDT_EIP3009_ABI = [
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s) external",
];

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

/** True once the caller has attached an x402 payment (either header spelling). */
export function hasX402Payment(req: NextRequest): boolean {
  return !!(req.headers.get("payment-signature") || req.headers.get("x-payment"));
}

/** The x402 v2 "402 Payment Required" challenge for a resource. */
export function x402Challenge(resource: string, description: string): NextResponse {
  const body = {
    x402Version: 1,
    error: "payment required: pay 0.0001 USDT on X Layer via x402, then resend with a PAYMENT-SIGNATURE header",
    accepts: [
      {
        scheme: "exact",
        network: X402_NETWORK,
        maxAmountRequired: X402_FEE_ATOMIC,
        amount: X402_FEE_ATOMIC,
        resource,
        description,
        mimeType: "application/json",
        payTo: X402_PAY_TO,
        maxTimeoutSeconds: X402_MAX_TIMEOUT,
        asset: X402_ASSET,
        decimals: X402_DECIMALS,
        extra: { assetTransferMethod: "eip3009", name: X402_TOKEN_NAME, version: X402_TOKEN_VERSION, decimals: X402_DECIMALS },
      },
    ],
  };
  return NextResponse.json(body, { status: 402 });
}

export type X402SettleResult =
  | { ok: true; txHash: string; payer: string }
  | { ok: false; status: number; error: string };

/**
 * Verify + settle the x402 fee. Flow:
 *   1. Decode the PAYMENT-SIGNATURE header (base64 x402 PaymentPayload).
 *   2. Enforce OUR requirements off-chain: recipient == payTo, value >= fee,
 *      time window valid, correct network/scheme.
 *   3. Verify the EIP-3009 signature off-chain (recover signer == from) BEFORE
 *      touching the chain — an invalid sig costs zero gas (no grief vector).
 *   4. Submit USD₮0.transferWithAuthorization(); the contract re-verifies the sig
 *      and enforces single-use of the nonce (on-chain replay protection).
 * Returns the settlement tx on success, or a status/error to return verbatim.
 */
export async function settleX402Fee(req: NextRequest): Promise<X402SettleResult> {
  const raw = req.headers.get("payment-signature") || req.headers.get("x-payment");
  if (!raw) return { ok: false, status: 402, error: "missing PAYMENT-SIGNATURE header" };

  let pp: Record<string, unknown>;
  try {
    pp = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    try { pp = JSON.parse(raw); } catch { return { ok: false, status: 400, error: "malformed PAYMENT-SIGNATURE" }; }
  }

  const scheme = pp.scheme as string | undefined;
  const network = pp.network as string | undefined;
  const payload = (pp.payload ?? pp) as Record<string, unknown>;
  const auth = payload.authorization as Record<string, unknown> | undefined;
  const sig = payload.signature as string | undefined;

  if (scheme && scheme !== "exact") return { ok: false, status: 400, error: "unsupported x402 scheme" };
  if (network && network !== X402_NETWORK) return { ok: false, status: 400, error: "wrong network (expected X Layer)" };
  if (!auth || typeof sig !== "string") return { ok: false, status: 400, error: "missing authorization or signature" };

  const from = auth.from as string;
  const to = auth.to as string;
  if (!ethers.isAddress(from)) return { ok: false, status: 400, error: "bad payer address" };
  if (typeof to !== "string" || to.toLowerCase() !== X402_PAY_TO) {
    return { ok: false, status: 400, error: "payment recipient does not match payTo" };
  }

  let valueBn: bigint, faBn: bigint, fbBn: bigint;
  try {
    valueBn = BigInt(auth.value as string | number);
    faBn = BigInt((auth.validAfter as string | number) ?? 0);
    fbBn = BigInt(auth.validBefore as string | number);
  } catch {
    return { ok: false, status: 400, error: "bad numeric authorization fields" };
  }
  if (valueBn < BigInt(X402_FEE_ATOMIC)) return { ok: false, status: 402, error: "insufficient payment amount" };

  const nonce = auth.nonce as string;
  if (!ethers.isHexString(nonce, 32)) return { ok: false, status: 400, error: "bad authorization nonce" };

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (fbBn <= now) return { ok: false, status: 402, error: "authorization expired" };
  if (faBn > now) return { ok: false, status: 402, error: "authorization not yet valid" };

  // Off-chain signature verification (blocks gas-grief from bogus signatures).
  const domain = { name: X402_TOKEN_NAME, version: X402_TOKEN_VERSION, chainId: X402_CHAIN_ID, verifyingContract: X402_ASSET };
  const message = { from, to, value: valueBn, validAfter: faBn, validBefore: fbBn, nonce };
  let recovered: string;
  try {
    recovered = ethers.verifyTypedData(domain, EIP3009_TYPES, message, sig);
  } catch {
    return { ok: false, status: 400, error: "unverifiable signature" };
  }
  if (recovered.toLowerCase() !== from.toLowerCase()) {
    return { ok: false, status: 400, error: "signature does not match payer" };
  }

  const key = loadRelayerKey();
  if (!key.ok) return { ok: false, status: 503, error: "settlement wallet unavailable" };

  try {
    const provider = new ethers.JsonRpcProvider(XLAYER_RPC);
    const relayer = new ethers.Wallet(key.privateKey, provider);
    const usdt = new ethers.Contract(X402_ASSET, USDT_EIP3009_ABI, relayer);
    const { v, r, s } = ethers.Signature.from(sig);
    const tx = await usdt.transferWithAuthorization(from, to, valueBn, faBn, fbBn, nonce, v, r, s, { gasLimit: 200000n });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) return { ok: false, status: 502, error: "fee settlement reverted on-chain" };
    return { ok: true, txHash: tx.hash, payer: from };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 502, error: `fee settlement failed: ${msg.slice(0, 140)}` };
  }
}

/** base64 PAYMENT-RESPONSE header value returned once the fee has settled. */
export function x402ResponseHeader(txHash: string, payer: string): string {
  return Buffer.from(
    JSON.stringify({ success: true, network: X402_NETWORK, asset: X402_ASSET, amount: X402_FEE_ATOMIC, payer, txHash }),
  ).toString("base64");
}
