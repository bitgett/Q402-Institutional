"use client";

/**
 * WalletButton — Navbar identity chip. Two auth methods can coexist:
 *
 *   - Wallet  : ethers-context connection (MetaMask / OKX)
 *   - Email   : Q402 session cookie set by Google / magic-link signup
 *
 * Four UI states depending on which of {wallet, email} is active:
 *
 *   (none)          → "Connect" CTA → WalletModal
 *   (wallet only)   → MY Page + addr chip (no nudge to add email)
 *   (email only)    → MY Page + email chip + "+ Wallet" → WalletModal
 *   (both)          → MY Page + email chip + addr chip + sign-out
 *
 * The "+ Email" / "+ Wallet" pills let an existing user attach the second
 * method without leaving the page — important now that the dashboard's
 * email-session view recognises a wallet binding (sets address on the
 * KV session record via pairSessionWithWallet on trial activation).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet } from "../context/WalletContext";
import WalletModal from "./WalletModal";
import ConnectModal from "./ConnectModal";

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

interface EmailSession {
  email: string;
  address: string | null;
}

export default function WalletButton() {
  const { address, isConnected, disconnect } = useWallet();
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [session, setSession] = useState<EmailSession | null>(null);

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

  async function signOut() {
    // Log out of BOTH methods so the user is genuinely "signed out". The
    // email session is server-side; the wallet is browser-side. Logging
    // out only one leaves a confusing half-state in the navbar.
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    setSession(null);
    if (isConnected) {
      try {
        disconnect();
      } catch {
        /* best-effort */
      }
    }
    if (typeof window !== "undefined") window.location.reload();
  }

  const hasWallet = isConnected && !!address;
  const hasEmail = !!session;

  // ── State 0: nothing connected ────────────────────────────────────────────
  if (!hasWallet && !hasEmail) {
    return (
      <>
        <button
          onClick={() => setShowConnectModal(true)}
          className="bg-yellow text-navy font-semibold text-sm px-5 py-2 rounded-full hover:bg-yellow-hover transition-colors"
        >
          Connect
        </button>
        {showConnectModal && <ConnectModal onClose={() => setShowConnectModal(false)} />}
      </>
    );
  }

  // ── Shared chips: MY Page, email, address ─────────────────────────────────
  const myPage = (
    <Link
      href="/dashboard"
      className="animate-mypage flex items-center gap-1.5 border text-yellow text-xs font-bold px-3.5 py-2 rounded-full"
      style={{ borderColor: "rgba(245,197,24,0.6)", background: "rgba(245,197,24,0.08)" }}
    >
      <span>✦</span>
      MY Page
    </Link>
  );

  const emailChip = session && (
    <div className="flex items-center gap-1.5 bg-white/[0.06] border border-white/12 text-white/85 text-xs px-3 py-2 rounded-full max-w-[180px]">
      <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" style={{ boxShadow: "0 0 5px #4ade80" }} />
      <span className="truncate">{session.email}</span>
    </div>
  );

  const walletChip = address && (
    <div className="flex items-center gap-1.5 bg-white/[0.06] border border-white/12 text-white text-xs font-mono px-3 py-2 rounded-full">
      <span className="w-1.5 h-1.5 rounded-full bg-yellow flex-shrink-0" style={{ boxShadow: "0 0 5px #F5C518" }} />
      {shortAddr(address)}
    </div>
  );

  const signOutBtn = (
    <button
      onClick={signOut}
      aria-label="Sign out"
      className="text-white/25 text-sm hover:text-white/60 transition-colors px-1 py-2"
      title="Sign out"
    >
      ×
    </button>
  );

  return (
    <>
      <div className="flex items-center gap-2">
        {myPage}
        {hasEmail && emailChip}
        {hasWallet && walletChip}

        {/* "+ Wallet" pill — only shown to email-only users. Wallet-only
            users see no "+ Email" prompt; email pairing is optional and
            we don't push it after a wallet sign-in. */}
        {hasEmail && !hasWallet && (
          <button
            onClick={() => setShowWalletModal(true)}
            className="text-[11px] font-semibold px-3 py-2 rounded-full border border-white/15 text-white/70 hover:text-white hover:border-white/30 hover:bg-white/[0.04] transition-colors whitespace-nowrap"
            title="Connect a wallet to this account"
          >
            + Wallet
          </button>
        )}

        {signOutBtn}
      </div>

      {showWalletModal && <WalletModal onClose={() => setShowWalletModal(false)} />}
    </>
  );
}
