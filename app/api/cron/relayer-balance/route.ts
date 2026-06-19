/**
 * GET /api/cron/relayer-balance
 *
 * Unified on-chain balance monitor for every Q402-controlled reserve:
 *
 *   • RELAYER_ADDRESS (per chain) — pays settlement gas
 *   • GASTANK_ADDRESS (per chain, native + LINK) — receives user
 *     deposits; visibility only (no alert threshold yet because ops
 *     manages the sweep cadence)
 *   • Q402CCIPSender (per CCIP chain, native + LINK pools) — actually
 *     pays CCIP Router fees; reverts with InsufficientNativePool /
 *     InsufficientLinkPool when empty
 *
 * For each reserve with a threshold, the cron computes a per-tick
 * "below safe minimum" boolean, batches every flagged reserve into a
 * single Telegram alert, and tracks a 6h cooldown per (reserve, chain)
 * so a continuously-low reserve doesn't spam ops every 5 minutes.
 *
 * Auth: CRON_SECRET via Authorization header (timing-safe; fail-closed
 * when unset). Read-only across the board — KV writes only update the
 * alert cooldown bookkeeping + a status row for /api/admin/cron-status.
 *
 * Cron name kept as `relayer-balance` for cron-status / Render-trigger
 * compatibility; scope expanded.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { JsonRpcProvider, formatEther, formatUnits } from "ethers";
import { requireCronAuth } from "@/app/lib/cron-auth";
import { sendOpsAlert } from "@/app/lib/ops-alerts";
import { loadRelayerKey } from "@/app/lib/relayer-key";
import { CHAIN_CONFIG, type ChainKey } from "@/app/lib/relayer";
import { GASTANK_ADDRESS } from "@/app/lib/wallets";
import { CCIP_CONFIG, isCCIPChain, type CCIPChainKey } from "@/app/lib/ccip";
import { recordCronStatus, CRON_NAMES } from "@/app/lib/cron-status";

export const runtime = "nodejs";
export const maxDuration = 45;

const MONITORED_CHAINS: ChainKey[] = [
  "bnb",
  "eth",
  "avax",
  "xlayer",
  "stable",
  "mantle",
  "injective",
  "monad",
  "scroll",
  "arbitrum",
  "base",
];

const CCIP_CHAINS: CCIPChainKey[] = ["eth", "avax", "arbitrum"];

/** 6h cooldown per (reserve, chain). */
const ALERT_COOLDOWN_SEC = 6 * 60 * 60;
const ALERT_COOLDOWN_MS  = ALERT_COOLDOWN_SEC * 1000;

function lastAlertKey(reserve: string, chain: string): string {
  return `cron:treasury:lastAlert:${reserve}:${chain}`;
}

/** Sender LINK pool minimum — enough for ~15 ETH bridges. */
const SENDER_LINK_MIN_WHOLE: Record<CCIPChainKey, number> = {
  eth:      1.0,
  avax:     1.0,
  arbitrum: 1.0,
};

/** Sender native pool minimum — covers ~30 bridges on ETH-priced lanes. */
const SENDER_NATIVE_MIN_WHOLE: Record<CCIPChainKey, number> = {
  eth:      0.01,
  avax:     0.5,
  arbitrum: 0.005,
};

const LINK_TOKEN_PER_CCIP: Record<CCIPChainKey, string> = {
  eth:      "0x514910771AF9Ca656af840dff83E8264EcF986CA",
  avax:     "0x5947BB275c521040051D82396192181b413227A3",
  arbitrum: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
};

const ERC20_BALANCE_OF_SELECTOR = "0x70a08231";

interface RelayerProbe {
  reserve:        "relayer";
  chain:          ChainKey;
  balanceWhole:   number;
  minSafeWhole:   number;
  belowThreshold: boolean;
  error?:         string;
  oneTxCostWhole?: number;
}

