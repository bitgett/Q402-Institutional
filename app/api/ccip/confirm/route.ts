/**
 * POST /api/ccip/confirm
 *
 * Poll the destination chain for CCIP message arrival. Used by the
 * dashboard to flip a "Bridging..." state to "Delivered ✓".
 *
 * No auth — messageId is itself a unique unguessable identifier. Anyone
 * can poll the status of any CCIP message (Chainlink Explorer is public).
 *
 * Status returned is one of:
 *   "pending"   — CCIP message not yet executed on destination
 *   "delivered" — USDC arrived (CCIP OffRamp ExecutionStateChanged: success)
 *   "failed"    — execution reverted
 *   "unknown"   — messageId not found / RPC error
 *
 * For "delivered" we also return the destination tx hash and block.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { isCCIPChain, CCIP_CONFIG, getCCIPProvider, type CCIPChainKey } from "@/app/lib/ccip";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { ethers } from "ethers";

export const runtime = "nodejs";
export const maxDuration = 15;

interface ConfirmBody {
  messageId?: string;
  dst?:       string;
}

interface BridgeHistoryRecord {
  messageId:   string;
  txHash:      string;
  src:         string;
  dst:         string;
  initiatedAt: number;
}

// CCIP v1.6 OffRamp ExecutionStateChanged event signature.
// Topics: [eventSig, sourceChainSelector, sequenceNumber, messageId]
// Data: messageHash, state (uint8), returnData, gasUsed
const EXECUTION_STATE_CHANGED_TOPIC =
  "0x05665fe9ad095383d018353f4cbcba77e84db27dd215081bbf7cdf9ae6fbe48b";

// state enum (matches CCIP Internal.MessageExecutionState):
//   0 = UNTOUCHED, 1 = IN_PROGRESS, 2 = SUCCESS, 3 = FAILURE
const STATE_SUCCESS = 2;
const STATE_FAILURE = 3;

function messageIdMapKey(messageId: string): string {
  return `ccip_msg:${messageId.toLowerCase()}`;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "ccip-confirm", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: ConfirmBody;
  try {
    body = (await req.json()) as ConfirmBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.messageId || !/^0x[0-9a-fA-F]{64}$/.test(body.messageId)) {
    return NextResponse.json({ error: "messageId must be a 32-byte hex string" }, { status: 400 });
  }

  // Resolve destination chain: from body, or KV cache (history record).
  let dst: CCIPChainKey | null = null;
  if (body.dst && isCCIPChain(body.dst)) {
    dst = body.dst as CCIPChainKey;
  } else {
    const hist = await kv.get<BridgeHistoryRecord>(messageIdMapKey(body.messageId));
    if (hist && isCCIPChain(hist.dst)) dst = hist.dst as CCIPChainKey;
  }
  if (!dst) {
    return NextResponse.json({
      error: "DST_UNKNOWN",
      detail: "messageId not in history; pass dst explicitly",
    }, { status: 400 });
  }

  // Scan recent destination blocks for ExecutionStateChanged with our
  // messageId in topic[3]. Window of ~6h covers worst-case CCIP latency.
  const provider = getCCIPProvider(dst);
  let current: number;
  try {
    current = await provider.getBlockNumber();
  } catch {
    return NextResponse.json({ status: "unknown", detail: "RPC unavailable" }, { status: 200 });
  }

  // Block windows tuned to ~6h per chain block time. Conservative — we
  // overscan rather than miss a recent confirmation.
  const WINDOW: Record<CCIPChainKey, number> = {
    eth:      2000,   // 6h / 12s
    avax:     11000,  // 6h / 2s
    arbitrum: 90000,  // 6h / 0.25s
  };
  // Chunk size per provider. Public Arbitrum RPCs refuse single-call
  // ranges > ~10k blocks; chunking keeps us under their limits and turns
  // a single hard failure into N small-window retries that the surrounding
  // try/catch swallows individually.
  const CHUNK: Record<CCIPChainKey, number> = {
    eth:      2000,
    avax:     5000,
    arbitrum: 5000,
  };
  const fromBlock = Math.max(0, current - WINDOW[dst]);
  const chunkSize = CHUNK[dst];

  const paddedMessageId = body.messageId.toLowerCase();
  const logs: ethers.Log[] = [];
  let chunkFailures = 0;
  // Walk newest → oldest so a recent settlement short-circuits the
  // outstanding chunks. CCIP execution is almost always within the most
  // recent ~30% of the window — scanning backwards halves the average
  // tail latency.
  for (let to = current; to >= fromBlock; to -= chunkSize) {
    const from = Math.max(fromBlock, to - chunkSize + 1);
    try {
      const chunk = await provider.getLogs({
        fromBlock: from,
        toBlock:   to,
        topics:    [EXECUTION_STATE_CHANGED_TOPIC, null, null, paddedMessageId],
      });
      if (chunk.length > 0) {
        logs.push(...chunk);
        // Found the matching log — no need to scan older chunks. (CCIP
        // re-execution would land in a NEWER block, not an older one.)
        break;
      }
    } catch {
      chunkFailures++;
      // Continue to older chunks; partial RPC failure shouldn't kill the
      // whole confirm probe. UI will re-poll on its 12s tick.
    }
  }

  if (logs.length === 0) {
    return NextResponse.json({
      status:    "pending",
      messageId: body.messageId,
      dst,
      ccipExplorer: `https://ccip.chain.link/msg/${body.messageId}`,
      ...(chunkFailures > 0 ? { chunkFailures } : {}),
    });
  }

  // Take the LAST log (most recent retry); CCIP can re-execute on partial
  // failure, but the final state is what matters.
  const log = logs[logs.length - 1];
  if (!log) {
    return NextResponse.json({ status: "pending", messageId: body.messageId, dst });
  }

  // data layout: messageHash (bytes32), state (uint8), returnData (bytes), gasUsed (uint256)
  // We only need state — first 32 bytes is messageHash, next 32 has state in last byte.
  const data = log.data;
  const stateByte = parseInt(data.slice(2 + 64 + 62, 2 + 64 + 64), 16);

  let status: "delivered" | "failed" | "unknown" = "unknown";
  if (stateByte === STATE_SUCCESS) status = "delivered";
  else if (stateByte === STATE_FAILURE) status = "failed";

  return NextResponse.json({
    status,
    messageId:   body.messageId,
    dst,
    dstTxHash:   log.transactionHash,
    dstBlock:    log.blockNumber,
    dstExplorer: `${CCIP_CONFIG[dst].explorer}/tx/${log.transactionHash}`,
    ccipExplorer: `https://ccip.chain.link/msg/${body.messageId}`,
  });
}
