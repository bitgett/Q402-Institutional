"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWallet } from "../context/WalletContext";
import { isWalletInstalled } from "../lib/wallet";

interface Props {
  onClose: () => void;
  /** Called with the connected address after a successful connect. */
  onConnected?: (address: string) => void;
}

export default function WalletModal({ onClose, onConnected }: Props) {
  const { connectWith } = useWallet();
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // ESC to close + initial focus
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    document.addEventListener("keydown", handleKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, loading]);

  async function handleConnect(type: "metamask" | "okx") {
    setError(null);
    if (!isWalletInstalled(type)) {
      setError(
        type === "metamask"
          ? "MetaMask not detected. Please install it first."
          : "OKX Wallet not detected. Please install it first.",
      );
      return;
    }
    setLoading(type);
    const result = await connectWith(type);
    setLoading(null);
    if (result) {
      onConnected?.(result);
      onClose();
    } else {
      setError("Connection failed or rejected. Please try again.");
    }
  }

  const wallets = [
    {
      id: "metamask" as const,
      name: "MetaMask",
      desc: "Browser extension wallet",
      icon: (
        <div className="w-8 h-8 rounded-lg flex-shrink-0 overflow-hidden" style={{ background: "#F6851B" }}>
          <svg viewBox="0 0 35 33" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full p-0.5" aria-hidden="true">
            <path d="M32.958 1L19.862 10.765l2.388-5.637L32.958 1z" fill="#E17726" stroke="#E17726" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M2.042 1l12.986 9.848-2.27-5.72L2.042 1z" fill="#E27625" stroke="#E27625" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M28.16 23.533l-3.488 5.338 7.463 2.054 2.143-7.27-6.118-.122zM.744 23.655l2.131 7.27 7.451-2.054-3.476-5.338-6.106.122z" fill="#E27625" stroke="#E27625" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M9.902 14.585l-2.082 3.147 7.415.338-.245-7.973-5.088 4.488zM25.098 14.585l-5.16-4.57-.169 8.055 7.415-.338-2.086-3.147zM10.326 28.871l4.47-2.165-3.852-3.003-.618 5.168zM20.204 26.706l4.458 2.165-.606-5.168-3.852 3.003z" fill="#E27625" stroke="#E27625" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M24.662 28.871l-4.458-2.165.357 2.916-.04 1.218 4.141-1.969zM10.326 28.871l4.153 1.969-.027-1.218.344-2.916-4.47 2.165z" fill="#D5BFB2" stroke="#D5BFB2" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M14.55 21.822l-3.714-.977 2.623-1.202 1.091 2.179zM20.45 21.822l1.09-2.179 2.636 1.202-3.726.977z" fill="#233447" stroke="#233447" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M10.326 28.871l.644-5.338-4.114.122 3.47 5.216zM24.03 23.533l.632 5.338 3.47-5.216-4.102-.122zM27.18 17.732l-7.415.338.688 3.752 1.09-2.179 2.636 1.202 3.001-3.113zM10.836 20.845l2.623-1.202 1.078 2.179.7-3.752-7.415-.338 3.014 3.113z" fill="#CC6228" stroke="#CC6228" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M7.82 17.732l3.11 6.073-.104-3.003-3.006-3.07zM24.174 20.802l-.116 3.003 3.122-6.073-3.006 3.07zM14.55 18.07l-.7 3.752.875 4.516.196-5.955-.371-2.313zM20.45 18.07l-.357 2.3.183 5.968.876-4.516-.702-3.752z" fill="#E27525" stroke="#E27525" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M21.152 21.822l-.876 4.516.631.447 3.852-3.003.116-3.003-3.723.043zM10.836 20.845l.104 2.937 3.852 3.003.631-.447-.875-4.516-3.712.023z" fill="#F5841F" stroke="#F5841F" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M21.218 30.84l.04-1.218-.333-.29h-4.85l-.318.29.027 1.218-4.153-1.969 1.454 1.19 2.947 2.04h5.047l2.96-2.04 1.44-1.19-4.261 1.969z" fill="#C0AC9D" stroke="#C0AC9D" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M20.992 26.706l-.631-.447h-4.722l-.631.447-.344 2.916.318-.29h4.85l.333.29-.173-2.916z" fill="#161616" stroke="#161616" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M33.518 11.33l1.117-5.41L32.958 1 20.992 10.452l4.106 3.47 5.804 1.697 1.285-1.5-.557-.403 .888-.812-.684-.527.888-.812-.71-.635zM.365 5.92L1.482 11.33l-.724.493.901.812-.671.527.888.812-.557.403 1.272 1.5 5.804-1.697 4.106-3.47L1.04 1 .365 5.92z" fill="#763E1A" stroke="#763E1A" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M30.902 15.619l-5.804-1.697 1.75 2.638-2.624 5.115 3.465-.044h5.172l-1.959-6.012zM9.902 13.922L4.098 15.62 2.16 21.63h5.16l3.453.044-2.611-5.115 1.74-2.638zM20.45 18.07l.37-6.39 1.69-4.573h-7.523l1.678 4.572.383 6.39.131 2.326.013 5.942h4.722l.013-5.942.14-2.326z" fill="#F5841F" stroke="#F5841F" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      ),
    },
    {
      id: "okx" as const,
      name: "OKX Wallet",
      desc: "Multi-chain Web3 wallet",
      icon: (
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/okx.jpg" alt="OKX Wallet" className="w-8 h-8 rounded-lg flex-shrink-0 object-cover" />
      ),
    },
  ];

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(10px)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-modal-title"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-full max-w-sm rounded-2xl border p-6 shadow-2xl shadow-black outline-none"
        style={{ background: "#090E1A", borderColor: "rgba(245,197,24,0.15)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 id="wallet-modal-title" className="font-bold text-base">Connect Wallet</h3>
            <p className="text-white/30 text-xs mt-0.5">Choose your wallet to continue</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close wallet selection"
            className="text-white/30 hover:text-white text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="space-y-3">
          {wallets.map((wallet) => {
            const installed = isWalletInstalled(wallet.id);
            const isLoading = loading === wallet.id;
            return (
              <button
                key={wallet.id}
                onClick={() => handleConnect(wallet.id)}
                disabled={!!loading}
                className="w-full flex items-center gap-4 p-4 rounded-xl border transition-all hover:border-yellow/30 hover:bg-yellow/[0.04] disabled:opacity-60"
                style={{ borderColor: "rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.02)" }}
              >
                {wallet.icon}
                <div className="text-left flex-1">
                  <div className="font-semibold text-sm">{wallet.name}</div>
                  <div className="text-white/35 text-xs">{wallet.desc}</div>
                </div>
                {isLoading ? (
                  <svg className="animate-spin w-4 h-4 text-yellow flex-shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3" />
                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                ) : installed ? (
                  <span className="text-[10px] text-green-400 font-semibold bg-green-400/10 px-2 py-0.5 rounded-full flex-shrink-0">Detected</span>
                ) : (
                  <span className="text-[10px] text-white/25 flex-shrink-0">Not installed</span>
                )}
              </button>
            );
          })}
        </div>

        {error && (
          <p role="alert" className="text-red-400 text-xs text-center mt-3 bg-red-400/10 rounded-lg px-3 py-2">{error}</p>
        )}

        <p className="text-white/20 text-xs text-center mt-5">
          By connecting, you agree to Q402&apos;s terms of service.
        </p>
      </div>
    </div>,
    document.body,
  );
}
