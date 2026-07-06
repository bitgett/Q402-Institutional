/**
 * x402 (OKX Agent Payments Protocol) layer for the A2MCP service endpoints.
 *
 * OKX requires an A2MCP service to be an x402-gated resource: accessed without a
 * payment, it returns HTTP 402 with the payment requirements ("accepts"); the
 * caller then pays the nominal service fee via x402 v2 `exact` (EIP-3009) and
 * replays the request with a PAYMENT-SIGNATURE header.
 *
 * Fee: 0.0001 USDC on Base (Circle USDC, 6 dp => 100 atomic units). Nominal by
 * design — the point is protocol compliance, not revenue. payTo is a Q402-owned
 * Base address (env-overridable).
 */

import { NextRequest, NextResponse } from "next/server";

// X Layer (OKX's own L2, chainId 196 — where ASP #2831 lives), CAIP-2.
// USDT (USD₮0) is OKX-native and resolves as a known token in their task system.
export const X402_NETWORK = "eip155:196";
export const X402_ASSET = "0x779ded0c9e1022225f8e0630b35a9b54be713736"; // USDT (USD₮0) on X Layer
export const X402_DECIMALS = 6;
export const X402_FEE_ATOMIC = "100"; // 0.0001 USDT (6 decimals)
export const X402_PAY_TO =
  process.env.A2MCP_X402_PAY_TO ?? "0xfc77ff29178b7286a8ba703d7a70895ca74ff466";
export const X402_MAX_TIMEOUT = 300;

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
        extra: { assetTransferMethod: "eip3009", name: "USDT", version: "1", decimals: X402_DECIMALS },
      },
    ],
  };
  return NextResponse.json(body, { status: 402 });
}
