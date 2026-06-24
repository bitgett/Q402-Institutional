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
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from "@/app/api/mcp/info/version";
import { MCP_VERSION } from "@/app/lib/version";
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

  it("PACKAGE_VERSION matches the single source of truth in app/lib/version.ts", () => {
    // The /api/mcp/info discovery route and the UI both surface a published
    // version. They live in two files (api/mcp/info/version.ts can't import the
    // gitignored mcp-server/ workspace, so it mirrors the constant). This
    // assertion ties them together so a publish bump can't leave the public
    // discovery endpoint reporting a stale version — exactly the drift that
    // shipped 0.8.22 on /api/mcp/info while everything else was 0.8.23.
    expect(PACKAGE_VERSION).toBe(MCP_VERSION);
  });
});

describe("operator scripts — MCP service drift guard", () => {
  // The runtime metadata builder is HTTPS-correct (see test above) but
  // the operator-only register/update scripts hardcode their own
  // metadata payload. If either drifts back to `npm://`, an operator
  // running the script unaware of the rollback would undo the work in
  // commit 04a07fb (Unhealthy on 8004scan again). Pin both files.
  const registerSrc = readFileSync(
    resolve(__dirname, "..", "scripts", "register-q402-self.mjs"),
    "utf8",
  );
  const updateSrc = readFileSync(
    resolve(__dirname, "..", "scripts", "update-q402-agent.mjs"),
    "utf8",
  );

  it("register-q402-self.mjs does NOT declare MCP endpoint as npm://", () => {
    expect(registerSrc).not.toMatch(/name:\s*"MCP"[\s\S]{0,80}npm:\/\//);
  });

  it("update-q402-agent.mjs does NOT declare MCP endpoint as npm://", () => {
    expect(updateSrc).not.toMatch(/name:\s*"MCP"[\s\S]{0,80}npm:\/\//);
  });

  it("both scripts point the MCP service at the HTTPS discovery endpoint", () => {
    expect(registerSrc).toMatch(/name:\s*"MCP"[\s\S]{0,120}\/api\/mcp\/info/);
    expect(updateSrc).toMatch(/name:\s*"MCP"[\s\S]{0,120}\/api\/mcp\/info/);
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

describe("/api/mcp/info tools[] == MCP server tool handlers (drift guard)", () => {
  // The discovery endpoint hardcodes a tools[] array; the MCP server registers
  // its real tools as CallTool `case "q402_…"` handlers. These drifted before:
  // q402_stake / q402_unstake shipped on npm but were missing from /api/mcp/info,
  // so an indexer saw 27 tools where the package exposed 29. This pins the two
  // together. Reads the gitignored mcp-server/ workspace off disk — skips if it
  // isn't checked out (the local pre-publish run is the real gate).
  const infoSrc = readFileSync(
    resolve(__dirname, "..", "app", "api", "mcp", "info", "route.ts"),
    "utf8",
  );
  const indexPath = resolve(__dirname, "..", "mcp-server", "src", "index.ts");

  const infoTools = [...infoSrc.matchAll(/name:\s*"(q402_[a-z_]+)"/g)].map((m) => m[1]).sort();

  it.skipIf(!existsSync(indexPath))(
    "every MCP CallTool handler is advertised in /api/mcp/info, and vice versa",
    () => {
      const indexSrc = readFileSync(indexPath, "utf8");
      // CallTool handlers — the authoritative enumeration of callable tools.
      const handlerTools = [...indexSrc.matchAll(/case\s+"(q402_[a-z_]+)":/g)].map((m) => m[1]).sort();
      expect(handlerTools.length).toBeGreaterThan(0);
      expect(infoTools).toEqual(handlerTools);
    },
  );
});
