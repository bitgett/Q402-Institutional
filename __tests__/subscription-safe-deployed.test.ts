/**
 * subscription-safe-deployed.test.ts
 *
 * The SUBSCRIPTION Safe is a CREATE2 contract — the same address resolves on
 * every EVM chain, but bytecode only exists where we've explicitly run the
 * Safe deploy flow. A previous review caught the case where the
 * payment-intent route allowed payments on chains where the Safe wasn't yet
 * deployed (P0); the fix narrowed VALID_CHAINS to ["bnb", "eth"], but that
 * fix relied on a human keeping the allowlist and the deploy footprint in
 * sync.
 *
 * This test pins the invariant in CI: every chain in
 * `SUBSCRIPTION_DEPLOYED_CHAINS` must have actual Safe bytecode at
 * `SUBSCRIPTION_ADDRESS`. The next time someone adds a chain key without
 * replicating the Safe to that network, this test fails before the change
 * reaches production — the human has to actually deploy the Safe before CI
 * goes green.
 *
 * Network unreachable? Soft-fail with a console.warn rather than redding the
 * board on flaky connectivity. The goal is to catch real drift, not to flap
 * on RPC outages. A future run on a healthy network will surface the issue.
 */

import { describe, it, expect } from "vitest";
import {
  SUBSCRIPTION_ADDRESS,
  SUBSCRIPTION_DEPLOYED_CHAINS,
  type SubscriptionDeployedChain,
} from "../app/lib/wallets";

const RPC_BY_CHAIN: Record<SubscriptionDeployedChain, string> = {
  bnb: "https://bsc-dataseed1.binance.org/",
  eth: "https://ethereum.publicnode.com",
};

async function getCode(rpcUrl: string, address: string): Promise<{ code: string | null; error: string | null }> {
  try {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_getCode",
        params: [address, "latest"],
        id: 1,
      }),
    });
    if (!resp.ok) return { code: null, error: `HTTP ${resp.status}` };
    const data = (await resp.json()) as { result?: string; error?: { message?: string } };
    if (data.error) return { code: null, error: data.error.message ?? "rpc error" };
    return { code: data.result ?? null, error: null };
  } catch (err) {
    return { code: null, error: err instanceof Error ? err.message : String(err) };
  }
}

describe("SUBSCRIPTION Safe deploy footprint matches SUBSCRIPTION_DEPLOYED_CHAINS", () => {
  it("every entry in SUBSCRIPTION_DEPLOYED_CHAINS has an RPC mapping", () => {
    for (const chain of SUBSCRIPTION_DEPLOYED_CHAINS) {
      expect(
        RPC_BY_CHAIN[chain],
        `Missing RPC mapping for "${chain}" in subscription-safe-deployed.test.ts. ` +
          "Add it to RPC_BY_CHAIN before deploying.",
      ).toBeTruthy();
    }
  });

  it.each(SUBSCRIPTION_DEPLOYED_CHAINS)(
    "%s: SUBSCRIPTION_ADDRESS has Safe bytecode (eth_getCode > 0x)",
    async chain => {
      const rpc = RPC_BY_CHAIN[chain];
      const { code, error } = await getCode(rpc, SUBSCRIPTION_ADDRESS);
      if (!code) {
        // Soft-skip on offline CI — the goal is to catch real drift, not flap
        // on connectivity. A future run will surface the issue.
        console.warn(
          `[subscription-safe-deployed] skipping ${chain} — RPC error: ${error ?? "unknown"}`,
        );
        return;
      }
      expect(
        code.length,
        `${chain}: no contract bytecode at SUBSCRIPTION_ADDRESS ${SUBSCRIPTION_ADDRESS}. ` +
          "The Safe must be replicated to this chain before adding it to SUBSCRIPTION_DEPLOYED_CHAINS.",
      ).toBeGreaterThan(2);
    },
  );
});