interface GasTankProbe {
  reserve:        "gastank-native" | "gastank-link";
  chain:          ChainKey;
  balanceWhole:   number;
  /** Gas Tank thresholds are advisory only — ops sweeps on cadence. */
  minSafeWhole?:  number;
  belowThreshold: false;
  error?:         string;
}

interface SenderProbe {
  reserve:        "sender-native" | "sender-link";
  chain:          CCIPChainKey;
  balanceWhole:   number;
  minSafeWhole:   number;
  belowThreshold: boolean;
  error?:         string;
}

type AnyProbe = RelayerProbe | GasTankProbe | SenderProbe;

async function probeBalanceWei(
  provider: JsonRpcProvider,
  address:  string,
): Promise<bigint> {
  return await Promise.race([
    provider.getBalance(address),
    new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 5000)),
  ]);
}

async function probeErc20BalanceWei(
  provider: JsonRpcProvider,
  token:    string,
  holder:   string,
): Promise<bigint> {
  const data = ERC20_BALANCE_OF_SELECTOR + holder.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const hex = await Promise.race([
    provider.call({ to: token, data }),
    new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 5000)),
  ]);
  return BigInt(hex);
}

async function probeRelayer(chain: ChainKey, relayer: string): Promise<RelayerProbe> {
  const cfg = CHAIN_CONFIG[chain];
  if (!cfg?.rpc) {
    return { reserve: "relayer", chain, balanceWhole: 0, minSafeWhole: 0, belowThreshold: false, error: "no_rpc" };
  }
  try {
    const provider = new JsonRpcProvider(cfg.rpc);
    const [balanceWei, feeData] = await Promise.all([
      probeBalanceWei(provider, relayer),
      Promise.race([
        provider.getFeeData(),
        new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 5000)),
      ]),
    ]);
    const maxFee = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const oneTxWei = maxFee * 360_000n;
    const minSafeWei = oneTxWei * 3n;
    return {
      reserve:        "relayer",
      chain,
      balanceWhole:   Number(formatEther(balanceWei)),
      oneTxCostWhole: Number(formatEther(oneTxWei)),
      minSafeWhole:   Number(formatEther(minSafeWei)),
      belowThreshold: balanceWei < minSafeWei,
    };
  } catch (e) {
    return {
      reserve: "relayer",
      chain,
      balanceWhole: 0,
      minSafeWhole: 0,
      belowThreshold: false,
      error: e instanceof Error ? e.message.slice(0, 80) : "rpc_error",
    };
  }
}

async function probeGastankNative(chain: ChainKey): Promise<GasTankProbe> {
  const cfg = CHAIN_CONFIG[chain];
  if (!cfg?.rpc) {
    return { reserve: "gastank-native", chain, balanceWhole: 0, belowThreshold: false, error: "no_rpc" };
  }
  try {
    const provider = new JsonRpcProvider(cfg.rpc);
    const balanceWei = await probeBalanceWei(provider, GASTANK_ADDRESS);
    return {
      reserve:        "gastank-native",
      chain,
      balanceWhole:   Number(formatEther(balanceWei)),
      belowThreshold: false,
    };
  } catch (e) {
    return {
      reserve: "gastank-native",
      chain,
      balanceWhole: 0,
      belowThreshold: false,
      error: e instanceof Error ? e.message.slice(0, 80) : "rpc_error",
    };
  }
}

async function probeGastankLink(chain: CCIPChainKey): Promise<GasTankProbe> {
  const cfg = CHAIN_CONFIG[chain];
  if (!cfg?.rpc) {
    return { reserve: "gastank-link", chain, balanceWhole: 0, belowThreshold: false, error: "no_rpc" };
  }
  try {
    const provider = new JsonRpcProvider(cfg.rpc);
    const balanceWei = await probeErc20BalanceWei(provider, LINK_TOKEN_PER_CCIP[chain], GASTANK_ADDRESS);
    return {
      reserve:        "gastank-link",
      chain,
      balanceWhole:   Number(formatUnits(balanceWei, 18)),
      belowThreshold: false,
    };
  } catch (e) {
    return {
      reserve: "gastank-link",
      chain,
      balanceWhole: 0,
      belowThreshold: false,
      error: e instanceof Error ? e.message.slice(0, 80) : "rpc_error",
    };
  }
}

