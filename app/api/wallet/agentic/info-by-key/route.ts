/**
 * POST /api/wallet/agentic/info-by-key
 *
 * Read-only Agent Wallet introspection authenticated by apiKey alone.
 * MCP path. Multi-wallet aware: takes optional `walletId` (defaults to
 * the apiKey owner's default wallet) and can also list all wallets
 * (`list: true`).
 *
 * Excludes soft-deleted wallets. Returning archived records here would
 * let a leaked apiKey enumerate caps + addresses of a wallet inside
 * its 7-day grace window.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getApiKeyRecord } from "@/app/lib/db";
import {
  getActiveAgenticWallet,
  listAgenticWallets,
  resolveWallet,
  type AgenticWalletRecord,
} from "@/app/lib/agentic-wallet";
import {
  fetchAgenticBalances,
  type AgenticBalances,
} from "@/app/lib/agentic-wallet-balance";
import { readReputationSummary } from "@/app/lib/erc8004-reputation";
import { RELAYER_ADDRESS } from "@/app/lib/wallets";

export const runtime = "nodejs";
export const maxDuration = 30;

const BALANCE_CACHE_TTL_SEC = 5 * 60;
const BALANCE_CACHE_KEY = (owner: string, walletId: string) =>
  `aw:balance:${owner.toLowerCase()}:${walletId.toLowerCase()}`;

interface InfoBody {
  apiKey?: string;
  /** Optional — omit to use default wallet, ignored when `list: true`. */
  walletId?: string;
  /** When true, returns all active wallets for the owner. */
  list?: boolean;
}

interface PublicWallet {
  /** Masked owner EOA — `0xAAAA…BBBB` (6 + 4). */
  ownerAddrShort: string;
  address: string;
  walletId: string;
  createdAt: number;
  deletedAt: number | null;
  dailyLimitUsd: number | null;
  perTxMaxUsd: number | null;
  erc8004AgentId: string | null;
  label: string | null;
}

function maskAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function project(wallet: AgenticWalletRecord): PublicWallet {
  return {
    ownerAddrShort: maskAddr(wallet.ownerAddr),
    address: wallet.address,
    walletId: wallet.address.toLowerCase(),
    createdAt: wallet.createdAt,
    deletedAt: wallet.deletedAt ?? null,
    dailyLimitUsd: wallet.dailyLimitUsd ?? null,
    perTxMaxUsd: wallet.perTxMaxUsd ?? null,
    erc8004AgentId: wallet.erc8004AgentId ?? null,
    label: wallet.label ?? null,
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-info-by-key", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: InfoBody;
  try {
    body = (await req.json()) as InfoBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.apiKey !== "string" || body.apiKey.length === 0) {
    return NextResponse.json({ error: "API_KEY_REQUIRED" }, { status: 400 });
  }
  // Reject BOTH sandbox prefixes (q402_test_ and the legacy q402_sandbox_)
  // — db.ts treats both as sandbox, and rec.isSandbox is the defence-in-depth
  // backstop for any record flagged sandbox regardless of prefix. Mirrors the
  // send / bridge / recurring / yield routes (which all gate both).
  if (body.apiKey.startsWith("q402_test_") || body.apiKey.startsWith("q402_sandbox_")) {
    return NextResponse.json(
      { error: "SANDBOX_KEY_REJECTED", message: "Use a live apiKey to read wallet info." },
      { status: 401 },
    );
  }

  const rec = await getApiKeyRecord(body.apiKey);
  if (!rec || !rec.active || rec.isSandbox) {
    return NextResponse.json({ error: "INVALID_API_KEY" }, { status: 401 });
  }
  const owner = rec.address.toLowerCase();

  // ── List mode ─────────────────────────────────────────────────────────
  if (body.list === true) {
    const all = await listAgenticWallets(owner);
    // Exclude soft-deleted from the list surface — same posture as
    // single-wallet info: an archived wallet shouldn't be enumerable
    // via apiKey auth.
    const active = all.filter(
      (w) => !w.deletedAt || Date.now() < w.deletedAt,
    );
    // Parallel reputation fetch for any graduated wallets in the list.
    // Cache TTL inside readReputationSummary keeps repeat polls (the
    // common case for MCP discovery) on the KV hot path. Each result
    // is attached inline so the MCP client sees the same shape as the
    // single-wallet response.
    const wallets = await Promise.all(
      active.map(async (w) => {
        const projected = project(w);
        if (w.erc8004AgentId) {
          const reputation = await readReputationSummary(
            w.erc8004AgentId,
            RELAYER_ADDRESS as `0x${string}`,
          );
          return { ...projected, reputation };
        }
        return projected;
      }),
    );
    return NextResponse.json({
      wallets,
      count: active.length,
    });
  }

  // ── Single-wallet mode ────────────────────────────────────────────────
  const wallet = body.walletId
    ? await getActiveAgenticWallet(owner, body.walletId)
    : await resolveWallet(owner, null);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }
  // Defensive — resolveWallet returns the default which is supposed to
  // be active, but double-check:
  if (wallet.deletedAt && Date.now() >= wallet.deletedAt) {
    return NextResponse.json({ error: "AGENTIC_WALLET_ARCHIVED" }, { status: 410 });
  }

  const walletId = wallet.address.toLowerCase();
  const publicWallet = project(wallet);

  // Balance — try cache, then live read.
  let balance: AgenticBalances | null = null;
  try {
    const cached = await kv.get<AgenticBalances>(BALANCE_CACHE_KEY(owner, walletId));
    if (cached && cached.asOf && Date.now() - cached.asOf < BALANCE_CACHE_TTL_SEC * 1000) {
      balance = cached;
    }
  } catch { /* cache miss falls through */ }

  if (!balance) {
    try {
      balance = await fetchAgenticBalances(wallet.address);
      try {
        await kv.set(BALANCE_CACHE_KEY(owner, walletId), balance, { ex: BALANCE_CACHE_TTL_SEC });
      } catch { /* best-effort */ }
    } catch {
      balance = null;
    }
  }

  // ERC-8004 reputation surface — only fetched for graduated wallets.
  // Cached 5 min inside readReputationSummary so MCP polls + dashboard
  // tabs share one RPC pair.
  const reputation =
    wallet.erc8004AgentId
      ? await readReputationSummary(wallet.erc8004AgentId, RELAYER_ADDRESS as `0x${string}`)
      : null;

  return NextResponse.json({ wallet: publicWallet, balance, reputation });
}
