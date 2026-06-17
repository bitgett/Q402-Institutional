/**
 * mcp-consent-schema-parity.test.ts
 *
 * Two-phase consent tools accept a `consentToken` on the confirming re-call.
 * The handler validates it via the Zod schema (which declares consentToken),
 * but MCP CLIENTS read the EXPORTED JSON `inputSchema` to decide which args a
 * tool accepts — and every such tool sets `additionalProperties: false`. If a
 * tool declares consentToken in Zod but OMITS it from inputSchema.properties,
 * a strict client can refuse / strip the token on the confirming call, leaving
 * the tool stuck returning a preview forever (it can never be confirmed).
 *
 * Regression: pay.ts / batch-pay.ts / request-pay.ts previously omitted
 * consentToken from inputSchema while bridge-send / yield-deposit /
 * yield-withdraw declared it — a real Zod<->JSON drift. This pins parity for
 * ALL two-phase tools so the omission can't recur, and pins the SET of
 * two-phase tools so the README "six fund-moving tools" copy stays honest.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// CRLF→LF so the anchored regexes work in CRLF Windows checkouts too.
function readLF(p: string): string {
  return readFileSync(p, "utf8").replace(/\r\n/g, "\n");
}

const TOOLS_DIR = resolve(__dirname, "..", "mcp-server", "src", "tools");
const available = existsSync(TOOLS_DIR);
const toolFiles = available ? readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts")) : [];

// A field declaration `consentToken: z...` in the Zod schema → two-phase tool.
const ZOD_CONSENT = /^\s*consentToken:\s*z\b/m;
// A property `consentToken: { ... }` in the exported JSON inputSchema.
const JSON_CONSENT = /^\s*consentToken:\s*\{/m;

describe.skipIf(!available)("MCP two-phase consent Zod<->JSON schema parity", () => {
  const twoPhase = toolFiles.filter((f) => ZOD_CONSENT.test(readLF(resolve(TOOLS_DIR, f))));

  it("finds exactly the six fund-moving two-phase consent tools", () => {
    // If this set changes, the README / landing copy that says "six
    // fund-moving tools use two-phase consent" must change with it.
    expect([...twoPhase].sort()).toEqual(
      [
        "batch-pay.ts",
        "bridge-send.ts",
        "pay.ts",
        "request-pay.ts",
        "yield-deposit.ts",
        "yield-withdraw.ts",
      ].sort(),
    );
  });

  it.each(twoPhase)("%s mirrors consentToken into its exported inputSchema", (f) => {
    const src = readLF(resolve(TOOLS_DIR, f));
    expect(
      JSON_CONSENT.test(src),
      `${f} declares consentToken in its Zod schema but NOT in inputSchema.properties — ` +
        `a strict MCP client (additionalProperties:false) could strip it on the confirming call.`,
    ).toBe(true);
  });
});
