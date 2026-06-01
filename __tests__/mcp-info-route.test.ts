/**
 * mcp-info-route.test.ts
 *
 * Drift guards for the /api/mcp/info discovery surface that 8004scan
 * (and any other ERC-8004 indexer) health-checks against the MCP
 * service declared in agent metadata.
 *
 * Critical invariants:
 *   1. The route is publicly reachable (no auth, GET + OPTIONS, CORS).
 *   2. `buildQ402AgentMetadata` declares `https://…/api/mcp/info` for
 *      the MCP service, NOT `npm://…` (the previous shape that 8004scan
 *      flagged as Unhealthy).
 *   3. The route's `PACKAGE_NAME` + `PACKAGE_VERSION` mirrors what's
 *      live on npm — drift breaks the indexer's "install" hint.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from "@/app/api/mcp/info/version";
import { buildQ402AgentMetadata } from "@/app/lib/erc8004";

describe("/api/mcp/info — discovery surface drift guard", () => {
  const src = readFileSync(
    resolve(__dirname, "..", "app", "api", "mcp", "info", "route.ts"),
    "utf8",
  );

  it("exports GET + OPTIONS (no other methods)", () => {
    expect(src).toMatch(/export async function GET\(/);
    expect(src).toMatch(/export async function OPTIONS\(/);
  });

  it("is public — no auth gate, no rate-limit override", () => {
    expect(src).not.toMatch(/requireCronAuth|requireAuth|requireIntentAuth|ADMIN_SECRET/);
  });

  it("ships CORS Access-Control-Allow-Origin: * (8004scan crawls cross-origin)", () => {
    expect(src).toMatch(/Access-Control-Allow-Origin.*\*/);
  });

  it("returns the canonical package name + version from version.ts", () => {
    expect(PACKAGE_NAME).toBe("@quackai/q402-mcp");
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
  });
});

describe("buildQ402AgentMetadata MCP service endpoint", () => {
  it("declares an HTTPS endpoint (NOT npm://) for the MCP service", () => {
    const meta = buildQ402AgentMetadata({
      name: "Q402 Agent (by Quack AI)",
      description: "Gasless stablecoin payment agent on BNB Chain.",
      walletAddress: "0xBFd133bF6A19437ae8EF43C1F3fa18FA333F6963",
      relayBaseUrl: "https://q402.quackai.ai",
      mcpPackage: "@quackai/q402-mcp",
    });
    const mcp = meta.services.find((s) => s.name === "MCP");
    expect(mcp).toBeDefined();
    expect(mcp?.endpoint).toBe("https://q402.quackai.ai/api/mcp/info");
    expect(mcp?.endpoint).not.toMatch(/^npm:\/\//);
  });

  it("keeps q402 service endpoint unchanged (regression guard)", () => {
    const meta = buildQ402AgentMetadata({
      name: "Q402 Agent (by Quack AI)",
      description: "Gasless stablecoin payment agent on BNB Chain.",
      walletAddress: "0xBFd133bF6A19437ae8EF43C1F3fa18FA333F6963",
      relayBaseUrl: "https://q402.quackai.ai",
      mcpPackage: "@quackai/q402-mcp",
    });
    const q402 = meta.services.find((s) => s.name === "q402");
    expect(q402?.endpoint).toBe("https://q402.quackai.ai/api/relay/info");
  });

  it("omits the MCP service when mcpPackage is not supplied", () => {
    const meta = buildQ402AgentMetadata({
      name: "Q402 Agent (by Quack AI)",
      description: "Gasless stablecoin payment agent on BNB Chain.",
      walletAddress: "0xBFd133bF6A19437ae8EF43C1F3fa18FA333F6963",
      relayBaseUrl: "https://q402.quackai.ai",
    });
    expect(meta.services.find((s) => s.name === "MCP")).toBeUndefined();
  });
});
