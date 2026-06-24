import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { __test } from "@/app/lib/staking/sign";

// The off-chain witness type tables MUST reconstruct to the EXACT EIP-712 type
// strings the on-chain impl hashes into STAKE_/UNSTAKE_AUTHORIZATION_TYPEHASH.
// A field-order/type edit in sign.ts that diverges from the contract would make
// every settle revert (digest won't recover to the owner) — this guards it.
function typeString(name: string, fields: ReadonlyArray<{ name: string; type: string }>): string {
  return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

const sol = readFileSync(
  resolve(process.cwd(), "contracts/staking/Q402StakingImplementationBNB.sol"),
  "utf8",
);

describe("staking witness typehash drift", () => {
  it("StakeAuthorization off-chain types == the contract typehash string", () => {
    const s = typeString("StakeAuthorization", __test.STAKE_AUTH_TYPES.StakeAuthorization);
    expect(s).toBe(
      "StakeAuthorization(address owner,address facilitator,address stakeContract,address token,uint256 stakeType,uint256 amount,uint256 nonce,uint256 deadline)",
    );
    expect(sol).toContain(`"${s}"`);
  });

  it("UnstakeAuthorization off-chain types == the contract typehash string", () => {
    const s = typeString("UnstakeAuthorization", __test.UNSTAKE_AUTH_TYPES.UnstakeAuthorization);
    // Unstake binds the record index `ith` (QuackAiStake.exit(ith)), not an amount.
    expect(s).toBe(
      "UnstakeAuthorization(address owner,address facilitator,address stakeContract,uint256 ith,uint256 nonce,uint256 deadline)",
    );
    expect(sol).toContain(`"${s}"`);
  });
});
