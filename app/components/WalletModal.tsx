"use client";

/**
 * WalletModal — wallet picker dialog.
 *
 * Visual: glass-morphism panel layered over two soft radial gradients,
 * a subtle gradient border that emphasises the dark-base + yellow-accent
 * brand. Each wallet row is a button with a brand-tinted glow on hover.
 *
 * Detection: relies on app/lib/wallet.ts which knows about MetaMask, OKX,
 * Binance Web3 Wallet, Coinbase Wallet, and Bitget Wallet. The "Detected"
 * pill is rendered from isWalletInstalled() at render time; mid-modal
 * detection (extension installed during the dialog) is rare enough that
 * a full reactive listener is not worth the wiring.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useWallet } from "../context/WalletContext";
import { isWalletInstalled, type WalletType } from "../lib/wallet";

interface Props {
  onClose: () => void;
  /** Called with the connected address after a successful connect. */
  onConnected?: (address: string) => void;
}

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
      <div className="w-9 h-9 rounded-lg flex-shrink-0 overflow-hidden" style={{ background: "#F6851B" }}>
        <svg viewBox="0 0 35 33" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full p-0.5" aria-hidden="true">
          <path d="M32.958 1L19.862 10.765l2.388-5.637L32.958 1z" fill="#E17726" stroke="#E17726" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M2.042 1l12.986 9.848-2.27-5.72L2.042 1z" fill="#E27625" stroke="#E27625" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M28.16 23.533l-3.488 5.338 7.463 2.054 2.143-7.27-6.118-.122zM.744 23.655l2.131 7.27 7.451-2.054-3.476-5.338-6.106.122z" fill="#E27625" stroke="#E27625" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9.902 14.585l-2.082 3.147 7.415.338-.245-7.973-5.088 4.488zM25.098 14.585l-5.16-4.57-.169 8.055 7.415-.338-2.086-3.147zM10.326 28.871l4.47-2.165-3.852-3.003-.618 5.168zM20.204 26.706l4.458 2.165-.606-5.168-3.852 3.003z" fill="#E27625" stroke="#E27625" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M24.662 28.871l-4.458-2.165.357 2.916-.04 1.218 4.141-1.969zM10.326 28.871l4.153 1.969-.027-1.218.344-2.916-4.47 2.165z" fill="#D5BFB2" stroke="#D5BFB2" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M14.55 21.822l-3.714-.977 2.623-1.202 1.091 2.179zM20.45 21.822l1.09-2.179 2.636 1.202-3.726.977z" fill="#233447" stroke="#233447" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M10.326 28.871l.644-5.338-4.114.122 3.47 5.216zM24.03 23.533l.632 5.338 3.47-5.216-4.102-.122zM27.18 17.732l-7.415.338.688 3.752 1.09-2.179 2.636 1.202 3.001-3.113zM10.836 20.845l2.623-1.202 1.078 2.179.7-3.752-7.415-.338 3.014 3.113z" fill="#CC6228" stroke="#CC6228" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M7.82 17.732l3.11 6.073-.104-3.003-3.006-3.07zM24.174 20.802l-.116 3.003 3.122-6.073-3.006 3.07zM14.55 18.07l-.7 3.752.875 4.516.196-5.955-.371-2.313zM20.45 18.07l-.357 2.3.183 5.968.876-4.516-.702-3.752z" fill="#E27525" stroke="#E27525" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M21.152 21.822l-.876 4.516.631.447 3.852-3.003.116-3.003-3.723.043zM10.836 20.845l.104 2.937 3.852 3.003.631-.447-.875-4.516-3.712.023z" fill="#F5841F" stroke="#F5841F" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
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
      <div className="w-9 h-9 rounded-lg flex-shrink-0 flex items-center justify-center" style={{ background: "#0052FF" }}>
        <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" aria-hidden="true">
          <path
            d="M512 0C229 0 0 229 0 512s229 512 512 512 512-229 512-512S795 0 512 0zm0 869c-197 0-357-160-357-357s160-357 357-357c177 0 324 130 352 300H693c-22-66-85-114-159-114-92 0-167 75-167 167v8c0 92 75 167 167 167 74 0 137-48 159-114h211c-28 170-175 300-352 300z"
            fill="#fff"
          />
        </svg>
      </div>
    ),
  },
  {
    id: "bitget",
    name: "Bitget Wallet",
    desc: "Multi-chain Web3 wallet",
    installUrl: "https://web3.bitget.com/",
    icon: (
      <div className="w-9 h-9 rounded-lg flex-shrink-0 flex items-center justify-center overflow-hidden relative">
        <div className="absolute inset-0" style={{ background: "linear-gradient(135deg, #00F0FF 0%, #2D5BFF 100%)" }} />
        <svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" className="w-6 h-6 relative" aria-hidden="true">
          <path
            d="M9 8h12.5c4 0 7 2.5 7 6.2 0 2.4-1.4 4.5-3.4 5.4 2.5 1 4.1 3.3 4.1 6.1 0 3.9-3.1 6.5-7.3 6.5H9V8zm5 5v5h7c1.7 0 2.9-1 2.9-2.5S22.7 13 21 13h-7zm0 10v6.2h7.7c1.9 0 3.2-1.2 3.2-3.1S22.6 23 20.7 23H14z"
            fill="#0F1419"
          />
        </svg>
      </div>
    ),
  },
];

