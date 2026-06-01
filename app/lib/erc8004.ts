/**
 * erc8004.ts — minimal client for the ERC-8004 Identity Registry.
 *
 * Wraps the canonical IdentityRegistry deployment on each supported
 * chain (BSC mainnet first; the registry is also live on Ethereum, Base,
 * Polygon, Arbitrum, Celo per the EIP-8004 multi-chain rollout). We
 * expose just the surface we need: encode the `register(agentURI,
 * metadata)` calldata for a user-signed mint, parse the resulting
 * `Registered` event to capture the assigned `agentId`, and read back
 * `tokenURI` / `getAgentWallet` / `ownerOf`.
 *
 * IMPORTANT: this module never holds keys. Mints are submitted by the
 * user's EOA (one-time MetaMask popup) — the NFT is owned by msg.sender
 * and the metadata JSON declares the Agent Wallet address as the
 * service endpoint. The "agent wallet binding" via `setAgentWallet` is
 * an optional second step that can be added later via EIP-712 permit;
 * v1 leaves Agent Wallet linkage implicit through the registration
 * file's `services[]` entry.
 *
 * Sources:
 *   EIP-8004 spec — https://eips.ethereum.org/EIPS/eip-8004
 *   Verified impl — bscscan.com/address/0x7274e874ca62410a93bd8bf61c69d8045e399c02
 */

import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";

export type Erc8004Network = "bsc" | "bsc-testnet" | "eth" | "base" | "polygon" | "arbitrum" | "celo";

interface NetworkConfig {
  chainId: number;
  name: string;
  rpc: string;
  /** Address of the canonical IdentityRegistry proxy. */
  registry: Address;
  /** Public explorer URL prefix for an agent — append `${agentId}`. */
  scanAgentPrefix: string;
}

const REGISTRY_BSC = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;

// 8004scan uses chain-slug paths, NOT EIP-155 CAIP-2 IDs. Verified
// against https://8004scan.io/agents — live entries link as
// `/agents/bsc/{id}` and `/agents/xlayer/{id}`. The earlier
// `/eip155:56/agent/{id}` was a guess and 404s. Slug list inferred
// from the public Browse Agents listing; chains 8004scan doesn't
// surface yet (eth/base/polygon/arbitrum/celo) follow the same shape
// using the conventional lower-case chain slug.
export const ERC8004_NETWORKS: Record<Erc8004Network, NetworkConfig> = {
  "bsc": {
    chainId: 56,
    name: "BNB Smart Chain",
    rpc: process.env.BSC_RPC_URL ?? "https://bsc-dataseed.binance.org",
    registry: REGISTRY_BSC,
    scanAgentPrefix: "https://8004scan.io/agents/bsc/",
  },
  "bsc-testnet": {
    chainId: 97,
    name: "BNB Smart Chain Testnet",
    rpc: process.env.BSC_TESTNET_RPC_URL ?? "https://data-seed-prebsc-1-s1.binance.org:8545",
    registry: REGISTRY_BSC,
    scanAgentPrefix: "https://8004scan.io/agents/bsc-testnet/",
  },
  "eth": {
    chainId: 1,
    name: "Ethereum",
    rpc: process.env.ETH_RPC_URL ?? "https://ethereum.publicnode.com",
    registry: REGISTRY_BSC,
    scanAgentPrefix: "https://8004scan.io/agents/ethereum/",
  },
  "base": {
    chainId: 8453,
    name: "Base",
    rpc: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
    registry: REGISTRY_BSC,
    scanAgentPrefix: "https://8004scan.io/agents/base/",
  },
  "polygon": {
    chainId: 137,
    name: "Polygon",
    rpc: process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com",
    registry: REGISTRY_BSC,
    scanAgentPrefix: "https://8004scan.io/agents/polygon/",
  },
  "arbitrum": {
    chainId: 42161,
    name: "Arbitrum One",
    rpc: process.env.ARBITRUM_RPC_URL ?? "https://arb1.arbitrum.io/rpc",
    registry: REGISTRY_BSC,
    scanAgentPrefix: "https://8004scan.io/agents/arbitrum/",
  },
  "celo": {
    chainId: 42220,
    name: "Celo",
    rpc: process.env.CELO_RPC_URL ?? "https://forno.celo.org",
    registry: REGISTRY_BSC,
    scanAgentPrefix: "https://8004scan.io/agents/celo/",
  },
};

