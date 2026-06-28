/**
 * yield-coexistence.test.ts
 *
 * Pins the BNB Aave<->Lista coexistence invariants that gate flipping
 * LISTA_YIELD_ENABLED (the full-coexistence build). These are the fund-safety
 * guarantees the external audit required before the flag can be turned on:
 *
 *  1. Per-protocol impl: a Lista deposit/withdraw delegates to YIELD_IMPL_<CHAIN>_LISTA
 *     and NEVER falls back to the chain's Aave impl — so enabling the flag without
 *     deploying the ERC-4626 impl fails closed instead of burning gas on every op.
 *  2. The deposit flag gates ONLY new-deposit routing + market advertising — NOT
 *     reads / withdraw-target resolution. So Lista funds stay readable + withdrawable
 *     even after the flag is turned back off (no "rollback orphans funds").
 *  3. A withdraw market is validated against the configured vault allowlist.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { yieldImplFor, yieldDepositProtocol } from "@/app/lib/yield/sign";
import {
  listaDepositsEnabled,
  listaDepositChains,
  listaConfiguredChains,
  listaVaultFor,
  isListaVaultAllowed,
} from "@/app/lib/yield/lista";

const BNB_AAVE_IMPL = "0x968DfEeDA554b2aB1a43944520CE2aB1e40f84A4";
const BNB_LISTA_IMPL = "0x1111111111111111111111111111111111111111";
const USDT_VAULT = "0x6d6783C146F2B0B2774C1725297f1845dc502525";
const USDC_VAULT = "0x8a06Ac91265dBEBE6D4606f45b10993E9a571869";

const ENV_KEYS = ["LISTA_YIELD_ENABLED", "YIELD_IMPL_BNB", "YIELD_IMPL_BNB_LISTA", "YIELD_IMPL_BNB_AAVE"] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe("per-protocol impl (yieldImplFor) — the P0 enable-ordering guard", () => {
  it("lista NEVER falls back to the chain-default Aave impl (fails closed without YIELD_IMPL_BNB_LISTA)", () => {
    process.env.YIELD_IMPL_BNB = BNB_AAVE_IMPL; // chain default = the Aave impl
    expect(yieldImplFor("bnb", "lista")).toBeUndefined();
  });
  it("lista resolves YIELD_IMPL_BNB_LISTA when it is set", () => {
    process.env.YIELD_IMPL_BNB = BNB_AAVE_IMPL;
    process.env.YIELD_IMPL_BNB_LISTA = BNB_LISTA_IMPL;
    expect(yieldImplFor("bnb", "lista")?.toLowerCase()).toBe(BNB_LISTA_IMPL);
  });
  it("aave uses the chain-default YIELD_IMPL_BNB", () => {
    process.env.YIELD_IMPL_BNB = BNB_AAVE_IMPL;
    expect(yieldImplFor("bnb", "aave")?.toLowerCase()).toBe(BNB_AAVE_IMPL.toLowerCase());
  });
});

describe("deposit flag gates deposits only — reads/withdraw stay wired", () => {
  it("yieldDepositProtocol(bnb): aave when flag off, lista when on", () => {
    expect(yieldDepositProtocol("bnb")).toBe("aave");
    process.env.LISTA_YIELD_ENABLED = "true";
    expect(yieldDepositProtocol("bnb")).toBe("lista");
  });
  it("listaConfiguredChains includes bnb REGARDLESS of the flag (reads/withdraw/GC stay wired)", () => {
    expect(listaConfiguredChains()).toContain("bnb");
    process.env.LISTA_YIELD_ENABLED = "true";
    expect(listaConfiguredChains()).toContain("bnb");
  });
  it("listaDepositChains includes bnb ONLY when the flag is on", () => {
    expect(listaDepositChains()).not.toContain("bnb");
    process.env.LISTA_YIELD_ENABLED = "true";
    expect(listaDepositChains()).toContain("bnb");
  });
  it("listaVaultFor resolves the curated vault even with deposits OFF (withdraw recoverable)", () => {
    expect(listaDepositsEnabled()).toBe(false);
    expect(listaVaultFor("bnb", "USDT")?.toLowerCase()).toBe(USDT_VAULT.toLowerCase());
    expect(listaVaultFor("bnb", "USDC")?.toLowerCase()).toBe(USDC_VAULT.toLowerCase());
  });
});

describe("withdraw market allowlist (isListaVaultAllowed)", () => {
  it("accepts the configured USDT/USDC vaults for their asset", () => {
    expect(isListaVaultAllowed("bnb", "USDT", USDT_VAULT)).toBe(true);
    expect(isListaVaultAllowed("bnb", "USDC", USDC_VAULT)).toBe(true);
  });
  it("rejects an unknown vault and an asset/vault mismatch", () => {
    expect(isListaVaultAllowed("bnb", "USDT", "0xdeadBEEF00000000000000000000000000000000")).toBe(false);
    expect(isListaVaultAllowed("bnb", "USDT", USDC_VAULT)).toBe(false); // USDC vault under USDT
  });
});
