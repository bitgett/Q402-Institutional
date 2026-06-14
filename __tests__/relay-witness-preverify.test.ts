import { describe, it, expect } from "vitest";
import { Wallet, TypedDataEncoder } from "ethers";
import { witnessSignerMatches } from "@/app/lib/witness-verify";
import manifest from "@/contracts.manifest.json";

// The off-chain witness pre-check must accept exactly the signatures the
// deployed impl would accept and reject the rest — reconstructed from the same
// struct + domain (name from manifest, version "1", verifyingContract = owner).
const TYPES = {
  TransferAuthorization: [
    { name: "owner", type: "address" },
    { name: "facilitator", type: "address" },
    { name: "token", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

const KEY = "0x" + "44".repeat(32);

async function signFor(chain: string, chainId: number, owner: string, v: Record<string, unknown>) {
  const dn = (manifest as { chains: Record<string, { witness: { domainName: string } }> }).chains[chain].witness.domainName;
  const domain = { name: dn, version: "1", chainId, verifyingContract: owner };
  return new Wallet(KEY).signTypedData(domain, TYPES, v);
}

describe("witnessSignerMatches — off-chain witness pre-check", () => {
  const owner = new Wallet(KEY).address;
  const base = {
    owner,
    facilitator: "0xfc77ff29178b7286a8ba703d7a70895ca74ff466",
    token: "0x55d398326f99059ff775485246999027b3197955",
    recipient: "0x1111111111111111111111111111111111111111",
    amount: 5_000_000n,
    nonce: 1n,
    deadline: 9_999_999_999n,
  };

  it("accepts a signature over the exact struct + chain domain (bnb)", async () => {
    const sig = await signFor("bnb", 56, owner, { ...base });
    expect(witnessSignerMatches("bnb", 56, base, sig)).toBe(true);
  });

  it("accepts on another chain with that chain's domain (eth)", async () => {
    const sig = await signFor("eth", 1, owner, { ...base });
    expect(witnessSignerMatches("eth", 1, base, sig)).toBe(true);
  });

  it("rejects when the amount is changed after signing (bait-and-switch)", async () => {
    const sig = await signFor("bnb", 56, owner, { ...base });
    expect(witnessSignerMatches("bnb", 56, { ...base, amount: 500_000_000n }, sig)).toBe(false);
  });

  it("rejects when the recipient is changed after signing", async () => {
    const sig = await signFor("bnb", 56, owner, { ...base });
    expect(witnessSignerMatches("bnb", 56, { ...base, recipient: "0x2222222222222222222222222222222222222222" }, sig)).toBe(false);
  });

  it("rejects a signature minted for a DIFFERENT chain's domain (cross-chain replay)", async () => {
    const sigForEth = await signFor("eth", 1, owner, { ...base });
    // Same struct, but presented as a bnb relay → domain name + chainId differ → no match.
    expect(witnessSignerMatches("bnb", 56, base, sigForEth)).toBe(false);
  });

  it("rejects garbage signatures", () => {
    expect(witnessSignerMatches("bnb", 56, base, "0x" + "00".repeat(65))).toBe(false);
  });

  it("fails OPEN for an unknown chain (no manifest domain → never blocks)", async () => {
    const sig = await signFor("bnb", 56, owner, { ...base });
    expect(witnessSignerMatches("does-not-exist", 999, base, sig)).toBe(true);
  });

  it("digest matches the canonical EIP-712 encoding (sanity)", () => {
    const dn = (manifest as { chains: Record<string, { witness: { domainName: string } }> }).chains.bnb.witness.domainName;
    const domain = { name: dn, version: "1", chainId: 56, verifyingContract: owner };
    expect(TypedDataEncoder.hash(domain, TYPES, base)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