/** Verified-impl ABI fragments. Source: bscscan.com/address/0x7274…99c02. */
export const ERC8004_ABI = [
  // register() — three overloads. We use the agentURI-only variant; the
  // metadata is folded into the IPFS JSON itself per ERC-8004 v1.
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "setAgentURI",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newURI", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getAgentWallet",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  // Event: Registered(uint256 indexed agentId, string agentURI, address indexed owner)
  {
    type: "event",
    name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
] as const;

/**
 * Build the `register(agentURI)` calldata. Caller (frontend) submits
 * this through the user's wallet (`eth_sendTransaction`) so the NFT
 * mints to msg.sender.
 */
export function encodeRegister(agentURI: string): Hex {
  return encodeFunctionData({
    abi: ERC8004_ABI,
    functionName: "register",
    args: [agentURI],
  });
}

/**
 * Walk the receipt logs from a `register` submission and pull out the
 * `Registered` event. Returns null if not found (likely a wrong-tx
 * receipt was passed in).
 */
interface LogShape {
  address: string;
  topics: readonly Hex[];
  data: Hex;
}

export function parseRegisteredEvent(
  logs: readonly LogShape[],
  registryAddress: string,
): { agentId: bigint; owner: Address; agentURI: string } | null {
  const target = registryAddress.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== target) continue;
    try {
      const decoded = decodeEventLog({
        abi: ERC8004_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName === "Registered") {
        const args = decoded.args as { agentId: bigint; owner: Address; agentURI: string };
        return {
          agentId: args.agentId,
          owner: args.owner,
          agentURI: args.agentURI,
        };
      }
    } catch {
      /* not our event — keep scanning */
    }
  }
  return null;
}

/**
 * Server-side read of an existing agent's URI + owner + bound wallet.
 * Used by the dashboard card to render the "Agent #1234" badge and the
 * 8004scan link.
 */
export async function readAgent(
  network: Erc8004Network,
  agentId: bigint,
): Promise<{ owner: Address; agentURI: string; wallet: Address | null }> {
  const cfg = ERC8004_NETWORKS[network];
  const client = createPublicClient({
    chain: {
      id: cfg.chainId,
      name: cfg.name,
      nativeCurrency: { name: cfg.name, symbol: cfg.name, decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpc] } },
    },
    transport: http(cfg.rpc),
  });

  const [owner, agentURI] = await Promise.all([
    client.readContract({
      address: cfg.registry,
      abi: ERC8004_ABI,
      functionName: "ownerOf",
      args: [agentId],
    }),
    client.readContract({
      address: cfg.registry,
      abi: ERC8004_ABI,
      functionName: "tokenURI",
      args: [agentId],
    }),
  ]);

  // getAgentWallet is optional — return null if the call reverts (the
  // function exists on the contract but only returns non-zero if the
  // owner has bound a wallet via setAgentWallet).
  let wallet: Address | null = null;
  try {
    const w = (await client.readContract({
      address: cfg.registry,
      abi: ERC8004_ABI,
      functionName: "getAgentWallet",
      args: [agentId],
    })) as Address;
    wallet = w === "0x0000000000000000000000000000000000000000" ? null : getAddress(w);
  } catch {
    wallet = null;
  }

  return { owner: getAddress(owner as Address), agentURI: agentURI as string, wallet };
}

/**
 * Canonical ERC-8004 agent registration metadata shape (the JSON
 * document `tokenURI` resolves to). Q402 contributes a `services[]`
 * entry pointing at our relay endpoint so other ERC-8004-aware tools
 * can discover that this agent settles through Q402.
 */
export interface AgentMetadata {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
  name: string;
  description?: string;
  image?: string;
  services: Array<{
    name: "q402" | "MCP" | "A2A" | "ENS" | "web" | string;
    endpoint: string;
    version?: string;
    /** For service "q402": the Agent Wallet address that signs payments. */
    walletAddress?: string;
  }>;
  x402Support?: boolean;
  supportedTrust?: Array<"reputation" | "crypto-economic" | "tee-attestation">;
  /** Cross-chain identity list — left empty for v1 single-chain mints. */
  registrations?: Array<{
    agentId: number | string;
    agentRegistry: string;
  }>;
  /** Free-form key/value extension. */
  metadata?: Record<string, string>;
}

/** Helper used by the register-agent route to assemble Q402-flavoured
 *  metadata before storing it. */
export function buildQ402AgentMetadata(opts: {
  name: string;
  description?: string;
  walletAddress: string;
  relayBaseUrl: string;
  mcpPackage?: string;
  imageUrl?: string;
}): AgentMetadata {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: opts.name,
    description: opts.description,
    image: opts.imageUrl,
    services: [
      {
        name: "q402",
        endpoint: `${opts.relayBaseUrl.replace(/\/$/, "")}/api/relay/info`,
        version: "1.3.1",
        walletAddress: getAddress(opts.walletAddress),
      },
      ...(opts.mcpPackage
        ? [{ name: "MCP" as const, endpoint: `npm://${opts.mcpPackage}` }]
        : []),
    ],
    // Q402 settles via EIP-7702 + EIP-712 TransferAuthorization, not
    // the canonical x402 facilitator flow. Declare honestly.
    x402Support: false,
    supportedTrust: ["reputation"],
  };
}

export function scanUrl(network: Erc8004Network, agentId: bigint | string): string {
  return ERC8004_NETWORKS[network].scanAgentPrefix + String(agentId);
}
