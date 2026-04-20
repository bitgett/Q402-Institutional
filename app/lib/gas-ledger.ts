import { ethers } from "ethers";

/**
 * Compute gas-tank withdrawal deduction at wei precision.
 *
 * The on-chain TX value is an exact BigInt wei. The KV ledger balance is
 * currently a float (legacy representation — see README roadmap for the
 * planned string-wei migration). Comparing `sentWei` against a float-derived
 * ledger wei with BigInt ensures the deduction is capped to the ledger's
 * representable precision without float-level rounding errors at the boundary.
 *
 * Invariants:
 *   - Returned `deductionWei` is always in [0, min(sentWei, ledgerWei)].
 *   - `deductionFloat` is `deductionWei` formatted back to an 18-decimal float
 *     to stay compatible with the existing float-shaped ledger.
 *   - If the ledger balance is <= 0, both return values are zero.
 */
export function computeWithdrawDeduction(
  sentWei: bigint,
  ledgerFloat: number,
): { deductionWei: bigint; deductionFloat: number } {
  if (!(ledgerFloat > 0)) return { deductionWei: 0n, deductionFloat: 0 };

  const ledgerWei    = ethers.parseUnits(ledgerFloat.toFixed(18), 18);
  const deductionWei = sentWei < ledgerWei ? sentWei : ledgerWei;
  const deductionFloat = parseFloat(ethers.formatUnits(deductionWei, 18));

  return { deductionWei, deductionFloat };
}
