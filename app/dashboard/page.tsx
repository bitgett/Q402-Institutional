"use client";

import Link from "next/link";
import { useWallet } from "../context/WalletContext";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import WalletButton from "../components/WalletButton";
import ClaudeMcpCard from "../components/ClaudeMcpCard";
import { getAuthCreds, clearAuthCache, getFreshChallenge } from "../lib/auth-client";
import { GASTANK_ADDRESS } from "../lib/wallets";
import { sendNativeTransfer, waitForWalletReceipt, walletErrorMessage, type WalletChainKey } from "../lib/wallet";
import { BNB_FOCUS_MODE } from "../lib/feature-flags";

function shortAddr(addr: string) { return `${addr.slice(0, 6)}…${addr.slice(-4)}`; }
function shortHash(hash: string) { return hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : "—"; }

// User gas deposits (BNB/ETH/MNT/INJ/AVAX/OKB/USDT0) go to the cold GASTANK wallet.
// This address is user-facing on the "Top up" modal; never send revenue or relayer hot-key here.
const DEPOSIT_ADDRESS = GASTANK_ADDRESS;

// Must mirror TIER_CREDITS / TIER_PLANS in app/lib/blockchain.ts — the server
// grants these values, so the UI display must match to the tx count.
const PLAN_QUOTA: Record<string, number> = {
  trial:          2_000,
  starter:          500,
  basic:          1_000,
  growth:         5_000,
  pro:           10_000,
  scale:         50_000,
  business:     100_000,
  enterprise_flex: 500_000,
};

const CHAIN_META: Record<string, { name: string; token: string; color: string; img: string; rounded: string; gasNote?: string }> = {
  bnb:    { name: "BNB Chain",  token: "BNB",   color: "#F0B90B", img: "/bnb.png",    rounded: "rounded-full" },
  eth:    { name: "Ethereum",   token: "ETH",   color: "#627EEA", img: "/eth.png",    rounded: "rounded-full" },
  mantle: { name: "Mantle",     token: "MNT",   color: "#FFFFFF", img: "/mantle.png", rounded: "rounded-full" },
  injective: { name: "Injective", token: "INJ", color: "#0082FA", img: "/injective.png", rounded: "rounded-full" },
  xlayer: { name: "X Layer",    token: "OKB",   color: "#1A1A1A", img: "/xlayer.png", rounded: "rounded-full" },
  avax:   { name: "Avalanche",  token: "AVAX",  color: "#E84142", img: "/avax.png",   rounded: "rounded-full" },
  // Stable: USDT0 is both the gas token and the payment token — no separate native coin
  stable: { name: "Stable",     token: "USDT0", color: "#4AE54A", img: "/stable.jpg", rounded: "rounded-full" },
};

const STEPS = [
  { n: "01", title: "Load the SDK (browser)", code: `<script src="https://q402.quackai.ai/q402-sdk.js"></script>\n<!-- or: import { Q402Client } from "q402-sdk" -->` },
  { n: "02", title: "Initialize with your API key", code: `const q402 = new Q402Client({\n  apiKey: "q402_live_xxxxx",\n  chain:  "avax",  // avax | bnb | eth | xlayer | stable | mantle | injective\n});\n// Note: chain "injective" is USDT-only until Circle CCTP native USDC ships (Q2 2026).` },
  { n: "03", title: "One-line gasless payment", code: `const result = await q402.pay({\n  to:     "0xRecipient...",\n  amount: "5.00",\n  token:  "USDC",  // use "USDT" for chain: "injective"\n});\nconsole.log(result.txHash);` },
  { n: "04", title: "Settlement confirmed", code: `// result = {\n//   success: true,\n//   txHash: "0xf3c8...d91e",\n//   tokenAmount: "5", token: "USDC"\n// }\n// Gas paid by Q402 — user spends $0` },
];

// ── Types ─────────────────────────────────────────────────────────────────────
interface Subscription { apiKey: string; plan: string; paidAt: string; amountUSD: number; quotaBonus?: number; sandboxApiKey?: string; trialExpiresAt?: string; email?: string; }
interface RelayedTx {
  apiKey: string; address: string; chain: string;
  fromUser: string; toUser: string; tokenAmount: number | string; tokenSymbol: string;
  gasCostNative: number; relayTxHash: string; relayedAt: string;
  receiptId?: string;
}
interface GasDeposit { chain: string; token: string; amount: number; txHash: string; depositedAt: string; }

// ── Deposit Modal ─────────────────────────────────────────────────────────────
const Spinner = ({ color = "text-yellow" }: { color?: string }) => (
  <svg className={`animate-spin w-10 h-10 ${color}`} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.2"/>
    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
  </svg>
);

