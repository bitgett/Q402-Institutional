# Q402 BNB-focus sprint — MERGE RUNBOOK

Branch: `feat/bnb-focus-sprint` on `bitgett/Q402-Institutional`
Pre-merge tag for rollback: `v1.27-multichain` (commit `7da74c0`)
MCP latest at merge time: `@quackai/q402-mcp@0.3.14` (default URL points at sprint preview deploy)

## Why this file exists

This sprint is unusual: trial users sign up on the preview deploy because the canonical site (`q402.quackai.ai`) still serves `main`. Cutover requires a sequenced operation across **landing repo + MCP package + Vercel env + Upstash KV**, not just a `git merge`. Missing a step leaks data, breaks trial users mid-flight, or sends new MCP installs to a sunset URL.

---

## Phase 0 — Pre-merge sanity (right before pulling the trigger)

1. **Tests + lint + build green** on the branch HEAD:
   ```
   cd q402-landing
   npx vitest run                    # → 39+ files, all pass + skip OK
   npx eslint . --max-warnings=0     # → 0 warnings
   npx next build --webpack          # → green
   ```

2. **MCP build green** (don't republish yet — see Phase 2):
   ```
   cd q402-landing/mcp-server
   npm run build                     # → tsup green
   npm audit --omit=dev              # → 0 vulnerabilities
   ```

3. **Fresh-clone simulation** (catches CRLF / sibling-repo issues):
   ```
   # move mcp-server/src/{client,index,tools/*} out, run vitest, move back
   # expectation: zero red. ~36 skip on the cross-repo blocks is fine.
   ```

4. **Vercel env vars verified for production**:
   - `APP_ORIGIN=https://q402.quackai.ai` (auth links pin here)
   - `RESEND_API_KEY` + `RESEND_FROM_ADDRESS` (else email signup fails closed and trial onboarding is dead)
   - `GOOGLE_CLIENT_ID` + `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (same value, set in BOTH Production and Preview scopes)
   - `KV_REST_API_*` decision made: either preview KV == production KV (recommended; see Phase 1), or production KV gets a one-shot data sync from preview (only if data isolation is required)
   - `RELAYER_PRIVATE_KEY`, `CRON_SECRET` (existing)
   - `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (ops alerts — gas drift, bridge index failure, etc.)

5. **Exposed-key cleanup**: any API key + private key the user pasted in chat during QA (e.g. `q402_live_3434...05fd` from sprint dev) is rotated / disabled in /dashboard BEFORE production exposure.

---

## Phase 1 — Choose the cutover model

Two reversible paths, listed in order of preference:

### (A) Vercel production-branch swap **[RECOMMENDED]**

Most reversible. Code on `main` stays the multichain v1.27 state. Production traffic moves to the sprint branch by Vercel UI alone.

1. Vercel → Project → Settings → Git → **Production Branch**: `main` → `feat/bnb-focus-sprint`
2. KV envs: keep production KV pointing at the same Upstash store the sprint preview uses, OR move the preview KV's data into production (one-shot import). This is the call that decides whether trial users signed up during QA carry over.
3. Trigger redeploy of production (Vercel auto-deploys on env change, but a manual rebuild forces a clean cold start).

Rollback: flip Production Branch back to `main`. Zero code change. Existing trial subscriptions persist as long as KV pointer is unchanged.

### (B) Squash-merge `feat/bnb-focus-sprint` → `main`

Lossier reversibility, but lets main carry a single clean commit. Do NOT use plain merge — squash only — because plain merge preserves every commit on the sprint branch verbatim (including any `Co-Authored-By` / postmortem-style bodies) on main's history.

1. PR title (clean — no external attribution, no AI authorship):
   ```
   feat: BNB-focus sprint — Free Trial + Multichain dashboard + MCP v0.4.0
   ```

2. GitHub's **Squash and merge** UI pre-fills the squash commit's body with the concatenated bodies of every branch commit. That default **carries the sprint history forward** — including any `Co-Authored-By: ...` trailers and verbose "earlier revision" narratives from individual sprint commits. Before clicking the green button:
   - Open the **commit message editor** on the merge page.
   - **Delete the entire pre-filled body** and write a clean summary (3–6 bullet points covering what shipped: Free Trial flow, multichain dashboard, MCP v0.3.x → v0.4.0, sprint hardening). No `Co-Authored-By` trailers. No references to specific reviewers or AI tooling.
   - Confirm the **title** is the canonical sprint title above (not the auto-generated `Merge pull request #N` style).

3. Click Squash and merge. Vercel auto-deploys main; the sprint branch can be deleted after.

Rollback: `git revert <squash-commit>` PR.

> **Why this step matters:** the sprint branch carries 50+ commits from incremental work and individual commit bodies are not always public-grade. Squash-merge with a hand-written body is the canonical place to scrub history — the alternative (force-push to rewrite individual sprint commits) is forbidden by the [no deep history rewrite](../README.md) policy.

---

## Phase 2 — MCP canonical URL flip (CRITICAL, post-cutover)

`@quackai/q402-mcp@0.3.13/14` ships with `DEFAULT_RELAY_BASE` pointing at the **sprint preview deploy URL** (`q402-institutional-git-feat-bnb-f-e317ee-...vercel.app/api`). Once production serves the sprint code, this default sends new MCP installs at a deploy that may be sunset, demoted, or auth-restricted.

**Required steps:**

1. Edit `mcp-server/src/config.ts`:
   ```diff
   - DEFAULT_RELAY_BASE = "https://q402-institutional-git-feat-bnb-f-e317ee-bitgett-7677s-projects.vercel.app/api"
   + DEFAULT_RELAY_BASE = "https://q402.quackai.ai/api"
   ```
   (the file has a "REVERT CHECKLIST" comment block — run it.)

2. Bump to **0.4.0** in `package.json`, `server.json`, `src/index.ts`, `.codex-plugin/plugin.json`. The major-minor bump (0.3.x → 0.4.0) signals the cutover and is a checkpoint for users running the sprint-temp default.

3. Also update `server.json` `Q402_RELAY_BASE_URL.default` (env var docs) + `mcp-server/README.md` sprint window callout.

4. `cd mcp-server && rm -rf dist && npm run build`

5. Tarball sanity:
   ```
   grep -ciE 'codex audit|external (audit|review|reviewer)' dist/index.js   # → 0
   grep -o 'q402-institutional-git-feat-bnb-f[^"]*' dist/index.js           # → empty (no preview URL leaks)
   grep -o 'https://q402.quackai.ai/api' dist/index.js                      # → ≥1 (canonical default)
   ```

6. Commit + push + `npm publish --access public` + `gh release create v0.4.0`.

7. **MCP Registry update** (registry.modelcontextprotocol.io, currently stale at v0.3.4):
   ```
   ./mcp-publisher.exe login github      # interactive GitHub device code
   ./mcp-publisher.exe publish           # uses server.json
   ```
   (the publisher binary is gitignored at `mcp-server/mcp-publisher.exe`; download fresh from `modelcontextprotocol/registry` releases if missing.)

---

## Phase 3 — Within 24h after cutover

Monitoring + cleanup:

1. **Telegram ops channel**: watch for `gas_drift_alert:*`, `bridge_write_alert:*`, `Insufficient gas tank` patterns. Trial users hitting `Insufficient gas tank` after the cutover means production KV doesn't have their subscription (and they need to re-signup) — bridge data sync was either missed or the user is on a stale MCP version.

2. **MCP version distribution**: `npm view @quackai/q402-mcp --json | jq .versions` — check that `0.4.0` is `latest`. Verify a fresh `npx -y @quackai/q402-mcp` installs the canonical version.

3. **Magic-link delivery health**: ekahs0266@gmail.com signup flow test against q402.quackai.ai. The 404 we hit during QA was because production was on main (no email/callback route). Post-cutover, this must 302 to `/dashboard?signin=email`.

4. **Trial gas-burn counter**: `HGETALL trial_gas_burned` on Upstash. Sanity-check the platform-spend trajectory matches the trial signup count — if it doesn't, the relay route's `after()` block isn't running (Vercel teardown timing issue).

5. **Sprint preview deploy**: keep it alive for ~7 days as a fallback for any MCP user still on 0.3.13/14 default URL. Then sunset.

---

## Phase 4 — Within 1 week post-merge (UX hardening sprint)

Carry over from Codex QA feedback (Set 1):

1. **`q402_status` MCP tool** — preflight that surfaces masked key + sender wallet + bound wallet + relay URL + per-chain gas tank + batchable + mode all in one read. This was the loudest QA pain point.
2. **`q402_pay { dryRun: true }`** — preflight preview without moving funds.
3. **Better error → next-action mapping**:
   - `Insufficient gas tank on bnb` → include dashboard URL in error body
   - `Unexpected token '<'` → "Relay returned HTML. Check relay URL/auth."
4. **Dashboard "Test Connection"** button — Test the live key from the browser, show "Your sender wallet is 0x…, gas tank is X BNB, batch supported: yes."
5. **`live` (key format) vs `trial` (account plan) terminology cleanup** in dashboard + tool descriptions.

---

## Phase 5 — Within 1 month (deferred reliability + security)

1. **Ledger write reliability — retry / backfill queue**
   `/api/relay` writes `recordRelayedTx` + `trial_gas_burned` via Next.js `after()` so the function survives Vercel teardown. That closes the cold-stop window but a KV write that throws **after** the response is flushed is still lost — the user sees a successful on-chain settlement but no Transactions-tab row and no gas-tank debit. Fix options, in order of preference:
   - **(a) Upstash QStash retry queue**: enqueue the ledger row on settlement, consume with exponential backoff. Dead-letter after N retries → ops alert.
   - **(b) In-process exponential retry** inside the `after()` block (3 attempts, 250ms/1s/4s backoff) before falling through to ops alert. Simpler, weaker — still bound to the same serverless invocation.
   - **(c) Reconciliation cron**: hourly job that pulls `txHash`es from on-chain events and back-fills any missing ledger rows. Strongest, also most code.
   Acceptable launch posture: `(b)` for short-term; plan `(a)` as the canonical fix.

2. **API-key from-binding for paid keys** (an earlier audit's P1): currently intentionally not enforced — Q402 is platform-billing (builder relays for N end-users; `from` is the end-user wallet, not the key owner). Locked in `__tests__/trial-from-binding.test.ts`. Revisit if abuse patterns emerge:
   - Per-key daily TX cap (already partially exists; tighten if needed)
   - Anomaly detection on sudden `from` distribution shifts
   - One-click rotation UX with audit-log of last-used IP/timestamp
2. **`/api/relay/batch` self-fetch refactor** — currently fans out to `/api/relay` via `req.nextUrl.origin` POST. Vercel mostly closes this off but it's still a "secret body posted to host-derived URL" pattern. Extract `/api/relay`'s core (validation + settlement) into a function and call in-process. ~1 hour effort, deferred.
3. **MCP Registry update cadence** — current process is manual (`mcp-publisher` CLI). Add a GitHub Action that auto-publishes on tag push.

---

## What NOT to touch on merge

- `app/lib/version.ts` constants — already aligned in sprint (SDK_VERSION 1.7.3-bnbfocus, MCP_VERSION 0.3.14). Bump together in Phase 2.
- Deep sprint history (52 commits with `Co-Authored-By: Claude` + occasional `External audit caught it`). Squash-merge (Phase 1B) or branch-swap (Phase 1A) handles both paths without rewriting deep history. Memory rule `feedback_no_external_audit_attribution.md` covers this — do NOT force-push to scrub.

---

## Known orphan-state edge case

A trial-plan API key whose subscription record is missing in the destination KV (e.g. user signed up on preview, production KV doesn't have a sync) falls THROUGH every trial gate: `isActiveTrial` is false, gas tank check fires, user sees "Insufficient gas tank on bnb". The fix is operational (sync the record / re-signup), not structural. Document in dashboard's trial-status card if it recurs.

---

## Files NOT needed on main post-merge (sweep candidates)

These were sprint-only and can be retired in a follow-up cleanup PR
(run AFTER Phase 4 settles — not part of merge):

### Sprint-flag scaffolding (now always-off, can be deleted with the flag)
- `app/lib/feature-flags.ts::BNB_FOCUS_MODE` + companion message constant
- `app/lib/feature-flags.ts::EVENT_MODE` if /event becomes default rather than a togglable view
- `mcp-server/src/chains.ts::BNB_FOCUS_MODE` + the supportedTokens-rewrite loop
- `mcp-server/src/config.ts` REVERT CHECKLIST comment block (stale after Phase 2)
- Sprint-window dates baked into copy:
  - `mcp-server/README.md` (the "🚧 Sprint window 2026-05-19 → 2026-06-30" banner)
  - `mcp-server/src/chains.ts` (header doc-block date)
  - Same dates in `app/lib/feature-flags.ts` if present
- `docs/sprint-bnb-focus.md` if it ever gets re-added — keep archived, not on main

### Probable script duplicates (verify before deleting)
- `scripts/transfer-sponsored.mjs` vs `scripts/transfer-sponsored-v2.mjs` — same op, two versions
- `scripts/test-xlayer-eip3009-direct.mjs` vs `scripts/test-xlayer-eip3009-packed.mjs` — adjacent xlayer smoke tests; one likely superseded
- `scripts/migrate-split-wallets.mjs` — one-shot migration, should already have run

### Things that look like clutter but are NOT — keep them
- `mcp-server/mcp-publisher.exe` (gitignored) — re-downloaded per registry update; do NOT add to repo
- `tmp-mcp-publisher/` (local-only at `C:/Users/user/tmp-mcp-publisher/`) — build dir
- `contracts.manifest.json` (10 KB) — single source of truth for chain registry, referenced by SDK + MCP + tests
- All 15 scripts under `scripts/` — manual ops/dev tools, called by hand

### Verified clean (no action needed)
- Top-level README: 12 KB, currently accurate post-scrub
- mcp-server README: 9.6 KB, accurate
- 0 TODO/FIXME/XXX/HACK markers in `app/` + `mcp-server/src/` — no debt-comments to chase
- 0 audit-attribution leaks in source, dist, release notes, npm tarball

---

## Telegram one-shot on cutover

When Phase 1 is done, post to the ops channel:

> 🚀 Q402 BNB-focus sprint went live: q402.quackai.ai now serves the sprint code. MCP latest = v0.4.0 (canonical URL). Trial flow: Google + Email + Wallet → 2000 sponsored TX over 30d on BNB Chain + USDC/USDT. Production KV has subscription records — fresh signups land directly. Watch the gas_drift_alert + bridge_write_alert channels.

That message is the human-readable proof every Phase 1-2 step completed.
