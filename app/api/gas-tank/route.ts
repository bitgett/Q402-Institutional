import { NextResponse } from "next/server";
import { ethers } from "ethers";

const RELAYER = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466";

const CHAINS = [
  { key: "bnb",  name: "BNB Chain", token: "BNB",  rpc: "https://bsc-dataseed1.binance.org/",         cgId: "binancecoin" },
  { key: "eth",  name: "Ethereum",  token: "ETH",  rpc: "https://ethereum.publicnode.com",             cgId: "ethereum"    },
  { key: "avax", name: "Avalanche", token: "AVAX", rpc: "https://api.avax.network/ext/bc/C/rpc",       cgId: "avalanche-2" },
  { key: "xlayer", name: "X Layer", token: "ETH",  rpc: "https://rpc.xlayer.tech",                    cgId: "ethereum"    },
];

async function getNativeBalance(rpc: string): Promise<string> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), 5000)
  );
  const provider = new ethers.JsonRpcProvider(rpc);
  const balance = await Promise.race([provider.getBalance(RELAYER), timeout]);
  return ethers.formatEther(balance);
}

async function getPrices(ids: string[]): Promise<Record<string, number>> {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`;
    const res = await fetch(url, { next: { revalidate: 60 } }); // cache 60s
    const data = await res.json();
    const out: Record<string, number> = {};
    for (const id of ids) out[id] = data[id]?.usd ?? 0;
    return out;
  } catch {
    return Object.fromEntries(ids.map(id => [id, 0]));
  }
}

export async function GET() {
  const uniqueCgIds = Array.from(new Set(CHAINS.map(c => c.cgId)));

  // Fetch balances + prices in parallel
  const [prices, ...balances] = await Promise.all([
    getPrices(uniqueCgIds),
    ...CHAINS.map(c => getNativeBalance(c.rpc).catch(() => "0")),
  ]);

  const tanks = CHAINS.map((chain, i) => {
    const bal = parseFloat(balances[i] as string);
    const price = (prices as Record<string, number>)[chain.cgId] ?? 0;
    const usd = bal * price;
    return {
      key: chain.key,
      chain: chain.name,
      token: chain.token,
      balance: bal.toFixed(4),
      usd: usd >= 0.01 ? `$${usd.toFixed(2)}` : "$0.00",
      price,
    };
  });

  return NextResponse.json({ tanks });
}
