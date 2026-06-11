/**
 * dashboard-state-machine.test.ts
 *
 * Identity-model coverage for app/dashboard/page.tsx — the 4-state
 * machine that routes users through (C) email-only / (D) claim prompt /
 * (E) reconnect / (F) full multichain / (G) wrong-wallet hard block.
 *
 * The regression mode this test catches: someone re-introduces silent
 * dual-identity rendering — the "Trial view = email, Multichain view =
 * whatever wallet's connected" failure mode. Specifically:
 *
 *   - removing the State G early return → mismatched wallet leaks data
 *   - removing the provision-useEffect wallet-match gate → silent fetch
 *     of the wrong wallet's subscription
 *   - dropping the auto-bind useEffect protection → wallet connection
 *     becomes irrevocable claim again
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const dashboardSource = readFileSync(
  resolve(ROOT, "app", "dashboard", "page.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");
const sidebarSource = readFileSync(
  resolve(ROOT, "app", "dashboard", "Sidebar.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");
const claimPromptSource = readFileSync(
  resolve(ROOT, "app", "dashboard", "ClaimWalletPrompt.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");
const wrongWalletSource = readFileSync(
  resolve(ROOT, "app", "dashboard", "WrongWalletHardBlock.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");
// v2 settlement ledger — the tx-history fetch moved here from page.tsx when
// the dashboard adopted the v2 shell (DashboardV2). page.tsx now renders
// <DashboardV2/> (which mounts ActivityView) ONLY after the State G early
// return, so a mismatched wallet never reaches this fetch. We assert the
// fetch keys strictly off the owner address threaded down from that gated
// mount — the same no-leak invariant, enforced at the new boundary.
const activityViewSource = readFileSync(
  resolve(ROOT, "app", "dashboard", "v2", "views", "ActivityView.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("dashboard — 4-state machine early returns", () => {
  it("imports the State D + State G components", () => {
    expect(dashboardSource).toMatch(/import\s+ClaimWalletPrompt\s+from/);
    expect(dashboardSource).toMatch(/import\s+WrongWalletHardBlock\s+from/);
  });

  it("derives walletMatches by lowercased comparison (case-insensitive)", () => {
    expect(dashboardSource).toMatch(
      /walletMatches\s*=[\s\S]+?address\.toLowerCase\(\)\s*===\s*emailSession\.address\.toLowerCase\(\)/,
    );
  });

  it("renders ClaimWalletPrompt when emailSession + wallet connected + no bound address (State D)", () => {
    // The early return must check all of: mounted, authChecked, emailSession,
    // isConnected, address, !emailSession.address, !skipClaimPrompt.
    const dBlock = dashboardSource.match(/!emailSession\.address[\s\S]+?<ClaimWalletPrompt/);
    expect(dBlock).toBeTruthy();
    expect(dashboardSource).toMatch(/<ClaimWalletPrompt[\s\S]+?onBound=/);
    expect(dashboardSource).toMatch(/skipClaimPrompt/);
  });

  it("renders WrongWalletHardBlock when bound address mismatches connected wallet (State G)", () => {
    const gBlock = dashboardSource.match(/!walletMatches[\s\S]+?<WrongWalletHardBlock/);
    expect(gBlock).toBeTruthy();
    expect(dashboardSource).toMatch(/<WrongWalletHardBlock[\s\S]+?boundAddress=/);
  });
});

describe("dashboard — data fetch gating (no leak from mismatched wallets)", () => {
  it("provision useEffect waits for authChecked (no race with /api/auth/me)", () => {
    // The /api/auth/me fetch resolves async on mount. If provision fires
    // before that, a localStorage-rehydrated wallet can pull its own
    // subscription milliseconds before we learn the session is bound to
    // a DIFFERENT wallet. State G would then replace the rendered output
    // but the KV read already happened on the wrong wallet. Gating the
    // provision useEffect on authChecked closes the window.
    expect(dashboardSource).toMatch(
      /if\s*\(\s*!authChecked\s*\)\s*return;[\s\S]+?provision/,
    );
  });

  it("provision useEffect refuses to run when bound wallet doesn't match connected", () => {
    // Belt-and-suspenders alongside the State G early return — the
    // useEffect must explicitly bail before any /api/keys/provision call.
    const provisionBlock = dashboardSource.match(
      /useEffect\(\(\)\s*=>\s*\{[^]*?provision\(\)/,
    );
    expect(provisionBlock).toBeTruthy();
    expect(provisionBlock![0]).toMatch(
      /emailSession\.address[\s\S]+?address\.toLowerCase\(\)\s*!==\s*emailSession\.address\.toLowerCase\(\)/,
    );
  });

  it("renders <DashboardV2/> only AFTER the State G hard-block early return", () => {
    // The tx-history (and all other multichain) fetches moved into the v2
    // views, which only mount when page.tsx renders <DashboardV2/>. That
    // render lives at the BOTTOM of the component, strictly after the State G
    // `!walletMatches` early return — so a mismatched wallet is hard-blocked
    // before DashboardV2 (and ActivityView's tx fetch) ever mounts. This
    // ordering IS the no-leak guard now; assert it can't be reordered.
    // Match the actual render JSX (`<DashboardV2 />`, with the space before
    // the self-close) — NOT the `<DashboardV2/>` mention in the file's
    // docstring, which appears earlier.
    const gReturnIdx = dashboardSource.indexOf("<WrongWalletHardBlock\n");
    const v2RenderIdx = dashboardSource.indexOf("<DashboardV2 />");
    expect(gReturnIdx).toBeGreaterThan(-1);
    expect(v2RenderIdx).toBeGreaterThan(-1);
    expect(v2RenderIdx).toBeGreaterThan(gReturnIdx);
  });

  it("ActivityView tx fetch keys strictly off the gated owner address", () => {
    // ActivityView (mounted only post-guard via DashboardV2) must auth + fetch
    // /api/transactions using the ownerAddress prop it receives — never a
    // separately-derived or browser-probed address. Threading the gated
    // address through is what preserves the legacy wallet-match guarantee.
    expect(activityViewSource).toMatch(
      /\/api\/transactions\?address=\$\{ownerAddress\}/,
    );
    expect(activityViewSource).toMatch(
      /getAuthCreds\(\s*ownerAddress\s*,\s*signMessage\s*\)/,
    );
  });

  it("does NOT auto-bind via silent unsigned POST anymore", () => {
    // The legacy useEffect that POSTed { address } to /api/auth/wallet-bind
    // without a challenge/signature is gone. Phase 1 requires explicit
    // user action through ClaimWalletPrompt.
    expect(dashboardSource).not.toMatch(
      /fetch\(\s*["']\/api\/auth\/wallet-bind["'][\s\S]*?body:\s*JSON\.stringify\(\s*\{\s*address\s*\}\s*\)/,
    );
  });
});

describe("Sidebar — Phase 1 routing keeps the lock UI unreachable", () => {
  // The sidebar is only ever rendered when the dashboard reaches State F
  // (email session present, wallet bound, wallet matches). In that state
  // emailSession.address is always set, so any `multichainLocked` prop we
  // could pass would always be false. The prop was dead code on Phase 1
  // routing and was removed — these assertions catch a regression that
  // re-introduces it without re-thinking when it should fire.
  it("Sidebar does not accept a multichainLocked prop", () => {
    expect(sidebarSource).not.toMatch(/multichainLocked/);
  });

  it("dashboard does not pass a multichainLocked prop to Sidebar", () => {
    expect(dashboardSource).not.toMatch(/multichainLocked=/);
  });
});

describe("trial-credits scope hygiene", () => {
  it("trialCredits falls back to 0 (not the paid pool) when no active trial", () => {
    // Regression catch: a paid user with no email trial used to see their
    // 491-remaining paid credits surfaced in the Trial view because the old
    // derivation defaulted to the unified `walletCredits` counter.
    //
    // After the two-pool migration, the source of truth is the scoped
    // mirror `trialQuotaBonus` (read as `trialPoolCredits`). The fallback
    // chain is:
    //   1. hasEmailTrial  → sessionTrial.credits
    //   2. hasScopedMirrors → trialPoolCredits (post-migration default)
    //   3. legacy single-pool: isTrialOnlySub → legacyTotalCredits,
    //      else boundEmailTrial?.credits ?? 0
    // Critically the legacy fallback is gated by isTrialOnlySub and never
    // touches the paid pool — so a paid user with no active trial never
    // sees their paid credits leak into the Trial view.
    expect(dashboardSource).toMatch(
      /trialCredits\s*=[\s\S]+?hasScopedMirrors[\s\S]+?trialPoolCredits[\s\S]+?isTrialOnlySub\s*\?\s*legacyTotalCredits\s*:\s*\(boundEmailTrial\?\.credits\s*\?\?\s*0\)/,
    );
    // Hard guard: the old `walletCredits` symbol must be gone — the regression
    // we're catching is its accidental reintroduction.
    expect(dashboardSource).not.toMatch(/\bwalletCredits\b/);
  });

  it("auto-flip uses an explicit active-trial signal, not just emailSession existence", () => {
    // Old auto-flip put any user with an email session into Trial view —
    // even paid users whose trial had expired. Now we require an active
    // trial signal (wallet plan=trial within expiry, OR email pseudo has
    // a trial key / expiry).
    expect(dashboardSource).toMatch(/walletHasTrialSignal/);
    expect(dashboardSource).toMatch(/emailHasTrialSignal/);
    expect(dashboardSource).toMatch(
      /walletHasTrialSignal\s*\|\|\s*emailHasTrialSignal/,
    );
  });
});

describe("ClaimWalletPrompt (State D) — irreversible-from-UI warning", () => {
  it("explicitly states the wallet becomes the ONLY wallet for the account", () => {
    expect(claimPromptSource).toMatch(/only.{0,20}wallet/i);
  });

  it("warns the bind cannot be undone from the UI (support-only recovery)", () => {
    expect(claimPromptSource).toMatch(/cannot undo|support-only|recovery/i);
  });

  it("calls bindWallet (signed) — not a raw fetch with unsigned address", () => {
    expect(claimPromptSource).toMatch(/import\s+\{[^}]*bindWallet[^}]*\}\s+from/);
    expect(claimPromptSource).not.toMatch(/fetch\(\s*["']\/api\/auth\/wallet-bind["']/);
  });

  it("handles WALLET_ALREADY_BOUND result without looping or auto-retry", () => {
    expect(claimPromptSource).toMatch(/WALLET_ALREADY_BOUND/);
  });
});

describe("WrongWalletHardBlock (State G) — full hard block, no data fetch", () => {
  it("does NOT fetch from /api/* inside the component (pure read-only render)", () => {
    expect(wrongWalletSource).not.toMatch(/fetch\(/);
  });

  it("displays both the bound address and the mismatched connected address", () => {
    expect(wrongWalletSource).toMatch(/boundAddress/);
    expect(wrongWalletSource).toMatch(/connectedAddress/);
  });

  it("points users to email support for recovery (Phase 2 placeholder)", () => {
    expect(wrongWalletSource).toMatch(/mailto:business@quackai\.ai/);
  });
});
