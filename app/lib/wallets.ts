/**
 * Operational wallet addresses (v1.16+).
 *
 * SECURITY MODEL — three roles, three wallets, zero commingling.
 *
 *   SUBSCRIPTION_ADDRESS  revenue only — subscription payments ($29/$49/$149…)
 *                         arrive here. As of v1.25 this is a 2-of-3 Safe
 *                         multisig deployed on BNB Chain + Ethereum at the
 *                         same deterministic CREATE2 address (deployed
 *                         2026-05-03):
 *                           - signer: Founder personal cold wallet
 *                           - signer: Company 1 cold wallet
 *                           - signer: Company 2 cold wallet
 *                           - threshold: 2 / 3
 *                         No server-side private key. Withdrawals require
 *                         two of the three signers to co-sign on Safe Web.
 *                         The previous single-EOA address
 *                         `0x700a873215edb1e1a2a401a2e0cec022f6b5bd71` is
 *                         retired — any residual balance was transferred
 *                         out and the address no longer receives revenue.
 *
 *                         The chains the Safe is *currently* deployed on
 *                         are exported as `SUBSCRIPTION_DEPLOYED_CHAINS`
 *                         below — that constant is the single source of
 *                         truth for the payment-intent allowlist
 *                         (`/api/payment/intent`) and the CI drift guard
 *                         (`__tests__/subscription-safe-deployed.test.ts`).
 *                         Adding a new payment rail is a two-step process:
 *                         (1) replicate the Safe to that chain via Safe
 *                         Web's "Add network" flow at the same address;
 *                         (2) add the chain key to
 *                         SUBSCRIPTION_DEPLOYED_CHAINS — the test will
 *                         fail if step (2) is done before step (1).
 *
 *   GASTANK_ADDRESS       user-deposited relay credits (BNB/ETH/MNT/INJ/AVAX/OKB/USDT0).
 *                         KV ledger tracks per-user balance; on-chain balance
 *                         MUST equal sum(KV gas balance) at all times. No
 *                         server-side private key — hot relayer is topped up
 *                         manually via cold→hot transfers when low-balance
 *                         Telegram alerts fire.
 *
 *   RELAYER_ADDRESS       operational hot wallet. Signs and submits every
 *                         EIP-7702 TX. Private key lives in Vercel env
 *                         (RELAYER_PRIVATE_KEY). Kept at minimal operating
 *                         balance per chain; gas-alert cron monitors it.
 *
 * INVARIANT: RELAYER_ADDRESS never receives user funds (gas deposits go to
 * GASTANK_ADDRESS; subscription payments go to SUBSCRIPTION_ADDRESS). A
 * compromise of the server (Vercel env) can drain only the operational gas
 * float in RELAYER_ADDRESS — never revenue, never user deposits. With v1.25,
 * even a complete compromise of any single founder/Taylor cold wallet leaves
 * SUBSCRIPTION funds untouchable (2-of-3 needed).
 *
 * KNOWN LIMITATION — per-user gas custody.
 *   This split protects the *aggregate* user gas pool (it lives in a cold
 *   wallet), but per-user attribution is still tracked by the KV ledger
 *   (`gas:<userAddr>` keys in Vercel KV). A KV loss / corruption / unauthorized
 *   write therefore can:
 *     - Forget which user owns which slice of the on-chain GASTANK balance
 *     - Inflate or reduce a single user's recorded balance independently of
 *       on-chain state
 *   The total liability vs. on-chain GASTANK balance can still be verified
 *   from chain history (`scripts/migrate-split-wallets.mjs`), but rebuilding
 *   per-user balances after KV loss requires re-scanning every deposit/relay
 *   event from chain logs. There is no per-user on-chain subaccount today.
 *   Per-user on-chain custody (CREATE2 vault per user) is a deliberate
 *   non-goal at current TVL — see README §22 trade-off discussion.
 */

export const SUBSCRIPTION_ADDRESS = "0x2ffdFD41E461DdE8bE5a28A392dA511084d23faE";
export const GASTANK_ADDRESS      = "0x10fb078594b70ee8024b2ded3d67fc3aa9ea747a";
export const RELAYER_ADDRESS      = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466";

/** Lowercase variants for address comparisons (Transfer event args are lowercase). */
export const SUBSCRIPTION_ADDRESS_LC = SUBSCRIPTION_ADDRESS.toLowerCase();
export const GASTANK_ADDRESS_LC      = GASTANK_ADDRESS.toLowerCase();
export const RELAYER_ADDRESS_LC      = RELAYER_ADDRESS.toLowerCase();

/**
 * Chain keys where the SUBSCRIPTION Safe is *actually deployed*. The Safe is a
 * CREATE2 contract so the same address resolves on every EVM chain, but the
 * runtime bytecode only exists where we've explicitly run the Safe deploy
 * flow. Sending funds to the address on any other chain would land them in a
 * counterfactual address that only becomes withdrawable after a future Safe
 * deploy — so the payment-intent route restricts subscription rails to chains
 * in this list, and a CI drift guard
 * (`__tests__/subscription-safe-deployed.test.ts`) verifies via eth_getCode
 * that bytecode actually exists on every chain listed here.
 *
 * To add a new payment rail:
 *   1. Replicate the Safe at the same address on the new chain via Safe
 *      Web's "Add network" flow.
 *   2. Append the chain key here.
 *   3. CI runs eth_getCode on every entry and fails if step (1) was skipped.
 */
export const SUBSCRIPTION_DEPLOYED_CHAINS = ["bnb", "eth"] as const;
export type SubscriptionDeployedChain = typeof SUBSCRIPTION_DEPLOYED_CHAINS[number];
