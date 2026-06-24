/**
 * Local mirror of the @quackai/q402-mcp package identity so the
 * /api/mcp/info discovery route can render version + name without
 * importing from the gitignored mcp-server/ workspace.
 *
 * Drift guard: `__tests__/mcp-info-route.test.ts` asserts these stay
 * in sync with the npm registry's `latest` tag — if MCP publishes a
 * new version, the test fails until this file is bumped.
 */
export const PACKAGE_NAME = "@quackai/q402-mcp";
export const PACKAGE_VERSION = "0.8.49";