async function probeSenderNative(chain: CCIPChainKey): Promise<SenderProbe> {
  const cfg = CHAIN_CONFIG[chain];
  const sender = CCIP_CONFIG[chain].sender;
  if (!cfg?.rpc || sender === "PENDING_DEPLOY") {
    return { reserve: "sender-native", chain, balanceWhole: 0, minSafeWhole: 0, belowThreshold: false, error: "no_rpc_or_pending" };
  }
  try {
    const provider = new JsonRpcProvider(cfg.rpc);
    const balanceWei = await probeBalanceWei(provider, sender);
    const balanceWhole = Number(formatEther(balanceWei));
    const minSafeWhole = SENDER_NATIVE_MIN_WHOLE[chain];
    return {
      reserve:        "sender-native",
      chain,
      balanceWhole,
      minSafeWhole,
      belowThreshold: balanceWhole < minSafeWhole,
    };
  } catch (e) {
    return {
      reserve: "sender-native",
      chain,
      balanceWhole: 0,
      minSafeWhole: 0,
      belowThreshold: false,
      error: e instanceof Error ? e.message.slice(0, 80) : "rpc_error",
    };
  }
}

async function probeSenderLink(chain: CCIPChainKey): Promise<SenderProbe> {
  const cfg = CHAIN_CONFIG[chain];
  const sender = CCIP_CONFIG[chain].sender;
  if (!cfg?.rpc || sender === "PENDING_DEPLOY") {
    return { reserve: "sender-link", chain, balanceWhole: 0, minSafeWhole: 0, belowThreshold: false, error: "no_rpc_or_pending" };
  }
  try {
    const provider = new JsonRpcProvider(cfg.rpc);
    const balanceWei = await probeErc20BalanceWei(provider, LINK_TOKEN_PER_CCIP[chain], sender);
    const balanceWhole = Number(formatUnits(balanceWei, 18));
    const minSafeWhole = SENDER_LINK_MIN_WHOLE[chain];
    return {
      reserve:        "sender-link",
      chain,
      balanceWhole,
      minSafeWhole,
      belowThreshold: balanceWhole < minSafeWhole,
    };
  } catch (e) {
    return {
      reserve: "sender-link",
      chain,
      balanceWhole: 0,
      minSafeWhole: 0,
      belowThreshold: false,
      error: e instanceof Error ? e.message.slice(0, 80) : "rpc_error",
    };
  }
}

