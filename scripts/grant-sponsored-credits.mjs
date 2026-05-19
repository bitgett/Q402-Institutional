/**
 * grant-sponsored-credits.mjs — DEPRECATED / BLOCKED
 *
 * Superseded by scripts/admin-grant.mjs, which writes the post-Phase-1
 * scoped credit pool (`quota:paid:{addr}`) and the modern subscription
 * mirror fields (paidQuotaBonus).
 *
 * The original implementation wrote the legacy single-pool schema:
 *
 *   apikey:<key>  plan: "sponsored"
 *   sub:<addr>    plan: "sponsored", amountUSD: 0, paidAt: "", quotaBonus
 *   quota:<addr>  INCRBY  (legacy, not the scoped pool)
 *
 * That shape is incompatible with the two-pool credit model: the
 * subscription's paid scope cannot be reconciled into `quota:paid:{addr}`
 * by seedFromLegacy without a sponsored-plan escape hatch (kept solely to
 * keep the one production sponsored orphan, 0xfe7ba1cd..., functional).
 * Recreating accounts in that shape today would force more such hatches.
 *
 * If a future ops case genuinely needs the legacy schema, recover the
 * original implementation from git history and rewire it onto the scoped
 * pool. For routine grants, use admin-grant.mjs:
 *
 *   node --env-file=.env.local scripts/admin-grant.mjs \
 *     --address=0x... --amount=50000 --execute
 */

console.error(
  "\n⚠ grant-sponsored-credits.mjs is DEPRECATED and intentionally blocked.\n" +
  "  This script wrote the legacy single-pool schema, which is no longer\n" +
  "  functional with the two-pool credit model. Running it would create a\n" +
  "  non-functional sub.\n\n" +
  "  Use scripts/admin-grant.mjs instead:\n\n" +
  "    node --env-file=.env.local scripts/admin-grant.mjs \\\n" +
  "      --address=0x... --amount=50000 --execute\n",
);
process.exit(2);
