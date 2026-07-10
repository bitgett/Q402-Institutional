import { describe, it, expect } from "vitest";
import manifest from "../contracts.manifest.json";
import {
  OFT_CONFIG, OFT_CHAINS, isOftChain, isOftLane, oftLaneMatrix,
  buildSendParam, type OftChainKey,
} from "@/app/lib/usdt0";

// Drift guard: app/lib/usdt0.ts OFT_CONFIG must stay in sync with manifest.oft.
// Companion to ccip-config.test.ts.
describe("OFT config ↔ manifest.oft", () => {
  const RAW = manifest.oft;

  it("has the v1 chain set", () => {
    expect(OFT_CHAINS).toEqual(["eth", "arbitrum", "mantle", "monad", "xlayer"]);
    for (const k of OFT_CHAINS) expect(RAW.chains).toHaveProperty(k);
  });

  it("eid / oft / decimals mirror the manifest", () => {
    for (const k of OFT_CHAINS) {
      const m = (RAW.chains as Record<string, { eid: number; oft: string; decimals: number }>)[k];
      expect(OFT_CONFIG[k].eid).toBe(m.eid);
      expect(OFT_CONFIG[k].oft.toLowerCase()).toBe(m.oft.toLowerCase());
      expect(OFT_CONFIG[k].decimals).toBe(m.decimals);
    }
  });

  it("every eid is a distinct LayerZero v2 endpoint id (>= 30000)", () => {
    const eids = OFT_CHAINS.map((k) => OFT_CONFIG[k].eid);
    expect(new Set(eids).size).toBe(eids.length);
    for (const e of eids) expect(e).toBeGreaterThanOrEqual(30000);
  });

  it("Ethereum is the adapter; the rest are native OFTs", () => {
    expect(OFT_CONFIG.eth.oftType).toBe("adapter");
    for (const k of OFT_CHAINS.filter((c) => c !== "eth")) {
      expect(OFT_CONFIG[k].oftType).toBe("native");
    }
  });

  it("lane matrix is symmetric and self-free", () => {
    const lanes = oftLaneMatrix();
    for (const { src, dst } of lanes) {
      expect(src).not.toBe(dst);
      expect(isOftLane(dst as OftChainKey, src as OftChainKey)).toBe(true); // reverse lane exists
    }
    // full mesh among 5 chains => 5 * 4 = 20 directed lanes
    expect(lanes.length).toBe(20);
  });

  it("isOftChain guards the set", () => {
    expect(isOftChain("mantle")).toBe(true);
    expect(isOftChain("base")).toBe(false);
    expect(isOftChain("avax")).toBe(false); // CCIP chain, not an OFT chain here
  });

  it("buildSendParam left-pads the owner into SendParam.to (recipient = self)", () => {
    const owner = "0x000000000000000000000000000000000000dEaD";
    const sp = buildSendParam(owner, 30181, 1_000_000n, 990_000n);
    expect(sp[0]).toBe(30181);                                  // dstEid
    expect(sp[1].toLowerCase()).toBe("0x000000000000000000000000" + owner.slice(2).toLowerCase()); // to
    expect(sp[2]).toBe(1_000_000n);                             // amountLD
    expect(sp[3]).toBe(990_000n);                               // minAmountLD
    expect(sp[5]).toBe("0x");                                   // composeMsg empty
    expect(sp[6]).toBe("0x");                                   // oftCmd empty
  });

  it("sender addresses are empty until deployed (env-overridable)", () => {
    // v1 ships with empty senders; the route returns OFT_SENDER_NOT_DEPLOYED
    // until Q402OftSender is deployed + the manifest/env carries the address.
    for (const k of OFT_CHAINS) {
      const s = OFT_CONFIG[k].sender;
      expect(typeof s).toBe("string");
    }
  });
});
