/**
 * Q402 API Test Script
 * Usage: node scripts/test-api.mjs
 *
 * Tests:
 *  1. API key validity
 *  2. Sandbox relay (mock TX — no real chain interaction)
 *  3. Gas tank balances
 */

const BASE = process.env.BASE_URL ?? "https://q402.quackai.ai";

if (!process.env.API_KEY) {
  console.error("Error: API_KEY environment variable is required.");
  console.error("Usage: API_KEY=q402_live_... node scripts/test-api.mjs");
  process.exit(1);
}
const LIVE_KEY = process.env.API_KEY;

// Minimal valid-format hex values for sandbox relay (signatures not actually verified in sandbox)
const FAKE_SIG    = "0x" + "ab".repeat(65);
const FAKE_R      = "0x" + "cd".repeat(32);
const FAKE_S      = "0x" + "ef".repeat(32);
const FAKE_ADDR   = "0xd4e8f1b2a3c09f7e6d5c4b3a2918273645a1b2c3";
const DEADLINE    = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✅ ${label}`);
  passed++;
}
function fail(label, detail) {
  console.log(`  ❌ ${label}`);
  if (detail) console.log(`     ${detail}`);
  failed++;
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, data: await res.json() };
}

// ── 1. API Key validity ────────────────────────────────────────────────────────
console.log("\n[1] API Key Validity");
{
  const { status, data } = await post("/api/keys/verify", { apiKey: LIVE_KEY });
  if (status === 200 && data.valid === true) {
    ok(`Live key valid — address: ${data.address}, plan: ${data.plan}`);
  } else {
    fail("Live key should be valid", JSON.stringify(data));
  }

  const { status: s2, data: d2 } = await post("/api/keys/verify", { apiKey: "q402_live_invalid_key_000" });
  if (s2 === 200 && d2.valid === false) {
    ok("Invalid key correctly rejected");
  } else {
    fail("Invalid key should return valid:false", JSON.stringify(d2));
  }
}

// ── 2. Gas Tank ────────────────────────────────────────────────────────────────
console.log("\n[2] Gas Tank Balances");
{
  const { status, data } = await get("/api/gas-tank");
  if (status === 200 && Array.isArray(data.tanks)) {
    for (const t of data.tanks) {
      const icon = t.empty ? "🔴" : t.low ? "🟡" : "🟢";
      console.log(`  ${icon} ${t.chain.padEnd(10)} ${t.balance} ${t.token.padEnd(6)} (${t.usd})`);
    }
    ok(`${data.tanks.length} chains checked`);
  } else {
    fail("Gas tank endpoint failed", JSON.stringify(data));
  }
}

// ── 3. Sandbox Relay ──────────────────────────────────────────────────────────
console.log("\n[3] Sandbox Relay (mock — no real TX)");
{
  // Derive sandbox key from live key prefix
  // Sandbox keys start with q402_test_ — we need to get it via the DB.
  // If you have a sandbox key, set SANDBOX_KEY env var.
  const SANDBOX_KEY = process.env.SANDBOX_KEY;
  if (!SANDBOX_KEY) {
    console.log("  ⚠️  SANDBOX_KEY not set. Get it from My Page → Developer tab.");
    console.log("     Then run: SANDBOX_KEY=q402_test_xxx node scripts/test-api.mjs");
  } else {
    const body = {
      apiKey:    SANDBOX_KEY,
      chain:     "bnb",
      token:     "USDT",
      from:      FAKE_ADDR,
      to:        FAKE_ADDR,
      amount:    "1000000000000000000", // 1 USDT (18 decimals)
      deadline:  DEADLINE,
      witnessSig: FAKE_SIG,
      authorization: {
        chainId: 56,
        address: FAKE_ADDR,
        nonce:   0,
        yParity: 0,
        r:       FAKE_R,
        s:       FAKE_S,
      },
    };

    const { status, data } = await post("/api/relay", body);
    if (status === 200 && data.success === true && data.txHash) {
      ok(`Sandbox relay OK — mock txHash: ${data.txHash.slice(0, 18)}...`);
      ok(`  tokenAmount: ${data.tokenAmount} ${data.token} on ${data.chain}`);
    } else if (status === 401) {
      fail("Sandbox key invalid or inactive", JSON.stringify(data));
    } else if (status === 402) {
      fail("Gas tank issue (sandbox should skip gas check)", JSON.stringify(data));
    } else {
      fail(`Unexpected response ${status}`, JSON.stringify(data));
    }
  }
}

// ── 4. Relay rejects bad API key ──────────────────────────────────────────────
console.log("\n[4] Relay Security Checks");
{
  const body = {
    apiKey:    "q402_live_totally_fake_key",
    chain:     "bnb",
    token:     "USDT",
    from:      FAKE_ADDR,
    to:        FAKE_ADDR,
    amount:    "1000000000000000000",
    deadline:  DEADLINE,
    witnessSig: FAKE_SIG,
    authorization: { chainId: 56, address: FAKE_ADDR, nonce: 0, yParity: 0, r: FAKE_R, s: FAKE_S },
  };
  const { status, data } = await post("/api/relay", body);
  if (status === 401) {
    ok("Relay correctly rejects invalid API key (401)");
  } else {
    fail(`Expected 401, got ${status}`, JSON.stringify(data));
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(40)}`);
console.log(`  Total: ${passed + failed} | ✅ ${passed} passed | ❌ ${failed} failed`);
console.log(`${"─".repeat(40)}\n`);
if (failed > 0) process.exit(1);
