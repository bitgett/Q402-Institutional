import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { getGasBalance, addGasDeposit } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { checkAdminSecret } from "@/app/lib/admin-auth";
import { GASTANK_ADDRESS_LC } from "@/app/lib/wallets";
import { computeWithdrawDeduction } from "@/app/lib/gas-ledger";

const CHAIN_RPC: Record<string, { rpc: string; token: string }> = {
  bnb:    { rpc: "https://bsc-dataseed1.binance.org/",         token: "BNB"  },
  eth:    { rpc: "https://ethereum.publicnode.com",             token: "ETH"  },
  mantle: { rpc: "https://rpc.mantle.xyz",                      token: "MNT"  },
  injective: { rpc: "https://sentry.evm-rpc.injective.network/", token: "INJ" },
  avax:   { rpc: "https://api.avax.network/ext/bc/C/rpc",      token: "AVAX" },
  xlayer: { rpc: "https://rpc.xlayer.tech",                    token: "OKB"  },
  stable: { rpc: "https://rpc.stable.xyz",                     token: "USDT0"},
};

/**
 * POST /api/gas-tank/withdraw — record-only endpoint.
 *
 * INTERNAL / ADMIN ONLY — requires x-admin-secret header.
 *
 * SECURITY MODEL (v1.16+):
 *   User gas deposits live in GASTANK_ADDRESS, a COLD wallet — its private key
 *   is NEVER on the server. This endpoint cannot sign withdrawals.
 *
 *   Manual withdrawal flow:
 *     1. Operator broadcasts a transfer GASTANK → user from a cold device.
 *     2. Operator POSTs { address, chain, txHash } here. We verify the TX
 *        on-chain and deduct the user's KV ledger balance.
 *
 * The KV ledger update is gated on on-chain verification (correct from/to/value),
 * so a malformed admin call cannot drain a user's recorded balance without a
 * matching real transfer.
 *
 * Body: { address: string, chain: string, txHash: string }
 */
export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "admin-withdraw", 5, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  if (!checkAdminSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { address?: string; chain?: string; txHash?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { address, chain, txHash } = body;
  if (!address || !chain || !txHash) {
    return NextResponse.json({ error: "address, chain, and txHash required" }, { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return NextResponse.json({ error: "invalid txHash" }, { status: 400 });
  }

  const chainCfg = CHAIN_RPC[chain];
  if (!chainCfg) {
    return NextResponse.json({ error: `Unsupported chain: ${chain}` }, { status: 400 });
  }

  try {
    const provider = new ethers.JsonRpcProvider(chainCfg.rpc);
    const tx = await provider.getTransaction(txHash);
    if (!tx) {
      return NextResponse.json({ error: "Transaction not found on-chain" }, { status: 404 });
    }
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) {
      return NextResponse.json({ error: "Transaction not confirmed or reverted" }, { status: 400 });
    }
    if (tx.from.toLowerCase() !== GASTANK_ADDRESS_LC) {
      return NextResponse.json({ error: "TX sender is not GASTANK_ADDRESS" }, { status: 400 });
    }
    if (!tx.to || tx.to.toLowerCase() !== address.toLowerCase()) {
      return NextResponse.json({ error: "TX recipient does not match user address" }, { status: 400 });
    }
    if (tx.value <= BigInt(0)) {
      return NextResponse.json({ error: "TX value must be positive" }, { status: 400 });
    }

    const balance = await getGasBalance(address);
    const ledgerAmount = balance[chain] ?? 0;
    if (ledgerAmount <= 0) {
      return NextResponse.json({ error: "User has no recorded balance to deduct" }, { status: 400 });
    }
    // Deduction is capped at ledger balance so KV never goes negative even if
    // the operator over-paid on-chain. Compare is wei-precise (BigInt); the
    // float value is only derived at the end for the legacy ledger shape.
    const { deductionFloat } = computeWithdrawDeduction(tx.value, ledgerAmount);

    const recorded = await addGasDeposit(address, {
      chain,
      token: chainCfg.token,
      amount: -deductionFloat,
      txHash,
      depositedAt: new Date().toISOString(),
    });
    if (!recorded) {
      return NextResponse.json({ error: "txHash already recorded (duplicate)" }, { status: 409 });
    }

    return NextResponse.json({
      success: true,
      txHash,
      deducted: deductionFloat,
      sentOnChain: parseFloat(ethers.formatEther(tx.value)),
      token: chainCfg.token,
    });
  } catch (e) {
    console.error("[withdraw] verification failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Withdrawal recording failed — check server logs" }, { status: 500 });
  }
}
