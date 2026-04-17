import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { addGasDeposit, getGasBalance } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { GASTANK_ADDRESS_LC } from "@/app/lib/wallets";

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
            tx.to?.toLowerCase() === GASTANK_ADDRESS_LC &&
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

/**
 * Direct-lookup path for deposits that fell outside the recent-block scan window.
 *
 * A user who deposits and then clicks "Verify" days later would miss the 50-500
 * block window above. Rather than leaving the money stuck, accept a txHash +
 * chain, fetch the TX directly via `eth_getTransactionByHash`, and credit if
 * (to == GASTANK, from == address, value > 0). Same dedupe via addGasDeposit.
 */
async function verifyByTxHash(
  chain: typeof CHAINS[number],
  fromAddress: string,
  txHash: string
): Promise<{ ok: true; amount: number } | { ok: false; reason: string }> {
  const provider = new ethers.JsonRpcProvider(chain.rpc);
  const tx = await Promise.race([
    provider.getTransaction(txHash),
    new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 8000)),
  ]);
  if (!tx) return { ok: false, reason: "Transaction not found on this chain" };

  // Wait for confirmation — reject pending TX so credits aren't granted on a
  // reorg/replaced TX. (ethers returns null blockNumber for pending.)
  if (tx.blockNumber == null) return { ok: false, reason: "Transaction not yet confirmed" };

  if (tx.to?.toLowerCase() !== GASTANK_ADDRESS_LC) {
    return { ok: false, reason: "Transaction recipient is not the Q402 gas tank" };
  }
  if (tx.from?.toLowerCase() !== fromAddress.toLowerCase()) {
    return { ok: false, reason: "Transaction sender does not match your wallet" };
  }
  if (tx.value === 0n) return { ok: false, reason: "Transaction has zero value" };

  return { ok: true, amount: parseFloat(ethers.formatEther(tx.value)) };
}

export async function POST(req: NextRequest) {
  // ── Security model: no wallet signature required by design ───────────────
  // This endpoint only records on-chain TXs that ALREADY happened from
  // `address` → GASTANK_ADDRESS, and addGasDeposit dedupes via SADD txHash.
  // An attacker calling this for someone else's address just helps that
  // user's balance reflect real deposits — no privilege escalation, no
  // fake-deposit risk. The rate-limit (5 scans/60s/IP, fail-closed) is the
  // abuse control for the ~250 public-RPC calls per scan.
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "verify-deposit", 5, 60, false))) {
    return NextResponse.json({ error: "Too many requests. Please wait before scanning again." }, { status: 429 });
  }

  let body: { address?: string; txHash?: string; chain?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const address = body.address;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "valid Ethereum address required" }, { status: 400 });
  }

  // ── Direct-lookup path: txHash + chain supplied ──────────────────────────
  // Handles late verifications that fall outside the recent-block scan window.
  if (body.txHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
      return NextResponse.json({ error: "valid txHash required (0x + 64 hex chars)" }, { status: 400 });
    }
    const chain = CHAINS.find(c => c.key === body.chain);
    if (!chain) {
      return NextResponse.json({ error: "chain required (bnb|eth|avax|xlayer|stable)" }, { status: 400 });
    }

    const result = await verifyByTxHash(chain, address, body.txHash);
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: 404 });
    }

    const added = await addGasDeposit(address, {
      chain: chain.key,
      token: chain.token,
      amount: result.amount,
      txHash: body.txHash,
      depositedAt: new Date().toISOString(),
    });
    const balances = await getGasBalance(address);
    return NextResponse.json({ newDeposits: added ? 1 : 0, balances, alreadyCredited: !added });
  }

  // ── Default path: recent-block scan across all 5 chains ──────────────────
  const results = await Promise.allSettled(
    CHAINS.map(chain => scanNativeDeposits(chain, address).then(txs => ({ chain, txs })))
  );

  let newDeposits = 0;
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { chain, txs } = r.value;
    for (const tx of txs) {
      const added = await addGasDeposit(address, {
        chain: chain.key,
        token: chain.token,
        amount: tx.amount,
        txHash: tx.txHash,
        depositedAt: new Date().toISOString(),
      });
      if (added) newDeposits++;
    }
  }

  const balances = await getGasBalance(address);
  return NextResponse.json({ newDeposits, balances });
}
