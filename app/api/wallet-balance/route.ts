import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

const CHAINS = [
  { key: "bnb",    token: "BNB",  rpc: "https://bsc-dataseed1.binance.org/",    cgId: "binancecoin" },
  { key: "eth",    token: "ETH",  rpc: "https://ethereum.publicnode.com",        cgId: "ethereum"    },
  { key: "mantle", token: "MNT",  rpc: "https://rpc.mantle.xyz",                 cgId: "mantle"      },
  { key: "avax",   token: "AVAX", rpc: "https://api.avax.network/ext/bc/C/rpc", cgId: "avalanche-2" },
  { key: "xlayer", token: "OKB",  rpc: "https://rpc.xlayer.tech",                cgId: "okb"         },
  { key: "stable", token: "USDT0", rpc: "https://rpc.stable.xyz",               cgId: "tether"      },
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
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "wallet-balance", 20, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const address = req.nextUrl.searchParams.get("address");
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "Valid EVM address required" }, { status: 400 });
  }

  const balances = await Promise.all(
    CHAINS.map(c => getBalance(c.rpc, address).catch(() => "0").then(b => ({ key: c.key, balance: b })))
  );

  return NextResponse.json({
    balances: Object.fromEntries(balances.map(b => [b.key, parseFloat(b.balance)])),
  });
}
