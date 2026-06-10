/**
 * Q402 Yield — YieldPolicy gate (Hooks).
 *
 * The single chokepoint both deposit and withdraw call, so a denial is
 * impossible to bypass. Withdraw is NEVER gated (returning funds to the
 * wallet is always allowed); only deposits ("supply") are guarded.
 *
 * Deposit guardrails come from the wallet owner's stored hook config
 * (getWalletHookConfig → yieldPolicy):
 *   - allowedAssets     — supply only these stablecoins.
 *   - allowedProtocols  — Aave-only build, so a list without "aave" denies.
 *   - maxAllocationPct  — cap the share of the wallet's total stablecoins
 *                         (liquid USDC+USDT + already-supplied position)
 *                         that may sit in yield after this deposit.
 *
 * FAIL CLOSED: balances guard funds, so if we can't read the wallet's
 * liquid balance or current position we DENY (BALANCE_READ_FAILED) rather
 * than wave the deposit through. getWalletHookConfig is allowed to throw
 * on a KV error — we let that propagate (the route surfaces it as 5xx),
 * NOT swallow it into an allow.
 */

import { createPublicClient, http, formatUnits, type Address } from "viem";
import type { AgenticChainKey, AgenticToken } from "@/app/lib/agentic-wallet-sign";
import { getPrimaryRpc, CHAIN_CONFIG, type ChainKey } from "@/app/lib/relayer";
import { getWalletHookConfig } from "@/app/lib/hooks/config";
import { aaveTotalPositionValueStrict } from "./aave";
import type { YieldAction } from "./sign";

export interface YieldPolicyInput {
  owner: string;
  walletId: string;
  chain: AgenticChainKey;
  asset: AgenticToken;
  action: YieldAction;
  amount: string;
}

export interface YieldPolicyResult {
  allow: boolean;
  code?: string;
  reason?: string;
}

const ERC20_BAL_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/**
 * Liquid (un-supplied) stablecoin balance of the wallet on the chain, in
 * human units, summed across USDC + USDT. THROWS on RPC failure so the
 * caller can fail closed — a silent 0 here would let maxAllocationPct
 * (which divides by total holdings) misbehave.
 */
async function readLiquidStableBalance(chain: AgenticChainKey, wallet: Address): Promise<number> {
  const cfg = CHAIN_CONFIG[chain as ChainKey];
  if (!cfg) throw new Error(`no chain config for ${chain}`);
  const client = createPublicClient({ transport: http(getPrimaryRpc(chain)) });

  // On some chains usdc/usdt point at the SAME token (e.g. Stable's
  // USDT0) — dedupe by address so we don't double-count it.
  const tokens = new Map<string, { address: Address; decimals: number }>();
  for (const t of [cfg.usdc, cfg.usdt]) {
    if (t?.address) tokens.set(t.address.toLowerCase(), { address: t.address as Address, decimals: t.decimals });
  }

  let total = 0;
  for (const t of tokens.values()) {
    const raw = (await client.readContract({
      address: t.address,
      abi: ERC20_BAL_ABI,
      functionName: "balanceOf",
      args: [wallet],
    })) as bigint;
    total += Number(formatUnits(raw, t.decimals));
  }
  return total;
}

export async function enforceYieldPolicy(input: YieldPolicyInput): Promise<YieldPolicyResult> {
  // Hard floor: only USDC/USDT yield (defense in depth; routes also validate).
  if (input.asset !== "USDC" && input.asset !== "USDT") {
    return { allow: false, code: "ASSET_NOT_ALLOWED", reason: `Yield not allowed for ${input.asset}.` };
  }

  // Withdraw is always allowed — returning funds to the wallet is never gated.
  if (input.action !== "supply") {
    return { allow: true };
  }

  // Per-wallet deposit guardrails. getWalletHookConfig may THROW on a KV
  // error by design — let it propagate (the route turns it into a 5xx);
  // do NOT swallow it into an allow.
  const cfg = await getWalletHookConfig(input.walletId);
  const yp = cfg?.yieldPolicy;
  if (!yp || !yp.enabled) {
    // No policy configured → only the hard USDC/USDT floor applies.
    return { allow: true };
  }

  // Asset allowlist.
  if (Array.isArray(yp.allowedAssets) && yp.allowedAssets.length > 0
    && !yp.allowedAssets.includes(input.asset)) {
    return { allow: false, code: "ASSET_NOT_ALLOWED", reason: `${input.asset} is not in this wallet's allowed yield assets.` };
  }

  // Protocol allowlist — this build only routes to Aave.
  if (Array.isArray(yp.allowedProtocols) && yp.allowedProtocols.length > 0
    && !yp.allowedProtocols.includes("aave")) {
    return { allow: false, code: "PROTOCOL_NOT_ALLOWED", reason: "Aave is not in this wallet's allowed yield protocols." };
  }

  // Max allocation: (current yield position + this deposit) as a share of
  // total stablecoins (liquid + already supplied) must stay at or under
  // maxAllocationPct. Reading balances guards funds → FAIL CLOSED on error.
  if (typeof yp.maxAllocationPct === "number") {
    const depositAmount = Number(input.amount);
    if (!Number.isFinite(depositAmount) || depositAmount < 0) {
      return { allow: false, code: "BALANCE_READ_FAILED", reason: "Could not interpret the deposit amount." };
    }

    let liquid: number;
    let currentPosition: number;
    try {
      // Both reads THROW on RPC failure → caught below → FAIL CLOSED.
      // (aaveTotalPositionValueStrict, unlike listAllPositions, does not
      // swallow errors into an under-counted 0.)
      const [liquidBal, positionVal] = await Promise.all([
        readLiquidStableBalance(input.chain, input.walletId as Address),
        aaveTotalPositionValueStrict(input.chain, input.walletId),
      ]);
      liquid = liquidBal;
      currentPosition = positionVal;
      if (!Number.isFinite(liquid) || !Number.isFinite(currentPosition)) {
        throw new Error("non-finite balance");
      }
    } catch {
      return {
        allow: false,
        code: "BALANCE_READ_FAILED",
        reason: "Could not read wallet balances to enforce the max-allocation guardrail; deposit blocked.",
      };
    }

    const total = liquid + currentPosition;
    if (total > 0) {
      const projectedPct = ((currentPosition + depositAmount) / total) * 100;
      if (projectedPct > yp.maxAllocationPct) {
        return {
          allow: false,
          code: "MAX_ALLOCATION_EXCEEDED",
          reason: `Deposit would put ${projectedPct.toFixed(1)}% of stablecoins in yield, over the ${yp.maxAllocationPct}% cap.`,
        };
      }
    }
    // total === 0: nothing liquid and no position, yet a positive deposit
    // was requested — the funds can't exist to supply. Let the relayer's
    // own balance check surface the real error rather than guessing here.
  }

  return { allow: true };
}
