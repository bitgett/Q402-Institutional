import { describe, it, expect } from "vitest";
import {
  isA2mcpChain, isStableToken, validateAmount, payDescriptor, requestDescriptor, A2MCP_CHAINS,
} from "@/app/lib/a2mcp";

describe("a2mcp input guards", () => {
  it("accepts the 11 relay chains, rejects others", () => {
    for (const c of A2MCP_CHAINS) expect(isA2mcpChain(c)).toBe(true);
    expect(isA2mcpChain("sepolia")).toBe(false);
    expect(isA2mcpChain("solana")).toBe(false);
    expect(isA2mcpChain(42)).toBe(false);
  });

  it("accepts only USDC / USDT", () => {
    expect(isStableToken("USDC")).toBe(true);
    expect(isStableToken("USDT")).toBe(true);
    expect(isStableToken("DAI")).toBe(false);
    expect(isStableToken(null)).toBe(false);
  });

  it("validates decimal-string amounts", () => {
    expect(validateAmount("1.5")).toEqual({ ok: true, amount: "1.5" });
    expect(validateAmount("100")).toEqual({ ok: true, amount: "100" });
    expect((validateAmount("0") as { ok: false }).ok).toBe(false);
    expect((validateAmount("-1") as { ok: false }).ok).toBe(false);
    expect((validateAmount("1.5", 0) as { ok: false }).ok).toBe(false);       // too many decimals
    expect(validateAmount("1.234567").ok).toBe(true);                          // exactly 6 dp = ok
    expect((validateAmount("1.2345678") as { ok: false }).ok).toBe(false);     // > 6 dp default
    expect(validateAmount("1.234567", 18).ok).toBe(true);
    expect((validateAmount(5 as unknown) as { ok: false }).ok).toBe(false);    // not a string
    expect((validateAmount("2000000") as { ok: false }).ok).toBe(false);       // over cap
  });

  it("descriptors advertise a free price + the endpoint", () => {
    const p = payDescriptor("https://q402.quackai.ai/api/a2mcp/pay");
    expect(p.price).toBe("0");
    expect(p.endpoint).toBe("https://q402.quackai.ai/api/a2mcp/pay");
    expect(p.method).toBe("POST");
    const r = requestDescriptor("https://q402.quackai.ai/api/a2mcp/request");
    expect(r.price).toBe("0");
    expect(r.service).toBe("Q402 Payment Request");
  });
});
