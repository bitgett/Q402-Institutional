"use client";

/**
 * AgenticWalletReceiveModal — chain-first deposit flow.
 *
 * Every supported EVM chain shares the same address (one EOA, ten
 * domains), but the safety story changes per chain — Stable speaks
 * USDT0, and a wrong-network deposit is
 * unrecoverable. So the modal puts the network choice *up front* as a
 * grid of pills, then folds the address, supported tokens, and the
 * scoped explorer link below.
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import type { ChainKey } from "@/app/lib/relayer";
import { explorerAddressUrl, explorerLabel } from "@/app/lib/eip7702";
import { useModalEscape } from "./useModalEscape";

interface ChainOption {
  key: ChainKey;
  label: string;
  tokens: readonly ("USDC" | "USDT")[];
  note?: string;
}

const RECEIVE_CHAINS: ReadonlyArray<ChainOption> = [
  { key: "bnb",       label: "BNB Chain",   tokens: ["USDT", "USDC"] },
  { key: "eth",       label: "Ethereum",    tokens: ["USDT", "USDC"] },
  { key: "avax",      label: "Avalanche",   tokens: ["USDT", "USDC"] },
  { key: "xlayer",    label: "X Layer",     tokens: ["USDT", "USDC"] },
  { key: "stable",    label: "Stable",      tokens: ["USDT"], note: "Stable's USDT0 — deposit as USDT" },
  { key: "mantle",    label: "Mantle",      tokens: ["USDT", "USDC"] },
  { key: "injective", label: "Injective",   tokens: ["USDT", "USDC"] },
  { key: "monad",     label: "Monad",       tokens: ["USDT", "USDC"] },
  { key: "scroll",    label: "Scroll",      tokens: ["USDT", "USDC"] },
  { key: "arbitrum",  label: "Arbitrum",    tokens: ["USDT", "USDC"] },
  { key: "base",      label: "Base",        tokens: ["USDT", "USDC"] },
];

interface Props {
  walletAddress: string;
  onClose: () => void;
}

export function AgenticWalletReceiveModal({ walletAddress, onClose }: Props) {
  const [chain, setChain] = useState<ChainKey>("bnb");
  const [copied, setCopied] = useState(false);
  // Receive is read-only — Escape is always safe.
  useModalEscape(onClose, false);
  const chainCfg = RECEIVE_CHAINS.find((c) => c.key === chain) ?? RECEIVE_CHAINS[0];

  async function copy() {
    try {
      await navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  // Portal escapes the v2 glass Surface's filter/transform ancestor so the
  // overlay centers on the real viewport. SSR-safe: this modal renders only
  // after a client interaction, so document is always present here.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(2,6,15,0.72)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border p-6 space-y-4"
        style={{ background: "#0F1929", borderColor: "rgba(247,202,22,0.20)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="text-white font-semibold text-lg">Deposit to your Agent Wallet</div>
            <div className="text-[11px] text-white/50 mt-0.5 leading-relaxed">
              Same address across every chain. Pick the network you&apos;re sending from
              — the explorer link below updates to match.
            </div>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white text-lg leading-none">
            ×
          </button>
        </div>

        {/* Chain grid — visible up-front so the user picks before reading the address */}
        <div>
          <div className="text-[11px] text-white/45 uppercase tracking-widest mb-2">
            Deposit on
          </div>
          <div className="grid grid-cols-3 gap-2">
            {RECEIVE_CHAINS.map((c) => {
              const active = c.key === chain;
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setChain(c.key)}
                  className={`rounded-md border px-2 py-2 text-[12px] font-medium transition-colors text-left ${
                    active
                      ? "border-emerald-400 text-emerald-300 bg-emerald-400/8"
                      : "border-white/10 text-white/55 hover:text-white hover:border-white/20"
                  }`}
                >
                  <div className="leading-tight">{c.label}</div>
                  <div className="text-[10px] text-white/40 mt-0.5">
                    {c.tokens.join(" + ")}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Chain-scoped detail */}
        <div className="space-y-3">
          <div
            className="rounded-md border px-3 py-2.5 text-[12px]"
            style={{
              background: "rgba(247,202,22,0.05)",
              borderColor: "rgba(247,202,22,0.18)",
              color: "rgba(226,232,240,0.88)",
            }}
          >
            <span className="font-medium">Depositing on {chainCfg.label}</span>
            <span className="text-white/60"> · accepts {chainCfg.tokens.join(", ")}</span>
            {chainCfg.note && (
              <div className="text-[11px] text-white/55 mt-1">{chainCfg.note}</div>
            )}
          </div>

          <div>
            <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">Address</div>
            <div
              className="rounded-md border px-3 py-3 font-mono text-[12px] text-white/85 break-all leading-relaxed"
              style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}
            >
              {walletAddress}
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={copy}
              className="flex-1 px-3 py-2 rounded-full text-sm font-medium"
              style={{
                background: "rgba(247,202,22,0.10)",
                color: "#f9d64a",
                border: "1px solid rgba(247,202,22,0.25)",
              }}
            >
              {copied ? "Copied!" : "Copy address"}
            </button>
            <a
              href={explorerAddressUrl(chain, walletAddress)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 px-3 py-2 rounded-full text-sm font-medium text-center text-white/65 hover:text-white border border-white/10 hover:bg-white/[0.04]"
            >
              View on {explorerLabel(chain)} ↗
            </a>
          </div>
        </div>

        {/* Wrong-network warning — last and explicit */}
        <div
          className="rounded-md border px-3 py-2.5 text-[11px] leading-relaxed"
          style={{
            background: "rgba(248,113,113,0.05)",
            borderColor: "rgba(248,113,113,0.22)",
            color: "#fecaca",
          }}
        >
          Send only {chainCfg.tokens.join(" or ")} on the {chainCfg.label} network.
          A deposit from another network can&apos;t be recovered.
        </div>
      </div>
    </div>,
    document.body,
  );
}
