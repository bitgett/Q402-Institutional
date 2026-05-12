/**
 * refresh-dune-datasets.mjs
 *
 * Pushes external (non-on-chain) data into the public Dune dashboard
 * https://dune.com/coincraze/q402-settlement-activity so that widgets
 * which depend on off-chain APIs (npm downloads, GitHub stars, etc.)
 * stay live without manual CSV exports.
 *
 * On-chain data — settlement TX, subscription revenue, chain mix — is
 * read by Dune SQL directly from each chain's transactions table and
 * does NOT go through this script. The runtime mock for those rails is
 * always live by virtue of the chain indexer; what this script handles
 * is the small surface where Dune cannot reach the source on its own.
 *
 * Usage (local):
 *   DUNE_API_KEY=... node scripts/refresh-dune-datasets.mjs
 *
 * CI:
 *   .github/workflows/refresh-dune-datasets.yml triggers this every
 *   Monday 00:00 UTC via cron, plus a workflow_dispatch button for
 *   manual runs.
 */

const DUNE_API_KEY = process.env.DUNE_API_KEY;
if (!DUNE_API_KEY) {
  console.error("Missing DUNE_API_KEY env var.");
  console.error("Get one at https://dune.com/settings/api and run:");
  console.error("  DUNE_API_KEY=... node scripts/refresh-dune-datasets.mjs");
  process.exit(1);
}

const DUNE_UPLOAD_URL = "https://api.dune.com/api/v1/table/upload/csv";
const today = new Date().toISOString().slice(0, 10);

/**
 * POST a CSV body to Dune's upload endpoint and resolve the table's
 * dune.<handle>.<table> name. Throws on any non-success response so the
 * GitHub Actions step fails loudly instead of silently no-op'ing.
 */
async function uploadCsv({ tableName, description, csv }) {
  const resp = await fetch(DUNE_UPLOAD_URL, {
    method: "POST",
    headers: {
      "x-dune-api-key": DUNE_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      table_name: tableName,
      description,
      is_private: false,
      data: csv,
    }),
  });
  const json = await resp.json();
  if (!resp.ok || !json.success) {
    throw new Error(
      `Dune upload failed for ${tableName}: ${resp.status} · ${JSON.stringify(json)}`,
    );
  }
  return json.full_name; // e.g. dune.coincraze.dataset_q402_mcp_npm_downloads
}

/**
 * @quackai/q402-mcp daily npm downloads.
 *
 * Range is fixed at the package's first publish (2026-05-02) → today.
 * npm returns daily counts including zeros, so the CSV is always a
 * stable shape: day,downloads — Dune SQL can SUM() / window() on top.
 */
async function refreshNpmDownloads() {
  const PUBLISH_DATE = "2026-05-02";
  const url =
    `https://api.npmjs.org/downloads/range/${PUBLISH_DATE}:${today}` +
    `/@quackai/q402-mcp`;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`npm registry returned ${resp.status} for ${url}`);
  }
  const json = await resp.json();
  if (!Array.isArray(json.downloads)) {
    throw new Error(`Unexpected npm response shape: ${JSON.stringify(json)}`);
  }

  let csv = "day,downloads\n";
  for (const row of json.downloads) csv += `${row.day},${row.downloads}\n`;

  const total = json.downloads.reduce((s, r) => s + r.downloads, 0);
  console.log(
    `[npm] @quackai/q402-mcp · ${json.downloads.length} days · ${total} total downloads`,
  );

  const fullName = await uploadCsv({
    tableName: "q402_mcp_npm_downloads",
    description:
      `Daily downloads of @quackai/q402-mcp from npm registry. ` +
      `Source: api.npmjs.org/downloads/range. Refreshed: ${today}.`,
    csv,
  });
  console.log(`[npm] uploaded to ${fullName}`);
}

// ── Add more refreshers below as off-chain widgets get added to the dashboard ──
// e.g. GitHub stars, Anthropic MCP Registry stats, Trust Receipt count.
// Each one should be its own async function that ends in `await uploadCsv(...)`.

async function main() {
  const refreshers = [
    { name: "npm downloads (@quackai/q402-mcp)", fn: refreshNpmDownloads },
  ];

  const results = [];
  for (const { name, fn } of refreshers) {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
      console.error(`[${name}] FAILED:`, err.message);
    }
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} refreshers succeeded`);
  if (failed.length) process.exit(1);
}

await main();
