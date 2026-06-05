/**
 * Native-deposit scanner — shared between the user-initiated POST
 * /api/gas-tank/verify-deposit endpoint and the background
 * GET /api/cron/deposit-scan cron sweep.
 *
 * Both surfaces use the SAME chain table + JSON-RPC batch walker, so a
 * fix to one (block-window size, RPC URL, batch chunking) takes effect
 * everywhere. Dedup is still handled at the storage layer via
 * `addGasDeposit` — a deposit credited by the inline verify path won't
 * be double-credited when the cron later sweeps the same block.
 */

import { ethers } from "ethers";
import { GASTANK_ADDRESS_LC } from "./wallets";

/**
 * 10-chain table for native-coin deposits to the Gas Tank.
 *
 * `blockWindow` is sized so each chain covers ~10 minutes of recent
 * history, matching the realistic gap between a user submitting a
 * deposit and either tapping "Verify" (verify-deposit) or the next
 * cron tick (deposit-scan, every 15 min). BSC and Injective values are
 * doubled vs the smaller-chain default because observed block times on
 * those networks are ~0.75s — a 200-block window would only cover
 * ~2.5 minutes there and silently drop legitimate deposits older than
 * a couple of minutes.
 */
export const DEPOSIT_CHAINS = [
  { key: "bnb",    name: "BNB Chain", token: "BNB",   rpc: "https://bsc-dataseed1.binance.org/",       blockWindow: 800, explorer: "https://bscscan.com/tx/" },
  { key: "eth",    name: "Ethereum",  token: "ETH",   rpc: "https://ethereum.publicnode.com",          blockWindow: 50,  explorer: "https://etherscan.io/tx/" },
  { key: "mantle", name: "Mantle",    token: "MNT",   rpc: "https://rpc.mantle.xyz",                   blockWindow: 500, explorer: "https://mantlescan.xyz/tx/" },
  { key: "injective", name: "Injective", token: "INJ", rpc: "https://sentry.evm-rpc.injective.network/", blockWindow: 800, explorer: "https://blockscout.injective.network/tx/" },
  { key: "avax",   name: "Avalanche", token: "AVAX",  rpc: "https://api.avax.network/ext/bc/C/rpc",    blockWindow: 300, explorer: "https://snowtrace.io/tx/" },
  { key: "xlayer", name: "X Layer",   token: "OKB",   rpc: "https://rpc.xlayer.tech",                  blockWindow: 200, explorer: "https://www.oklink.com/xlayer/tx/" },
  { key: "stable", name: "Stable",    token: "USDT0", rpc: "https://rpc.stable.xyz",                   blockWindow: 600, explorer: "https://stablescan.xyz/tx/" },
  { key: "monad",  name: "Monad",     token: "MON",   rpc: "https://rpc.monad.xyz",                    blockWindow: 6000, explorer: "https://monadscan.com/tx/" },
  { key: "scroll", name: "Scroll",    token: "ETH",   rpc: "https://rpc.scroll.io",                    blockWindow: 1200, explorer: "https://scrollscan.com/tx/" },
  // Arbitrum One — block time ~0.25s after Nitro, so 5000 blocks ≈ 21 min,
  // matching the 15-min cron cadence with headroom for late deposits.
  { key: "arbitrum", name: "Arbitrum", token: "ETH",   rpc: "https://arb1.arbitrum.io/rpc",             blockWindow: 5000, explorer: "https://arbiscan.io/tx/" },
] as const;

export type DepositChain = typeof DEPOSIT_CHAINS[number];

