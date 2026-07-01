/**
 * Q402 A2MCP services (OKX.AI ASP #2831) — two FREE, agent-callable endpoints:
 *
 *   POST /api/a2mcp/pay      execute a gasless stablecoin payment (agent sends a
 *                            signed Q402 authorization; Q402 relays it on-chain).
 *   POST /api/a2mcp/request  create a real, payable Q402 payment-request.
 *
 * Both are free (the OKX service fee is 0). `pay` moves ONLY funds the caller
 * cryptographically signed for (the on-chain signature is the authority — no
 * theft vector), and it forwards to the existing, audited /api/relay via a
 * Q402-owned, quota-bounded key so ALL of the relay's safety (sanctions screening,
 * witness verification, chain/gas checks, settlement) is reused verbatim and the
 * key's quota is the hard cap on Q402's gas sponsorship.
 *
 * Inert unless A2MCP_ENABLED=1 (mirrors the escrow gate).
 */

export const A2MCP_ENABLED = process.env.A2MCP_ENABLED === "1";

/** Q402-owned, quota-bounded relay key the /pay wrapper injects (the gas cap). */
export const A2MCP_RELAY_KEY = process.env.A2MCP_RELAY_KEY ?? "";

/**
 * The relay URL /pay forwards to. MUST be a fixed, server-controlled origin —
 * NEVER derived from the request (a spoofed Host header would otherwise exfiltrate
 * the injected A2MCP_RELAY_KEY to an attacker). Defaults to the canonical prod relay.
 */
export const A2MCP_RELAY_URL = process.env.A2MCP_RELAY_URL ?? "https://q402.quackai.ai/api/relay";

/**
 * Hard daily cap on the number of /pay calls forwarded to the relay (i.e. the
 * max gas-sponsoring settlements per day). A CODE-level bound so a mis-provisioned
 * key can never become an unbounded gas faucet. 0 disables the cap.
 */
export const A2MCP_PAY_DAILY_CAP = Number.isFinite(Number(process.env.A2MCP_PAY_DAILY_CAP))
  ? Number(process.env.A2MCP_PAY_DAILY_CAP)
  : 300;

export const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;
export const AMOUNT_RE = /^\d+(\.\d+)?$/;

/** The chains Q402 relays on (mirrors relayer CHAIN_CONFIG keys). */
export const A2MCP_CHAINS = [
  "bnb", "eth", "avax", "xlayer", "stable", "mantle",
  "injective", "monad", "scroll", "arbitrum", "base",
] as const;
export type A2mcpChain = (typeof A2MCP_CHAINS)[number];

export function isA2mcpChain(c: unknown): c is A2mcpChain {
  return typeof c === "string" && (A2MCP_CHAINS as readonly string[]).includes(c);
}
export function isStableToken(t: unknown): t is "USDC" | "USDT" {
  return t === "USDC" || t === "USDT";
}

/**
 * Validate a positive decimal-string amount that fits `decimals` places. Amounts
 * are ALWAYS decimal strings (never JS Number) — 18-dec tokens lose precision as
 * floats. Returns the trimmed string or an error.
 */
export function validateAmount(raw: unknown, decimals = 6): { ok: true; amount: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || !AMOUNT_RE.test(raw)) return { ok: false, error: "amount must be a positive decimal string" };
  if (!(Number(raw) > 0)) return { ok: false, error: "amount must be greater than 0" };
  const dot = raw.indexOf(".");
  if (dot !== -1 && raw.length - dot - 1 > decimals) return { ok: false, error: `amount has more than ${decimals} decimals` };
  if (Number(raw) > 1_000_000) return { ok: false, error: "amount exceeds the per-call maximum of 1,000,000" };
  return { ok: true, amount: raw };
}

/** Self-describing manifest returned on GET — lets OKX / an agent introspect the service. */
export function payDescriptor(resource: string) {
  return {
    service: "Q402 Gasless Payment",
    description: "Execute a gasless stablecoin payment on BNB Chain. The caller signs a Q402 transfer authorization; Q402 relays it on-chain and sponsors the gas.",
    method: "POST",
    endpoint: resource,
    price: "0",
    input: {
      chain: "bnb",
      token: "USDC or USDT",
      from: "payer EOA (must match the signature)",
      to: "recipient address",
      amount: "atomic base-units integer string matching your signed authorization, e.g. \"1500000\" = 1.5 USDC (6 dp)",
      nonce: "payment nonce",
      deadline: "unix seconds",
      witnessSig: "EIP-712 TransferAuthorization signature",
      authorization: "EIP-7702 authorization tuple { chainId, address, nonce, yParity, r, s }",
    },
    docs: "https://q402.quackai.ai/docs",
  };
}

export function requestDescriptor(resource: string) {
  return {
    service: "Q402 Payment Request",
    description: "Create a payable Q402 payment-request link. Anyone can pay it gaslessly, no account required.",
    method: "POST",
    endpoint: resource,
    price: "0",
    input: {
      chain: `one of: ${A2MCP_CHAINS.join(", ")}`,
      token: "USDC or USDT",
      amount: "decimal string, e.g. \"1.5\"",
      recipient: "address to be paid (required)",
      memo: "optional note, <= 200 chars",
    },
    docs: "https://q402.quackai.ai/docs",
  };
}
