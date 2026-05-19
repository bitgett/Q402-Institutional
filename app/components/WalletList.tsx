"use client";

/**
 * WalletList — the five-wallet picker, reused by both WalletModal (dialog
 * shown from Dashboard / TrialActivationModal / ClaimWalletPrompt) and
 * ConnectModal (the Navbar's "Connect" dialog that also offers Google +
 * Email). Owning a single source for the wallet rows keeps the brand
 * icons + detection flags + click handlers in lockstep across surfaces.
 *
 * Detection comes from app/lib/wallet.ts which scans both namespaced
 * window globals (window.okxwallet, window.coinbaseWalletExtension, …)
 * and the EIP-1193-style window.ethereum.providers[] array so multi-
 * extension installs surface every supported wallet.
 */

import { useState, type ReactNode } from "react";
import Image from "next/image";
import { useWallet } from "../context/WalletContext";
import { isWalletInstalled, type WalletType } from "../lib/wallet";

interface WalletDef {
  id: WalletType;
  name: string;
  desc: string;
  installUrl: string;
  icon: ReactNode;
}

const WALLETS: WalletDef[] = [
  {
    id: "metamask",
    name: "MetaMask",
    desc: "Browser extension wallet",
    installUrl: "https://metamask.io/download/",
    icon: (
      <Image
        src="/metamask.png"
        alt="MetaMask"
        width={36}
        height={36}
        className="w-9 h-9 rounded-lg flex-shrink-0 object-cover"
      />
    ),
  },
  {
    id: "okx",
    name: "OKX Wallet",
    desc: "Multi-chain Web3 wallet",
    installUrl: "https://www.okx.com/web3",
    // eslint-disable-next-line @next/next/no-img-element
    icon: <img src="/okx.jpg" alt="OKX Wallet" className="w-9 h-9 rounded-lg flex-shrink-0 object-cover" />,
  },
  {
    id: "binance",
    name: "Binance Web3 Wallet",
    desc: "Binance Wallet for EVM chains",
    installUrl: "https://www.binance.com/en/web3wallet",
    icon: (
      <div className="w-9 h-9 rounded-lg flex-shrink-0 flex items-center justify-center" style={{ background: "#0B0E11" }}>
        <svg viewBox="0 0 126.61 126.61" xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" aria-hidden="true">
          <g fill="#F3BA2F">
            <path d="M38.73 53.2l24.59-24.58 24.6 24.6 14.3-14.31L63.32 0 24.42 38.9z" />
            <path d="M0 63.31L14.3 49l14.3 14.31-14.3 14.3z" />
            <path d="M38.73 73.41l24.59 24.59 24.6-24.6 14.31 14.29-38.9 38.91L24.42 87.7z" />
            <path d="M98 63.31L112.3 49l14.31 14.31-14.31 14.3z" />
            <path d="M77.83 63.3l-14.51-14.52-10.73 10.73-1.24 1.23-2.54 2.55-.02.02.02.02L63.32 77.83l14.51-14.5z" />
          </g>
        </svg>
      </div>
    ),
  },
  {
    id: "coinbase",
    name: "Coinbase Wallet",
    desc: "Self-custody from Coinbase",
    installUrl: "https://www.coinbase.com/wallet/downloads",
    icon: (
      <Image
        src="/coinbase.png"
        alt="Coinbase Wallet"
        width={36}
        height={36}
        className="w-9 h-9 rounded-lg flex-shrink-0 object-cover"
      />
    ),
  },
  {
    id: "bitget",
    name: "Bitget Wallet",
    desc: "Multi-chain Web3 wallet",
    installUrl: "https://web3.bitget.com/",
    icon: (
      <Image
        src="/bitget.png"
        alt="Bitget Wallet"
        width={36}
        height={36}
        className="w-9 h-9 rounded-lg flex-shrink-0 object-cover"
      />
    ),
  },
];

interface Props {
  /** Notify the parent on a successful connect. The parent typically
   *  closes the surrounding modal (and may navigate). */
  onConnected?: (address: string) => void;
}

export default function WalletList({ onConnected }: Props) {
  const { connectWith } = useWallet();
  const [loading, setLoading] = useState<WalletType | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Detection is read-only against `window` and SSR-safe (the helper
  // short-circuits to false when window is undefined). Computing inline
  // during render keeps the data flow linear and avoids the
  // cascading-render pitfall flagged by the React-Hooks lint rule when
  // a one-shot useEffect calls setState.
  const installedFlags: Record<WalletType, boolean> = {
    metamask: isWalletInstalled("metamask"),
    okx:      isWalletInstalled("okx"),
    binance:  isWalletInstalled("binance"),
    coinbase: isWalletInstalled("coinbase"),
    bitget:   isWalletInstalled("bitget"),
  };

  async function handleConnect(wallet: WalletDef) {
    setError(null);
    if (!installedFlags[wallet.id]) {
      window.open(wallet.installUrl, "_blank", "noopener,noreferrer");
      return;
    }
    setLoading(wallet.id);
    const result = await connectWith(wallet.id);
    setLoading(null);
    if (result) {
      onConnected?.(result);
    } else {
      setError("Connection failed or rejected. Please try again.");
    }
  }

  return (
    <>
      <div className="space-y-2">
        {WALLETS.map((wallet) => {
          const installed = installedFlags[wallet.id];
          const isLoading = loading === wallet.id;
          return (
            <button
              key={wallet.id}
              onClick={() => handleConnect(wallet)}
              disabled={!!loading}
              className="group w-full flex items-center gap-3.5 p-3 rounded-xl border transition-all disabled:opacity-50 disabled:cursor-not-allowed relative overflow-hidden"
              style={{
                borderColor: "rgba(255,255,255,0.06)",
                background: "rgba(255,255,255,0.02)",
              }}
              onMouseEnter={(e) => {
                if (loading) return;
                e.currentTarget.style.borderColor = "rgba(245,197,24,0.35)";
                e.currentTarget.style.background = "rgba(245,197,24,0.04)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)";
                e.currentTarget.style.background = "rgba(255,255,255,0.02)";
              }}
            >
              {wallet.icon}
              <div className="text-left flex-1 min-w-0">
                <div className="font-semibold text-sm">{wallet.name}</div>
                <div className="text-white/40 text-xs truncate">{wallet.desc}</div>
              </div>
              {isLoading ? (
                <svg className="animate-spin w-4 h-4 text-yellow flex-shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3" />
                  <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                </svg>
              ) : installed ? (
                <span className="text-[10px] text-green-400 font-semibold bg-green-400/10 border border-green-400/20 px-2 py-0.5 rounded-full flex-shrink-0">
                  Detected
                </span>
              ) : (
                <span className="text-[10px] text-white/30 flex-shrink-0">Install →</span>
              )}
            </button>
          );
        })}
      </div>

      {error && (
        <p role="alert" className="text-red-400 text-xs text-center mt-3 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
          {error}
        </p>
      )}
    </>
  );
}
