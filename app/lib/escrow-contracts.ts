/**
 * Deployed Q402 escrow contracts, per chain. ENV-GATED and testnet-first:
 * escrow is live only where a Q402EscrowVault + Q402EscrowLockImpl pair has been
 * deployed AND its chain key appears here. Everything is off unless
 * ESCROW_ENABLED=1 and the escrow relayer key is set — so this cannot touch the
 * production payment paths.
 *
 * Source of truth for the on-chain addresses is the deploy output
 * (scripts/deploy-smoke-sepolia.ts in q402-avalanche). Sepolia proven live
 * (v6 — post-audit-fix contracts: H-1 refund-from-disputed + resolve-window-close,
 *  M-1 arbiter-neutral, M-2 per-escrow nonce):
 *   lock tx    0xe84914162b41e62a8a930561cb73e4e734bab97c64e68ba8dd0a8a151147f5b8
 *   release tx 0x76d0380a30281f2976e98923ffe9e1ae189d004b16fb6537c6439efd4a50419a
 */

export interface EscrowChainCfg {
  chainId: number;
  rpc: string;
  vault: string;
  lockImpl: string;
  /** EIP-712 domain names of the two contracts (must match the deployed source). */
  vaultDomainName: string;   // "Q402 Escrow"
  lockDomainName: string;    // "Q402 Escrow Lock"
  tokens: Record<string, string>;   // symbol -> address (the vault allowlist)
  decimals: number;          // token decimals on this chain (USDC/USDT share 6)
  explorerTx: string;        // prefix for tx links
}

export const ESCROW_CHAINS: Record<string, EscrowChainCfg> = {
  sepolia: {
    chainId: 11155111,
    rpc: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
    vault: "0xd9C571D2930Cb8BFD1823A95090952d8E2272323",
    lockImpl: "0x999FE0b452212445f6c32a78F1443E62f77d7F71",
    vaultDomainName: "Q402 Escrow",
    lockDomainName: "Q402 Escrow Lock",
    tokens: {
      USDC: "0x4b49A0a7B17E77CddA51F4c0bA533e12246e58e3",
      USDT: "0x7A07e97b509543fed5B3DDc1A20Ec2dDA6F7e2e5",
    },
    decimals: 6,
    explorerTx: "https://sepolia.etherscan.io/tx/",
  },
  // BNB Chain mainnet (chainId 56) — v6-final audited source deployed 2026-07-02.
  // Real Binance-Peg USDC + BSC-USD (both 18 decimals) in the immutable allowlist.
  bnb: {
    chainId: 56,
    rpc: process.env.BNB_RPC_URL || "https://bsc-dataseed1.binance.org/",
    vault: "0x56c2A0B14341bd3FEF3174714EF664D8bb6F1256",
    lockImpl: "0x1da993Ac47bf492A72FA8e5DCBcFb5C0AFDD8a56",
    vaultDomainName: "Q402 Escrow",
    lockDomainName: "Q402 Escrow Lock",
    tokens: {
      USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      USDT: "0x55d398326f99059fF775485246999027B3197955",
    },
    decimals: 18,
    explorerTx: "https://bscscan.com/tx/",
  },
};

/** Master feature flag. Escrow relay is inert unless this is set. */
export const ESCROW_ENABLED = process.env.ESCROW_ENABLED === "1";

export function getEscrowChain(chain: string): EscrowChainCfg | null {
  return ESCROW_CHAINS[chain] ?? null;
}

export function isEscrowChain(chain: unknown): chain is string {
  return typeof chain === "string" && Object.prototype.hasOwnProperty.call(ESCROW_CHAINS, chain);
}