function formatReserveLine(p: AnyProbe): string {
  const token = (p.reserve === "gastank-link" || p.reserve === "sender-link") ? "LINK" : "native";
  const head =
    p.reserve === "relayer"        ? `Relayer ${p.chain}`
    : p.reserve === "gastank-native" ? `GASTANK native ${p.chain}`
    : p.reserve === "gastank-link"   ? `GASTANK LINK ${p.chain}`
    : p.reserve === "sender-native"  ? `Sender native ${p.chain}`
    : `Sender LINK ${p.chain}`;
  if (p.error) return `${head}: <i>${p.error}</i>`;
  const min = p.minSafeWhole != null ? ` (min ${p.minSafeWhole})` : "";
  return `${head}: ${p.balanceWhole.toFixed(6)} ${token}${min}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denial = requireCronAuth(req);
  if (denial) return denial;

  const startedAt = Date.now();
  const key = loadRelayerKey();
  if (!key.ok) {
    await recordCronStatus(CRON_NAMES.RELAYER_BALANCE, {
      lastStatus: "error",
      lastError:  "RELAYER_PRIVATE_KEY not configured",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ error: "RELAYER_PRIVATE_KEY not configured" }, { status: 500 });
  }
  const relayer = key.address;

  const relayerProbes = await Promise.all(MONITORED_CHAINS.map((c) => probeRelayer(c, relayer)));
  const gastankNativeProbes = await Promise.all(MONITORED_CHAINS.map((c) => probeGastankNative(c)));
  const gastankLinkProbes = await Promise.all(CCIP_CHAINS.map((c) => probeGastankLink(c)));
  const senderNativeProbes = await Promise.all(CCIP_CHAINS.map((c) => probeSenderNative(c)));
  const senderLinkProbes = await Promise.all(CCIP_CHAINS.map((c) => probeSenderLink(c)));

  const allProbes: AnyProbe[] = [
    ...relayerProbes,
    ...gastankNativeProbes,
    ...gastankLinkProbes,
    ...senderNativeProbes,
    ...senderLinkProbes,
  ];

  const flagged = allProbes.filter((p) => p.belowThreshold);
  const alertsSentFor: string[] = [];

  if (flagged.length > 0) {
    const eligible: AnyProbe[] = [];
    for (const f of flagged) {
      const cdKey = lastAlertKey(f.reserve, f.chain);
      const last = await kv.get<number>(cdKey);
      if (!last || Date.now() - last > ALERT_COOLDOWN_MS) {
        eligible.push(f);
      }
    }
    if (eligible.length > 0) {
      const lines = [
        `<b>⚠ Q402 treasury reserves below threshold</b>`,
        ``,
        `Relayer: <code>${relayer}</code>`,
        `Gas Tank: <code>${GASTANK_ADDRESS}</code>`,
        ``,
        ...eligible.map(formatReserveLine),
        ``,
        `Top-up paths:`,
        `  • <b>Relayer ${"<chain>"}</b> low → send native to relayer EOA`,
        `  • <b>Sender LINK ${"<chain>"}</b> low → POST /api/admin/sender-topup {chain, token:"LINK", amount}`,
        `  • <b>Sender native ${"<chain>"}</b> low → POST /api/admin/sender-topup {chain, token:"native", amount}`,
      ].join("\n");
      try {
        await sendOpsAlert(lines, "warn");
        const now = Date.now();
        for (const f of eligible) {
          await kv.set(lastAlertKey(f.reserve, f.chain), now, { ex: ALERT_COOLDOWN_SEC });
          alertsSentFor.push(`${f.reserve}:${f.chain}`);
        }
      } catch (e) {
        console.error("[cron/relayer-balance] sendOpsAlert failed:", e);
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  await recordCronStatus(CRON_NAMES.RELAYER_BALANCE, {
    lastStatus: "success",
    lastResult: {
      checked:      allProbes.length,
      flaggedCount: flagged.length,
      alertsSentFor,
      relayer: relayerProbes.map((p) => ({
        chain: p.chain,
        balance: p.balanceWhole,
        minSafe: p.minSafeWhole,
        below: p.belowThreshold,
        error: p.error,
      })),
      senderNative: senderNativeProbes.map((p) => ({
        chain: p.chain,
        balance: p.balanceWhole,
        minSafe: p.minSafeWhole,
        below: p.belowThreshold,
        error: p.error,
      })),
      senderLink: senderLinkProbes.map((p) => ({
        chain: p.chain,
        balance: p.balanceWhole,
        minSafe: p.minSafeWhole,
        below: p.belowThreshold,
        error: p.error,
      })),
      gastankNative: gastankNativeProbes.map((p) => ({
        chain: p.chain,
        balance: p.balanceWhole,
        error: p.error,
      })),
      gastankLink: gastankLinkProbes.map((p) => ({
        chain: p.chain,
        balance: p.balanceWhole,
        error: p.error,
      })),
    },
    durationMs,
  });

  return NextResponse.json({
    relayer,
    gastank: GASTANK_ADDRESS,
    relayerProbes,
    gastankNativeProbes,
    gastankLinkProbes,
    senderNativeProbes,
    senderLinkProbes,
    alertsSentFor,
    durationMs,
    asOf: new Date().toISOString(),
  });
}

// Used by URL template in alert text; avoid TS unused-import warning.
void isCCIPChain;
