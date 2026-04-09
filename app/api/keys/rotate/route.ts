import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { rotateApiKey } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

const PROVISION_MSG = (addr: string) =>
  `Q402 API Key Request\nAddress: ${addr.toLowerCase()}`;

/**
 * POST /api/keys/rotate
 *
 * Deactivates the current live API key and issues a new one.
 * Requires the same EIP-191 proof-of-ownership signature.
 *
 * Body: { address: string, signature: string }
 */
export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "rotate", 5, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { address?: string; signature?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { address, signature } = body;
  if (!address || !signature) {
    return NextResponse.json({ error: "address and signature required" }, { status: 400 });
  }

  const addr = address.toLowerCase();

  try {
    const recovered = ethers.verifyMessage(PROVISION_MSG(addr), signature);
    if (recovered.toLowerCase() !== addr) throw new Error();
  } catch {
    return NextResponse.json({ error: "Signature does not match address" }, { status: 401 });
  }

  try {
    const newKey = await rotateApiKey(addr);
    return NextResponse.json({ apiKey: newKey });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Rotation failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
