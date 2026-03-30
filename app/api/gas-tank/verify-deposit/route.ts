import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { addGasDeposit, getGasBalance } from "@/app/lib/db";

const RELAYER = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466";

const CHAINS = [
  { key: "bnb",    name: "BNB Chain", token: "BNB",   rpc: "https://bsc-dataseed1.binance.org/",   blockWindow: 200 },
  { key: "eth",    name: "Ethereum",  token: "ETH",   rpc: "https://ethereum.publicnode.com",       blockWindow: 50  },
  { key: "avax",   name: "Avalanche", token: "AVAX",  rpc: "https://api.avax.network/ext/bc/C/rpc", blockWindow: 200 },
  { key: "xlayer", name: "X Layer",   token: "OKB",   rpc: "https://rpc.xlayer.tech",               blockWindow: 200 },
  { key: "stable", name: "Stable",    token: "USDT0", rpc: "https://rpc.stable.xyz",                blockWindow: 500 },
];

async function scanNativeDeposits(
  chain: typeof CHAINS[number],
  fromAddress: string
): Promise<{ txHash: string; amount: number }[]> {
  const provider = new ethers.JsonRpcProvider(chain.rpc);
  const current = await Promise.race([
    provider.getBlockNumber(),
    new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 5000)),
  ]);
  const fromBlock = current - chain.blockWindow;

  const found: { txHash: string; amount: number }[] = [];

  // Scan each block in range — use eth_getLogs workaround:
  // For native transfers, we must scan block transactions directly.
  // To keep it fast, use eth_getBlockByNumber with full tx objects in batches.
  // We'll use a JSON-RPC batch call approach via fetch.
  const rpcUrl = chain.rpc;
  const batchSize = 20;
  const blockNums: number[] = [];
  for (let b = fromBlock; b <= current; b++) blockNums.push(b);

  for (let i = 0; i < blockNums.length; i += batchSize) {
    const batch = blockNums.slice(i, i + batchSize).map((n, j) => ({
      jsonrpc: "2.0",
      id: j,
      method: "eth_getBlockByNumber",
      params: [`0x${n.toString(16)}`, true],
    }));

    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(6000),
      });
      const blocks: { result: { transactions: { from: string; to: string; value: string; hash: string }[] } }[] = await res.json();

      for (const block of blocks) {
        if (!block?.result?.transactions) continue;
        for (const tx of block.result.transactions) {
          if (
            tx.to?.toLowerCase() === RELAYER.toLowerCase() &&
            tx.from?.toLowerCase() === fromAddress.toLowerCase() &&
            tx.value !== "0x0"
          ) {
            const amount = parseFloat(ethers.formatEther(BigInt(tx.value)));
            if (amount > 0) found.push({ txHash: tx.hash, amount });
          }
        }
      }
    } catch {
      // RPC batch failed — skip
    }
  }

  return found;
}

export async function POST(req: NextRequest) {
  const { address } = await req.json();
  if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });

  const results = await Promise.allSettled(
    CHAINS.map(chain => scanNativeDeposits(chain, address).then(txs => ({ chain, txs })))
  );

  let newDeposits = 0;
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { chain, txs } = r.value;
    for (const tx of txs) {
      await addGasDeposit(address, {
        chain: chain.key,
        token: chain.token,
        amount: tx.amount,
        txHash: tx.txHash,
        depositedAt: new Date().toISOString(),
      });
      newDeposits++;
    }
  }

  const balances = await getGasBalance(address);
  return NextResponse.json({ newDeposits, balances });
}
