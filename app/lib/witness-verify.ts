/**
 * Off-chain EIP-712 witness pre-check for the relay path.
 *
 * Recovers the TransferAuthorization signer before the relayer spends gas, so an
 * invalid signature is rejected up front (it would revert on-chain anyway — a
 * sybil gas-drain vector otherwise). The digest is rebuilt from the EXACT struct
 * the route is about to submit + the chain's domain (name from the manifest,
 * version "1", verifyingContract = the owner EOA, matching the deployed impl's
 * _domainSeparator under EIP-7702), so it can only reject what the contract
 * would also reject — a valid payment always passes.
 */
import { verifyTypedData } from "ethers";
import manifest from "@/contracts.manifest.json";

// Matches the witness every chain's impl verifies + what the SDK signs.
const WITNESS_TYPES = {
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

export interface WitnessValue {
  owner: string;
  facilitator: string;
  token: string;
  recipient: string;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
}

/**
 * Fails OPEN only when the domain can't be constructed (unknown chain) — there a
 * bug must never block a payment. Once the domain is known, anything that
 * doesn't recover to `owner` is rejected: a garbage/short signature, a
 * wrong-signer signature, a tampered struct, or a cross-chain replay all revert
 * on-chain too, so rejecting them here is free and correct. Valid signatures
 * recover cleanly (pinned by relay-witness-preverify.test.ts).
 */
export function witnessSignerMatches(
  chain: string,
  chainId: number,
  v: WitnessValue,
  sig: string,
): boolean {
  const dn = (manifest as { chains?: Record<string, { witness?: { domainName?: string } }> })
    .chains?.[chain]?.witness?.domainName;
  if (!dn) return true; // unknown domain → can't construct → don't block
  const domain = { name: dn, version: "1", chainId, verifyingContract: v.owner };
  try {
    const recovered = verifyTypedData(
      domain,
      WITNESS_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
      v,
      sig,
    );
    return recovered.toLowerCase() === v.owner.toLowerCase();
  } catch {
    return false; // malformed / invalid signature — would revert on-chain anyway
  }
}
