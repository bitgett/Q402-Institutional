import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { getGasBalance, addGasDeposit } from "@/app/lib/db";

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

// Admin-only: Withdraw gas balance for an address.
// Requires x-admin-secret header.
export async function POST(req: NextRequest) {
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
