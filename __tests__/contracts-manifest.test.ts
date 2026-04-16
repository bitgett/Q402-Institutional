/**
 * contracts-manifest.test.ts
 *
 * contracts.manifest.json is the single source of truth for:
 *   - chain → implementation contract address
 *   - chain → chainId
 *   - chain → supported tokens and addresses
 *   - chain → witness type / EIP-712 domain name
 *
 * This test guards against silent drift between the manifest, the server
 * (`app/lib/relayer.ts`), and the public SDK (`public/q402-sdk.js`). If you
 * rotate an impl contract or add a chain, update the manifest first and let
 * this test tell you what else to sync.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CHAIN_CONFIG, type ChainKey } from "../app/lib/relayer";

type ManifestToken = { address: string; decimals: number; aliasFor?: string };
type ManifestChain = {
  name: string;
  chainId: number;
  relayMode: string;
  implContract: string;
  witness: {
    type: "TransferAuthorization";
    domainName: string;
    verifyingContractRule: "implContract" | "userEOA";
  };
  tokens: Record<string, ManifestToken>;
  fallbackRelayMode?: string;
  fallbackTokens?: string[];
};
type Manifest = {
  version: string;
  chains: Record<string, ManifestChain>;
};

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "..", "contracts.manifest.json"), "utf8")
) as Manifest;

const sdkSource = readFileSync(
  resolve(__dirname, "..", "public", "q402-sdk.js"),
  "utf8"
);

const CHAINS = ["avax", "bnb", "eth", "xlayer", "stable"] as const;

describe("contracts.manifest.json ↔ server CHAIN_CONFIG", () => {
  it.each(CHAINS)("%s: chainId + implContract match manifest", (chain) => {
    const m = manifest.chains[chain];
    const s = CHAIN_CONFIG[chain as ChainKey];
    expect(m, `manifest missing chain ${chain}`).toBeDefined();
    expect(s.chainId).toBe(m.chainId);
    expect(s.implContract.toLowerCase()).toBe(m.implContract.toLowerCase());
  });

  it.each(CHAINS)("%s: token addresses match manifest", (chain) => {
    const m = manifest.chains[chain];
    const s = CHAIN_CONFIG[chain as ChainKey];
    expect(s.usdc.address.toLowerCase()).toBe(m.tokens.USDC.address.toLowerCase());
    expect(s.usdc.decimals).toBe(m.tokens.USDC.decimals);
    expect(s.usdt.address.toLowerCase()).toBe(m.tokens.USDT.address.toLowerCase());
    expect(s.usdt.decimals).toBe(m.tokens.USDT.decimals);
  });
});

describe("contracts.manifest.json ↔ public SDK", () => {
  it.each(CHAINS)("%s: SDK embeds the manifest implContract", (chain) => {
    const m = manifest.chains[chain];
    expect(sdkSource).toContain(m.implContract);
  });

  it.each(CHAINS)("%s: SDK embeds the manifest chainId", (chain) => {
    const m = manifest.chains[chain];
    expect(sdkSource).toMatch(new RegExp(`chainId:\\s*${m.chainId}\\b`));
  });

  it("SDK uses the unified TransferAuthorization witness type for all 5 chains", () => {
    expect(sdkSource).toContain("Q402_TRANSFER_AUTH_TYPES");
    expect(sdkSource).toContain("TransferAuthorization:");
    expect(sdkSource).not.toContain("PaymentWitness");
    expect(sdkSource).not.toContain("Q402_WITNESS_TYPES");
  });

  it.each(CHAINS)("%s: SDK embeds the manifest domain name", (chain) => {
    const m = manifest.chains[chain];
    expect(sdkSource).toContain(m.witness.domainName);
  });

  it.each(CHAINS)("%s: manifest declares TransferAuthorization + userEOA verifyingContract", (chain) => {
    const m = manifest.chains[chain];
    expect(m.witness.type).toBe("TransferAuthorization");
    expect(m.witness.verifyingContractRule).toBe("userEOA");
  });

  it("Stable chain USDC and USDT both alias to USDT0", () => {
    const m = manifest.chains.stable;
    expect(m.tokens.USDC.aliasFor).toBe("USDT0");
    expect(m.tokens.USDT.aliasFor).toBe("USDT0");
    expect(m.tokens.USDC.address.toLowerCase()).toBe(m.tokens.USDT.address.toLowerCase());
  });

  it("X Layer EIP-3009 fallback is declared USDC-only", () => {
    const m = manifest.chains.xlayer;
    expect(m.fallbackRelayMode).toBe("eip3009");
    expect(m.fallbackTokens).toEqual(["USDC"]);
  });
});
