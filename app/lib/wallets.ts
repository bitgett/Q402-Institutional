/**
 * Operational wallet addresses (v1.16+).
 *
 * SECURITY MODEL — three roles, three wallets, zero commingling.
 *
 *   SUBSCRIPTION_ADDRESS  revenue only — subscription payments ($29/$49/$149…)
 *                         arrive here. No server-side private key. Withdraw
 *                         manually from a cold device.
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
 * float in RELAYER_ADDRESS — never revenue, never user deposits.
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

export const SUBSCRIPTION_ADDRESS = "0x700a873215edb1e1a2a401a2e0cec022f6b5bd71";
export const GASTANK_ADDRESS      = "0x10fb078594b70ee8024b2ded3d67fc3aa9ea747a";
export const RELAYER_ADDRESS      = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466";

/** Lowercase variants for address comparisons (Transfer event args are lowercase). */
export const SUBSCRIPTION_ADDRESS_LC = SUBSCRIPTION_ADDRESS.toLowerCase();
export const GASTANK_ADDRESS_LC      = GASTANK_ADDRESS.toLowerCase();
export const RELAYER_ADDRESS_LC      = RELAYER_ADDRESS.toLowerCase();
