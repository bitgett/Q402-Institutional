/**
 * agentic-wallet-sign.ts — server-side EIP-712 + EIP-7702 signing for
 * the Agentic Wallet, plus the internal forwarder to /api/relay.
 *
 * Why this lives apart from `app/lib/relayer.ts`:
 *   - relayer.ts contains the canonical client-signed flow (user holds
 *     the EOA). Mixing the server-key path into it would couple the two
 *     trust models in one module.
 *   - All Agentic Wallet routes (single send, batch, withdraw) share
 *     this signer, so isolating it keeps the per-route handlers thin.
 *
 * Chain config is mirrored here from contracts.manifest.json. The
 * single source of truth is the manifest; tests in
 * __tests__/contracts-manifest.test.ts keep relayer.ts and the SDK in
 * sync — once that pattern extends to this file, drift will be caught
 * the same way.
 */

import { ethers } from "ethers";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type AgenticChainKey =
  | "bnb"
  | "eth"
  | "avax"
  | "xlayer"
  | "stable"
  | "mantle"
  | "injective"
  | "monad"
  | "scroll";

interface TokenCfg {
  address: Address;
  decimals: number;
}

interface ChainCfg {
  key: AgenticChainKey;
  id: number;
  name: string;
  rpc: string;
  impl: Address;
  domainName: string;
  domainVersion: "1";
  tokens: { USDC: TokenCfg; USDT: TokenCfg };
}

/** Mirrors contracts.manifest.json `chains.*` for the fields needed by
 *  server-side signing. RPC overrides through env keep the same shape as
 *  app/lib/relayer.ts. */
