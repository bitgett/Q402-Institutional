"use client";

/**
 * AgenticWalletSendModal — single-recipient send form for the dashboard.
 *
 * Phase 1 MVP: BNB chain + USDC/USDT. The actual signing happens
 * server-side in /api/wallet/agentic/send — this UI only forwards the
 * user's intent + their EIP-191 session signature for owner-auth.
 */

import { useState } from "react";
import { getAuthCreds } from "@/app/lib/auth-client";

interface Props {
  walletAddress: string;
  ownerAddress: string;
  signMessage: (message: string) => Promise<string | null>;
  onClose: () => void;
  onSent: () => void;
}

type Token = "USDC" | "USDT";

function isAddress(s: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(s.trim());
}

function isDecimalAmount(s: string) {
  return /^\d+(\.\d+)?$/.test(s.trim()) && Number(s) > 0;
}

export function AgenticWalletSendModal({
  walletAddress,
  ownerAddress,
  signMessage,
  onClose,
  onSent,
}: Props) {
  const [token, setToken] = useState<Token>("USDT");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ txHash: string } | null>(null);

  const recipientValid = recipient === "" || isAddress(recipient);
  const amountValid = amount === "" || isDecimalAmount(amount);
  const canSubmit =
    !submitting && isAddress(recipient) && isDecimalAmount(amount);

  async function submit() {
    setError(null);
    if (!isAddress(recipient)) {
      setError("Recipient must be a 0x-prefixed 20-byte address.");
      return;
    }
    if (!isDecimalAmount(amount)) {
      setError("Amount must be a positive decimal (e.g. 1.50).");
      return;
    }
    setSubmitting(true);
    try {
      const auth = await getAuthCreds(ownerAddress, signMessage);
      if (!auth) {
        setError("Please sign the auth challenge to authorize this send.");
        return;
      }
      const res = await fetch("/api/wallet/agentic/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chain: "bnb",
          token,
          to: recipient.trim(),
          amount: amount.trim(),
          ownerAddress,
          nonce: auth.nonce,
          signature: auth.signature,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Send failed (HTTP ${res.status}).`);
        return;
      }
      if (data?.txHash) {
        setSuccess({ txHash: data.txHash as string });
      } else {
        setSuccess({ txHash: "(pending)" });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(2,6,15,0.72)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border p-6 space-y-4"
        style={{ background: "#0F1929", borderColor: "rgba(74,222,128,0.20)" }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="text-white font-semibold text-lg">Send from Agentic Wallet</div>
            <div className="text-[11px] text-white/40 font-mono mt-0.5">
              {walletAddress.slice(0, 10)}…{walletAddress.slice(-6)}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-white/40 hover:text-white text-lg leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {success ? (
          <div className="space-y-3">
            <div className="rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2 text-sm text-green-200">
              Sent.
            </div>
            {success.txHash !== "(pending)" && (
              <a
                href={`https://bscscan.com/tx/${success.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-emerald-400 hover:underline font-mono break-all"
              >
                {success.txHash} ↗
              </a>
            )}
            <button
              type="button"
              onClick={onSent}
              className="w-full px-3 py-2 rounded-md text-sm font-semibold bg-emerald-400 text-slate-900 hover:bg-emerald-300"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <div>
                <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">Chain</div>
                <div
                  className="rounded-md border px-3 py-2 text-sm text-white/85"
                  style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.05)" }}
                >
                  BNB Chain
                  <span className="text-[10px] text-white/35 ml-2">multichain unlocks with paid plan</span>
                </div>
              </div>

              <div>
                <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">Token</div>
                <div className="grid grid-cols-2 gap-2">
                  {(["USDT", "USDC"] as Token[]).map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setToken(t)}
                      className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                        token === t
                          ? "border-emerald-400 text-emerald-300 bg-emerald-400/8"
                          : "border-white/10 text-white/55 hover:text-white"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">Recipient</div>
                <input
                  type="text"
                  value={recipient}
                  onChange={e => setRecipient(e.target.value)}
                  placeholder="0x…"
                  spellCheck={false}
                  className="w-full rounded-md border px-3 py-2 text-sm font-mono text-white placeholder-white/25"
                  style={{
                    background: "rgba(255,255,255,0.02)",
                    borderColor: recipientValid ? "rgba(255,255,255,0.05)" : "rgba(248,113,113,0.45)",
                  }}
                />
              </div>

              <div>
                <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">Amount</div>
                <input
                  type="text"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder="1.50"
                  inputMode="decimal"
                  className="w-full rounded-md border px-3 py-2 text-sm font-mono text-white placeholder-white/25"
                  style={{
                    background: "rgba(255,255,255,0.02)",
                    borderColor: amountValid ? "rgba(255,255,255,0.05)" : "rgba(248,113,113,0.45)",
                  }}
                />
              </div>
            </div>

            {error && (
              <div className="text-[12px] text-red-300/80">{error}</div>
            )}

            <button
              type="button"
              disabled={!canSubmit}
              onClick={submit}
              className="w-full px-3 py-2 rounded-md text-sm font-semibold bg-emerald-400 text-slate-900 hover:bg-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? "Sending…" : `Send ${amount || "—"} ${token}`}
            </button>
            <div className="text-[10px] text-white/30 text-center">
              Gas is sponsored by Q402&apos;s relayer. Your Agentic Wallet only pays the stablecoin.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
