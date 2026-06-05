/**
 * ccip-config.test.ts
 *
 * Pin the CCIP integration's source-of-truth invariants:
 *   - The 3-chain triangle (eth/avax/arbitrum) is the ONLY supported scope.
 *     A future commit accidentally adding bnb/mantle/scroll/etc. without
 *     verifying their USDC pool's getSupportedChains() will trip this.
 *   - chainSelector + router + linkToken values match the canonical
 *     Chainlink mainnet deployments (cross-referenced against
 *     smartcontractkit/documentation chains.json).
 *   - supportedDestinations is symmetric — if A lists B, then B lists A.
 *     CCIP lanes ARE bidirectional in our scope; a missing pair would
 *     silently break one direction at runtime.
 *   - The chain set is a STRICT SUBSET of the main contracts.manifest
 *     chain set, so we never accidentally CCIP a chain we don't actually
 *     operate on.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Manifest {
  version: string;
  chains: Record<string, unknown>;
  ccip: {
    version: string;
    chains: Record<string, {
      chainSelector: string;
      router: string;
      linkToken: string;
      sender: string;
      supportedDestinations: string[];
      explorer: string;
      ccipExplorer: string;
    }>;
    feeTokens: Record<string, number>;
    gasTankSchema: {
      linkChains: string[];
      linkKey: string;
      nativeKey: string;
    };
    feePolicy: { q402Markup: number };
  };
}

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "..", "contracts.manifest.json"), "utf8"),
) as Manifest;

const CCIP_CHAINS = ["eth", "avax", "arbitrum"] as const;

// Canonical values from on-chain investigation + smartcontractkit/documentation
// (chains.json v1_2_0/mainnet). If Chainlink ever redeploys the routers
// these constants need updating in lockstep — but that's a once-a-year
// event and the test will catch the drift loudly.
const EXPECTED: Record<typeof CCIP_CHAINS[number], {
  chainSelector: string;
  router: string;
  linkToken: string;
}> = {
  eth: {
    chainSelector: "5009297550715157269",
    router:        "0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D",
    linkToken:     "0x514910771AF9Ca656af840dff83E8264EcF986CA",
  },
  avax: {
    chainSelector: "6433500567565415381",
    router:        "0xF4c7E640EdA248ef95972845a62bdC74237805dB",
    linkToken:     "0x5947BB275c521040051D82396192181b413227A3",
  },
  arbitrum: {
    chainSelector: "4949039107694359620",
    router:        "0x141fa059441E0ca23ce184B6A78bafD2A517DdE8",
    linkToken:     "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
  },
};

describe("contracts.manifest.json — ccip block", () => {
  it("exists and uses CCIP version 1.6.0", () => {
    expect(manifest.ccip).toBeDefined();
    expect(manifest.ccip.version).toBe("1.6.0");
  });

  it("declares EXACTLY the 3-chain triangle (eth/avax/arbitrum)", () => {
    // Adding a 4th chain without verifying its USDC pool's
    // getSupportedChains() on-chain would silently break bridges.
    expect(Object.keys(manifest.ccip.chains).sort()).toEqual([...CCIP_CHAINS].sort());
  });

  it.each(CCIP_CHAINS)("%s: chainSelector matches Chainlink canonical value", (chain) => {
    expect(manifest.ccip.chains[chain].chainSelector).toBe(EXPECTED[chain].chainSelector);
  });

  it.each(CCIP_CHAINS)("%s: router address matches Chainlink mainnet deployment", (chain) => {
    expect(manifest.ccip.chains[chain].router).toBe(EXPECTED[chain].router);
  });

  it.each(CCIP_CHAINS)("%s: LINK token address matches canonical Chainlink LINK", (chain) => {
    expect(manifest.ccip.chains[chain].linkToken).toBe(EXPECTED[chain].linkToken);
  });

  it("CCIP chain set is a strict subset of main contracts.manifest chains", () => {
    // Catches a class of error where someone CCIPs a chain we don't actually
    // run Q402 settlements on — the bridge destination wouldn't have an
    // Agentic Wallet to receive into.
    for (const c of CCIP_CHAINS) {
      expect(manifest.chains[c], `CCIP chain "${c}" missing from main manifest.chains`).toBeDefined();
    }
  });

  it("supportedDestinations is bidirectionally symmetric", () => {
    // If A → B is supported but B → A is not, the UI would show stale
    // lane options. CCIP lanes in our scope ARE bidirectional; a one-way
    // entry is a bug.
    for (const src of CCIP_CHAINS) {
      const dests = manifest.ccip.chains[src].supportedDestinations;
      for (const dst of dests) {
        const reverse = manifest.ccip.chains[dst]?.supportedDestinations;
        expect(reverse, `dest chain "${dst}" missing from ccip.chains`).toBeDefined();
        expect(
          reverse,
          `lane asymmetry: ${src} → ${dst} listed, but ${dst} → ${src} missing`,
        ).toContain(src);
      }
    }
  });

  it("self-edge: source is never in its own supportedDestinations", () => {
    for (const src of CCIP_CHAINS) {
      expect(
        manifest.ccip.chains[src].supportedDestinations,
        `${src} lists itself as a CCIP destination`,
      ).not.toContain(src);
    }
  });

  it("each chain lists exactly 2 destinations (the other 2 of the triangle)", () => {
    for (const src of CCIP_CHAINS) {
      expect(manifest.ccip.chains[src].supportedDestinations).toHaveLength(2);
    }
  });

  it("feeTokens enum matches contract constants", () => {
    // Contract FEE_TOKEN_LINK=0, FEE_TOKEN_NATIVE=1 — see Q402CCIPSender.sol
    expect(manifest.ccip.feeTokens).toEqual({ LINK: 0, native: 1 });
  });

  it("Gas Tank LINK slot is scoped to exactly the 3 CCIP chains", () => {
    // Drift guard: extending Gas Tank LINK slot to chains we don't have
    // a CCIP router for would be unrecoverable spend (user thinks they
    // can bridge from BNB, server accepts LINK deposit, no actual bridge).
    expect([...manifest.ccip.gasTankSchema.linkChains].sort()).toEqual([...CCIP_CHAINS].sort());
  });

  it("Gas Tank LINK key shape mirrors the existing native key shape", () => {
    expect(manifest.ccip.gasTankSchema.nativeKey).toBe("gastank:{address}:{chain}");
    expect(manifest.ccip.gasTankSchema.linkKey).toBe("gastank:{address}:{chain}:link");
  });

  it("Q402 markup fee is zero (user pays only actual CCIP cost)", () => {
    expect(manifest.ccip.feePolicy.q402Markup).toBe(0);
  });

  it.each(CCIP_CHAINS)("%s: sender field is set (post-deploy)", (chain) => {
    const sender = manifest.ccip.chains[chain].sender;
    // PENDING_DEPLOY allowed during pre-launch. Once filled in, it must be
    // a valid checksummed EVM address. This assertion accepts both.
    expect(
      sender === "PENDING_DEPLOY" || /^0x[0-9a-fA-F]{40}$/.test(sender),
      `${chain} sender field is malformed (got "${sender}")`,
    ).toBe(true);
  });
});
