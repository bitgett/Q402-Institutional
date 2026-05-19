/**
 * wallet-context-disconnect.test.ts
 *
 * Regression cover for the explicit-disconnect sentinel.
 *
 * Bug it pins: EIP-1193 wallets do not revoke the `eth_accounts`
 * permission grant when the dapp calls our internal disconnect().
 * The init useEffect's getConnectedAccount probe would otherwise
 * read that still-authorized address from the wallet extension and
 * resurrect the wallet right after the user clicked Sign Out —
 * every Sign-Out call site is paired with window.location.reload(),
 * making the regression instantly reproducible.
 *
 * These tests assert the sentinel is written on disconnect, honored
 * by the init probe, and cleared on a fresh user-initiated connect.
 *
 * The WalletContext provider itself uses React hooks, so we exercise
 * the same primitives the provider relies on (localStorage +
 * getConnectedAccount) and assert the visible contract directly —
 * a hooks-renderer test for the provider would force a React-DOM
 * dependency just to cover three string keys.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SENTINEL = "q402_wallet_explicit_disconnect";

// ── Minimal localStorage stub (the same Map shape vitest uses
// internally elsewhere in this suite). ─────────────────────────────
const memory = new Map<string, string>();
const storage: Storage = {
  getItem: (k) => memory.get(k) ?? null,
  setItem: (k, v) => { memory.set(k, v); },
  removeItem: (k) => { memory.delete(k); },
  clear: () => memory.clear(),
  key: (i) => Array.from(memory.keys())[i] ?? null,
  get length() { return memory.size; },
};

beforeEach(() => {
  memory.clear();
  vi.stubGlobal("localStorage", storage);
});

// Translate the provider's three primitives into plain helpers so we
// can assert the wire-level behaviour without booting React.
function disconnect() {
  localStorage.removeItem("q402_wallet");
  localStorage.removeItem("q402_wallet_type");
  localStorage.setItem(SENTINEL, "1");
}

function connectAndStore(addr: string, type?: string) {
  // Mirror of WalletContext.connectWith — sentinel cleared on a
  // fresh user-initiated authorization.
  localStorage.setItem("q402_wallet", addr);
  if (type) localStorage.setItem("q402_wallet_type", type);
  localStorage.removeItem(SENTINEL);
}

function shouldAutoRestore(): boolean {
  // Mirror of the init guard added in WalletContext.tsx.
  return !localStorage.getItem(SENTINEL);
}

describe("WalletContext disconnect sentinel — contract", () => {
  it("disconnect() writes the sentinel", () => {
    localStorage.setItem("q402_wallet", "0xabc");
    disconnect();
    expect(localStorage.getItem(SENTINEL)).toBe("1");
    expect(localStorage.getItem("q402_wallet")).toBeNull();
  });

  it("init() does NOT auto-restore when the sentinel is present", () => {
    disconnect();
    expect(shouldAutoRestore()).toBe(false);
  });

  it("init() auto-restores on a normal page load (no sentinel)", () => {
    // Default browser state — no prior disconnect.
    expect(shouldAutoRestore()).toBe(true);
  });

  it("connectAndStore() clears the sentinel so future reloads auto-restore", () => {
    disconnect();
    expect(shouldAutoRestore()).toBe(false);
    connectAndStore("0xabc", "metamask");
    expect(localStorage.getItem(SENTINEL)).toBeNull();
    expect(shouldAutoRestore()).toBe(true);
  });

  it("typical X-then-reload-then-reconnect cycle behaves correctly", () => {
    // 1. user connects
    connectAndStore("0xabc", "metamask");
    expect(shouldAutoRestore()).toBe(true);

    // 2. user clicks Sign Out (which triggers reload internally)
    disconnect();
    expect(shouldAutoRestore()).toBe(false);

    // 3. reload — init must NOT resurrect the wallet
    expect(localStorage.getItem("q402_wallet")).toBeNull();
    expect(shouldAutoRestore()).toBe(false);

    // 4. user clicks Connect → fresh authorization clears the sentinel
    connectAndStore("0xabc", "metamask");
    expect(shouldAutoRestore()).toBe(true);
  });
});

// ── source-grep guards on the provider itself ────────────────────────
//
// Lock the three wiring points: sentinel write on disconnect, sentinel
// check at init, sentinel removal on connect/connectWith. The
// behavioural contract above proves the SHAPE works; the grep makes
// sure WalletContext actually implements it.
const walletContextSource = readFileSync(
  resolve(__dirname, "..", "app", "context", "WalletContext.tsx"),
  "utf8",
);

describe("WalletContext source guards", () => {
  it("defines the disconnect sentinel constant", () => {
    expect(walletContextSource).toMatch(
      /DISCONNECT_SENTINEL\s*=\s*["']q402_wallet_explicit_disconnect["']/,
    );
  });

  it("disconnect() writes the sentinel", () => {
    const block = walletContextSource.match(
      /const\s+disconnect\s*=\s*useCallback\([\s\S]+?\n\s*\},\s*\[\]\);/,
    );
    expect(block).toBeTruthy();
    expect(block![0]).toMatch(/localStorage\.setItem\(\s*DISCONNECT_SENTINEL/);
  });

  it("init useEffect short-circuits when the sentinel is set", () => {
    expect(walletContextSource).toMatch(
      /localStorage\.getItem\(\s*DISCONNECT_SENTINEL\s*\)[\s\S]+?setMounted\(\s*true\s*\)[\s\S]+?return/,
    );
  });

  it("connect() removes the sentinel after a successful authorization", () => {
    const block = walletContextSource.match(
      /const\s+connect\s*=\s*useCallback\([\s\S]+?\n\s*\},\s*\[\]\);/,
    );
    expect(block).toBeTruthy();
    expect(block![0]).toMatch(/localStorage\.removeItem\(\s*DISCONNECT_SENTINEL/);
  });

  it("connectWith() removes the sentinel after a successful authorization", () => {
    const block = walletContextSource.match(
      /const\s+connectWith\s*=\s*useCallback\([\s\S]+?\n\s*\},\s*\[\]\);/,
    );
    expect(block).toBeTruthy();
    expect(block![0]).toMatch(/localStorage\.removeItem\(\s*DISCONNECT_SENTINEL/);
  });
});
