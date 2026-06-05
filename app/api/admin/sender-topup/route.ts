/**
 * POST /api/admin/sender-topup
 *
 * Operator-triggered top-up for Q402CCIPSender pools on the CCIP triangle
 * (eth / avax / arbitrum). Used to plug the gap between the unified
 * balance monitor's Telegram alert ("Sender LINK on eth: 0.44 LINK,
 * below 1.0 min") and an actual on-chain refill.
 *
 * Two topup modes:
 *   token = "native"  → relayer signs a plain native transfer to the
 *                       Sender contract. The contract's `bridge()` uses
 *                       `address(this).balance` to gate native fees, so
 *                       no ABI call is needed; raw ETH/AVAX arrives,
 *                       balance goes up, future bridges work.
 *   token = "LINK"    → relayer signs an ERC-20 transfer of LINK to the
 *                       Sender contract. Same shape — Sender uses
 *                       LINK.balanceOf(address(this)) to gate LINK
 *                       fees, so a plain transfer is sufficient. The
 *                       relayer hot wallet MUST hold ≥ amount LINK on
 *                       the chain (no auto-sweep from GASTANK; treat
 *                       as a 2-step ops flow).
 *
 * Auth: X-Q402-Admin-Key header timing-safe-compared against the
 * ADMIN_SECRET env. Same posture as /api/admin/cron-status.
 *
 * Idempotency: none beyond what the chain provides. A double-fire
 * sends LINK / native twice. Operator-only endpoint and the daily
 * blast radius is the relayer's reserve balance, so we accept the
 * trade-off rather than baking in per-request nonces.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { ethers } from "ethers";
import { loadRelayerKey } from "@/app/lib/relayer-key";
import { CHAIN_CONFIG } from "@/app/lib/relayer";
import { CCIP_CONFIG, isCCIPChain, type CCIPChainKey } from "@/app/lib/ccip";

export const runtime = "nodejs";
export const maxDuration = 60;

interface TopupBody {
  chain?:  string;        // "eth" | "avax" | "arbitrum"
  token?:  string;        // "native" | "LINK"
  amount?: string;        // raw 18-dec wei OR human decimal — see parsing below
}

const LINK_TOKEN_PER_CCIP: Record<CCIPChainKey, string> = {
  eth:      "0x514910771AF9Ca656af840dff83E8264EcF986CA",
  avax:     "0x5947BB275c521040051D82396192181b413227A3",
  arbitrum: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
};

const ERC20_TRANSFER_SELECTOR = "0xa9059cbb"; // transfer(address,uint256)

function adminAuth(req: NextRequest): boolean {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) return false;
  const presented = req.headers.get("x-q402-admin-key") ?? "";
  if (presented.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!adminAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: TopupBody;
  try {
    body = (await req.json()) as TopupBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.chain || !isCCIPChain(body.chain)) {
    return NextResponse.json(
      { error: "INVALID_CHAIN", supported: ["eth", "avax", "arbitrum"] },
      { status: 400 },
    );
  }
  const chain = body.chain as CCIPChainKey;
  if (body.token !== "native" && body.token !== "LINK") {
    return NextResponse.json(
      { error: "INVALID_TOKEN", supported: ["native", "LINK"] },
      { status: 400 },
    );
  }
  if (!body.amount || typeof body.amount !== "string") {
    return NextResponse.json({ error: "amount_required" }, { status: 400 });
  }
  // Accept either raw wei (all digits) or human decimal (contains a dot).
  // Both 18-decimal — LINK is 18-dec on every CCIP chain.
  let amountWei: bigint;
  try {
    amountWei = body.amount.includes(".")
      ? ethers.parseUnits(body.amount, 18)
      : BigInt(body.amount);
  } catch {
    return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
  }
  if (amountWei <= 0n) {
    return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
  }

  const cfg = CHAIN_CONFIG[chain];
  const sender = CCIP_CONFIG[chain].sender;
  if (sender === "PENDING_DEPLOY") {
    return NextResponse.json(
      { error: "SENDER_NOT_DEPLOYED", chain },
      { status: 503 },
    );
  }

  const keyResult = loadRelayerKey();
  if (!keyResult.ok) {
    return NextResponse.json(
      { error: "RELAYER_KEY_UNAVAILABLE", reason: keyResult.reason },
      { status: 500 },
    );
  }

  const provider = new ethers.JsonRpcProvider(cfg.rpc);
  const wallet = new ethers.Wallet(keyResult.privateKey, provider);

  try {
    if (body.token === "native") {
      // Pre-check: relayer covers amount + worst-case gas (21k × maxFeePerGas).
      const [balanceWei, feeData] = await Promise.all([
        provider.getBalance(wallet.address),
        provider.getFeeData(),
      ]);
      const maxFee = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
      const gasReserveWei = maxFee * 50_000n;
      if (balanceWei < amountWei + gasReserveWei) {
        return NextResponse.json(
          {
            error:        "RELAYER_INSUFFICIENT_NATIVE",
            chain,
            balanceWei:   balanceWei.toString(),
            requiredWei:  (amountWei + gasReserveWei).toString(),
            shortfallWei: (amountWei + gasReserveWei - balanceWei).toString(),
          },
          { status: 402 },
        );
      }
      const tx = await wallet.sendTransaction({
        to:       sender,
        value:    amountWei,
        gasLimit: 21_000n,
      });
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        return NextResponse.json(
          { error: "NATIVE_TOPUP_REVERTED", txHash: tx.hash },
          { status: 502 },
        );
      }
      return NextResponse.json({
        success:     true,
        chain,
        token:       "native",
        sender,
        amountWei:   amountWei.toString(),
        amountWhole: Number(ethers.formatEther(amountWei)),
        txHash:      tx.hash,
        blockNumber: receipt.blockNumber,
        explorer:    `${CCIP_CONFIG[chain].explorer}/tx/${tx.hash}`,
      });
    }

    // LINK path — plain ERC-20 transfer to the Sender contract.
    // Sender.bridge() uses LINK.balanceOf(address(this)) for its gate,
    // so a raw transfer is sufficient (no need to call topupLink()).
    const linkToken = LINK_TOKEN_PER_CCIP[chain];
    // Pre-check: relayer has the LINK to send.
    const balanceData = "0x70a08231" + wallet.address.replace(/^0x/, "").toLowerCase().padStart(64, "0");
    const linkBalHex  = await provider.call({ to: linkToken, data: balanceData });
    const linkBalWei  = BigInt(linkBalHex);
    if (linkBalWei < amountWei) {
      return NextResponse.json(
        {
          error:        "RELAYER_INSUFFICIENT_LINK",
          chain,
          balanceWei:   linkBalWei.toString(),
          requiredWei:  amountWei.toString(),
          shortfallWei: (amountWei - linkBalWei).toString(),
          hint:         "Send LINK to the relayer EOA first, then retry this topup.",
        },
        { status: 402 },
      );
    }
    // ERC-20 transfer calldata: a9059cbb + recipient (32B) + amount (32B)
    const transferData =
      ERC20_TRANSFER_SELECTOR +
      sender.replace(/^0x/, "").toLowerCase().padStart(64, "0") +
      amountWei.toString(16).padStart(64, "0");
    const tx = await wallet.sendTransaction({
      to:   linkToken,
      data: transferData,
    });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      return NextResponse.json(
        { error: "LINK_TOPUP_REVERTED", txHash: tx.hash },
        { status: 502 },
      );
    }
    return NextResponse.json({
      success:     true,
      chain,
      token:       "LINK",
      sender,
      amountWei:   amountWei.toString(),
      amountWhole: Number(ethers.formatUnits(amountWei, 18)),
      txHash:      tx.hash,
      blockNumber: receipt.blockNumber,
      explorer:    `${CCIP_CONFIG[chain].explorer}/tx/${tx.hash}`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "TOPUP_FAILED", detail: msg.slice(0, 300) },
      { status: 502 },
    );
  }
}