/**
 * Walk the most-recent block window on `chain` looking for native-coin
 * transfers `fromAddress → GASTANK_ADDRESS`. Returns the matching tx
 * hashes + decoded amounts AND surfaces partial-failure metadata so
 * callers can distinguish "0 deposits" from "RPC dropped half the
 * range and we genuinely don't know if there were deposits".
 *
 * Result shape:
 *   - `deposits` — successful matches.
 *   - `chunkFailures` — count of batched RPC chunks that errored.
 *   - `chunkTotal` — total chunks attempted. `chunkFailures > 0` means
 *     the sweep was INCOMPLETE — credit what we found, log the rest,
 *     and let the next sweep retry. The overlapping block window
 *     between cron ticks means a flapping RPC eventually catches up.
 *
 * Dedup against the storage layer is the caller's responsibility (via
 * `addGasDeposit`'s SADD txHash set).
 *
 * The walker uses raw JSON-RPC batches (eth_getBlockByNumber with full
 * tx objects) rather than ethers' per-block helper — every public RPC
 * we use accepts batched POSTs, and pulling 50–6000 blocks one at a
 * time would burn the function timeout for free.
 */
export interface ScanResult {
  deposits: { txHash: string; amount: number }[];
  chunkFailures: number;
  chunkTotal: number;
}

export async function scanNativeDeposits(
  chain: DepositChain,
  fromAddress: string,
): Promise<ScanResult> {
  const provider = new ethers.JsonRpcProvider(chain.rpc);
  const current = await Promise.race([
    provider.getBlockNumber(),
    new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 5000)),
  ]);
  const fromBlock = current - chain.blockWindow;

  const found: { txHash: string; amount: number }[] = [];

  const rpcUrl = chain.rpc;
  const batchSize = 20;
  const blockNums: number[] = [];
  for (let b = fromBlock; b <= current; b++) blockNums.push(b);

  let chunkFailures = 0;
  let chunkTotal = 0;
  for (let i = 0; i < blockNums.length; i += batchSize) {
    chunkTotal++;
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
      if (!res.ok) { chunkFailures++; continue; }
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
      // RPC chunk dropped — counted in chunkFailures so the caller
      // knows "0 deposits" here is NOT authoritative. The next sweep
      // covers the same blocks (overlapping window), so a flapping
      // RPC eventually catches everything.
      chunkFailures++;
    }
  }

  return { deposits: found, chunkFailures, chunkTotal };
}

// ─── LINK ERC-20 Transfer scanner (CCIP bridge Gas Tank) ────────────────────

/**
 * CCIP chains where users can deposit LINK to fund the bridge Gas Tank.
 * Scope is strict: only chains where Q402CCIPSender is deployed AND the
 * USDC pool has the other 2 chains in its supported-destinations set.
 *
 * Token addresses canonical (Chainlink mainnet LINK):
 *   eth      0x514910771AF9Ca656af840dff83E8264EcF986CA
 *   avax     0x5947BB275c521040051D82396192181b413227A3  (avax-native LINK, OFT)
 *   arbitrum 0xf97f4df75117a78c1A5a0DBb814Af92458539FB4  (canonical-bridged LINK)
 */
