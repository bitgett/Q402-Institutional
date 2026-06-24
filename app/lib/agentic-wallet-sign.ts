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
  | "scroll"
  | "arbitrum"
  | "base";

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
  /** Q (QuackAI token) is optional and BNB-only; it is NOT a stablecoin so
   *  callers must value it via the Q/USDT TWAP, never as 1:1 USD. */
  tokens: { USDC: TokenCfg; USDT: TokenCfg; Q?: TokenCfg };
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
      // QuackAI token (BNB-only). Priced via the Q/USDT V3 pool TWAP, not 1:1.
      Q: { address: "0xc07e1300dc138601FA6B0b59f8D0FA477e690589", decimals: 18 },
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
    impl: "0xE5b90D564650bdcE7C2Bb4344F777f6582e05699",
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
    impl: "0xa9a7dcE76DEF2AC36057FeF0d8103dF10581d61e",
    domainName: "Q402 Injective",
    domainVersion: "1",
    tokens: {
      USDC: { address: "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a", decimals: 6 },
      USDT: { address: "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13", decimals: 6 },
    },
  },
  monad: {
    key: "monad",
    id: 143,
    name: "Monad",
    rpc: process.env.MONAD_RPC_URL ?? "https://rpc.monad.xyz",
    impl: "0xc5d4dFA6D2e545409C1abf86f336Dd43bb87621f",
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
    impl: "0x7635F32D893B64b5944CB8cbF2AC4cd3dA41B2f1",
    domainName: "Q402 Scroll",
    domainVersion: "1",
    tokens: {
      USDC: { address: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4", decimals: 6 },
      USDT: { address: "0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df", decimals: 6 },
    },
  },
  arbitrum: {
    key: "arbitrum",
    id: 42161,
    name: "Arbitrum",
    rpc: process.env.ARBITRUM_RPC_URL ?? "https://arb1.arbitrum.io/rpc",
    impl: "0x8D854436ab0426F5BC6Cc70865C90576AD523E73",
    domainName: "Q402 Arbitrum",
    domainVersion: "1",
    tokens: {
      // Native Circle USDC (CCTP) — NOT the bridged USDC.e (0xFF970A61...).
      USDC: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
      USDT: { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
    },
  },
  base: {
    key: "base",
    id: 8453,
    name: "Base",
    rpc: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
    impl: "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    domainName: "Q402 Base",
    domainVersion: "1",
    tokens: {
      // Native Circle USDC + bridged Tether USD on Base, both 6 decimals.
      USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
      USDT: { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 },
    },
  },
};

export function isAgenticChainKey(s: unknown): s is AgenticChainKey {
  return typeof s === "string" && s in AGENTIC_CHAINS;
}

export type AgenticToken = "USDC" | "USDT" | "Q";

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

// EIP-3009 TransferWithAuthorization — the x402 rail signs this against the
// USDC token's OWN EIP-712 domain (name "USD Coin", version "2"). The relayer
// then submits USDC.transferWithAuthorization() and sponsors the gas; the USDC
// contract self-verifies the signature, so there is no EIP-7702 delegation.
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" },
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
  witnessSig: Hex;         // q402 rail: TransferAuthorization witness. x402 rail: EIP-3009 sig.
  /** Settlement rail. "q402" (default) = EIP-7702 TransferAuthorization.
   *  "x402" = EIP-3009 USDC transferWithAuthorization (Base USDC only). */
  rail?: "q402" | "x402";
  /** EIP-7702 authorization — present for the q402 rail, absent for x402. */
  authorization?: SignedAuthorization;
  /** EIP-3009 bytes32 nonce — present for the x402 rail, absent for q402. */
  eip3009Nonce?: Hex;
}

interface SignParams {
  privateKey: Hex;
  /** The wallet RECORD's address. The signer is derived from privateKey and
   *  asserted to equal this BEFORE signing — so a KV-swapped / mismatched key
   *  blob can never sign from a record it doesn't belong to (defence-in-depth
   *  over the keystore; closes the "copy a victim's encrypted blob into another
   *  record" vector). Required. */
  expectedOwner: Address;
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
  /** Settlement rail. Default "q402" (EIP-7702). "x402" signs an EIP-3009
   *  USDC transferWithAuthorization instead — Base + USDC only. */
  rail?: "q402" | "x402";
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
  // Q is an optional BNB-only token slot; reject before signing on any chain
  // where it isn't configured rather than crash on an undefined token config.
  if (!tokenCfg) {
    throw new Error(`TOKEN_NOT_ON_CHAIN: ${p.token} is not available on ${p.chain}`);
  }

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

