import { NextRequest, NextResponse } from "next/server";
import { quackUsdPrice } from "@/app/lib/quack-price";

/**
 * GET /api/payment/q-quote?usd=<planPrice>
 *
 * Public, unauthenticated ESTIMATE of the Q amount for a Q-token subscription
 * payment (50% off the plan price). Mirrors the exact math + rounding used by
 * POST /api/payment/intent so the number shown before paying matches the amount
 * the intent later locks. This is display-only — the binding amount is locked
 * server-side at intent time; a Q price move between quote and pay changes only
 * the estimate, never a payment already in flight.
 */

const Q_DISCOUNT_BPS = 5000; // 50% — must mirror the intent route

export async function GET(req: NextRequest) {
  const usd = Number(req.nextUrl.searchParams.get("usd"));
  if (!Number.isFinite(usd) || usd <= 0) {
    return NextResponse.json({ error: "usd must be a positive number" }, { status: 400 });
  }

  let qPriceUsd: number;
  try {
    qPriceUsd = await quackUsdPrice(); // 30-min TWAP, sanity band, fail-closed
  } catch {
    return NextResponse.json({ error: "Q price is temporarily unavailable" }, { status: 503 });
  }

  const discountedUsd = usd * (1 - Q_DISCOUNT_BPS / 10_000);
  const quotedQAmount = Math.ceil((discountedUsd / qPriceUsd) * 1e4) / 1e4; // round UP, 4 dp

  return NextResponse.json(
    { usd, discountBps: Q_DISCOUNT_BPS, discountedUsd, qPriceUsd, quotedQAmount },
    { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } },
  );
}
