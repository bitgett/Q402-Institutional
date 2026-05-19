/**
 * transfer-sponsored-v2.mjs — DEPRECATED / BLOCKED
 *
 * Same intent as transfer-sponsored.mjs with a more aggressive source-
 * side cleanup (scans every apikey:* binding for FROM_ADDR and
 * deactivates each live key), but the destination-side mint writes the
 * same legacy single-pool sponsored schema (plan: "sponsored",
 * amountUSD: 1, paidAt: "", quota:{addr} single pool) — which is no
 * longer functional with the two-pool credit model.
 *
 * The original implementation is in git history. For a transfer:
 *
 *   1. Revoke source-side access (manual KV edit or a focused rotate
 *      script — admin-grant.mjs does not currently revoke).
 *   2. Issue fresh paid credits on the destination wallet:
 *
 *        node --env-file=.env.local scripts/admin-grant.mjs \
 *          --address=0x... --amount=50000 --execute
 */

console.error(
  "\n⚠ transfer-sponsored-v2.mjs is DEPRECATED and intentionally blocked.\n" +
  "  This script wrote the legacy single-pool sponsored schema, which is\n" +
  "  no longer functional with the two-pool credit model. Running it would\n" +
  "  create a non-functional sub on the destination wallet.\n\n" +
  "  Use scripts/admin-grant.mjs to issue credits on the new wallet:\n\n" +
  "    node --env-file=.env.local scripts/admin-grant.mjs \\\n" +
  "      --address=0x... --amount=50000 --execute\n",
);
process.exit(2);
