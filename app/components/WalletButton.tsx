"use client";

import { useState } from "react";
import Link from "next/link";
import { useWallet } from "../context/WalletContext";
import WalletModal from "./WalletModal";

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function WalletButton() {
  const { address, isConnected, disconnect } = useWallet();
  const [showModal, setShowModal] = useState(false);

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        <Link
          href="/dashboard"
          className="animate-mypage flex items-center gap-1.5 border text-yellow text-xs font-bold px-3.5 py-2 rounded-full"
          style={{ borderColor: "rgba(245,197,24,0.6)", background: "rgba(245,197,24,0.08)" }}
        >
          <span>✦</span>
          MY Page
        </Link>

        <div className="flex items-center gap-1.5 bg-white/[0.06] border border-white/12 text-white text-xs font-mono px-3.5 py-2 rounded-full">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" style={{ boxShadow: "0 0 5px #4ade80" }} />
          {shortAddr(address)}
        </div>

        <button
          onClick={disconnect}
          aria-label="Disconnect wallet"
          className="text-white/25 text-sm hover:text-white/60 transition-colors px-1 py-2"
          title="Disconnect"
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="bg-yellow text-navy font-semibold text-sm px-5 py-2 rounded-full hover:bg-yellow-hover transition-colors"
      >
        Connect Wallet
      </button>
      {showModal && <WalletModal onClose={() => setShowModal(false)} />}
    </>
  );
}
