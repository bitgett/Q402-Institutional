import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";

const CHAINS = [
  { key: "bnb",    token: "BNB",  rpc: "https://bsc-dataseed1.binance.org/",    cgId: "binancecoin" },
  { key: "eth",    token: "ETH",  rpc: "https://ethereum.publicnode.com",        cgId: "ethereum"    },
  { key: "avax",   token: "AVAX", rpc: "https://api.avax.network/ext/bc/C/rpc", cgId: "avalanche-2" },
  { key: "xlayer", token: "ETH",  rpc: "https://rpc.xlayer.tech",                cgId: "ethereum"    },
];

async function getBalance(rpc: string, address: string): Promise<string> {
  const provider = new ethers.JsonRpcProvider(rpc);
  const bal = await Promise.race([
    provider.getBalance(address),
    new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 5000)),
  ]);
  return ethers.formatEther(bal);
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });

  const balances = await Promise.all(
    CHAINS.map(c => getBalance(c.rpc, address).catch(() => "0").then(b => ({ key: c.key, balance: b })))
  );

  return NextResponse.json({
    balances: Object.fromEntries(balances.map(b => [b.key, parseFloat(b.balance)])),
  });
}
