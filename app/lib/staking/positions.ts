/**
 * Read a wallet's Q staking positions from the live QuackAiStake contract
 * (0x8f5aF1…) on BNB. getStakeData(account) returns a flat uint256[] of
 * 8-field records: [stakeTime, amount, stakeType, flag, id, unlockTime,
 * aprRaw, reward]. We parse those into typed positions + a withdrawable
 * (matured) total. Read-only; used by the positions endpoint (display) and
 * the unstake "max" resolution (route).
 */
import { ethers } from "ethers";
import { QUACK_STAKE } from "./sign";
import { AGENTIC_CHAINS } from "@/app/lib/agentic-wallet-sign";

const STAKE_ABI = [
  "function getStakeData(address account) view returns (uint256[])",
  "function getNowTIme() view returns (uint256)",
];

export interface StakePosition {
  id: number;
  stakeType: number;
  amount: string; // human Q (18 dec)
  aprPct: number;
  stakedAt: number; // unix seconds
  unlockAt: number; // unix seconds
  matured: boolean;
}

export interface StakePositionsResult {
  positions: StakePosition[];
  /** Sum of all active staked principal (human Q). */
  stakedTotal: string;
  /** Sum of matured (unlockable) principal (human Q) — the unstake "max". */
  withdrawable: string;
  /** Raw withdrawable in wei — for exact-amount unstake resolution. */
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
  for (let i = 0; i + F <= sd.length; i += F) {
    const amountRaw = sd[i + 1];
    if (amountRaw <= 0n) continue; // withdrawn / empty slot
    const stakedAt = Number(sd[i]);
    const unlockAt = Number(sd[i + 5]);
    const matured = now >= unlockAt;
    positions.push({
      id: Number(sd[i + 4]),
      stakeType: Number(sd[i + 2]),
      amount: ethers.formatUnits(amountRaw, 18),
      aprPct: Number(sd[i + 6]) / 100,
      stakedAt,
      unlockAt,
      matured,
    });
    stakedRaw += amountRaw;
    if (matured) withdrawableRaw += amountRaw;
  }

  return {
    positions,
    stakedTotal: ethers.formatUnits(stakedRaw, 18),
    withdrawable: ethers.formatUnits(withdrawableRaw, 18),
    withdrawableRaw: withdrawableRaw.toString(),
  };
}