export const LINK_DEPOSIT_CHAINS = [
  { key: "eth",      name: "Ethereum",     rpc: "https://ethereum.publicnode.com",       linkToken: "0x514910771AF9Ca656af840dff83E8264EcF986CA", blockWindow: 50,   explorer: "https://etherscan.io/tx/" },
  { key: "avax",     name: "Avalanche",    rpc: "https://api.avax.network/ext/bc/C/rpc", linkToken: "0x5947BB275c521040051D82396192181b413227A3", blockWindow: 300,  explorer: "https://snowtrace.io/tx/" },
  { key: "arbitrum", name: "Arbitrum One", rpc: "https://arb1.arbitrum.io/rpc",          linkToken: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", blockWindow: 5000, explorer: "https://arbiscan.io/tx/" },
] as const;

export type LinkDepositChain = typeof LINK_DEPOSIT_CHAINS[number];

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface LinkScanMatch {
  /** ERC-20 sender — credited to their Gas Tank LINK slot for this chain. */
  fromAddress: string;
  /** LINK amount as 18-decimal fractional (e.g. 0.05 = 0.05 LINK). */
  amount: number;
  txHash: string;
  blockNumber: number;
}

export interface LinkScanResult {
  matches:       LinkScanMatch[];
  rangeFrom:     number;
  rangeTo:       number;
  rpcCallFailed: boolean;
}

/**
 * Walk the most-recent block window on a CCIP chain looking for LINK
 * ERC-20 Transfer events where `to == facilitator`. Each match is a new
 * deposit to credit to the sender's Gas Tank LINK slot.
 *
 * Filter uses eth_getLogs with the canonical Transfer topic + the LINK
 * token contract + a padded facilitator address in topic[2]. Much cheaper
 * than the block-scan path the native scanner uses — LINK is low-volume
 * compared to native gas, so we can hit a single getLogs call per chain
 * per sweep instead of 50-6000 getBlockByNumber requests.
 *
 * Dedup against the storage layer is the caller's responsibility (via
 * `addLinkDeposit`'s SADD txHash set in db.ts).
 */
export async function scanLinkDeposits(
  chain: LinkDepositChain,
  facilitator: string,
): Promise<LinkScanResult> {
  const provider = new ethers.JsonRpcProvider(chain.rpc);
  let current: number;
  try {
    current = await Promise.race([
      provider.getBlockNumber(),
      new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 5000)),
    ]);
  } catch {
    return { matches: [], rangeFrom: 0, rangeTo: 0, rpcCallFailed: true };
  }
  const fromBlock = Math.max(0, current - chain.blockWindow);
  const toBlock = current;

  // Pad facilitator to 32-byte topic. Lowercase + leading zeros.
  const padded = "0x" + facilitator.toLowerCase().replace(/^0x/, "").padStart(64, "0");

  try {
    const logs = await provider.getLogs({
      address:   chain.linkToken,
      fromBlock,
      toBlock,
      topics:    [ERC20_TRANSFER_TOPIC, null, padded],
    });
    const matches: LinkScanMatch[] = [];
    for (const log of logs) {
      const fromTopic = log.topics[1];
      if (!fromTopic) continue;
      const fromAddress = "0x" + fromTopic.slice(26); // last 20 bytes
      const valueRaw = BigInt(log.data);             // amount in 18-decimal
      const amount = Number(valueRaw) / 1e18;
      matches.push({
        fromAddress,
        amount,
        txHash:      log.transactionHash,
        blockNumber: log.blockNumber,
      });
    }
    return { matches, rangeFrom: fromBlock, rangeTo: toBlock, rpcCallFailed: false };
  } catch {
    return { matches: [], rangeFrom: fromBlock, rangeTo: toBlock, rpcCallFailed: true };
  }
}

/**
 * Operator alert (Telegram) — new gas-tank deposit credited.
 *
 * Fires only after `addGasDeposit` returns true (i.e. NOT a duplicate).
 * Missing env vars, a Telegram outage, or a malformed payload here must
 * NEVER fail the deposit credit, since KV state is already authoritative
 * at this point. Caller is expected to `await` so the function returns
 * cleanly before Vercel terminates the request, but the inner fetch is
 * try/catch-wrapped to swallow transient Telegram errors.
 */
export async function notifyTelegramDeposit(args: {
  address: string;
  chain: DepositChain;
  amount: number;
  txHash: string;
  /** Tag the source so ops can tell inline-verify vs cron-sweep events apart. */
  source?: "verify" | "cron";
}): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;
  const explorerUrl = `${args.chain.explorer}${args.txHash}`;
  const amount      = args.amount.toFixed(args.amount >= 1 ? 4 : 6);
  const sourceTag   = args.source === "cron" ? "  _(via auto-scan)_" : "";
  const lines = [
    `⛽ *New Gas Tank Deposit*${sourceTag}`,
    ``,
    `*From:* \`${args.address}\``,
    `*Chain:* ${args.chain.name} (${args.chain.token})`,
    `*Amount:* ${amount} ${args.chain.token}`,
    `*TX:* [${args.txHash.slice(0, 10)}…${args.txHash.slice(-6)}](${explorerUrl})`,
  ].join("\n");
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        chat_id: chatId,
        text: lines,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
  } catch { /* non-critical — deposit is already credited */ }
}
