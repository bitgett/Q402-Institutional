#!/usr/bin/env node
/**
 * rotate-keystore-key.mjs — one-shot Agent Wallet keystore re-wrap.
 *
 * Decrypts every `aw:{ownerAddr}` record in Vercel KV with the OLD
 * KEY_ENCRYPTION_KEY, then re-encrypts each one with a NEW key (fresh
 * AES-256-GCM nonce per record). Use this for incident response when the
 * master key has been leaked or rotated as part of a security audit.
 *
 * Usage (PowerShell):
 *   $env:OLD_KEY="<old hex 64-char>"
 *   $env:NEW_KEY="<new hex 64-char>"
 *   $env:KV_REST_API_URL="<from Vercel>"
 *   $env:KV_REST_API_TOKEN="<from Vercel>"
 *   node scripts/rotate-keystore-key.mjs --dry-run     # preview
 *   node scripts/rotate-keystore-key.mjs               # apply
 *
 * After success: rotate Vercel env (`vercel env rm KEY_ENCRYPTION_KEY`
 * then `vercel env add KEY_ENCRYPTION_KEY production`) so the running
 * route handlers pick up the NEW key on next cold start.
 *
 * Safety:
 *   - Both keys must be present and validate as 32-byte hex.
 *   - OLD === NEW is rejected (no-op + footgun).
 *   - Dry-run prints the scan + decrypt-with-old check but writes nothing.
 *   - On any decrypt failure for a record, the script SKIPS that record
 *     (it does NOT clobber with a partial re-wrap) and logs it for
 *     manual triage. This is important: if even one record can't be
 *     decrypted with OLD_KEY, the operator has a key mismatch and should
 *     abort the rotation.
 *
 * Idempotency: a record that's already encrypted with NEW_KEY (e.g. the
 * script was re-run after a partial rotation) will fail the OLD_KEY
 * decrypt and be skipped — re-running is safe but won't make progress.
 * To resume after a partial run, swap OLD <-> NEW and finish the tail.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    "limit":   { type: "string" },                   // optional cap for safety
  },
});

const DRY_RUN = !!values["dry-run"];
const LIMIT   = values["limit"] ? Number(values["limit"]) : null;

function die(msg) {
  process.stderr.write(`[rotate-keystore] ERROR: ${msg}\n`);
  process.exit(1);
}

function parseHexKey(label, raw) {
  if (!raw) die(`${label} env var is required`);
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]+$/.test(hex)) die(`${label} must be hex`);
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== KEY_BYTES) die(`${label} must decode to ${KEY_BYTES} bytes (got ${buf.length})`);
  return buf;
}

const OLD = parseHexKey("OLD_KEY", process.env.OLD_KEY);
const NEW = parseHexKey("NEW_KEY", process.env.NEW_KEY);
if (OLD.equals(NEW)) die("OLD_KEY === NEW_KEY — refusing no-op rotation");

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
if (!KV_URL || !KV_TOKEN) die("KV_REST_API_URL and KV_REST_API_TOKEN are required");

function decrypt(blob, key) {
  const nonce = Buffer.from(blob.nonce, "hex");
  const tag = Buffer.from(blob.tag, "hex");
  const ct = Buffer.from(blob.ciphertext, "hex");
  if (nonce.length !== NONCE_BYTES) throw new Error("bad nonce length");
  if (tag.length !== TAG_BYTES) throw new Error("bad tag length");
  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

function encrypt(plaintext, key) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    nonce: nonce.toString("hex"),
    ciphertext: ct.toString("hex"),
    tag: tag.toString("hex"),
  };
}

async function kvRequest(cmd) {
  const res = await fetch(`${KV_URL}`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${KV_TOKEN}`,
    },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`KV ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function scanOwnerKeys() {
  // Upstash KV pipeline supports SCAN; iterate with a cursor.
  const out = [];
  let cursor = "0";
  do {
    const r = await kvRequest(["SCAN", cursor, "MATCH", "aw:*", "COUNT", "200"]);
    cursor = r.result[0];
    for (const key of r.result[1]) {
      // Owner records: exactly one `:` after the `aw:` prefix. Skip
      // export-log, daily-spend, batch, balance side keys.
      if (key.startsWith("aw:export-log:")) continue;
      if (key.startsWith("aw:daily-spend:")) continue;
      if (key.startsWith("aw:batch:")) continue;
      if (key.startsWith("aw:balance:")) continue;
      out.push(key);
    }
  } while (cursor !== "0");
  return out;
}

async function getRecord(key) {
  const r = await kvRequest(["GET", key]);
  if (!r.result) return null;
  try {
    return JSON.parse(r.result);
  } catch {
    return null;
  }
}

async function setRecord(key, record) {
  await kvRequest(["SET", key, JSON.stringify(record)]);
}

// ── Checkpoint journal ──────────────────────────────────────────────────
// A per-rotation KV slot tracks which records have already been re-
// wrapped under NEW_KEY. Lets a mid-flight crash (OOM, transient KV
// 5xx, Ctrl+C) resume cleanly on re-run instead of leaving the
// keystore half-OLD / half-NEW. Slot key includes the SHA-256 prefix
// of the NEW key so two distinct rotations don't share state.
const ROTATION_ID = createHash("sha256").update(NEW).digest("hex").slice(0, 16);
const JOURNAL_KEY = `aw:rotate-keystore:${ROTATION_ID}`;
const JOURNAL_TTL_SEC = 7 * 24 * 60 * 60; // 7 days — enough for ops cleanup

async function loadJournal() {
  try {
    const raw = await kvRequest(["GET", JOURNAL_KEY]);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
async function saveJournal(done) {
  // Best-effort; rotation continues even if journal write fails (the
  // next run might re-rotate already-rotated records, which the
  // second-chance NEW_KEY decrypt handles cleanly).
  try {
    const arr = Array.from(done);
    await kvRequest(["SET", JOURNAL_KEY, JSON.stringify(arr), "EX", String(JOURNAL_TTL_SEC)]);
  } catch (e) {
    process.stderr.write(`[rotate-keystore] journal write failed: ${e}\n`);
  }
}

async function main() {
  process.stderr.write(`[rotate-keystore] ${DRY_RUN ? "DRY RUN — no writes" : "LIVE — writing rotated records"}\n`);
  process.stderr.write(`[rotate-keystore] rotation id (NEW key prefix): ${ROTATION_ID}\n`);

  const done = DRY_RUN ? new Set() : await loadJournal();
  if (done.size > 0) {
    process.stderr.write(`[rotate-keystore] resume — ${done.size} record(s) already rotated in a prior run\n`);
  }

  const keys = await scanOwnerKeys();
  process.stderr.write(`[rotate-keystore] scanned ${keys.length} owner record(s)\n`);

  const slice = LIMIT ? keys.slice(0, LIMIT) : keys;
  if (LIMIT) process.stderr.write(`[rotate-keystore] capped at --limit=${LIMIT}\n`);

  let rotated = 0;
  let alreadyRotated = 0;
  let skipped = 0;
  const errors = [];
  let journalDirty = false;

  for (const key of slice) {
    if (done.has(key)) {
      alreadyRotated++;
      continue;
    }

    let record;
    try {
      record = await getRecord(key);
    } catch (e) {
      errors.push({ key, stage: "get", error: String(e) });
      continue;
    }
    if (!record?.encryptedPK?.nonce) {
      skipped++;
      errors.push({ key, stage: "shape", error: "missing encryptedPK" });
      continue;
    }

    let plaintext;
    try {
      plaintext = decrypt(record.encryptedPK, OLD);
    } catch {
      // OLD decrypt failed — try NEW. If THAT succeeds, the record was
      // already rotated in a prior run (and we just hadn't journalled
      // it). Mark journal-done and proceed. Otherwise the key really
      // mismatches and we skip + log.
      try {
        decrypt(record.encryptedPK, NEW);
        done.add(key);
        journalDirty = true;
        alreadyRotated++;
        continue;
      } catch (e2) {
        skipped++;
        errors.push({ key, stage: "decrypt", error: String(e2) });
        continue;
      }
    }

    if (DRY_RUN) {
      rotated++;
      continue;
    }

    const newBlob = encrypt(plaintext, NEW);
    try {
      await setRecord(key, { ...record, encryptedPK: newBlob });
      done.add(key);
      journalDirty = true;
      rotated++;
      // Flush journal every 25 successful rotations so a crash near
      // the end doesn't lose the entire run's progress. The trade-off
      // is up to 25 records re-rotated on resume (idempotent thanks
      // to the NEW-key second-chance branch above).
      if (rotated % 25 === 0) {
        await saveJournal(done);
        journalDirty = false;
      }
    } catch (e) {
      errors.push({ key, stage: "set", error: String(e) });
    }
  }

  if (journalDirty && !DRY_RUN) {
    await saveJournal(done);
  }

  process.stderr.write(
    `[rotate-keystore] done — ${rotated} rotated, ${alreadyRotated} already-rotated, ${skipped} skipped, ${errors.length} errored\n`,
  );

  if (errors.length > 0) {
    process.stderr.write(`[rotate-keystore] errors:\n`);
    for (const e of errors) {
      process.stderr.write(`  ${e.key} [${e.stage}]: ${e.error}\n`);
    }
    process.exit(2);
  }

  if (!DRY_RUN) {
    process.stderr.write(
      `[rotate-keystore] NEXT STEP: update Vercel KEY_ENCRYPTION_KEY to the new value:\n` +
      `  vercel env rm KEY_ENCRYPTION_KEY production\n` +
      `  vercel env add KEY_ENCRYPTION_KEY production\n` +
      `  vercel redeploy --prod\n` +
      `\n[rotate-keystore] journal at ${JOURNAL_KEY} (7-day TTL). Delete after rotation is fully\n` +
      `confirmed:  curl -X POST -H "Authorization: Bearer $KV_REST_API_TOKEN" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  $KV_REST_API_URL/del/${encodeURIComponent(JOURNAL_KEY)}\n`,
    );
  }
}

main().catch((e) => die(e instanceof Error ? e.stack ?? e.message : String(e)));
