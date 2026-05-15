/**
 * dashboard-state-machine.test.ts
 *
 * Phase 1 identity model coverage for app/dashboard/page.tsx — the
 * 4-state machine that routes users through (C) email-only / (D) claim
 * prompt / (E) reconnect / (F) full multichain / (G) wrong-wallet hard
 * block. See docs/sprint-bnb-focus.md §10 for the full state table.
 *
 * The regression mode this test catches: someone re-introduces silent
 * dual-identity rendering (the audit's "Trial view = email, Multichain
 * view = whatever wallet's connected" finding). Specifically:
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
);
const sidebarSource = readFileSync(
  resolve(ROOT, "app", "dashboard", "Sidebar.tsx"),
  "utf8",
);
const claimPromptSource = readFileSync(
  resolve(ROOT, "app", "dashboard", "ClaimWalletPrompt.tsx"),
  "utf8",
);
const wrongWalletSource = readFileSync(
  resolve(ROOT, "app", "dashboard", "WrongWalletHardBlock.tsx"),
  "utf8",
);

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

  it("transactions useEffect refuses to run when wallet doesn't match bound", () => {
    const txBlock = dashboardSource.match(
      /useEffect\(\(\)\s*=>\s*\{[^]*?fetchTxs/,
    );
    expect(txBlock).toBeTruthy();
    expect(txBlock![0]).toMatch(
      /emailSession\.address[\s\S]+?address\.toLowerCase\(\)\s*!==\s*emailSession\.address\.toLowerCase\(\)/,
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

describe("Sidebar — Multichain section lock when unbound", () => {
  it("accepts multichainLocked prop", () => {
    expect(sidebarSource).toMatch(/multichainLocked\?:\s*boolean/);
  });

  it("disables the section header button when locked", () => {
    expect(sidebarSource).toMatch(/disabled=\{multichainLocked\}/);
  });

  it("makes tab list non-interactive (pointer-events-none) when locked", () => {
    expect(sidebarSource).toMatch(/multichainLocked\s*\?\s*["']opacity-40 pointer-events-none["']/);
  });

  it("dashboard passes multichainLocked = email session has no bound wallet", () => {
    expect(dashboardSource).toMatch(
      /multichainLocked=\{!!emailSession\s*&&\s*!emailSession\.address\}/,
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
