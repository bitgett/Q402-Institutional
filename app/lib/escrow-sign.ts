"use client";

/**
 * Browser-side escrow action signing (release / dispute).
 *
 * The buyer releases and a party disputes by signing an EIP-712 message against
 * the VAULT's domain (verifyingContract = vault). Unlike a lock - which needs an
 * EIP-7702 authorization that injected wallets can't produce (funding stays on
 * the agent/MCP path) - release/dispute are ordinary typed-data signatures that
 * MetaMask / OKX sign via eth_signTypedData_v4. The relayer then broadcasts +
 * sponsors gas; the signature is the sole fund authority.
 *
 * The type sets + domain MUST match the deployed Q402EscrowVault exactly (the
 * same strings the MCP witness and the __tests__/escrow-witness-drift guard
 * pin). Domain/vault/chainId come from GET /api/escrow/info so this never
 * hard-codes an address.
 */

export type EscrowActionKind = "release" | "dispute";

export interface EscrowInfo {
  chainId: number;
  vault: string;
  vaultDomainName: string;
  explorerTx: string;
}

// EIP-712 type sets - identical to Q402EscrowVault RELEASE_TYPEHASH /
// DISPUTE_TYPEHASH (bytes32 escrowId, uint256 nonce, uint256 deadline).
const ACTION_FIELDS = [
  { name: "escrowId", type: "bytes32" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;
const PRIMARY: Record<EscrowActionKind, string> = {
  release: "EscrowRelease",
  dispute: "EscrowDispute",
};

const infoCache = new Map<string, EscrowInfo>();

/** Fetch (and cache) the live escrow config for a chain. Throws if not live. */
export async function getEscrowInfo(chain: string): Promise<EscrowInfo> {
  const hit = infoCache.get(chain);
  if (hit) return hit;
  const res = await fetch(`/api/escrow/info?chain=${encodeURIComponent(chain)}`);
  const data = (await res.json().catch(() => ({}))) as Partial<EscrowInfo> & { error?: string };
  if (!res.ok || typeof data.chainId !== "number" || !data.vault) {
    throw new Error(data.error ?? `Escrow is not live on ${chain}`);
  }
  const info: EscrowInfo = {
    chainId: data.chainId,
    vault: data.vault,
    vaultDomainName: data.vaultDomainName ?? "Q402 Escrow",
    explorerTx: data.explorerTx ?? "",
  };
  infoCache.set(chain, info);
  return info;
}

/** A random 64-bit nonce as a decimal string - unique per (signer, escrowId). */
export function randomEscrowNonce(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let hex = "0x";
  for (const x of b) hex += x.toString(16).padStart(2, "0");
  return BigInt(hex).toString();
}

/**
 * Build the eth_signTypedData_v4 payload for a release/dispute. `onchainEscrowId`
 * is the bytes32 vault id (PublicEscrow.onchainEscrowId), NOT the esc_... record
 * id. The returned object is passed straight to WalletContext.signTypedData.
 */
export function buildEscrowActionTypedData(
  kind: EscrowActionKind,
  info: EscrowInfo,
  onchainEscrowId: string,
  nonce: string,
  deadline: string,
) {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      [PRIMARY[kind]]: ACTION_FIELDS,
    },
    primaryType: PRIMARY[kind],
    domain: {
      name: info.vaultDomainName,
      version: "1",
      chainId: info.chainId,
      verifyingContract: info.vault,
    },
    message: { escrowId: onchainEscrowId, nonce, deadline },
  };
}
