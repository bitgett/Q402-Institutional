/**
 * transfer-sponsored.mjs — DEPRECATED / BLOCKED
 *
 * Originally moved a legacy sponsored grant from one wallet to another
 * by deactivating the source key, dropping its sub record, and re-
 * issuing the same allotment on the destination. Both the source-side
 * cleanup and the destination-side mint wrote the legacy single-pool
 * schema (plan: "sponsored", amountUSD: 1, paidAt: "", quota:{addr}
 * single pool) — which is no longer functional with the two-pool
 * credit model. seedFromLegacy() keeps the one existing sponsored
 * orphan operational via a narrow escape hatch, but creating more such
 * accounts forces more such hatches.
 *
 * If a transfer is genuinely needed, do it in two steps with the
 * canonical scripts:
 *
 *   # 1. zero out the source's paid scope (manual KV edit or a focused
 *   #    rotate script — admin-grant.mjs does not currently revoke).
 *   # 2. issue fresh paid credits on the destination:
 *
 *   node --env-file=.env.local scripts/admin-grant.mjs \
 *     --address=0x... --amount=50000 --execute
 *
 * The original implementation is in git history if anyone needs to
 * reference the source-side cleanup steps.
 */

console.error(
  "\n⚠ transfer-sponsored.mjs is DEPRECATED and intentionally blocked.\n" +
  "  This script wrote the legacy single-pool sponsored schema, which is\n" +
  "  no longer functional with the two-pool credit model. Running it would\n" +
  "  create a non-functional sub on the destination wallet.\n\n" +
  "  Use scripts/admin-grant.mjs to issue credits on the new wallet:\n\n" +
  "    node --env-file=.env.local scripts/admin-grant.mjs \\\n" +
  "      --address=0x... --amount=50000 --execute\n",
);
process.exit(2);
