/**
 * Q402 Hook system — types.
 *
 * Q402 Hooks 1.0 turns the payment pipeline into a plug-in surface.
 * Each hook attaches to one of three lifecycle points and either GATES
 * the payment (allow / deny) or TRANSFORMS it (split one intent into N).
 *
 * Lifecycle points (mapped to moments in a settlement):
 *
 *   beforeAuthorize  — before the payment intent is allowed to become a
 *                      signed authorization. The earliest gate. Use for
 *                      checks that should block the SIGNATURE itself,
 *                      independent of balance/limits (e.g. ComplianceGate
 *                      blocking a sanctioned recipient).
 *
 *   beforeSettle     — after all existing gating (per-tx max, daily cap,
 *                      subscription, api key) but BEFORE the on-chain
 *                      settlement fires. Use for gates that depend on the
 *                      recipient or external state (ReputationGate,
 *                      ConditionalOracle) and for transforms that fan one
 *                      intent into many (MultiPayeeSplit).
 *
 *   afterSettle      — after the on-chain settlement confirms. Side
 *                      effects on the receipt (YieldAutoDeposit,
 *                      LoyaltyMint, TrustReceiptNFT). Reserved for a
 *                      later sprint; the dispatcher supports the
 *                      lifecycle today but no afterSettle hooks ship in
 *                      Hooks 1.0 first wave.
 *
 * Design invariants:
 *   - First DENY short-circuits the chain. A denied payment never
 *     reaches settle.
 *   - At most ONE split per settlement. Two hooks both returning a
 *     split is a configuration error (MULTIPLE_SPLITS), not a silent
 *     merge — fan-out semantics would be ambiguous.
 *   - A hook that THROWS is resolved by its failMode: "closed" → deny
 *     (compliance / reputation: never let a payment through on an
 *     errored check), "open" → allow (quality filters that shouldn't
 *     wedge the payment rail on a transient RPC blip).
 */

export type HookLifecycle = "beforeAuthorize" | "beforeSettle" | "afterSettle";

export type PaymentSource = "send" | "batch" | "bridge" | "recurring";

/**
 * Oracle condition for ConditionalOracle (#4). Travels with the payment
 * intent (per-payment, not stored per-wallet) — a payer attaches "only
 * settle when BTC >= 80000" or "only after this timestamp" to the
 * request. Evaluated against Chainlink Data Feeds at settle time.
 */
export interface OracleCondition {
  kind: "price" | "timestamp";
  /** Chainlink feed pair, e.g. "BTC/USD". Required when kind="price". */
  feed?: string;
  /** Comparison operator. */
  op: ">=" | "<=" | ">" | "<" | "after" | "before";
  /** Threshold — USD price (kind="price") or unix seconds (kind="timestamp"). */
  value: number;
}

/**
 * One leg of a MultiPayeeSplit (#3). `bps` is basis points (1/100th of
 * a percent); all legs in a split must sum to exactly 10000.
 */
export interface SplitSpec {
  recipient: string;
  bps: number;
}

/**
 * Per-intent hook parameters carried in the request body. Hooks that
 * need request-supplied config read from here; hooks that read stored
 * per-wallet config (ReputationGate threshold) read from
 * WalletHookConfig instead. A given hook may use either or both.
 */
export interface HookParams {
  /** ReputationGate — which ERC-8004 agent the recipient claims to be. */
  recipientAgentId?: string;
  /** ConditionalOracle — the gate condition for this specific payment. */
  condition?: OracleCondition;
  /** MultiPayeeSplit — per-payment split override (else wallet default). */
  splits?: SplitSpec[];
}

/**
 * The immutable payment intent + environment a hook evaluates against.
 * `recipient`, `owner`, `walletId` are all lowercased on construction
 * so hooks never have to re-normalise.
 */
export interface HookContext {
  lifecycle: HookLifecycle;
  owner: string;
  walletId: string;
  chain: string;
  token: string;
  recipient: string;
  /** Human-readable decimal amount string (NOT raw units). */
  amount: string;
  /** Numeric USD-equivalent for convenience (callers pass Number(amount)). */
  amountUsd: number;
  source: PaymentSource;
  params?: HookParams;
  /** afterSettle only — the confirmed settlement tx hash. */
  txHash?: string;
  /** afterSettle only — CCIP messageId for bridge settlements. */
  messageId?: string;
}

