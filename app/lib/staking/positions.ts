/**
 * Read a wallet's Q staking positions from the live QuackAiStake contract
 * (0x8f5aF1…) on BNB. getStakeData(account) returns a flat uint256[] of
 * 8-field records: [stakeTime, amount, stakeType, _bExit, stakeId, unlockTime,
 * aprRaw, reward].
 *
 * VERIFIED CONTRACT SEMANTICS (Sourcify full-match, BSC 56):
 *  - `_bExit` (index 3) is the closed flag: 1 == already exited. On exit the
 *    contract sets _bExit=1 but LEAVES `amount` (index 1) non-zero, so a record
 *    with amount>0 can still be closed. We MUST skip _bExit!=0 records, else
 *    exited principal inflates stakedTotal/withdrawable.
 *  - Unstake is `exit(ith)` where `ith` is the 0-based ARRAY index (this record's
 *    position in getStakeData order, counting exited records too). `exit` requires
 *    ith>0 — index 0 is permanently un-exitable, so `exitable` is false for it.
 *
 * Read-only; drives the positions endpoint (display) + the unstake "max"
 * resolution (route picks the exitable records to exit).
 */
import { ethers } from "ethers";
import { QUACK_STAKE } from "./sign";
import { AGENTIC_CHAINS } from "@/app/lib/agentic-wallet-sign";

const STAKE_ABI = [
  "function getStakeData(address account) view returns (uint256[])",
  "function getNowTIme() view returns (uint256)",
];

/** Mirrors Q402StakingImplementationBNB.SEED_DUST (1e4 wei) — the dust record the
 *  impl plants at index 0 on a wallet's first stake. Internal plumbing, hidden. */
const SEED_DUST_WEI = 10000n;

export interface StakePosition {
  /** 0-based array index — the argument to QuackAiStake.exit(ith). */
  ith: number;
  /** On-chain stakeId (global counter, index 4) — display only, NOT the exit arg. */
  id: number;
  stakeType: number;
  amount: string; // human Q (18 dec)
  aprPct: number;
  stakedAt: number; // unix seconds
  unlockAt: number; // unix seconds
  matured: boolean;
  /** matured && ith>=1 && not exited — can be unstaked now via exit(ith). */
  exitable: boolean;
}

export interface StakePositionsResult {
  /** Active (non-exited) positions only. */
  positions: StakePosition[];
  /** Sum of all active (non-exited) staked principal (human Q). */
  stakedTotal: string;
  /** Sum of EXITABLE (matured, non-exited, ith>=1) principal — the unstake "max". */
  withdrawable: string;
  /** Raw withdrawable in wei. */
  withdrawableRaw: string;
}

/** Read + parse one wallet's Q stake positions. Returns empty on read failure. */
export async function readStakePositions(wallet: string): Promise<StakePositionsResult> {
  const provider = new ethers.JsonRpcProvider(AGENTIC_CHAINS.bnb.rpc, undefined, { batchMaxCount: 1 });
  const c = new ethers.Contract(QUACK_STAKE, STAKE_ABI, provider);

  const now = Number(await c.getNowTIme().catch(() => Math.floor(Date.now() / 1000)));
  const sd: bigint[] = await c.getStakeData(wallet);

  const positions: StakePosition[] = [];
  let stakedRaw = 0n;
  let withdrawableRaw = 0n;
  const F = 8;
  // `ith` MUST be the absolute array index (count exited records too) because
  // exit(ith) indexes the full on-chain array.
  const recordCount = Math.floor(sd.length / F);
  for (let ith = 0; ith < recordCount; ith++) {
    const i = ith * F;
    const exited = sd[i + 3] !== 0n; // _bExit
    const amountRaw = sd[i + 1];
    if (exited || amountRaw <= 0n) continue; // closed or empty slot — not active
    // Hide the index-0 seed dust (un-exitable internal plumbing, ~$0) from the
    // positions list + stakedTotal. A real index-0 stake (amount != SEED_DUST) is
    // still shown (exitable:false) so a pre-seed stranded position stays visible.
    if (ith === 0 && amountRaw === SEED_DUST_WEI) continue;
    const stakedAt = Number(sd[i]);
    const unlockAt = Number(sd[i + 5]);
    const matured = now >= unlockAt;
    const exitable = matured && ith >= 1; // index 0 is un-exitable on-chain
    positions.push({
      ith,
      id: Number(sd[i + 4]),
      stakeType: Number(sd[i + 2]),
      amount: ethers.formatUnits(amountRaw, 18),
      aprPct: Number(sd[i + 6]) / 100,
      stakedAt,
      unlockAt,
      matured,
      exitable,
    });
    stakedRaw += amountRaw;
    if (exitable) withdrawableRaw += amountRaw;
  }

  return {
    positions,
    stakedTotal: ethers.formatUnits(stakedRaw, 18),
    withdrawable: ethers.formatUnits(withdrawableRaw, 18),
    withdrawableRaw: withdrawableRaw.toString(),
  };
}