export default function WalletModal({ onClose, onConnected }: Props) {
  const { connectWith } = useWallet();
  const [loading, setLoading] = useState<WalletType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // WalletModal is only rendered from within a useEffect-gated parent
  // (ConnectModal, WalletButton) so it never appears in the SSR pass.
  // `isWalletInstalled` is SSR-safe regardless (it returns false when
  // `window` is undefined), and each call is a handful of property reads
  // — computing this inline during render keeps the code linear and
  // avoids the cascading-render pitfall of useEffect-driven detection.
  const installedFlags: Record<WalletType, boolean> = {
    metamask: isWalletInstalled("metamask"),
    okx:      isWalletInstalled("okx"),
    binance:  isWalletInstalled("binance"),
    coinbase: isWalletInstalled("coinbase"),
    bitget:   isWalletInstalled("bitget"),
  };

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    document.addEventListener("keydown", handleKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, loading]);

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
      onClose();
    } else {
      setError("Connection failed or rejected. Please try again.");
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{
        background:
          "radial-gradient(60% 60% at 20% 30%, rgba(245,197,24,0.10) 0%, rgba(0,0,0,0) 60%), " +
          "radial-gradient(50% 60% at 80% 80%, rgba(99,102,241,0.12) 0%, rgba(0,0,0,0) 60%), " +
          "rgba(0,0,0,0.78)",
        backdropFilter: "blur(14px)",
      }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-modal-title"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative w-full max-w-sm rounded-2xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Gradient border using a wrapper div — Tailwind doesn't ship a clean
            linear-gradient border-image, so two layers do the work. */}
        <div
          className="absolute inset-0 rounded-2xl"
          aria-hidden="true"
          style={{
            background:
              "linear-gradient(135deg, rgba(245,197,24,0.45) 0%, rgba(245,197,24,0.05) 30%, rgba(99,102,241,0.05) 70%, rgba(99,102,241,0.35) 100%)",
            padding: 1,
          }}
        >
          <div className="w-full h-full rounded-2xl" style={{ background: "#070B14" }} />
        </div>

        {/* Soft glow blob behind the panel for ambient depth. */}
        <div
          className="pointer-events-none absolute -inset-4 rounded-3xl blur-2xl opacity-50"
          aria-hidden="true"
          style={{
            background:
              "radial-gradient(40% 40% at 20% 20%, rgba(245,197,24,0.30) 0%, rgba(0,0,0,0) 70%), " +
              "radial-gradient(40% 40% at 80% 80%, rgba(99,102,241,0.30) 0%, rgba(0,0,0,0) 70%)",
          }}
        />

        <div
          className="relative p-6"
          style={{
            background: "rgba(7,11,20,0.92)",
            backdropFilter: "blur(20px) saturate(140%)",
            WebkitBackdropFilter: "blur(20px) saturate(140%)",
            borderRadius: "1rem",
          }}
        >
          <div className="flex items-start justify-between mb-5">
            <div>
              <div className="text-[10px] uppercase tracking-[0.22em] text-yellow font-bold mb-1.5">
                Connect
              </div>
              <h3 id="wallet-modal-title" className="font-bold text-lg leading-tight">
                Choose your wallet
              </h3>
              <p className="text-white/40 text-xs mt-1">Five supported wallets — pick the one you use.</p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close wallet selection"
              className="text-white/30 hover:text-white text-xl leading-none -mt-0.5 -mr-0.5 w-7 h-7 rounded-full hover:bg-white/5 flex items-center justify-center transition-colors"
            >
              ×
            </button>
          </div>

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

          <p className="text-white/25 text-[11px] text-center mt-5 leading-relaxed">
            By connecting, you agree to Q402&apos;s terms of service.
            <br />
            We never see your seed phrase.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