export const AGENTIC_CHAINS: Record<AgenticChainKey, ChainCfg> = {
  bnb: {
    key: "bnb",
    id: 56,
    name: "BNB Chain",
    rpc: process.env.BSC_RPC_URL ?? "https://bsc-dataseed.binance.org",
    impl: "0x6cF4aD62C208b6494a55a1494D497713ba013dFa",
    domainName: "Q402 BNB Chain",
    domainVersion: "1",
    tokens: {
      USDC: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
      USDT: { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
    },
  },
  eth: {
    key: "eth",
    id: 1,
    name: "Ethereum",
    rpc: process.env.ETH_RPC_URL ?? "https://ethereum.publicnode.com",
    impl: "0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD",
    domainName: "Q402 Ethereum",
    domainVersion: "1",
    tokens: {
      USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
      USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    },
  },
  avax: {
    key: "avax",
    id: 43114,
    name: "Avalanche",
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    impl: "0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c",
    domainName: "Q402 Avalanche",
    domainVersion: "1",
    tokens: {
      USDC: { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 },
      USDT: { address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6 },
    },
  },
  xlayer: {
    key: "xlayer",
    id: 196,
    name: "X Layer",
    rpc: "https://rpc.xlayer.tech",
    impl: "0x8D854436ab0426F5BC6Cc70865C90576AD523E73",
    domainName: "Q402 X Layer",
    domainVersion: "1",
    tokens: {
      USDC: { address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", decimals: 6 },
      USDT: { address: "0x1E4a5963aBFD975d8c9021ce480b42188849D41d", decimals: 6 },
    },
  },
  stable: {
    key: "stable",
    id: 988,
    name: "Stable",
    rpc: "https://rpc.stable.xyz",
    impl: "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    domainName: "Q402 Stable",
    domainVersion: "1",
    tokens: {
      // Stable's native USDT0 is exposed under both USDC and USDT keys to
      // keep the SDK surface uniform across chains.
      USDC: { address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18 },
      USDT: { address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18 },
    },
  },
  mantle: {
    key: "mantle",
    id: 5000,
    name: "Mantle",
    rpc: process.env.MANTLE_RPC_URL ?? "https://rpc.mantle.xyz",
    impl: "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    domainName: "Q402 Mantle",
    domainVersion: "1",
    tokens: {
      USDC: { address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", decimals: 6 },
      // USDT0 (LayerZero OFT) — Mantle's official 2025-11-27 USDT.
      // Legacy canonical-bridged USDT (0x201EBa5...) sunset 2026-02-03.
      // Shares the 0x779Ded… address with Stable via CREATE3 — but
      // decimals differ per chain (Mantle 6, Stable 18). Per manifest.
      USDT: { address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", decimals: 6 },
    },
  },
  injective: {
    key: "injective",
    id: 1776,
    name: "Injective",
    rpc: process.env.INJECTIVE_RPC_URL ?? "https://sentry.evm-rpc.injective.network/",
    impl: "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    domainName: "Q402 Injective",
    domainVersion: "1",
    tokens: {
      // Injective is USDT-only — USDC mirrors USDT to keep the type uniform.
      USDC: { address: "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13", decimals: 6 },
      USDT: { address: "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13", decimals: 6 },
    },
  },
  monad: {
    key: "monad",
    id: 143,
    name: "Monad",
    rpc: process.env.MONAD_RPC_URL ?? "https://rpc.monad.xyz",
    impl: "0x39Ba9520718eE069D7f72882FF4C28a5Ea8a2acC",
    domainName: "Q402 Monad",
    domainVersion: "1",
    tokens: {
      USDC: { address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6 },
      USDT: { address: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", decimals: 6 },
    },
  },
  scroll: {
    key: "scroll",
    id: 534352,
    name: "Scroll",
    rpc: process.env.SCROLL_RPC_URL ?? "https://rpc.scroll.io",
    impl: "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    domainName: "Q402 Scroll",
    domainVersion: "1",
    tokens: {
      USDC: { address: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4", decimals: 6 },
      USDT: { address: "0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df", decimals: 6 },
    },
  },
};

export function isAgenticChainKey(s: unknown): s is AgenticChainKey {
  return typeof s === "string" && s in AGENTIC_CHAINS;
}

export type AgenticToken = "USDC" | "USDT";

/** Cryptographically-random uint256 nonce for the EIP-712 witness. */
export function randomUint256Nonce(): bigint {
  const bytes = ethers.randomBytes(32);
  return BigInt(ethers.hexlify(bytes));
}

const TRANSFER_AUTH_TYPES = {
  TransferAuthorization: [
    { name: "owner",       type: "address" },
    { name: "facilitator", type: "address" },
    { name: "token",       type: "address" },
    { name: "recipient",   type: "address" },
    { name: "amount",      type: "uint256" },
    { name: "nonce",       type: "uint256" },
    { name: "deadline",    type: "uint256" },
  ],
} as const;

export interface SignedAuthorization {
  chainId: number;
  address: Address;
  nonce: number;
  yParity: number;
  r: Hex;
  s: Hex;
}

export interface SignedPayment {
  chain: AgenticChainKey;
  token: AgenticToken;
  fromAddr: Address;
  to: Address;
  amount: string;          // human-readable decimal string echoed in body
  amountRaw: bigint;       // atomic units (kept for callers that need it)
  nonceUint: bigint;
  deadline: bigint;
  witnessSig: Hex;
  authorization: SignedAuthorization;
}

interface SignParams {
  privateKey: Hex;
  chain: AgenticChainKey;
  token: AgenticToken;
  to: Address;
  amount: string;
  facilitator: Address;
  /** Optional override — useful for batch where every TX shares the
   *  same deadline. Defaults to now + 600s. */
  deadlineSeconds?: number;
  /** Optional override for the EIP-7702 authorization tx-count. Batch
   *  callers should pre-fetch once and reuse so 20 calls don't fire 20
   *  RPC reads. */
  authorizationNonce?: number;
}

const DEFAULT_DEADLINE_AHEAD = 600;

/**
 * Sign a single TransferAuthorization + matching EIP-7702 authorization
 * with the supplied private key. Returns the body shape ready to forward
 * to `/api/relay`. Throws on a malformed amount decimal so the caller
 * can surface a clean 400.
 */
export async function signAgenticPayment(p: SignParams): Promise<SignedPayment> {
  const cfg = AGENTIC_CHAINS[p.chain];
  const tokenCfg = cfg.tokens[p.token];

  let amountRaw: bigint;
  try {
    amountRaw = ethers.parseUnits(p.amount, tokenCfg.decimals);
  } catch {
    throw new Error("AMOUNT_PRECISION_TOO_HIGH");
  }
  if (amountRaw <= 0n) throw new Error("INVALID_AMOUNT");

  const nonceUint = randomUint256Nonce();
  const deadline = BigInt(
    Math.floor(Date.now() / 1000) + (p.deadlineSeconds ?? DEFAULT_DEADLINE_AHEAD),
  );

  const account = privateKeyToAccount(p.privateKey);
  const fromAddr = account.address as Address;

  const viemChain = {
    id: cfg.id,
    name: cfg.name,
    nativeCurrency: { name: cfg.name, symbol: cfg.name, decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc] } },
  } as const;

  const walletClient = createWalletClient({
    account,
    chain: viemChain,
    transport: http(cfg.rpc),
  });

  const witnessSig = (await walletClient.signTypedData({
    domain: {
      name: cfg.domainName,
      version: cfg.domainVersion,
      chainId: cfg.id,
      verifyingContract: fromAddr,
    },
    types: TRANSFER_AUTH_TYPES,
    primaryType: "TransferAuthorization",
    message: {
      owner: fromAddr,
      facilitator: p.facilitator,
      token: tokenCfg.address,
      recipient: p.to,
      amount: amountRaw,
      nonce: nonceUint,
      deadline,
    },
  })) as Hex;

  // EIP-7702 authorization. Caller may supply a pre-fetched nonce to
  // avoid one RPC call per TX in a batch.
  let txNonce = p.authorizationNonce;
  if (txNonce === undefined) {
    const publicClient = createPublicClient({ chain: viemChain, transport: http(cfg.rpc) });
    txNonce = await publicClient.getTransactionCount({ address: fromAddr });
  }

  const auth = await account.signAuthorization({
    chainId: cfg.id,
    address: cfg.impl,
    nonce: txNonce,
  });

  // viem types yParity as optional but every real EIP-7702 signature
  // emits it. Throw loud if a viem update ever drops it so callers see
  // the breakage in tests instead of a malformed relay body.
  if (auth.yParity === undefined || auth.r === undefined || auth.s === undefined) {
    throw new Error("signAuthorization returned an incomplete signature");
  }

  return {
    chain: cfg.key,
    token: p.token,
    fromAddr,
    to: p.to,
    amount: p.amount,
    amountRaw,
    nonceUint,
    deadline,
    witnessSig,
    authorization: {
      chainId: auth.chainId,
      address: auth.address as Address,
      nonce: auth.nonce,
      yParity: auth.yParity,
      r: auth.r,
      s: auth.s,
    },
  };
}

/** Convenience — read the EIP-7702 authorization nonce (tx count) for
 *  the wallet. Batches call this once before signing 20 TXs in a row. */
export async function fetchAuthNonce(
  chain: AgenticChainKey,
  walletAddr: Address,
): Promise<number> {
  const cfg = AGENTIC_CHAINS[chain];
  const viemChain = {
    id: cfg.id,
    name: cfg.name,
    nativeCurrency: { name: cfg.name, symbol: cfg.name, decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc] } },
  } as const;
  const publicClient = createPublicClient({ chain: viemChain, transport: http(cfg.rpc) });
  return await publicClient.getTransactionCount({ address: walletAddr });
}

/**
 * Forward a single signed payment to the canonical /api/relay route.
 *
 * Two field-shape rules the relay enforces:
 *
 *   1. `amount` MUST be the raw atomic-unit integer string (parsed via
 *      `BigInt(amount)` on the relay side). The human-readable decimal
 *      string (`"1.5"`) would either reject outright or — worse — be
 *      coerced to an integer that diverges from what the witness
 *      signed, so we always wire `signed.amountRaw.toString()` here.
 *
 *   2. Nonce field name depends on chain:
 *         xlayer → `xlayerNonce`
 *         stable → `stableNonce`
 *         everything else → `nonce`
 *      The relay reads them as separate top-level fields and 400s when
 *      the wrong one is supplied. (`eip3009Nonce` is an X Layer
 *      USDC-only fallback that Agentic Wallet doesn't use — we always
 *      go EIP-7702 type-4 from the keystore.)
 */
/**
 * Optional metadata the cron path attaches when it relays on behalf of
 * a recurring rule. The relay route IGNORES these fields unless an
 * accompanying `X-Q402-Internal-Trust` header matches CRON_SECRET, so
 * external customers calling /api/relay directly can't forge a
 * "source: recurring" tag on their txes.
 */
export interface InternalRelayMeta {
  source?: "recurring" | "send" | "batch" | "api";
  ruleId?: string;
  /** CRON_SECRET value. Caller is responsible for fetching from env;
   *  passing it here keeps the relay-side trust check single-source. */
  internalTrustToken?: string;
}

export async function submitToRelay(
  baseUrl: string,
  apiKey: string,
  signed: SignedPayment,
  meta?: InternalRelayMeta,
): Promise<Response> {
  const nonceStr = signed.nonceUint.toString();
  const chainNoncePayload =
    signed.chain === "xlayer"
      ? { xlayerNonce: nonceStr }
      : signed.chain === "stable"
        ? { stableNonce: nonceStr }
        : { nonce: nonceStr };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (meta?.internalTrustToken) {
    headers["X-Q402-Internal-Trust"] = meta.internalTrustToken;
  }

  return await fetch(`${baseUrl}/api/relay`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      apiKey,
      chain: signed.chain,
      token: signed.token,
      from: signed.fromAddr,
      to: signed.to,
      // Raw atomic units, NOT the human decimal string.
      amount: signed.amountRaw.toString(),
      ...chainNoncePayload,
      deadline: signed.deadline.toString(),
      witnessSig: signed.witnessSig,
      authorization: signed.authorization,
      ...(meta?.source ? { source: meta.source } : {}),
      ...(meta?.ruleId ? { ruleId: meta.ruleId } : {}),
    }),
  });
}

/** Resolve the base URL used for internal /api/relay forwards. Mirrors
 *  the convention in the send route so the env precedence stays uniform
 *  across all agentic-wallet endpoints. */
export function internalBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://127.0.0.1:${process.env.PORT ?? 3000}`)
  );
}
