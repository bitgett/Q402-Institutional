"use client";

/**
 * AgenticWalletReceiveModal — chain-first deposit flow, Command-deck system.
 *
 * Every supported EVM chain shares the same address (one EOA, ten domains),
 * but the safety story changes per chain (Stable speaks USDT0, a wrong-network
 * deposit is unrecoverable). So the network choice is up front as a Segmented
 * grid; address + tokens + the scoped explorer link fold below.
 */

import { useState } from "react";
import type { ChainKey } from "@/app/lib/relayer";
import { explorerAddressUrl, explorerLabel } from "@/app/lib/eip7702";
import { ModalShell, Field, Segmented, AlertBox, INPUT_FILL, GOLD, GOLD_TEXT, CYAN } from "./modal-kit";
import { ReceiveGlyph } from "./action-icons";

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

  return (
    <ModalShell
      icon={<ReceiveGlyph size={19} color={CYAN} />}
      accent={CYAN}
      title="Deposit to your Agent Wallet"
      subtitle="Same address on every chain. Pick the network you're sending from."
      size="md"
      onClose={onClose}
      footer={
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={copy}
            className="transition-opacity"
            style={{ flex: 1, padding: "11px 14px", borderRadius: 11, border: "none", background: GOLD, color: "#101722", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
          >
            {copied ? "Copied" : "Copy address"}
          </button>
          <a
            href={explorerAddressUrl(chain, walletAddress)}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors"
            style={{ flex: 1, padding: "11px 14px", borderRadius: 11, border: "1px solid rgba(255,255,255,.1)", color: "rgba(255,255,255,.7)", fontSize: 13, fontWeight: 600, textAlign: "center" }}
          >
            View on {explorerLabel(chain)}
          </a>
        </div>
      }
    >
      <Field label="Deposit on">
        <Segmented
          cols={3}
          value={chain}
          onChange={setChain}
          options={RECEIVE_CHAINS.map((c) => ({ value: c.key, label: c.label, sub: c.tokens.join(" + ") }))}
        />
      </Field>

      <AlertBox variant="info">
        <span style={{ fontWeight: 600, color: GOLD_TEXT }}>Depositing on {chainCfg.label}</span>
        <span style={{ opacity: 0.85 }}> · accepts {chainCfg.tokens.join(", ")}</span>
        {chainCfg.note && <div style={{ marginTop: 3, opacity: 0.8 }}>{chainCfg.note}</div>}
      </AlertBox>

      <Field label="Address">
        <div
          style={{
            background: INPUT_FILL,
            border: "1px solid rgba(255,255,255,.07)",
            borderRadius: 10,
            padding: "11px 12px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 12,
            color: "rgba(255,255,255,.85)",
            wordBreak: "break-all",
            lineHeight: 1.55,
          }}
        >
          {walletAddress}
        </div>
      </Field>

      <AlertBox variant="error">
        Send only {chainCfg.tokens.join(" or ")} on the {chainCfg.label} network. A deposit from another network can&apos;t be recovered.
      </AlertBox>
    </ModalShell>
  );
}
