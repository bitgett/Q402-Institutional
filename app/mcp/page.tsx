import { redirect } from "next/navigation";

/**
 * /mcp is a guessable alias. The canonical MCP install + onboarding page is
 * /claude (kept at that URL for backlink stability: npm README, the Anthropic
 * Registry, and prior tweets all point there). Redirect so /mcp lands on the
 * real, complete page instead of a second, competing MCP surface.
 */
export default function McpAlias(): never {
  redirect("/claude");
}
