import { Wallet, JsonRpcProvider } from "ethers";
import type { EscrowChainCfg } from "./escrow-contracts";
import type { LockParams, Authorization } from "./escrow-relayer";

/**
 * Server-side escrow signing for an AGENT-WALLET buyer.
 *
 * When the escrow buyer is a server-managed Agent Wallet the owner controls, the
 * SERVER signs the lock/release/dispute with the wallet's decrypted key - the
 * same model agentic send uses (see agentic-wallet-sign.ts). This is the ONLY
 * new place a lock witness is produced (browsers can't sign the 7702 auth a lock
 * needs), so the type sets + domains here are pinned by
 * __tests__/escrow-witness-drift.test.ts against the deployed contracts.
 *
 * CRITICAL (validation G3): every field comes from the ESCROW chain cfg
 * (escrow-contracts.ts), NEVER the payment AGENTIC_CHAINS - the impl addresses,
 * chain set, and decimals diverge. Callers pass an `EscrowChainCfg`.
 *
 * The relayer stays the sole gas sponsor + named facilitator; these signatures
 * are what the wallet's own key would have signed, nothing more.
 */

// MUST match Q402EscrowLockImpl.ESCROW_LOCK_TYPEHASH exactly (drift-guarded).
const ESCROW_LOCK_TYPES = {
  EscrowLock: [
    { name: "buyer", type: "address" }, { name: "seller", type: "address" }, { name: "vault", type: "address" },
    { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "salt", type: "bytes32" },
    { name: "releaseDeadline", type: "uint256" }, { name: "arbiter", type: "address" }, { name: "facilitator", type: "address" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
};
// MUST match Q402EscrowVault RELEASE_TYPEHASH / DISPUTE_TYPEHASH exactly.
const VAULT_ACTION_FIELDS = [
  { name: "escrowId", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
];
const VAULT_ACTION_TYPES = {
  release: { EscrowRelease: VAULT_ACTION_FIELDS },
  dispute: { EscrowDispute: VAULT_ACTION_FIELDS },
} as const;

function signerFor(cfg: EscrowChainCfg, privateKey: string): Wallet {
  const provider = new JsonRpcProvider(cfg.rpc, cfg.chainId);
  return new Wallet(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`, provider);
}

/**
 * Sign an EscrowLock witness + a fresh EIP-7702 authorization (delegating the
 * agent-wallet EOA to the escrow lockImpl) for the server-derived `p`. `p.buyer`
 * MUST be the agent wallet - we assert the decrypted key's address matches it, so
 * a config/record mismatch fails loud instead of signing for the wrong account.
 * The 7702 auth nonce is fetched FRESH from the chain at sign time (ethers
 * `authorize`), per validation G1/G5.
 */
export async function signEscrowLockWithKey(
  cfg: EscrowChainCfg,
  privateKey: string,
  p: LockParams,
): Promise<{ witnessSig: string; authorization: Authorization }> {
  const signer = signerFor(cfg, privateKey);
  if (signer.address.toLowerCase() !== p.buyer.toLowerCase()) {
    throw new Error("escrow lock signer key does not match the buyer wallet");
  }
  const witnessSig = await signer.signTypedData(
    { name: cfg.lockDomainName, version: "1", chainId: cfg.chainId, verifyingContract: p.buyer },
    ESCROW_LOCK_TYPES,
    p,
  );
  // ethers fills the authorization nonce from the account's CURRENT tx count.
  const auth = await signer.authorize({ address: cfg.lockImpl });
  return {
    witnessSig,
    authorization: {
      chainId: Number(auth.chainId),
      address: auth.address,
      nonce: Number(auth.nonce),
      yParity: auth.signature.yParity,
      r: auth.signature.r,
      s: auth.signature.s,
    },
  };
}

/**
 * Sign an EscrowRelease / EscrowDispute vault message (verifyingContract = vault)
 * with the agent wallet key. Release pays the seller; dispute freezes for the
 * arbiter. No funds move beyond what the vault's on-chain checks allow.
 */
export async function signEscrowVaultActionWithKey(
  cfg: EscrowChainCfg,
  privateKey: string,
  kind: "release" | "dispute",
  expectedSigner: string,
  onchainEscrowId: string,
  nonce: string,
  deadline: string,
): Promise<string> {
  const signer = signerFor(cfg, privateKey);
  if (signer.address.toLowerCase() !== expectedSigner.toLowerCase()) {
    throw new Error("escrow action signer key does not match the buyer wallet");
  }
  return signer.signTypedData(
    { name: cfg.vaultDomainName, version: "1", chainId: cfg.chainId, verifyingContract: cfg.vault },
    VAULT_ACTION_TYPES[kind],
    { escrowId: onchainEscrowId, nonce, deadline },
  );
}
