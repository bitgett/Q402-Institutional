/**
 * Q402 Hook system — public surface.
 *
 * Routes import from here, not from the individual files, so the
 * internal layout can change without touching call sites.
 */

export type {
  Hook,
  HookContext,
  HookLifecycle,
  HookOutcome,
  HookFailMode,
  HookParams,
  PaymentSource,
  OracleCondition,
  SplitSpec,
  WalletHookConfig,
} from "./types";

export { runHooks, HOOKS, type DispatchResult } from "./registry";

export {
  getWalletHookConfig,
  setWalletHookConfig,
  validateWalletHookConfig,
  assertSplitsSumTo10000,
} from "./config";

export { canonicalHookConfig, canonicalJson } from "./canonical";