  // F5 defence-in-depth: the address the decrypted key derives to MUST match
  // the wallet record this payment is for. Without this, an attacker with KV
  // write access (but not the keystore master key) could swap a funded
  // victim's encrypted blob into another record and have the server sign from
  // the victim's address. Fail closed.
  if (fromAddr.toLowerCase() !== p.expectedOwner.toLowerCase()) {
    throw new Error("KEY_RECORD_MISMATCH");
  }

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

  // ── x402 rail: sign an EIP-3009 USDC transferWithAuthorization instead of the
  // EIP-7702 TransferAuthorization witness. Base + USDC only (USDT on Base does
  // not expose EIP-3009). No EIP-7702 authorization — the USDC contract verifies
  // the signature against its own domain; the relayer submits + sponsors gas.
  if (p.rail === "x402") {
    if (p.chain !== "base" || p.token !== "USDC") {
      throw new Error("X402_BASE_USDC_ONLY");
    }
    const eip3009Nonce = ethers.hexlify(ethers.randomBytes(32)) as Hex;
    const sig = (await walletClient.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: cfg.id,
        verifyingContract: tokenCfg.address,
      },
      types: EIP3009_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: fromAddr,
        to: p.to,
        value: amountRaw,
        validAfter: 0n,
        validBefore: deadline,
        nonce: eip3009Nonce,
      },
    })) as Hex;
    return {
      chain: p.chain,
      token: p.token,
      fromAddr,
      to: p.to,
      amount: p.amount,
      amountRaw,
      nonceUint,            // unused by the x402 body; kept for the shared type
      deadline,
      witnessSig: sig,
      rail: "x402",
      eip3009Nonce,
    };
  }

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
  source?: "recurring" | "send" | "batch" | "api" | "request";
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
  // x402 rail carries a bytes32 EIP-3009 nonce and no EIP-7702 authorization.
  const isX402 = signed.rail === "x402";
  const chainNoncePayload = isX402
    ? { eip3009Nonce: signed.eip3009Nonce }
    : signed.chain === "xlayer"
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
      ...(isX402 ? {} : { authorization: signed.authorization }),
      ...(meta?.source ? { source: meta.source } : {}),
      ...(meta?.ruleId ? { ruleId: meta.ruleId } : {}),
    }),
  });
}

/**
 * Classify a thrown relay fetch as a DEFINITE connect/DNS-phase failure — the
 * request never reached the relay, so nothing could have broadcast on-chain.
 * Callers that bracket a relay submit (recurring cron, batch) use this to treat
 * such throws as a CLEAN pre-broadcast failure (retry, no fired-marker, no
 * count inflation) rather than the ambiguous "uncertain" path. Anything NOT
 * matched here (response-phase timeout, reset, unknown) stays uncertain — the
 * classification fails SAFE toward never double-paying. undici surfaces the
 * phase via `err.cause.code`; DNS failures can nest under `cause.errors[]`.
 */
export function isRelayConnectPhaseError(e: unknown): boolean {
  const CONNECT = new Set([
    "ENOTFOUND",               // DNS: host not found
    "EAI_AGAIN",               // DNS: temporary failure
    "ECONNREFUSED",            // TCP: connection refused
    "UND_ERR_CONNECT_TIMEOUT", // undici: connect (not response) timed out
  ]);
  const cause = (e as { cause?: { code?: string; errors?: Array<{ code?: string }> } })?.cause;
  if (cause?.code && CONNECT.has(cause.code)) return true;
  for (const sub of cause?.errors ?? []) if (sub?.code && CONNECT.has(sub.code)) return true;
  return false;
}

/** Resolve the base URL used for internal /api/relay forwards. Mirrors
 *  the convention in the send route so the env precedence stays uniform
 *  across all agentic-wallet endpoints. */
export function internalBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  // No base URL configured. Silently forwarding agentic settlements to
  // localhost in production would make every send/yield/bridge fail opaquely
  // — fail loud so the misconfiguration is caught at the first request.
  if (process.env.NODE_ENV === "production") {
    throw new Error("internalBaseUrl: NEXT_PUBLIC_BASE_URL / VERCEL_URL unset in production");
  }
  return `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}
