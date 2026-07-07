import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { checkAdminSecret } from "@/app/lib/admin-auth";
import { GASTANK_ADDRESS, RELAYER_ADDRESS } from "@/app/lib/wallets";

const CHAINS = [
  { key: "bnb",    name: "BNB Chain", token: "BNB",   rpc: "https://bsc-dataseed1.binance.org/",         cgId: "binancecoin"  },
  { key: "eth",    name: "Ethereum",  token: "ETH",   rpc: "https://ethereum.publicnode.com",             cgId: "ethereum"     },
  { key: "mantle", name: "Mantle",    token: "MNT",   rpc: "https://rpc.mantle.xyz",                      cgId: "mantle"       },
  { key: "injective", name: "Injective", token: "INJ", rpc: "https://sentry.evm-rpc.injective.network/", cgId: "injective-protocol" },
  { key: "avax",   name: "Avalanche", token: "AVAX",  rpc: "https://api.avax.network/ext/bc/C/rpc",       cgId: "avalanche-2"  },
  { key: "xlayer", name: "X Layer",   token: "OKB",   rpc: "https://rpc.xlayer.tech",                     cgId: "okb"          },
  { key: "stable", name: "Stable",    token: "USDT0", rpc: "https://rpc.stable.xyz",                      cgId: "tether"       },
  { key: "monad",  name: "Monad",     token: "MON",   rpc: "https://rpc.monad.xyz",                       cgId: "monad-2"      },
  { key: "scroll", name: "Scroll",    token: "ETH",   rpc: "https://rpc.scroll.io",                       cgId: "ethereum"     },
  { key: "arbitrum", name: "Arbitrum", token: "ETH",  rpc: "https://arb1.arbitrum.io/rpc",                 cgId: "ethereum"     },
  { key: "base",   name: "Base",      token: "ETH",   rpc: "https://mainnet.base.org",                    cgId: "ethereum"     },
  { key: "robinhood", name: "Robinhood Chain", token: "ETH", rpc: process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com", cgId: "ethereum" },
];

// Minimum USD thresholds — alert when below these
const ALERT_THRESHOLD_USD: Record<string, number> = {
  bnb:    5,   // BNB: alert below $5
  eth:    5,   // ETH: alert below $5 (gas is expensive)
  mantle: 2,
  injective: 2,
  avax:   3,
  xlayer: 2,
  stable: 2,
  // Monad's EIP-7702 reserve-balance rule forces delegated EOAs to keep
  // ≥10 MON. The facilitator is never delegated, but keep the alert
  // threshold above 15 MON so a top-up happens well before operational
  // headroom shrinks under the 10-MON tripwire.
  monad:  15,
  // Scroll: ETH-denominated, L2 fees dominate. $5 floor ≈ 0.00125 ETH at
  // $4000/ETH — enough headroom for the alert to fire long before any
  // realistic burst would drain the facilitator's balance.
  scroll: 5,
  // Arbitrum One: ETH-denominated L2 fees dominate, similar profile to Scroll.
  // Same $5 floor for consistency; tune after first week of mainnet data.
  arbitrum: 5,
  // Base: ETH-denominated OP Stack L2, same fee profile as Scroll/Arbitrum.
  // Same $5 floor for consistency; tune after first week of mainnet data.
  base: 5,
  // Robinhood Chain: ETH-denominated Arbitrum Nitro L2, same fee profile as
  // Arbitrum One. Same $5 floor for consistency.
  robinhood: 5,
};

async function getNativeBalance(rpc: string, address: string): Promise<string> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), 5000)
  );
  const provider = new ethers.JsonRpcProvider(rpc);
  const balance = await Promise.race([provider.getBalance(address), timeout]);
  return ethers.formatEther(balance);
}

async function getPrices(ids: string[]): Promise<Record<string, number>> {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`;
    const res = await fetch(url, { next: { revalidate: 60 } });
    const data = await res.json();
    const out: Record<string, number> = {};
    for (const id of ids) out[id] = data[id]?.usd ?? 0;
    return out;
  } catch {
    return Object.fromEntries(ids.map(id => [id, 0]));
  }
}

async function sendTelegramAlert(message: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });
  } catch { /* non-critical */ }
}

export async function GET(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "gas-tank", 20, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const uniqueCgIds = Array.from(new Set(CHAINS.map(c => c.cgId)));
  const { searchParams } = new URL(req.url);
  const checkAlerts = searchParams.get("check_alerts") === "1";

  if (checkAlerts && !checkAdminSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch prices + GASTANK balances (user-facing) + RELAYER balances (ops-facing) in parallel.
  // GASTANK holds user deposits (cold); RELAYER is the hot operational wallet that pays gas.
  const gastankCalls = CHAINS.map(c => getNativeBalance(c.rpc, GASTANK_ADDRESS).catch(() => "0"));
  const relayerCalls = CHAINS.map(c => getNativeBalance(c.rpc, RELAYER_ADDRESS).catch(() => "0"));
  const [prices, gastankBals, relayerBals] = await Promise.all([
    getPrices(uniqueCgIds),
    Promise.all(gastankCalls),
    Promise.all(relayerCalls),
  ]);

  // Dashboard ("Gas Tank" tab) reads user-facing GASTANK balance.
  const tanks = CHAINS.map((chain, i) => {
    const bal = parseFloat(gastankBals[i]);
    const price = (prices as Record<string, number>)[chain.cgId] ?? 0;
    const usd = bal * price;
    return {
      key: chain.key,
      chain: chain.name,
      token: chain.token,
      balance: bal.toFixed(4),
      usd: usd >= 0.01 ? `$${usd.toFixed(2)}` : "$0.00",
      usdValue: usd,
      price,
      empty: bal === 0,
    };
  });

  // Telegram alerts monitor the RELAYER hot wallet — that's what actually needs topping up
  // (cold → hot transfer from GASTANK when it falls below operational threshold).
  let flagged = 0;
  let alertSent = false;
  if (checkAlerts) {
    const relayerStatus = CHAINS.map((chain, i) => {
      const bal = parseFloat(relayerBals[i]);
      const price = (prices as Record<string, number>)[chain.cgId] ?? 0;
      const usd = bal * price;
      const threshold = ALERT_THRESHOLD_USD[chain.key] ?? 3;
      return {
        chain: chain.name,
        token: chain.token,
        balance: bal.toFixed(4),
        usd: usd >= 0.01 ? `$${usd.toFixed(2)}` : "$0.00",
        low: usd < threshold && usd >= 0,
        empty: bal === 0,
      };
    });
    const lowRelayers = relayerStatus.filter(r => r.low || r.empty);
    flagged = lowRelayers.length;
    if (lowRelayers.length > 0) {
      const lines = lowRelayers.map(r =>
        r.empty
          ? `🔴 <b>${r.chain}</b> Relayer EMPTY — relay will fail`
          : `🟡 <b>${r.chain}</b> Relayer LOW — ${r.balance} ${r.token} (~${r.usd})`
      );
      await sendTelegramAlert(
        `⚠️ <b>Q402 Relayer Gas Alert</b>\n\n${lines.join("\n")}\n\n` +
        `Hot relayer: <code>${RELAYER_ADDRESS}</code>\n` +
        `Cold gas tank: <code>${GASTANK_ADDRESS}</code>\n` +
        `Action: cold → hot top-up to prevent relay failures.`
      );
      alertSent = true;
    }
  }

  return NextResponse.json(
    checkAlerts ? { tanks, flagged, alertSent } : { tanks }
  );
}
