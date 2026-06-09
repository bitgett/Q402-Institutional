/**
 * Q402 Yield — shared types.
 *
 * "Q402 Yield" lets an Agent Wallet's idle stablecoins earn yield in a
 * lending protocol (Aave first, on BNB Chain; Morpho later on Base/
 * Arbitrum), gasless and within Hooks policy, with a Trust Receipt per
 * supply/withdraw.
 *
 * Phase 0 (this file's read surface) moves NO funds — it only reads
 * available markets + a wallet's current position. Deposit/withdraw
 * (Phase 1) ride the gasless relayer; their plan/execution types live
 * here too so the adapter surface is stable from the start.
 *
 * The adapter abstraction keeps the route/MCP/dashboard layer
 * protocol-agnostic: Aave today, Morpho next, both behind YieldAdapter.
 */

export type YieldProtocol = "aave" | "morpho";

/** A lending market an agent can supply a stablecoin into. */
export interface YieldMarket {
  protocol: YieldProtocol;
  chain: string;               // Q402 chain key, e.g. "bnb"
  asset: "USDC" | "USDT";
  /** Underlying token address (the stablecoin). */
  assetAddress: string;
  /** Aave: the aToken; Morpho: the ERC-4626 vault share token. */
  positionToken: string;
  /** Aave: the Pool; Morpho: the vault. The contract the supply hits. */
  marketAddress: string;
  /** Live supply APY as a fraction (0.021 = 2.1%). */
  supplyApy: number;
  /** Optional human label (Aave market name / Morpho vault+curator). */
  label?: string;
}

/** A wallet's current position in one market. */
export interface YieldPosition {
  protocol: YieldProtocol;
  chain: string;
  asset: "USDC" | "USDT";
  marketAddress: string;
  positionToken: string;
  /** Current redeemable value in human units (principal + accrued). */
  balance: string;
  /** Raw on-chain balance (aToken/share), for accounting. */
  balanceRaw: string;
  /**
   * Principal the wallet supplied, tracked off-chain (KV), in human
   * units. null when we have no record (e.g. position predates tracking).
   * accrued yield ≈ balance − principal.
   */
  principal: string | null;
  /** balance − principal when principal is known, else null. */
  accrued: string | null;
  supplyApy: number;
}

/**
 * A built deposit/withdraw the route hands to the relayer. Phase 1.
 * For Aave (EIP-7702 witness path) the wallet signs `witnessToSign`
 * (EIP-712) and the relayer submits `relayerCall`. For Morpho
 * (Bundler3 + Permit2) the wallet signs a Permit2 message; same shape,
 * different `signKind`.
 */
export interface YieldExecutionPlan {
  protocol: YieldProtocol;
  chain: string;
  action: "supply" | "withdraw";
  asset: "USDC" | "USDT";
  amount: string;              // human units; "max" allowed for withdraw
  marketAddress: string;
  /** What the Agent Wallet must sign (off-chain, gasless). */
  signKind: "eip712-witness" | "permit2";
  signPayload: unknown;        // the typed-data the wallet signs
  /** Opaque handle the relayer uses to submit after signing. */
  relayerCall: unknown;
}

export interface YieldAdapter {
  protocol: YieldProtocol;
  /** Markets this adapter offers on a given chain (read). */
  listMarkets(chain: string): Promise<YieldMarket[]>;
  /** A wallet's positions on a given chain (read). */
  getPositions(chain: string, walletAddress: string): Promise<YieldPosition[]>;
  /** Build a supply/withdraw plan (Phase 1). */
  buildSupply?(chain: string, walletAddress: string, asset: "USDC" | "USDT", amount: string): Promise<YieldExecutionPlan>;
  buildWithdraw?(chain: string, walletAddress: string, asset: "USDC" | "USDT", amount: string): Promise<YieldExecutionPlan>;
}
