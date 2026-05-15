"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet } from "../context/WalletContext";
import WalletModal from "./WalletModal";

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

interface EmailSession {
  email: string;
  address: string | null;
}

export default function WalletButton() {
  const { address, isConnected, disconnect } = useWallet();
  const [showModal, setShowModal] = useState(false);
  const [session, setSession] = useState<EmailSession | null>(null);

  // Fetch email session once on mount. If the user signed in with Google or
  // email magic-link, the Navbar should reflect that even without a wallet
  // connection. Failure is silent — no session is the common case.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { credentials: "include" })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        if (d.authenticated && typeof d.email === "string") {
          setSession({ email: d.email, address: d.address ?? null });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    setSession(null);
    // Reload so any state in WalletContext / dashboards rehydrates cleanly.
    if (typeof window !== "undefined") window.location.reload();
  }

  // Wallet connected — full UI: MY Page link + address chip + disconnect
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

  // Email session active but no wallet — show email + dashboard link + sign-out
  if (session) {
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
        <div className="flex items-center gap-1.5 bg-white/[0.06] border border-white/12 text-white/80 text-xs px-3.5 py-2 rounded-full max-w-[200px] truncate">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" style={{ boxShadow: "0 0 5px #4ade80" }} />
          <span className="truncate">{session.email}</span>
        </div>
        <button
          onClick={logout}
          aria-label="Sign out"
          className="text-white/25 text-sm hover:text-white/60 transition-colors px-1 py-2"
          title="Sign out"
        >
          ×
        </button>
      </div>
    );
  }

  // Nothing — show Connect CTA. Opens the bare wallet picker directly
  // (MetaMask / OKX). Google + email signup flows live on the /event page;
  // navbar stays a simple "connect a wallet" entry like before the sprint.
  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="bg-yellow text-navy font-semibold text-sm px-5 py-2 rounded-full hover:bg-yellow-hover transition-colors"
      >
        Connect
      </button>
      {showModal && <WalletModal onClose={() => setShowModal(false)} />}
    </>
  );
}
