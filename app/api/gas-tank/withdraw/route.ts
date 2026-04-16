import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { getGasBalance, addGasDeposit } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

const CHAIN_RPC: Record<string, { rpc: string; token: string }> = {
  bnb:    { rpc: "https://bsc-dataseed1.binance.org/",         token: "BNB"  },
  eth:    { rpc: "https://ethereum.publicnode.com",             token: "ETH"  },
  avax:   { rpc: "https://api.avax.network/ext/bc/C/rpc",      token: "AVAX" },
  xlayer: { rpc: "https://rpc.xlayer.tech",                    token: "OKB"  },
  stable: { rpc: "https://rpc.stable.xyz",                     token: "USDT0"},
};

function checkAdminSecret(req: NextRequest): boolean {
  const secret = req.headers.get("x-admin-secret");
  const expected = process.env.ADMIN_SECRET;
  return !!expected && secret === expected;
}

/**
 * POST /api/gas-tank/withdraw
 *
 * INTERNAL / ADMIN ONLY — requires x-admin-secret header.
 * This endpoint is NOT accessible to end users.
 *
 * End-user withdrawal requests are handled manually by Q402 operations.
 * Users should contact hello@quackai.ai for refund requests.
 *
 * Body: { address: string, chain: string }
 */
// Requires x-admin-secret header.
export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "admin-withdraw", 5, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  if (!checkAdminSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { address, chain } = await req.json();
  if (!address || !chain) {
    return NextResponse.json({ error: "address and chain required" }, { status: 400 });
  }

  const chainCfg = CHAIN_RPC[chain];
  if (!chainCfg) {
    return NextResponse.json({ error: `Unsupported chain: ${chain}` }, { status: 400 });
  }

  const balance = await getGasBalance(address);
  const amount = balance[chain] ?? 0;
  if (amount < 0.0005) {
    return NextResponse.json({ error: "Balance too low to withdraw" }, { status: 400 });
  }

  const pkRaw = process.env.RELAYER_PRIVATE_KEY;
  if (!pkRaw || pkRaw === "your_private_key_here") {
    return NextResponse.json({ error: "Relayer not configured" }, { status: 500 });
  }

  try {
    const pk = pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`;
    const provider = new ethers.JsonRpcProvider(chainCfg.rpc);
    const wallet = new ethers.Wallet(pk, provider);

    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? BigInt(1_000_000_000);
    const gasLimit = BigInt(21_000);
    const gasCost = gasLimit * gasPrice;

    const totalWei = ethers.parseEther(amount.toFixed(18));
    const sendWei = totalWei - gasCost;

    if (sendWei <= BigInt(0)) {
      return NextResponse.json({ error: "Balance too low to cover gas fee" }, { status: 400 });
    }

    const tx = await wallet.sendTransaction({
      to: address,
      value: sendWei,
      gasLimit,
    });

    // Wait for 1 confirmation before recording the deduction.
    // If the TX is dropped or replaced, this throws — balance stays intact.
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      throw new Error("Transaction reverted on-chain");
    }

    await addGasDeposit(address, {
      chain,
      token: chainCfg.token,
      amount: -amount,
      txHash: tx.hash,
      depositedAt: new Date().toISOString(),
    });

    return NextResponse.json({
      success: true,
      txHash: tx.hash,
      amount: ethers.formatEther(sendWei),
      token: chainCfg.token,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
