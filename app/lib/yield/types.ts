/**
 * Q402 Yield — shared types.
 *
 * "Q402 Yield" lets an Agent Wallet's idle stablecoins earn yield in a
 * lending protocol — Aave V3 on BNB Chain (USDC/USDT) and Morpho on Base
 * (USDC only) — gasless and within Hooks policy, with a Trust Receipt per
 * supply/withdraw.
 *
 * Read surface: this file's market/position types move NO funds. Write
 * surface (deposit/withdraw) settles through the EIP-7702 witness relayer
 * (yield/sign + yield/relay); the live path is signYieldAction, not the
 * optional adapter build* methods below.
 *
 * The adapter abstraction keeps the route/MCP/dashboard layer
 * protocol-agnostic: Aave and Morpho both behind YieldAdapter.
 */

export type YieldProtocol = "aave" | "morpho" | "lista";

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
 * Optional pre-built deposit/withdraw plan type. NOTE: the LIVE write path
 * does NOT use this — it goes through signYieldAction (EIP-712 witness) +
 * settleYieldAction. Both Aave and Morpho use the SAME EIP-7702 witness path
 * (supplyToAave/withdrawFromAave and supplyToErc4626/withdrawFromErc4626);
 * Morpho does NOT use Permit2/Bundler3. Kept as a stable adapter surface.
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
  /**
   * Strict variant of {@link listMarkets}: THROWS on an RPC read failure
   * instead of degrading APY to 0. Lets callers tell "couldn't read the
   * market" from a real 0% APY. A genuinely absent chain still returns [].
   */
  listMarketsStrict(chain: string): Promise<YieldMarket[]>;
  /** A wallet's positions on a given chain (read). */
  getPositions(chain: string, walletAddress: string): Promise<YieldPosition[]>;
  /**
   * Strict variant of {@link getPositions}: THROWS on an RPC read failure
   * instead of skipping the reserve / returning an empty list. Lets
   * callers tell "couldn't read" from a real "no position". A genuinely
   * empty position (0 balance) still reports as [].
   */
  getPositionsStrict(chain: string, walletAddress: string): Promise<YieldPosition[]>;
  /** Build a supply/withdraw plan (Phase 1). */
  buildSupply?(chain: string, walletAddress: string, asset: "USDC" | "USDT", amount: string): Promise<YieldExecutionPlan>;
  buildWithdraw?(chain: string, walletAddress: string, asset: "USDC" | "USDT", amount: string): Promise<YieldExecutionPlan>;
}