/**
 * A hook's verdict.
 *   allow            — proceed.
 *   deny             — block hard with a stable code + reason + status.
 *   require_approval — soft-block: a human could approve this (e.g. a
 *                      payment above the soft cap). The settlement does
 *                      NOT proceed; the route surfaces an
 *                      "approval_required" response. Distinct from deny
 *                      so the caller knows it's holdable, not forbidden.
 *   split            — replace the single settlement with N legs
 *                      (beforeSettle only).
 *
 * Dispatcher precedence (strongest wins): deny > require_approval >
 * split > allow. So a deny anywhere in the chain overrides an earlier
 * require_approval/split, and an approval hold outranks a split (don't
 * settle the split until approved).
 */
export type HookOutcome =
  | { action: "allow" }
  | {
      action: "deny";
      code: string;
      reason: string;
      /** HTTP status the route should surface. Default 403. */
      status?: number;
      /** Optional structured detail for the response body. */
      meta?: Record<string, unknown>;
    }
  | {
      action: "require_approval";
      code: string;
      reason: string;
      /** HTTP status the route should surface. Default 202. */
      status?: number;
      meta?: Record<string, unknown>;
    }
  | {
      action: "split";
      parts: Array<{ recipient: string; amount: string }>;
    };

/**
 * On-error behaviour. "closed" denies (fail-safe for compliance /
 * reputation), "open" allows (fail-soft for non-blocking quality
 * filters). Chosen per-hook.
 */
export type HookFailMode = "open" | "closed";

export interface Hook {
  name: string;
  lifecycle: HookLifecycle;
  failMode: HookFailMode;
  /**
   * Cheap predicate: should this hook's (potentially expensive) run()
   * even execute for this context? Reads per-wallet config or checks
   * for the presence of the params it needs. Keeping this separate
   * from run() lets the dispatcher skip RPC/KV work for hooks that
   * aren't enabled.
   */
  shouldRun(ctx: HookContext): Promise<boolean> | boolean;
  run(ctx: HookContext): Promise<HookOutcome>;
}

/**
 * Per-wallet hook configuration, stored in KV (`aw:hooks:{walletId}`).
 * Compliance is global (not represented here — it reads a separate
 * OFAC-list KV and always runs). Each field is optional; an absent
 * field means the hook is not enabled for the wallet.
 */
export interface WalletHookConfig {
  reputationGate?: {
    enabled: boolean;
    /** Minimum ERC-8004 summary value the recipient must meet. */
    minScore: number;
    /** What to do when the recipient's agentId can't be resolved. */
    onUnknown: "allow" | "deny";
  };
  multiPayeeSplit?: {
    enabled: boolean;
    /**
     * DEPRECATED / inert. Splits are now EXPLICIT-ONLY: the hook acts only
     * on per-payment `params.splits`, never on a stored wallet default
     * (auto-applying a default silently redirects a confirmed recipient's
     * funds — a consent violation). Retained for backward compatibility
     * with old stored configs; the hook ignores it and the dashboard no
     * longer sets it.
     */
    defaultSplits?: SplitSpec[];
  };
  /**
   * SpendCapPolicy (#part-of-#1 policy engine). Programmable spend rules
   * layered ON TOP of the Agent Wallet's native perTxMaxUsd/dailyLimitUsd
   * (which are hard denies). This adds the things native caps don't have:
   *   - allowedRecipients — a whitelist; a recipient not on it is denied.
   *   - allowedWindowsUtc — settle only within these UTC hour windows.
   *   - perCallApprovalUsd — a SOFT cap; an amount at/above it returns
   *     require_approval (human-in-the-loop) rather than a hard deny.
   *     Distinct from the native perTxMaxUsd hard ceiling.
   */
  spendCap?: {
    enabled: boolean;
    /**
     * Whitelist of 0x recipients. ABSENT = no whitelist (allow-all by this
     * rule). An EMPTY array is rejected at validation — it would otherwise
     * read as allow-all in the runtime `length > 0` guard, the opposite of
     * a typed-but-empty allowlist's intent. Present ⇒ must list >=1 address.
     */
    allowedRecipients?: string[];
    /** Allowed settlement windows in UTC hours [startHour, endHour). */
    allowedWindowsUtc?: Array<{ startHour: number; endHour: number }>;
    /** Amount (USD) at/above which the payment needs human approval. */
    perCallApprovalUsd?: number;
  };
}