// Note: Gas Tank withdrawals are currently processed manually by Q402 operations.
// Contact business@quackai.ai to request a withdrawal.
function DepositModal({ chain, token, onClose, address, onDepositVerified }: {
  chain: string; token: string; onClose: () => void; address: string;
  onDepositVerified?: (balances: Record<string, number>) => void;
}) {
  const chainKey = Object.entries(CHAIN_META).find(([, v]) => v.name === chain)?.[0] ?? chain.toLowerCase();
  const [phase, setPhase] = useState<"loading"|"main"|"awaiting_wallet"|"confirming_tx"|"checking"|"deposit_verified"|"not_found">("loading");
  const [verifiedBalances, setVerifiedBalances] = useState<Record<string, number>>({});
  const [txHashError, setTxHashError] = useState("");
  const [depositAmount, setDepositAmount] = useState("");
  const [submittedTxHash, setSubmittedTxHash] = useState("");

  useEffect(() => { const t = setTimeout(() => setPhase("main"), 1000); return () => clearTimeout(t); }, []);

  // Internal rescue: server-side retry that absorbs public-RPC lag for a freshly
  // confirmed wallet deposit. Triggered automatically by topUpWithWallet — no
  // user-facing TX-hash input is needed.
  async function creditByTxHashWithRetry(txHash: string, attempts = 8) {
    let lastError = "Payment submitted, but we could not credit it yet.";
    for (let i = 0; i < attempts; i++) {
      const res = await fetch("/api/gas-tank/verify-deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, txHash, chain: chainKey }),
      });
      const data = await res.json();
      if (res.ok && (data.newDeposits > 0 || data.alreadyCredited)) return data;
      lastError = data.error ?? lastError;

      const retryable =
        res.status === 404 &&
        /not found|not yet confirmed/i.test(lastError);
      if (!retryable || i === attempts - 1) break;
      await new Promise(resolve => setTimeout(resolve, 2500 + i * 1000));
    }
    throw new Error(lastError);
  }

  async function topUpWithWallet() {
    const amount = depositAmount.trim();
    if (!/^(?:\d+|\d*\.\d+)$/.test(amount) || Number(amount) <= 0) {
      setTxHashError(`Enter an amount of ${token} to deposit.`);
      return;
    }
    setTxHashError("");
    setSubmittedTxHash("");
    try {
      setPhase("awaiting_wallet");
      const txHash = await sendNativeTransfer({
        chain: chainKey as WalletChainKey,
        from: address,
        to: DEPOSIT_ADDRESS,
        amount,
      });
      setSubmittedTxHash(txHash);

      setPhase("confirming_tx");
      await waitForWalletReceipt(chainKey as WalletChainKey, txHash);

      setPhase("checking");
      const data = await creditByTxHashWithRetry(txHash);
      setVerifiedBalances(data.balances);
      setPhase("deposit_verified");
      onDepositVerified?.(data.balances);
    } catch (err) {
      setTxHashError(err instanceof Error ? err.message : walletErrorMessage(err));
      setPhase("not_found");
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(10px)" }} onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border p-6 shadow-2xl shadow-black" style={{ background: "#090E1A", borderColor: "rgba(245,197,24,0.2)" }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-bold text-base">{token} — {chain}</h3>
          <button onClick={onClose} className="text-white/30 hover:text-white text-xl leading-none">×</button>
        </div>

        {(phase === "loading") && <div className="flex justify-center py-8"><Spinner /></div>}

        {phase === "main" && (
          <div className="space-y-4">
            <p className="text-white/40 text-sm">Send <span className="text-yellow font-semibold">{token}</span> to Q402 to top up your gas tank.</p>
            <div className="rounded-2xl border border-yellow/20 bg-yellow/5 p-4 space-y-3">
              <div>
                <label className="block text-[10px] text-white/30 uppercase tracking-widest mb-1">
                  Amount to deposit
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={depositAmount}
                    onChange={e => setDepositAmount(e.target.value)}
                    placeholder={`0.10 ${token}`}
                    className="min-w-0 flex-1 bg-[#060C14] border border-white/10 rounded-xl px-3 py-3 text-sm font-mono text-white placeholder:text-white/20 focus:outline-none focus:border-yellow/40"
                  />
                  <span className="text-xs text-white/35 font-semibold w-14 text-right">{token}</span>
                </div>
              </div>
              <button
                onClick={topUpWithWallet}
                disabled={!depositAmount.trim()}
                className="w-full py-3 rounded-xl font-bold text-sm bg-yellow text-navy hover:bg-yellow-hover disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                Top up with wallet
              </button>
              <p className="text-[10px] text-white/30 leading-relaxed">
                We will switch to {chain}, send native {token}, wait for confirmation, and credit your Gas Tank automatically.
              </p>
            </div>
            {chainKey === "stable" ? (
              <div className="flex items-start gap-2.5 bg-green-400/5 border border-green-400/20 rounded-xl px-4 py-3 text-xs text-green-400/80">
                <span className="mt-0.5 flex-shrink-0">ℹ</span>
                <span>
                  Stable chain uses <strong>USDT0</strong> as both gas token and payment token.
                  Send USDT0 on Stable network (Chain ID 988) to this address.
                  Do <strong>not</strong> send ETH, BNB, or AVAX.
                </span>
              </div>
            ) : (
              <div className="flex items-start gap-2.5 bg-yellow/5 border border-yellow/15 rounded-xl px-4 py-3 text-xs text-yellow/80">
                <span className="mt-0.5 flex-shrink-0">⚡</span>
                <span>Only send <strong>{token}</strong> on the <strong>{chain}</strong> network.</span>
              </div>
            )}
            <div className="border-t border-white/8 pt-4">
              <p className="text-xs text-white/30 mb-1">Gas Tank withdrawals</p>
              <p className="text-xs text-white/20 leading-relaxed">
                Withdrawals are processed manually by Q402 operations.
                Contact <span className="text-white/40">business@quackai.ai</span> to request a refund.
              </p>
            </div>
          </div>
        )}

        {(phase === "awaiting_wallet" || phase === "confirming_tx" || phase === "checking") && (
          <div className="flex flex-col items-center gap-4 py-8">
            <Spinner />
            <div className="text-center">
              <p className="text-white/60 text-sm font-semibold">
                {phase === "awaiting_wallet" ? `Confirm ${token} deposit in your wallet`
                  : phase === "confirming_tx" ? "Waiting for on-chain confirmation..."
                  : "Crediting your Gas Tank..."}
              </p>
              <p className="text-white/30 text-xs mt-1">
                {phase === "checking"
                  ? "Public RPCs can lag for a few seconds. We will retry automatically."
                  : submittedTxHash ? shortHash(submittedTxHash) : "Do not close this modal."}
              </p>
            </div>
          </div>
        )}

        {phase === "deposit_verified" && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3 bg-green-400/8 border border-green-400/20 rounded-xl px-4 py-3">
              <span className="text-green-400 text-xl">✓</span>
              <div><p className="text-green-400 font-bold text-sm">Deposit Confirmed!</p><p className="text-white/40 text-xs">Gas tank credited.</p></div>
            </div>
            <div className="space-y-1.5 text-xs font-mono">
              {Object.entries(verifiedBalances).filter(([, v]) => v > 0).map(([c, amt]) => (
                <div key={c} className="flex justify-between text-white/50 bg-white/4 rounded-lg px-3 py-2">
                  <span className="uppercase text-white/30">{c}</span>
                  <span className="text-white/70">{amt.toFixed(4)} {CHAIN_META[c]?.token ?? c.toUpperCase()}</span>
                </div>
              ))}
            </div>
            <button onClick={onClose} className="w-full py-3 rounded-xl font-bold text-sm bg-yellow text-navy hover:bg-yellow-hover transition-all">Back to Dashboard</button>
          </div>
        )}


        {phase === "not_found" && (
          <div className="space-y-4 py-2">
            <div className="bg-red-400/8 border border-red-400/20 rounded-xl px-4 py-3 text-sm text-red-400">
              {txHashError || "Deposit could not be confirmed yet. Try again in a moment."}
            </div>
            <button
              onClick={() => { setTxHashError(""); setPhase("main"); }}
              className="w-full py-2.5 rounded-xl text-sm bg-yellow/10 text-yellow border border-yellow/20 hover:bg-yellow/20 transition-all font-semibold"
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

// ── Bar Chart ─────────────────────────────────────────────────────────────────
function BarChart({ data, labels }: { data: number[]; labels: string[] }) {
  const max = Math.max(...data) || 1;
  return (
    <div className="flex items-end gap-1.5 h-28">
      {data.map((v, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1 group">
          <div className="relative w-full" style={{ height: `${Math.max((v / max) * 100, v > 0 ? 4 : 0)}%` }}>
            <motion.div initial={{ scaleY: 0 }} animate={{ scaleY: 1 }} transition={{ duration: 0.5, delay: i * 0.03 }}
              style={{ transformOrigin: "bottom", background: i === data.length - 1 ? "#F5C518" : "rgba(245,197,24,0.3)" }}
              className="w-full h-full rounded-sm" />
            {v > 0 && <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-[10px] font-mono text-white/50 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity bg-navy px-1 rounded">{v}</div>}
          </div>
          {i % 3 === 0 && <span className="text-[9px] text-white/20 font-mono whitespace-nowrap">{labels[i]?.split(" ")[1]}</span>}
        </div>
      ))}
    </div>
  );
}

// ── Playground ────────────────────────────────────────────────────────────────
function Playground({ apiKey, trialView }: { apiKey: string; trialView: boolean }) {
  const [chain, setChain] = useState(trialView ? "bnb" : "avax");
  const [token, setToken] = useState<"USDC" | "USDT" | "RLUSD">("USDC");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("5");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<null | { hash: string }>(null);

  // Per-chain token availability mirrors app/api/relay/route.ts CHAIN_TOKEN_ALLOWLIST.
  //   - Injective: USDT only (Circle CCTP native USDC announced for Q2 2026)
  //   - Ethereum:  USDC / USDT / RLUSD (Ripple USD, NY DFS regulated, decimals 18)
  //   - Others:    USDC / USDT
  // BNB-focus sprint collapses every chain except bnb to []; the playground
  // hides them in the picker below, so this branch only matters once the flag
  // flips back.
  const availableTokens: ("USDC" | "USDT" | "RLUSD")[] = trialView
    ? ["USDC", "USDT"]
    : chain === "injective" ? ["USDT"]
      : chain === "eth"    ? ["USDC", "USDT", "RLUSD"]
      :                       ["USDC", "USDT"];

  // Coerce the selected token onto the chain's allowlist when chain changes.
  // (e.g. user had RLUSD selected on eth, then switched to bnb → snap to USDC.)
  useEffect(() => {
    if (!availableTokens.includes(token)) {
      setToken(availableTokens[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain]);

  // Snap chain to BNB when the user flips into trial view (and they were
  // previously on a chain that's no longer in the dropdown). Avoids a
  // stale dropdown showing "Avalanche" while the playground only renders
  // the BNB option after the trial-view re-render.
  useEffect(() => {
    if (trialView && chain !== "bnb") setChain("bnb");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trialView]);

  const previewToken = token;

  async function simulate() {
    setLoading(true); setResult(null);
    await new Promise(r => setTimeout(r, 1800));
    setLoading(false);
    setResult({ hash: `0x${Math.random().toString(16).slice(2, 10)}…${Math.random().toString(16).slice(2, 6)}` });
  }

  return (
    <div className="space-y-5">
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div><label className="text-xs text-white/30 uppercase tracking-widest block mb-1.5">Chain</label>
          <div className="relative">
            <select value={chain} onChange={e => setChain(e.target.value)} className="w-full appearance-none border border-white/8 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-yellow/30 cursor-pointer" style={{ background: "#0d1422" }}>
              {trialView ? (
                <option value="bnb" style={{ background: "#0d1422" }}>BNB Chain ✓ (trial)</option>
              ) : (
                <>
                  <option value="avax" style={{ background: "#0d1422" }}>Avalanche ✓</option>
                  <option value="bnb" style={{ background: "#0d1422" }}>BNB Chain ✓</option>
                  <option value="eth" style={{ background: "#0d1422" }}>Ethereum ✓</option>
                  <option value="xlayer" style={{ background: "#0d1422" }}>X Layer ✓</option>
                  <option value="stable" style={{ background: "#0d1422" }}>Stable ✓</option>
                  <option value="mantle" style={{ background: "#0d1422" }}>Mantle ✓</option>
                  <option value="injective" style={{ background: "#0d1422" }}>Injective ✓</option>
                </>
              )}
            </select>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/30 text-xs">▾</span>
          </div></div>
        <div><label className="text-xs text-white/30 uppercase tracking-widest block mb-1.5">Token</label>
          <div className="relative">
            <select value={token} onChange={e => setToken(e.target.value as "USDC" | "USDT" | "RLUSD")} className="w-full appearance-none border border-white/8 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-yellow/30 cursor-pointer" style={{ background: "#0d1422" }}>
              {availableTokens.map(t => (
                <option key={t} value={t} style={{ background: "#0d1422" }}>{t}{t === "RLUSD" ? " (Ethereum-only)" : ""}</option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/30 text-xs">▾</span>
          </div></div>
        <div><label className="text-xs text-white/30 uppercase tracking-widest block mb-1.5">Recipient</label>
          <input value={to} onChange={e => setTo(e.target.value)} placeholder="0x..." className="w-full bg-white/5 border border-white/8 rounded-xl px-3 py-2.5 text-sm text-white font-mono outline-none focus:border-yellow/30 placeholder-white/20" /></div>
        <div><label className="text-xs text-white/30 uppercase tracking-widest block mb-1.5">Amount ({previewToken})</label>
          <input type="number" value={amount} onChange={e => setAmount(e.target.value)} className="w-full bg-white/5 border border-white/8 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-yellow/30" /></div>
      </div>
      <div className="bg-[#060C14] border border-white/8 rounded-xl p-4 font-mono text-xs text-white/50 leading-6">
        <div><span className="text-purple-400">const</span><span className="text-white"> tx </span><span className="text-white/30">= await </span><span className="text-blue-300">q402</span><span className="text-white/30">.pay({"{"}</span></div>
        <div className="pl-5">
          <div><span className="text-green-300">to</span><span className="text-white/30">: </span><span className="text-orange-300">&quot;{to}&quot;</span><span className="text-white/30">,</span></div>
          <div><span className="text-green-300">amount</span><span className="text-white/30">: </span><span className="text-cyan-300">&quot;{amount}&quot;</span><span className="text-white/30">,</span></div>
          <div><span className="text-green-300">token</span><span className="text-white/30">: </span><span className="text-orange-300">&quot;{previewToken}&quot;</span></div>
        </div>
        <div><span className="text-white/30">{"});"}</span></div>
      </div>
      <button onClick={simulate} disabled={loading} className="bg-yellow text-navy font-bold text-sm px-6 py-3 rounded-xl hover:bg-yellow-hover transition-all disabled:opacity-60 flex items-center gap-2">
        {loading ? (<><svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3"/><path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/></svg>Sending…</>) : "▶ Run Simulation"}
      </button>
      {result && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="bg-green-400/5 border border-green-400/20 rounded-xl p-4 font-mono text-xs space-y-1">
          <div className="text-green-400 font-bold mb-2">✓ Simulated</div>
          <div><span className="text-white/30">hash: </span><span className="text-orange-300">{result.hash}</span></div>
          <div><span className="text-white/30">gas by user: </span><span className="text-yellow font-bold">$0.000000</span></div>
          <div><span className="text-white/30">{previewToken} sent: </span><span className="text-green-400">${amount}.00</span></div>
        </motion.div>
      )}
      <div className="pt-4 border-t border-white/6">
        <p className="text-xs text-white/25 mb-2">Your API Key</p>
        <div className="flex items-center gap-2 font-mono text-xs text-white/50 bg-navy border border-white/8 rounded-lg px-3 py-2">
          <span className="flex-1 break-all">{apiKey ? `${apiKey.slice(0, 12)}${"•".repeat(16)}${apiKey.slice(-4)}` : "—"}</span>
          <button
            onClick={() => { navigator.clipboard.writeText(apiKey); }}
            className="text-white/25 hover:text-yellow transition-colors flex-shrink-0 text-[10px] uppercase tracking-widest"
          >Copy</button>
        </div>
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
const TABS = ["overview", "gas-tank", "developer", "transactions", "claude"] as const;
type Tab = typeof TABS[number];

export default function DashboardPage() {
  const { address, isConnected, signMessage } = useWallet();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("overview");
  const [keyCopied, setKeyCopied] = useState(false);
  const [depositChain, setDepositChain] = useState<{ chain: string; token: string } | null>(null);
  const [alertEmail, setAlertEmail] = useState("");
  const [alertEmailInput, setAlertEmailInput] = useState("");
  const [showEmailSetup, setShowEmailSetup] = useState(false);
  const [emailSaved, setEmailSaved] = useState(false);

  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [isExpired, setIsExpired] = useState(false);
  const [sandboxApiKey, setSandboxApiKey] = useState<string>("");
  const [sandboxKeyCopied, setSandboxKeyCopied] = useState(false);
  const [relayedTxs, setRelayedTxs] = useState<RelayedTx[]>([]);
  const [thisMonthCount, setThisMonthCount] = useState(0); // for chart only
  const [gasDeposits, setGasDeposits] = useState<GasDeposit[]>([]);
  const [userGasBalance, setUserGasBalance] = useState<Record<string, number>>({ bnb: 0, eth: 0, avax: 0, xlayer: 0, stable: 0, mantle: 0, injective: 0 });
  const [tokenPrices, setTokenPrices] = useState<Record<string, number>>({});
  const [walletBalances, setWalletBalances] = useState<Record<string, number>>({});
  const [tankLoading, setTankLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  // Top-level view toggle: trial-flavored (BNB-only · 2k credits · no Gas
  // Tank · trial key) vs the original Multichain dashboard. Defaulted to
  // trial for plan === "trial" wallets so first-touch lands on what they
  // just signed up for.
  const [trialViewActive, setTrialViewActive] = useState(false);
  const [hasPaid, setHasPaid] = useState<boolean | null>(null);
  // Server-computed paywall bypass flag — see /api/keys/provision. The list
  // of owner EOAs lives in OWNER_WALLETS (server-only env) and never reaches
  // the client bundle; we receive only the boolean for the connected address.
  const [isOwner,  setIsOwner]  = useState<boolean>(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookUrlInput, setWebhookUrlInput] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [webhookSaving, setWebhookSaving] = useState(false);
  const [webhookTesting, setWebhookTesting] = useState(false);
  const [webhookTestResult, setWebhookTestResult] = useState<null | { ok: boolean; msg: string }>(null);
  const [rotatingKey, setRotatingKey] = useState(false);
  const [rotateConfirm, setRotateConfirm] = useState(false);
  // Email session (Google OAuth or magic-link signup). When the user signed
  // in via /api/auth/google or clicked an email magic link, /api/auth/me
  // returns { authenticated: true, email, address? }. We surface a
  // separate sandbox-only view for sessions that have no paired wallet yet,
  // so "API key 받으러 온" users can grab their sandbox key in one click.
  const [emailSession, setEmailSession] = useState<{
    email: string;
    address: string | null;
  } | null>(null);
  const [sessionTrial, setSessionTrial] = useState<{
    apiKey: string | null;
    sandboxApiKey: string | null;
    credits: number;
    totalCredits: number;
    trialExpiresAt: string | null;
  }>({ apiKey: null, sandboxApiKey: null, credits: 0, totalCredits: 2000, trialExpiresAt: null });
  const [sessionLiveCopied, setSessionLiveCopied] = useState(false);
  const [sessionSandboxCopied, setSessionSandboxCopied] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Auto-flip to trial view on first load when the subscription's plan is
  // "trial" (Google / email signup grants this). Users can toggle back any
  // time; we don't override their explicit choice on subsequent renders.
  const initialViewMatched = useRef(false);
  useEffect(() => {
    if (initialViewMatched.current) return;
    if (subscription?.plan === "trial") {
      setTrialViewActive(true);
      initialViewMatched.current = true;
    } else if (subscription) {
      initialViewMatched.current = true;
    }
  }, [subscription]);

  useEffect(() => {
    let cancelled = false;
    async function loadSession() {
      try {
        const res = await fetch("/api/auth/me", { credentials: "include" });
        const data = await res.json();
        if (cancelled) return;
        if (data.authenticated && typeof data.email === "string") {
          setEmailSession({ email: data.email, address: data.address ?? null });
        }
      } catch {
        /* no session — silent */
      }
    }
    loadSession();
    return () => {
      cancelled = true;
    };
  }, []);

  // When the user is email-only (session active, no wallet connected), fetch
  // the sandbox key bound to their email account. Lookup is via the email
  // pseudo-address index that /api/auth/google + /api/auth/email/callback
  // both populate. We POST to /api/keys/provision-by-email so the path stays
  // unauthenticated-by-email — server reads the session cookie, never trusts
  // a client-supplied email.
  useEffect(() => {
    if (!emailSession || emailSession.address || isConnected) return;
    let cancelled = false;
    async function loadTrial() {
      try {
        const res = await fetch("/api/keys/email-sandbox", { credentials: "include" });
        const data = await res.json();
        if (cancelled || !res.ok) return;
        setSessionTrial({
          apiKey: data.apiKey ?? null,
          sandboxApiKey: data.sandboxApiKey ?? null,
          credits: typeof data.credits === "number" ? data.credits : 0,
          totalCredits: typeof data.totalCredits === "number" ? data.totalCredits : 2000,
          trialExpiresAt: data.trialExpiresAt ?? null,
        });
      } catch {
        /* leave blanks; UI falls back to "—" */
      }
    }
    loadTrial();
    return () => {
      cancelled = true;
    };
  }, [emailSession, isConnected]);

  useEffect(() => {
    if (!address) return;
    const addr = address;
    let cancelled = false;
    async function load() {
      const auth = await getAuthCreds(addr, signMessage);
      if (!auth || cancelled) return;
      const { nonce, signature } = auth;
      try {
        const qs  = new URLSearchParams({ address: addr, nonce, sig: signature }).toString();
        const res = await fetch(`/api/usage-alert?${qs}`);
        const d   = await res.json();
        if (cancelled) return;
        if (res.status === 401 && d.code === "NONCE_EXPIRED") { clearAuthCache(addr); return; }
        if (d.configured && d.email) {
          setAlertEmail(d.email);
          setShowEmailSetup(false);
        } else {
          setAlertEmail("");
          setShowEmailSetup(true);
        }
      } catch { /* network blip — leave banner open */ }
    }
    load();
    return () => { cancelled = true; };
  }, [address, signMessage]);
  useEffect(() => {
    if (!mounted) return;
    const t = setTimeout(() => { if (!isConnected) router.push("/"); }, 600);
    return () => clearTimeout(t);
  }, [mounted, isConnected, router]);

  const refreshUserBalance = useCallback(async (addr: string) => {
    // Q402-SEC-003: user-balance now requires nonce+signature auth.
    // Reuses the cached session nonce (55-min sessionStorage TTL) — no
    // extra wallet popup on re-renders.
    const auth = await getAuthCreds(addr, signMessage);
    if (!auth) return;
    const { nonce, signature } = auth;
    const qs = new URLSearchParams({ address: addr, nonce, sig: signature }).toString();
    try {
      const res  = await fetch(`/api/gas-tank/user-balance?${qs}`);
      const data = await res.json();
      if (res.status === 401 && data.code === "NONCE_EXPIRED") {
        clearAuthCache(addr);
        return;
      }
      if (data.balances) setUserGasBalance(data.balances);
      if (data.deposits) setGasDeposits(data.deposits);
    } catch { /* ignore */ }
  }, [signMessage]);

  useEffect(() => {
    if (!address) return;
    const addr = address; // narrow to string for async closures

    async function provision() {
      // getAuthCreds caches {nonce, signature} in sessionStorage for 7.5h.
      // On 401 NONCE_EXPIRED the caller clears the cache and the user re-signs on next load.
      const auth = await getAuthCreds(addr, signMessage);
      if (!auth) return; // user rejected wallet prompt

      const { nonce, signature } = auth;

      let provData: Record<string, unknown> = {};
      try {
        const res = await fetch("/api/keys/provision", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ address: addr, nonce, signature }),
        });
        provData = await res.json();
        if (res.status === 401 && provData.code === "NONCE_EXPIRED") {
          clearAuthCache(addr);
          return;
        }
      } catch { return; }

      if (provData.sandboxApiKey) setSandboxApiKey(provData.sandboxApiKey as string);
      setHasPaid(provData.hasPaid === true);
      setIsOwner(provData.isOwner === true);

      setSubscription(prev => ({
        ...(prev ?? { paidAt: "", plan: "starter", amountUSD: 0 }),
        apiKey:     (provData.hasPaid ? provData.apiKey : "") as string ?? "",
        plan:       provData.plan as string ?? "starter",
        quotaBonus: provData.quotaBonus as number ?? prev?.quotaBonus ?? 0,
        paidAt:     provData.paidAt as string ?? prev?.paidAt ?? "",
        amountUSD:  prev?.amountUSD ?? 0,
      }));

      // Fetch subscription expiry & status
      fetch(`/api/payment/check?address=${addr}`)
        .then(r => r.json())
        .then(data => {
          if (data.expiresAt) { setExpiresAt(new Date(data.expiresAt)); setIsExpired(data.isExpired ?? false); }
        })
        .catch(() => {});

      // Fetch webhook config
      fetch(`/api/webhook?address=${addr}&nonce=${encodeURIComponent(nonce)}&sig=${encodeURIComponent(signature)}`)
        .then(r => r.json())
        .then(data => { if (data.configured && data.url) setWebhookUrl(data.url); })
        .catch(() => {});
    }

    provision();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  useEffect(() => {
    if (!address) return;
    const addr = address;
    async function fetchTxs() {
      const auth = await getAuthCreds(addr, signMessage);
      if (!auth) return;
      const { nonce, signature } = auth;
      const res = await fetch(`/api/transactions?address=${addr}&nonce=${encodeURIComponent(nonce)}&sig=${encodeURIComponent(signature)}`);
      if (res.status === 401) { const d = await res.json(); if (d.code === "NONCE_EXPIRED") clearAuthCache(addr); return; }
      const data = await res.json();
      if (data.txs) setRelayedTxs(data.txs);
      if (data.thisMonthCount !== undefined) setThisMonthCount(data.thisMonthCount);
    }
    fetchTxs().catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, subscription]);

  useEffect(() => {
    setTankLoading(true);
    fetch("/api/gas-tank").then(r => r.json()).then(data => {
      if (data.tanks) {
        const prices: Record<string, number> = {};
        for (const t of data.tanks) prices[t.key] = t.price;
        setTokenPrices(prices);
      }
    }).catch(() => {}).finally(() => setTankLoading(false));
  }, []);

  useEffect(() => {
    if (!address) return;
    refreshUserBalance(address);
    fetch(`/api/wallet-balance?address=${address}`).then(r => r.json()).then(data => {
      if (data.balances) setWalletBalances(data.balances);
    }).catch(() => {});
  }, [address, refreshUserBalance]);

  // Email-only view: user signed in via Google / magic-link, no wallet
  // connected yet. Trial is already active (Google/email callback grants
  // 2,000 sponsored TX + live key on first signup) — surface everything
  // they need in one screen.
  if (mounted && emailSession && !isConnected) {
    const trialDaysLeft = sessionTrial.trialExpiresAt
      ? Math.max(0, Math.ceil((new Date(sessionTrial.trialExpiresAt).getTime() - Date.now()) / 86_400_000))
      : null;
    const creditsPct = Math.min(100, Math.max(0, Math.round((sessionTrial.credits / Math.max(1, sessionTrial.totalCredits)) * 100)));

    return (
      <div className="min-h-screen text-white px-6 py-12" style={{ background: "linear-gradient(160deg, #05070A 0%, #0B1220 100%)" }}>
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between mb-8">
            <Link href="/" className="text-yellow font-bold text-base">Q402</Link>
            <div className="flex items-center gap-3 text-xs text-white/45">
              <span>{emailSession.email}</span>
              <button
                onClick={async () => {
                  await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
                  router.push("/");
                }}
                className="text-white/35 hover:text-white transition-colors"
              >
                Sign out
              </button>
            </div>
          </div>

          <h1 className="text-2xl font-bold mb-1">Welcome, {emailSession.email.split("@")[0]}</h1>
          <p className="text-white/45 text-sm mb-8">
            Your free trial is active. 2,000 sponsored TX on BNB Chain, Q402 covers the gas.
            Use the live key from your backend; connect a wallet only when an end user signs an EIP-712.
          </p>

          {/* Trial summary card — sponsored TX gauge + days left + chain badge */}
          <div className="rounded-2xl border border-yellow/25 p-6 mb-6"
               style={{ background: "linear-gradient(135deg, rgba(245,197,24,0.06) 0%, rgba(74,222,128,0.04) 100%)" }}>
            <div className="flex items-baseline justify-between mb-4">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-yellow font-bold mb-1">Sponsored TX</div>
                <div className="text-3xl font-display font-extrabold text-yellow leading-none">
                  {sessionTrial.credits.toLocaleString()}
                  <span className="text-white/30 text-base ml-1">/ {sessionTrial.totalCredits.toLocaleString()}</span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-widest text-white/35 font-bold mb-1">Trial ends in</div>
                <div className="text-2xl font-display font-extrabold text-white leading-none">
                  {trialDaysLeft !== null ? `${trialDaysLeft}d` : "—"}
                </div>
              </div>
            </div>
            <div className="h-1.5 rounded-full bg-white/5 overflow-hidden mb-3">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${creditsPct}%`,
                  background: "linear-gradient(90deg, #F5C518, #4ade80)",
                }}
              />
            </div>
            <div className="flex items-center gap-2 text-[11px] text-white/45">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-yellow animate-pulse" />
                Active
              </span>
              <span className="text-white/20">·</span>
              <span>BNB Chain · USDC + USDT</span>
              <span className="text-white/20">·</span>
              <span>Q402 covers gas</span>
            </div>
          </div>

          {/* Live API key — primary, the key they came for */}
          <div className="rounded-2xl border border-white/10 p-6 mb-4" style={{ background: "rgba(255,255,255,0.03)" }}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-widest text-white/45 font-semibold">Live API key</div>
              <span className="text-[10px] font-bold uppercase tracking-widest text-yellow bg-yellow/15 border border-yellow/40 rounded-sm px-1.5 py-0.5">
                BNB only
              </span>
            </div>
            <div className="flex items-center gap-3">
              <code className="flex-1 font-mono text-sm text-yellow break-all">
                {sessionTrial.apiKey || "—"}
              </code>
              <button
                onClick={() => {
                  if (!sessionTrial.apiKey) return;
                  navigator.clipboard.writeText(sessionTrial.apiKey);
                  setSessionLiveCopied(true);
                  setTimeout(() => setSessionLiveCopied(false), 2000);
                }}
                disabled={!sessionTrial.apiKey}
                className="text-xs px-3 py-1.5 rounded-md bg-white/5 hover:bg-yellow/15 hover:text-yellow text-white/60 transition-colors disabled:opacity-40"
              >
                {sessionLiveCopied ? "Copied!" : "Copy"}
              </button>
            </div>
            <p className="text-white/30 text-xs mt-3">
              Use with the SDK on <code className="text-white/55">chain: &quot;bnb&quot;</code>, token{" "}
              <code className="text-white/55">&quot;USDC&quot;</code> or <code className="text-white/55">&quot;USDT&quot;</code>.
              Each relay consumes one sponsored TX credit.
            </p>
          </div>

          {/* Sandbox API key — secondary */}
          <div className="rounded-2xl border border-white/8 p-6 mb-6" style={{ background: "rgba(255,255,255,0.02)" }}>
            <div className="text-[10px] uppercase tracking-widest text-white/35 font-semibold mb-2">Sandbox API key</div>
            <div className="flex items-center gap-3">
              <code className="flex-1 font-mono text-sm text-white/70 break-all">
                {sessionTrial.sandboxApiKey || "—"}
              </code>
              <button
                onClick={() => {
                  if (!sessionTrial.sandboxApiKey) return;
                  navigator.clipboard.writeText(sessionTrial.sandboxApiKey);
                  setSessionSandboxCopied(true);
                  setTimeout(() => setSessionSandboxCopied(false), 2000);
                }}
                disabled={!sessionTrial.sandboxApiKey}
                className="text-xs px-3 py-1.5 rounded-md bg-white/5 hover:bg-yellow/15 hover:text-yellow text-white/60 transition-colors disabled:opacity-40"
              >
                {sessionSandboxCopied ? "Copied!" : "Copy"}
              </button>
            </div>
            <p className="text-white/30 text-xs mt-3">
              Mock-response key for integration testing — no real TX, no credits burned.
            </p>
          </div>

          {/* Wallet-bind nudge */}
          <div className="rounded-2xl border border-white/8 p-6 mb-6" style={{ background: "rgba(255,255,255,0.02)" }}>
            <h2 className="text-base font-bold mb-2">Need to test the full flow yourself?</h2>
            <p className="text-white/45 text-sm mb-4">
              Connect a wallet to sign EIP-712 from this browser. Trial credits + keys stay attached to your email account.
            </p>
            <Link
              href="/event"
              className="inline-block bg-white/5 border border-white/15 text-white font-semibold text-sm px-6 py-2.5 rounded-full hover:bg-white/10 transition-colors"
            >
              Connect wallet →
            </Link>
          </div>

          <div className="text-white/35 text-xs">
            Docs: <Link href="/docs" className="hover:text-white/60 underline-offset-2 hover:underline">/docs</Link>{" · "}
            Claude MCP: <Link href="/claude" className="hover:text-white/60 underline-offset-2 hover:underline">/claude</Link>
          </div>
        </div>
      </div>
    );
  }

  if (!mounted || !isConnected || !address) return null;

  const isGated = hasPaid === false && !isOwner;

  const API_KEY = subscription?.apiKey ?? "—";
  const plan = subscription?.plan ?? "starter";

  // View mode — top-level toggle between Free-trial flavoring and the
  // original Multichain dashboard. State lives on a query param so a
  // refresh / share-link keeps the user in the same view.
  const isTrialAccount = plan === "trial";
  const viewMode: "trial" | "multichain" = trialViewActive ? "trial" : "multichain";
  // Internal key "enterprise_flex" is shown to users as just "Enterprise".
  const planDisplayKey = plan === "enterprise_flex" ? "enterprise" : plan;
  const planName = planDisplayKey.charAt(0).toUpperCase() + planDisplayKey.slice(1);
  // TX credits remaining — decrements on each successful relay
  const remainingCredits = subscription?.quotaBonus ?? 0;
  // Use plan base quota as reference for the bar (credits start at plan quota per payment)
  const baseCredits = PLAN_QUOTA[plan.toLowerCase()] ?? 500;
  // pct consumed = how far below base we are (capped 0–100)
  const pct = Math.min(100, Math.max(0, Math.round((1 - remainingCredits / Math.max(baseCredits, 1)) * 100)));
  const daysLeft = expiresAt ? Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000) : null;
  const totalUserUSD = Object.entries(userGasBalance).reduce((sum, [c, amt]) => {
    return sum + amt * (tokenPrices[c] ?? 0);
  }, 0);

  // Build 14-day chart
  const today = new Date();
  const dailyLabels: string[] = [];
  const dailyData: number[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    dailyLabels.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    dailyData.push(relayedTxs.filter(tx => new Date(tx.relayedAt).toDateString() === d.toDateString()).length);
  }

  function copyKey() { navigator.clipboard.writeText(API_KEY); setKeyCopied(true); setTimeout(() => setKeyCopied(false), 2000); }

  function copySandboxKey() {
    navigator.clipboard.writeText(sandboxApiKey);
    setSandboxKeyCopied(true);
    setTimeout(() => setSandboxKeyCopied(false), 2000);
  }

  async function rotateKey() {
    if (!address) return;
    // Key rotation requires a fresh one-time challenge (not the cached session nonce)
    const chal = await getFreshChallenge(address, signMessage);
    if (!chal) return;
    const { challenge, signature } = chal;
    setRotatingKey(true);
    try {
      const res = await fetch("/api/keys/rotate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, challenge, signature }) });
      const data = await res.json();
      if (res.status === 401 && data.code === "NONCE_EXPIRED") { clearAuthCache(address); return; }
      if (data.apiKey) {
        setSubscription(prev => prev ? { ...prev, apiKey: data.apiKey } : null);
        setRotateConfirm(false);
      }
    } catch { /* ignore */ } finally { setRotatingKey(false); }
  }

  async function saveAlertEmail() {
    if (!address || !alertEmailInput) return;
    const auth = await getAuthCreds(address, signMessage);
    if (!auth) return;
    const { nonce, signature } = auth;
    try {
      const res = await fetch("/api/usage-alert", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ address, nonce, signature, email: alertEmailInput }),
      });
      const data = await res.json();
      if (res.status === 401 && data.code === "NONCE_EXPIRED") { clearAuthCache(address); return; }
      if (!res.ok || !data.ok) return;
      setAlertEmail(alertEmailInput);
      setEmailSaved(true);
      setTimeout(() => { setShowEmailSetup(false); setEmailSaved(false); }, 1500);
    } catch { /* ignore */ }
  }

  async function saveWebhook() {
    if (!address) return;
    const auth = await getAuthCreds(address, signMessage);
    if (!auth) return;
    const { nonce, signature } = auth;
    if (!webhookUrlInput) return;
    setWebhookSaving(true);
    try {
      const res = await fetch("/api/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, nonce, signature, url: webhookUrlInput }) });
      const data = await res.json();
      if (res.status === 401 && data.code === "NONCE_EXPIRED") { clearAuthCache(address); return; }
      if (data.success) {
        setWebhookUrl(webhookUrlInput);
        if (data.secret) setWebhookSecret(data.secret);
      }
    } catch { /* ignore */ } finally { setWebhookSaving(false); }
  }

  async function testWebhook() {
    if (!address) return;
    const auth = await getAuthCreds(address, signMessage);
    if (!auth) return;
    const { nonce, signature } = auth;
    setWebhookTesting(true); setWebhookTestResult(null);
    try {
      const res = await fetch("/api/webhook/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, nonce, signature }) });
      const data = await res.json();
      if (res.status === 401 && data.code === "NONCE_EXPIRED") { clearAuthCache(address); setWebhookTestResult({ ok: false, msg: "Session expired. Please reload." }); return; }
      setWebhookTestResult({ ok: data.success, msg: data.success ? `Delivered (HTTP ${data.statusCode})` : (data.error ?? "Failed") });
    } catch { setWebhookTestResult({ ok: false, msg: "Network error" }); } finally { setWebhookTesting(false); }
  }

  const tabLabel: Record<Tab, string> = {
    "overview": "Overview",
    "gas-tank": "Gas Tank",
    "developer": "Developer",
    "transactions": `Transactions${relayedTxs.length > 0 ? ` (${relayedTxs.length})` : ""}`,
    "claude": "Claude",
  };

  return (
    <div className="min-h-screen text-white" style={{ background: "linear-gradient(160deg, #05070A 0%, #0B1220 100%)" }}>
      {/* Paywall gate — shown to connected-but-unpaid users */}
      {isGated && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center px-4"
          style={{ background: "rgba(5,7,10,0.88)", backdropFilter: "blur(14px)" }}>
          <div className="w-full max-w-sm rounded-2xl border p-8 text-center shadow-2xl shadow-black"
            style={{ background: "#090E1A", borderColor: "rgba(245,197,24,0.2)" }}>
            <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-5"
              style={{ background: "rgba(245,197,24,0.08)", border: "1px solid rgba(245,197,24,0.2)" }}>
              <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
                style={{ color: "#F5C518" }}>
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
            </div>
            <h2 className="text-lg font-bold mb-2">Activate My Page</h2>
            <p className="text-white/40 text-sm mb-7 leading-relaxed">
              My Page is available to active Q402 subscribers.<br />
              Make a one-time payment to unlock your API key, Gas Tank, and transaction history — or apply for a grant to get access at no cost.
            </p>
            <div className="space-y-3">
              <button
                onClick={() => router.push("/payment")}
                className="block w-full bg-yellow text-navy font-bold text-sm py-3.5 rounded-full hover:bg-yellow-hover transition-colors">
                Activate — from $29 / 30-day access
              </button>
              <button
                onClick={() => router.push("/grant")}
                className="block w-full border text-sm font-medium py-3.5 rounded-full transition-colors hover:bg-yellow/5"
                style={{ borderColor: "rgba(245,197,24,0.3)", color: "#F5C518" }}>
                Apply for a Grant instead
              </button>
            </div>
            <p className="text-white/20 text-xs mt-6">Connected as {shortAddr(address)}</p>
          </div>
        </div>
      )}

      {depositChain && (
        <DepositModal chain={depositChain.chain} token={depositChain.token} onClose={() => setDepositChain(null)} address={address}
          onDepositVerified={balances => { setUserGasBalance(balances); setDepositChain(null); }} />
      )}

      <header className="border-b px-6 h-16 flex items-center justify-between max-w-7xl mx-auto sticky top-0 z-40 backdrop-blur-md"
        style={{ borderColor: "rgba(255,255,255,0.07)", background: "rgba(5,7,10,0.85)" }}>
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-yellow font-bold text-base">Q402</span>
          <span className="text-white/25 text-xs hidden sm:block">Dashboard</span>
        </Link>
        <div className="flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-2 bg-white/5 border border-white/8 rounded-full px-3 py-1.5">
            <span className="text-xs text-white/30 font-mono">{shortAddr(address)}</span>
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" style={{ boxShadow: "0 0 5px #4ade80" }} />
          </div>
          <WalletButton />
        </div>
      </header>

      {/* Trial banner — surfaces when subscription.plan === "trial".
          Shown above the paying-user warning so a trial user about to
          expire still sees the upgrade CTA, not the renewal CTA. */}
      {plan === "trial" && (
        <div className="border-b px-6 py-3 flex items-center justify-between gap-4"
          style={{ background: "rgba(74,222,128,0.06)", borderColor: "rgba(74,222,128,0.25)" }}>
          <p className="text-green-400 text-sm font-medium">
            Free trial active{daysLeft !== null ? <> · <span className="font-bold">{daysLeft} day{daysLeft !== 1 ? "s" : ""} left</span></> : null}
            <span className="text-white/40 text-xs ml-2">
              {remainingCredits.toLocaleString()} / {(PLAN_QUOTA.trial).toLocaleString()} TX remaining · Q402 covers gas
            </span>
          </p>
          <button onClick={() => router.push("/payment")}
            className="flex-shrink-0 bg-yellow text-navy font-bold text-xs px-4 py-1.5 rounded-full hover:bg-yellow-hover transition-colors">
            Upgrade
          </button>
        </div>
      )}

      {/* Expiry warning banner — only for paying users */}
      {hasPaid && daysLeft !== null && daysLeft <= 7 && !isExpired && (
        <div className="border-b px-6 py-3 flex items-center justify-between gap-4"
          style={{ background: "rgba(245,197,24,0.06)", borderColor: "rgba(245,197,24,0.2)" }}>
          <p className="text-yellow text-sm font-medium">
            Your subscription expires in <span className="font-bold">{daysLeft} day{daysLeft !== 1 ? "s" : ""}</span>. Renew now to avoid service interruption.
          </p>
          <button onClick={() => router.push("/payment")}
            className="flex-shrink-0 bg-yellow text-navy font-bold text-xs px-4 py-1.5 rounded-full hover:bg-yellow-hover transition-colors">
            Renew
          </button>
        </div>
      )}
      {hasPaid && isExpired && (
        <div className="border-b px-6 py-3 flex items-center justify-between gap-4"
          style={{ background: "rgba(239,68,68,0.06)", borderColor: "rgba(239,68,68,0.2)" }}>
          <p className="text-red-400 text-sm font-medium">
            Your subscription has expired. Your API key is currently inactive.
          </p>
          <button onClick={() => router.push("/payment")}
            className="flex-shrink-0 bg-red-500 text-white font-bold text-xs px-4 py-1.5 rounded-full hover:bg-red-600 transition-colors">
            Renew Now
          </button>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* View toggle — Free Trial vs Multichain. Default lands on the
            user's natural side (trial signup → Trial; otherwise →
            Multichain). The toggle is persistent for the session so a user
            who chose Multichain doesn't keep getting bounced back to Trial
            after a re-render. */}
        <div className="mb-6 inline-flex items-center gap-1 bg-white/4 border border-white/10 rounded-full p-1">
          <button
            onClick={() => setTrialViewActive(true)}
            className={`px-5 py-2 rounded-full text-xs font-bold transition-all ${
              trialViewActive
                ? "bg-yellow text-navy shadow-lg shadow-yellow/15"
                : "text-white/45 hover:text-white"
            }`}
          >
            ✦ Free Trial
            {isTrialAccount && !trialViewActive && (
              <span className="ml-1.5 text-[9px] text-green-400">●</span>
            )}
          </button>
          <button
            onClick={() => setTrialViewActive(false)}
            className={`px-5 py-2 rounded-full text-xs font-bold transition-all ${
              !trialViewActive
                ? "bg-white text-navy shadow-lg shadow-white/15"
                : "text-white/45 hover:text-white"
            }`}
          >
            Multichain
          </button>
        </div>

        <div className="flex items-start justify-between mb-6 flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold">
              {viewMode === "trial" ? "Free Trial" : "My Dashboard"}
            </h1>
            <p className="text-white/35 text-sm mt-0.5">
              {viewMode === "trial"
                ? "2,000 sponsored TX · BNB Chain only · Q402 covers gas."
                : "Manage your Q402 plan, gas tank, and API access."}
            </p>
          </div>
          <div className="flex items-center gap-2 bg-yellow/8 border border-yellow/20 rounded-full px-4 py-2">
            <span className="text-yellow font-bold text-sm">
              {viewMode === "trial" ? "Trial" : `${planName} Plan`}
            </span>
            {viewMode === "multichain" && subscription && subscription.amountUSD > 0 && (
              <span className="text-white/30 text-xs">· ${subscription.amountUSD} paid</span>
            )}
          </div>
        </div>

        {/* Expiry banner — only for paying users */}
        {hasPaid && expiresAt && (
          <div className={`mb-6 flex items-center justify-between gap-4 rounded-2xl px-5 py-4 border ${isExpired ? "bg-red-400/8 border-red-400/20" : daysLeft !== null && daysLeft <= 7 ? "bg-yellow/6 border-yellow/20" : "bg-white/4 border-white/8"}`}>
            <div className="flex items-center gap-3">
              <span className={`text-lg ${isExpired ? "text-red-400" : "text-yellow"}`}>{isExpired ? "⚠" : "📅"}</span>
              <div>
                <p className={`font-semibold text-sm ${isExpired ? "text-red-400" : "text-white"}`}>
                  {isExpired ? "Subscription Expired" : daysLeft !== null && daysLeft <= 7 ? `Expiring in ${daysLeft} day${daysLeft === 1 ? "" : "s"}` : "Subscription Active"}
                </p>
                <p className="text-white/35 text-xs">
                  {isExpired ? "Renew to restore relay access" : `Renews ${expiresAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`}
                </p>
              </div>
            </div>
            {(isExpired || (daysLeft !== null && daysLeft <= 7)) && (
              <a href="/payment" className="flex-shrink-0 bg-yellow text-navy font-bold text-xs px-4 py-2 rounded-full hover:bg-yellow-hover transition-colors">Renew →</a>
            )}
          </div>
        )}

        {/* Email alert — saved state (always visible, editable) */}
        {alertEmail && !showEmailSetup && (
          <div className="mb-6 flex items-center justify-between gap-4 rounded-2xl px-5 py-3 border bg-white/4 border-white/10">
            <div className="flex items-center gap-2 text-sm text-white/40">
              <span>🔔</span>
              <span>Usage alerts → <span className="text-white/70">{alertEmail}</span></span>
            </div>
            <button
              onClick={() => { setAlertEmailInput(alertEmail); setShowEmailSetup(true); setAlertEmail(""); }}
              className="text-xs text-white/30 hover:text-white transition-colors"
            >
              Edit
            </button>
          </div>
        )}

        {/* Email alert setup banner */}
        {showEmailSetup && !alertEmail && (
          <div className="mb-6 rounded-2xl px-5 py-4 border bg-white/4 border-white/10">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-start gap-3">
                <span className="text-xl mt-0.5">🔔</span>
                <div>
                  <p className="font-semibold text-sm text-white">Would you like to receive usage alerts?</p>
                  <p className="text-white/35 text-xs mt-0.5">We&apos;ll email you when you&apos;re at 20% and 10% of your sponsored TXs remaining.</p>
                </div>
              </div>
              <button onClick={() => setShowEmailSetup(false)} className="text-white/25 hover:text-white text-lg leading-none flex-shrink-0">×</button>
            </div>
            <div className="flex gap-2 mt-4">
              <input
                type="email"
                placeholder="your@email.com"
                value={alertEmailInput}
                onChange={e => setAlertEmailInput(e.target.value)}
                className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-yellow/40 transition-colors"
              />
              <button
                onClick={saveAlertEmail}
                className="bg-yellow text-navy font-bold text-sm px-5 py-2.5 rounded-xl hover:bg-yellow-hover transition-all"
              >
                {emailSaved ? "Saved ✓" : "Save"}
              </button>
            </div>
          </div>
        )}

        {/* Quota usage warning banner — only for paying users */}
        {hasPaid && subscription && pct >= 80 && (
          <div className={`mb-6 flex items-center justify-between gap-4 rounded-2xl px-5 py-4 border ${pct >= 90 ? "bg-red-400/8 border-red-400/25" : "bg-yellow/6 border-yellow/20"}`}>
            <div className="flex items-center gap-3">
              <span className={`text-lg ${pct >= 90 ? "text-red-400" : "text-yellow"}`}>⚠</span>
              <div>
                <p className={`font-semibold text-sm ${pct >= 90 ? "text-red-400" : "text-yellow"}`}>
                  {pct >= 90 ? "Sponsored TXs almost exhausted" : "Sponsored TXs running low"}
                </p>
                <p className="text-white/35 text-xs">
                  {remainingCredits.toLocaleString()} TXs remaining
                  {alertEmail && ` · Alert will be sent to ${alertEmail}`}
                </p>
              </div>
            </div>
            <a href="/payment" className="flex-shrink-0 bg-yellow text-navy font-bold text-xs px-4 py-2 rounded-full hover:bg-yellow-hover transition-colors">Top up →</a>
          </div>
        )}

        {/* Tabs — Gas Tank tab is hidden for trial users since Q402 covers
            their gas during the sprint window. Trial users can still click
            into the underlying API endpoints (no auth bypass) — this is a
            display-only filter so the UI matches the user's actual needs. */}
        <div className="flex gap-1 bg-white/4 border border-white/7 rounded-2xl p-1 w-fit mb-8 flex-wrap">
          {TABS.filter(t => !(t === "gas-tank" && viewMode === "trial")).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-5 py-2 rounded-xl text-sm font-medium transition-all ${tab === t ? "bg-yellow text-navy shadow-lg shadow-yellow/15" : "text-white/40 hover:text-white"}`}>
              {tabLabel[t]}
            </button>
          ))}
        </div>

        {/* ── OVERVIEW ── */}
        {tab === "overview" && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                {
                  label: "Sponsored TXs Left",
                  value: remainingCredits.toLocaleString(),
                  sub: viewMode === "trial" ? "trial · BNB only" : `${plan} plan`,
                },
                { label: "Total Relayed", value: relayedTxs.length.toLocaleString(), sub: "all time" },
                // Trial view: no per-user gas tank — Q402 covers it. Multichain
                // view: surface the deposited balance card so paid users can
                // top up.
                viewMode === "trial"
                  ? { label: "Gas",         value: "Covered",                      sub: "Q402 pays during trial", accent: true }
                  : { label: "My Gas Tank", value: `$${totalUserUSD.toFixed(2)}`, sub: "deposited balance",       accent: true },
                { label: "Today's Txs", value: dailyData[13].toLocaleString(), sub: "today", green: true },
              ].map((s, i) => (
                <div key={i} className="card-glow rounded-2xl p-5 border" style={{ background: "#0F1929", borderColor: "rgba(255,255,255,0.07)" }}>
                  <div className="text-white/35 text-xs mb-2">{s.label}</div>
                  <div className={`text-2xl font-bold mb-1 ${"accent" in s && s.accent ? "text-yellow" : "green" in s && s.green ? "text-green-400" : "text-white"}`}>{s.value}</div>
                  <div className="text-white/25 text-xs">{s.sub}</div>
                </div>
              ))}
            </div>

            <div className="rounded-2xl p-6 border" style={{ background: "#0F1929", borderColor: "rgba(255,255,255,0.07)" }}>
              <div className="flex items-center justify-between mb-6">
                <div><div className="font-semibold">Daily Transactions</div><div className="text-white/35 text-xs mt-0.5">Last 14 days</div></div>
                <div className="flex items-center gap-4 text-xs text-white/30">
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-yellow/30" />Previous</span>
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-yellow" />Today</span>
                </div>
              </div>
              <BarChart data={dailyData} labels={dailyLabels} />
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="rounded-2xl p-6 border" style={{ background: "#0F1929", borderColor: "rgba(255,255,255,0.07)" }}>
                <div className="flex justify-between mb-3">
                  <span className="text-sm font-medium">Sponsored TXs</span>
                  <span className="text-sm text-white/40">{remainingCredits.toLocaleString()} remaining</span>
                </div>
                <div className="w-full h-2.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.07)" }}>
                  <motion.div initial={{ width: 0 }} animate={{ width: `${Math.min(pct, 100)}%` }} transition={{ duration: 1, delay: 0.3 }}
                    className="h-full rounded-full" style={{ background: pct > 80 ? "#E84142" : "#F5C518" }} />
                </div>
                <div className="flex justify-between mt-2 text-xs text-white/25">
                  <span>{thisMonthCount.toLocaleString()} used</span>
                  <span>{remainingCredits.toLocaleString()} left</span>
                </div>
              </div>

              <div className="rounded-2xl p-5 border" style={{ background: "#0F1929", borderColor: "rgba(255,255,255,0.07)" }}>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium">API Key</span>
                  <span className={`text-xs px-2.5 py-0.5 rounded-full border ${isExpired ? "text-red-400 bg-red-400/8 border-red-400/20" : "text-green-400 bg-green-400/8 border-green-400/20"}`}>
                    {isExpired ? "Expired" : "Active"}
                  </span>
                </div>
                <div className="flex items-center gap-2 bg-navy border border-white/7 rounded-xl px-3 py-2.5">
                  <span className="font-mono text-xs text-white/40 truncate flex-1">{API_KEY === "—" ? "Loading…" : API_KEY}</span>
                  {API_KEY !== "—" && (
                    <button onClick={copyKey} className={`flex-shrink-0 text-xs px-3 py-1 rounded-lg font-semibold transition-all ${keyCopied ? "bg-green-400/15 text-green-400" : "bg-yellow/10 text-yellow hover:bg-yellow/20"}`}>
                      {keyCopied ? "Copied!" : "Copy"}
                    </button>
                  )}
                </div>
                {subscription?.paidAt && expiresAt && (
                  <p className="text-white/20 text-xs mt-2">
                    Paid {new Date(subscription.paidAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    {" · expires "}{expiresAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </p>
                )}
                {!rotateConfirm ? (
                  <button onClick={() => setRotateConfirm(true)} className="mt-3 text-xs text-white/25 hover:text-red-400 transition-colors">
                    Rotate Key…
                  </button>
                ) : (
                  <div className="mt-3 flex items-center gap-2 bg-red-400/8 border border-red-400/20 rounded-xl px-3 py-2.5">
                    <span className="text-xs text-red-400 flex-1">Current key will stop working immediately.</span>
                    <button onClick={() => setRotateConfirm(false)} className="text-xs text-white/30 hover:text-white px-2">Cancel</button>
                    <button onClick={rotateKey} disabled={rotatingKey} className="text-xs font-bold text-red-400 hover:text-red-300 px-2 disabled:opacity-50">
                      {rotatingKey ? "Rotating…" : "Confirm"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}

        {/* ── GAS TANK ── */}
        {tab === "gas-tank" && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
            <div className="rounded-2xl p-6 border relative overflow-hidden"
              style={{ background: "linear-gradient(135deg, #0F1929 0%, #131E30 100%)", borderColor: "rgba(245,197,24,0.15)" }}>
              <div className="absolute right-6 top-6 w-32 h-32 rounded-full blur-3xl" style={{ background: "rgba(245,197,24,0.06)" }} />
              <div className="text-white/40 text-sm mb-1">My Gas Tank (USD est.)</div>
              <div className="text-4xl font-bold text-yellow mb-1">
                {tankLoading ? <span className="text-2xl text-white/20 animate-pulse">Loading…</span> : `$${totalUserUSD.toFixed(2)}`}
              </div>
              <div className="text-white/25 text-xs">Your deposited balance · used for gas sponsorship</div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
              {Object.entries(CHAIN_META).map(([key, meta]) => {
                const userAmt = userGasBalance[key] ?? 0;
                const price = tokenPrices[key] ?? 0;
                const userUSD = userAmt * price;
                const hasBalance = userAmt > 0;
                return (
                  <div key={key} className="rounded-2xl p-5 border flex flex-col gap-0 relative overflow-hidden"
                    style={{ background: "linear-gradient(145deg, #0F1929 0%, #0B1220 100%)", borderColor: hasBalance ? "rgba(245,197,24,0.2)" : "rgba(255,255,255,0.07)" }}>
                    {/* chain color accent top bar */}
                    <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-2xl" style={{ background: meta.color, opacity: 0.5 }} />

                    {/* header */}
                    <div className="flex items-center gap-2.5 mb-4">
                      <div className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 ring-1 ring-white/10">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={meta.img} alt={meta.name} className="w-full h-full object-cover" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold leading-tight truncate">{meta.name}</div>
                        <div className="text-white/35 text-[11px]">{meta.token}</div>
                      </div>
                    </div>

                    {/* balance */}
                    <div className="text-2xl font-bold tracking-tight leading-none">
                      {userAmt.toFixed(4)}
                      <span className="text-sm font-normal text-white/35 ml-1">{meta.token}</span>
                    </div>
                    <div className="text-white/30 text-xs mt-1 mb-3">
                      {userUSD >= 0.01 ? `$${userUSD.toFixed(2)}` : "$0.00"}
                    </div>

                    {/* wallet balance indicator */}
                    {(walletBalances[key] ?? 0) > 0 && (
                      <div className="flex items-center gap-1.5 text-[10px] text-white/30 mb-3">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400/50 flex-shrink-0" />
                        <span>Wallet: {(walletBalances[key] ?? 0).toFixed(4)} {meta.token}</span>
                      </div>
                    )}

                    {/* button */}
                    <button onClick={() => setDepositChain({ chain: meta.name, token: meta.token })}
                      className="mt-auto w-full text-xs font-bold py-2 rounded-xl transition-all"
                      style={hasBalance
                        ? { background: "rgba(245,197,24,0.12)", color: "#F5C518", border: "1px solid rgba(245,197,24,0.25)" }
                        : { background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.5)", border: "1px solid rgba(255,255,255,0.1)" }
                      }>
                      {hasBalance ? `Manage ${meta.token}` : `+ Deposit`}
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Real deposit history */}
            <div className="rounded-2xl border overflow-hidden" style={{ background: "#0F1929", borderColor: "rgba(255,255,255,0.07)" }}>
              <div className="px-6 py-4 border-b" style={{ borderColor: "rgba(255,255,255,0.07)" }}>
                <span className="font-semibold">Tank Activity</span>
              </div>
              {gasDeposits.length === 0 ? (
                <div className="px-6 py-10 text-center text-white/25 text-sm">No activity yet</div>
              ) : [...gasDeposits].reverse().map((d, i) => {
                const isWithdrawal = d.amount < 0;
                return (
                  <div key={i} className="flex items-center justify-between px-6 py-4 border-b last:border-0 hover:bg-white/2 transition-colors" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                    <div>
                      <div className="text-sm font-medium">{isWithdrawal ? "Withdrawal" : "Deposit"}</div>
                      <div className="text-white/30 text-xs mt-0.5">{CHAIN_META[d.chain]?.name ?? d.chain} · {new Date(d.depositedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>
                      <div className="font-mono text-[10px] text-white/20 mt-0.5">{shortHash(d.txHash)}</div>
                    </div>
                    <span className={`font-mono text-sm font-semibold ${isWithdrawal ? "text-red-400" : "text-green-400"}`}>
                      {isWithdrawal ? "-" : "+"}{Math.abs(d.amount).toFixed(4)} {d.token}
                    </span>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}

        {/* ── DEVELOPER ── */}
        {tab === "developer" && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">

            {/* Sandbox Key + Webhook row */}
            <div className="grid md:grid-cols-2 gap-4">
              {/* Sandbox Key */}
              <div className="rounded-2xl border p-5 space-y-3" style={{ background: "#0F1929", borderColor: "rgba(255,255,255,0.07)" }}>
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-semibold">Sandbox Key</span>
                    <span className="ml-2 text-[10px] bg-yellow/10 text-yellow border border-yellow/20 px-2 py-0.5 rounded-full font-semibold">TEST</span>
                  </div>
                </div>
                <p className="text-white/35 text-xs">Prefix <span className="font-mono text-yellow/70">q402_test_</span> — no real transactions. Safe for local dev &amp; CI.</p>
                {sandboxApiKey ? (
                  <div className="flex items-center gap-2 bg-navy border border-white/7 rounded-xl px-3 py-2.5">
                    <span className="font-mono text-xs text-white/40 truncate flex-1">{sandboxApiKey.slice(0,14)}{"•".repeat(14)}{sandboxApiKey.slice(-4)}</span>
                    <button onClick={copySandboxKey} className={`flex-shrink-0 text-xs px-3 py-1 rounded-lg font-semibold transition-all ${sandboxKeyCopied ? "bg-green-400/15 text-green-400" : "bg-yellow/10 text-yellow hover:bg-yellow/20"}`}>
                      {sandboxKeyCopied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                ) : <div className="font-mono text-xs text-white/20 animate-pulse">Loading…</div>}
              </div>

              {/* Webhook */}
              <div className="rounded-2xl border p-5 space-y-3" style={{ background: "#0F1929", borderColor: "rgba(255,255,255,0.07)" }}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">Webhook</span>
                  {webhookUrl && <span className="text-[10px] bg-green-400/10 text-green-400 border border-green-400/20 px-2 py-0.5 rounded-full">Active</span>}
                </div>
                <p className="text-white/35 text-xs">Receive a signed POST after every relay. Header: <span className="font-mono text-white/50">X-Q402-Signature</span></p>
                <div className="flex gap-2">
                  <input value={webhookUrlInput || webhookUrl} onChange={e => setWebhookUrlInput(e.target.value)}
                    placeholder="https://your-server.com/webhook"
                    className="flex-1 bg-white/5 border border-white/8 rounded-xl px-3 py-2 text-xs text-white placeholder-white/20 outline-none focus:border-yellow/30" />
                  <button onClick={saveWebhook} disabled={webhookSaving || !webhookUrlInput}
                    className="text-xs font-bold px-4 py-2 rounded-xl bg-yellow/10 text-yellow border border-yellow/20 hover:bg-yellow/20 transition-all disabled:opacity-40">
                    {webhookSaving ? "…" : "Save"}
                  </button>
                </div>
                {webhookSecret && (
                  <div className="bg-yellow/5 border border-yellow/20 rounded-xl px-3 py-2.5 space-y-1">
                    <p className="text-[10px] text-yellow/70 font-semibold uppercase tracking-widest">Signing Secret — save this now</p>
                    <div className="font-mono text-xs text-white/60 break-all">{webhookSecret}</div>
                    <button onClick={() => { navigator.clipboard.writeText(webhookSecret); }} className="text-[10px] text-white/30 hover:text-yellow transition-colors">Copy secret</button>
                  </div>
                )}
                {webhookUrl && (
                  <div className="flex items-center gap-2">
                    <button onClick={testWebhook} disabled={webhookTesting}
                      className="text-xs text-white/40 hover:text-white border border-white/10 hover:border-white/25 px-3 py-1.5 rounded-lg transition-all disabled:opacity-40">
                      {webhookTesting ? "Sending…" : "▶ Test"}
                    </button>
                    {webhookTestResult && (
                      <span className={`text-xs ${webhookTestResult.ok ? "text-green-400" : "text-red-400"}`}>
                        {webhookTestResult.ok ? "✓" : "✗"} {webhookTestResult.msg}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="grid lg:grid-cols-2 gap-5">
              <div className="space-y-4">
                <h3 className="font-semibold text-white/70 text-sm uppercase tracking-widest">Integration Guide</h3>
                {STEPS.map(s => (
                  <div key={s.n} className="rounded-2xl border overflow-hidden" style={{ background: "#0F1929", borderColor: "rgba(255,255,255,0.07)" }}>
                    <div className="flex items-center gap-3 px-5 py-4">
                      <span className="w-7 h-7 rounded-lg bg-yellow/10 border border-yellow/20 text-yellow text-xs font-bold flex items-center justify-center flex-shrink-0">{s.n}</span>
                      <span className="text-sm font-medium">{s.title}</span>
                    </div>
                    <div className="mx-4 mb-4 bg-[#060C14] border border-white/7 rounded-xl p-4">
                      <pre className="font-mono text-xs text-green-400 leading-5 whitespace-pre-wrap overflow-x-auto">{s.code}</pre>
                    </div>
                  </div>
                ))}
              </div>
              <div>
                <h3 className="font-semibold text-white/70 text-sm uppercase tracking-widest mb-4">API Playground</h3>
                <div className="rounded-2xl border p-6" style={{ background: "#0F1929", borderColor: "rgba(255,255,255,0.07)" }}>
                  <p className="text-white/40 text-sm mb-5">Test a simulated transaction using your API key.</p>
                  <Playground apiKey={API_KEY} trialView={viewMode === "trial"} />
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {/* ── TRANSACTIONS ── */}
        {tab === "transactions" && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
            <div className="rounded-2xl border overflow-hidden" style={{ background: "#0F1929", borderColor: "rgba(255,255,255,0.07)" }}>
              <div className="px-6 py-4 border-b flex items-center justify-between" style={{ borderColor: "rgba(255,255,255,0.07)" }}>
                <span className="font-semibold">Relayed Transaction History</span>
                <span className="text-white/25 text-xs">{relayedTxs.length} total · {remainingCredits.toLocaleString()} TXs left</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px]">
                  <thead>
                    <tr className="border-b" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                      {["Date", "Chain", "From → To", "Amount", "Tx Hash", "Receipt", "Status"].map(h => (
                        <th key={h} className="text-left text-xs text-white/25 font-normal px-5 py-3">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {relayedTxs.length === 0 ? (
                      <tr><td colSpan={7} className="px-6 py-12 text-center text-white/25 text-sm">No transactions yet</td></tr>
                    ) : [...relayedTxs].reverse().map((tx, i) => {
                      const meta = CHAIN_META[tx.chain];
                      return (
                        <motion.tr key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.03 }}
                          className="border-b last:border-0 hover:bg-white/2 transition-colors" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
                          <td className="px-5 py-4 text-xs text-white/50 whitespace-nowrap">
                            {new Date(tx.relayedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                          </td>
                          <td className="px-5 py-4">
                            <span className="flex items-center gap-1.5 text-xs text-white/60">
                              {meta && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: meta.color }} />}
                              {meta?.name ?? tx.chain}
                            </span>
                          </td>
                          <td className="px-5 py-4 font-mono text-xs text-white/35">{shortAddr(tx.fromUser)} → {shortAddr(tx.toUser)}</td>
                          <td className="px-5 py-4 text-xs font-semibold text-white/70">
                            {Number(tx.tokenAmount).toFixed(2)} <span className="text-white/30">{tx.tokenSymbol}</span>
                          </td>
                          <td className="px-5 py-4 font-mono text-xs text-white/30">{shortHash(tx.relayTxHash)}</td>
                          <td className="px-5 py-4 text-xs">
                            {tx.receiptId ? (
                              <a href={`/receipt/${tx.receiptId}`} target="_blank" rel="noopener noreferrer"
                                 className="text-yellow/80 hover:text-yellow transition">
                                View ↗
                              </a>
                            ) : (
                              <span className="text-white/20">—</span>
                            )}
                          </td>
                          <td className="px-5 py-4">
                            <span className="text-xs text-green-400 bg-green-400/8 border border-green-400/20 px-2.5 py-1 rounded-full">Success</span>
                          </td>
                        </motion.tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </motion.div>
        )}

        {/* ── CLAUDE MCP ── */}
        {tab === "claude" && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
            <div className="space-y-1 mb-2">
              <h2 className="text-lg font-semibold">Use Q402 from Claude</h2>
              <p className="text-white/40 text-sm">
                Q402 ships as a Model Context Protocol server, so Claude Desktop, Claude Code, and any other
                MCP-compatible AI client can quote and (optionally) settle gasless USDC, USDT, and RLUSD payments
                directly from a chat. The config snippet below is pre-filled with your{" "}
                <strong className="text-white/60">sandbox key</strong> — safe to paste into{" "}
                <code className="text-white/60">claude_desktop_config.json</code>. Real on-chain payments
                are configured separately, via shell environment variables — your live key never leaves
                your terminal.
              </p>
            </div>
            <ClaudeMcpCard sandboxApiKey={sandboxApiKey || "q402_test_••••"} />
            <div className="rounded-2xl border p-5" style={{ background: "#0F1929", borderColor: "rgba(255,255,255,0.07)" }}>
              <div className="text-[10px] uppercase tracking-widest text-white/40 mb-2 font-semibold">
                What ships in the package
              </div>
              <ul className="text-white/55 text-sm space-y-1.5 leading-relaxed">
                <li>• <code className="text-yellow text-xs">q402_quote</code> — {BNB_FOCUS_MODE ? "BNB-focus sprint: shows BNB Chain + USDC/USDT." : "compare gas across all 7 chains."} Read-only, no auth.</li>
                <li>• <code className="text-yellow text-xs">q402_balance</code> — verify your API key and report its plan tier. Read-only.</li>
                <li>• <code className="text-yellow text-xs">q402_pay</code> — send a gasless payment. <strong>Sandbox by default</strong>; real on-chain TX requires <code className="text-white/60">Q402_PRIVATE_KEY</code> + <code className="text-white/60">Q402_ENABLE_REAL_PAYMENTS=1</code> alongside a live API key.</li>
              </ul>
              <div className="text-[11px] text-white/30 mt-4 pt-3 border-t border-white/8">
                Full reference in{" "}
                <a className="text-yellow hover:underline" href="/docs#claude-mcp">/docs → Claude MCP</a>
                {" "}· npm:{" "}
                <a className="text-yellow hover:underline" href="https://www.npmjs.com/package/@quackai/q402-mcp">@quackai/q402-mcp</a>
                {" "}· source:{" "}
                <a className="text-yellow hover:underline" href="https://github.com/bitgett/q402-mcp">bitgett/q402-mcp</a>
              </div>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
