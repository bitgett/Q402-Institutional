import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { checkAdminSecret } from "@/app/lib/admin-auth";

const RELAYER = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466";

const CHAINS = [
  { key: "bnb",    name: "BNB Chain", token: "BNB",   rpc: "https://bsc-dataseed1.binance.org/",         cgId: "binancecoin"  },
  { key: "eth",    name: "Ethereum",  token: "ETH",   rpc: "https://ethereum.publicnode.com",             cgId: "ethereum"     },
  { key: "avax",   name: "Avalanche", token: "AVAX",  rpc: "https://api.avax.network/ext/bc/C/rpc",       cgId: "avalanche-2"  },
  { key: "xlayer", name: "X Layer",   token: "OKB",   rpc: "https://rpc.xlayer.tech",                     cgId: "okb"          },
  { key: "stable", name: "Stable",    token: "USDT0", rpc: "https://rpc.stable.xyz",                      cgId: "tether"       },
];

// Minimum USD thresholds — alert when below these
const ALERT_THRESHOLD_USD: Record<string, number> = {
  bnb:    5,   // BNB: alert below $5
  eth:    5,   // ETH: alert below $5 (gas is expensive)
  avax:   3,
  xlayer: 2,
  stable: 2,
};

async function getNativeBalance(rpc: string): Promise<string> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), 5000)
  );
  const provider = new ethers.JsonRpcProvider(rpc);
  const balance = await Promise.race([provider.getBalance(RELAYER), timeout]);
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

  // Fetch balances + prices in parallel
  const [prices, ...balances] = await Promise.all([
    getPrices(uniqueCgIds),
    ...CHAINS.map(c => getNativeBalance(c.rpc).catch(() => "0")),
  ]);

  const tanks = CHAINS.map((chain, i) => {
    const bal = parseFloat(balances[i] as string);
    const price = (prices as Record<string, number>)[chain.cgId] ?? 0;
    const usd = bal * price;
    const threshold = ALERT_THRESHOLD_USD[chain.key] ?? 3;
    return {
      key: chain.key,
      chain: chain.name,
      token: chain.token,
      balance: bal.toFixed(4),
      usd: usd >= 0.01 ? `$${usd.toFixed(2)}` : "$0.00",
      usdValue: usd,
      price,
      low: usd < threshold && usd >= 0,
      empty: bal === 0,
    };
  });

  // Send Telegram alerts for low/empty tanks (only when explicitly requested,
  // e.g. from a cron job — not on every dashboard load)
  if (checkAlerts) {
    const lowTanks = tanks.filter(t => t.low || t.empty);
    if (lowTanks.length > 0) {
      const lines = lowTanks.map(t =>
        t.empty
          ? `🔴 <b>${t.chain}</b> Gas Tank EMPTY — relay will fail`
          : `🟡 <b>${t.chain}</b> Gas Tank LOW — ${t.balance} ${t.token} (~${t.usd})`
      );
      await sendTelegramAlert(
        `⚠️ <b>Q402 Gas Tank Alert</b>\n\n${lines.join("\n")}\n\n` +
        `Relayer: <code>${RELAYER}</code>\n` +
        `Top up immediately to prevent relay failures.`
      );
    }
  }

  return NextResponse.json({ tanks });
}
