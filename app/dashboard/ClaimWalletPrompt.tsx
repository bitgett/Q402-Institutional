"use client";

/**
 * ClaimWalletPrompt — Phase 1 dashboard State D.
 *
 * Rendered when an email session exists, a wallet is connected in the
 * browser, but the session has not yet been claimed by any wallet
 * (session.address === null). The user must explicitly bind the connected
 * wallet to lock the email account to that single identity — once bound,
 * the dashboard's multichain view starts working and the trial credits +
 * keys will (Phase 2) migrate onto the wallet's subscription record.
 *
 * Important: connecting a wallet ≠ binding. We render this prompt instead
 * of silently flipping session.address so a user who happens to have
 * MetaMask connected for unrelated reasons doesn't get permanently bound
 * to it on first dashboard load.
 *
 * Buttons:
 *   - "Bind permanently"   → signs a fresh challenge, POSTs /api/auth/wallet-bind
 *   - "Use a different wallet" → opens WalletModal so the user can switch
 *   - "Skip for now"       → dismisses the prompt for this session only; on
 *                            next page-load the prompt returns. This is a UX
 *                            escape hatch, not a "save preference" toggle.
 */

import { useState } from "react";
import Link from "next/link";
import { useWallet } from "../context/WalletContext";
import { bindWallet } from "../lib/auth-client";
import WalletModal from "../components/WalletModal";

interface Props {
  email: string;
  connectedAddress: string;
  onBound: (address: string) => void;
  onSkip: () => void;
  onSignOut: () => void;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function ClaimWalletPrompt({
  email,
  connectedAddress,
  onBound,
  onSkip,
  onSignOut,
}: Props) {
  const { signMessage } = useWallet();
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showWalletPicker, setShowWalletPicker] = useState(false);

  async function handleBind() {
    setBinding(true);
    setError(null);
    const result = await bindWallet(connectedAddress, signMessage);
    setBinding(false);

    if (result.ok) {
      onBound(result.address);
      return;
    }
    if (result.code === "WALLET_ALREADY_BOUND") {
      // Edge case: server says this session already has a different bound
      // address. Shouldn't happen if we got here via State D, but if it
      // does, surface honestly rather than loop.
      setError(
        `This email account is already bound to ${shortAddr(result.boundAddress)}. Sign out and back in with that wallet.`,
      );
      return;
    }
    if (result.code === "EMAIL_ALREADY_BOUND") {
      // Cross-session bind: the email was previously bound to a different
      // wallet from another session that's since logged out. Server
      // refuses the new wallet — user must reconnect the original one.
      setError(
        `Your email is already bound to wallet ${shortAddr(result.boundAddress)}. Switch your wallet extension to that address (or sign out to use a different account).`,
      );
      return;
    }
    if (result.code === "WALLET_TAKEN") {
      // The wallet itself is claimed by a different email account. Wallet
      // ownership was proven (fresh signature passed), but a different
      // email already holds the bind — likely the same person with two
      // emails, or two distinct people sharing a wallet. Recovery is
      // sign-in-with-the-other-email or use a different wallet.
      setError(
        `Wallet ${shortAddr(connectedAddress)} is already linked to a different Q402 account. Sign in with that email, or use a different wallet.`,
      );
      return;
    }
    if (result.code === "SIGNATURE_CANCELLED") {
      setError("Signature cancelled. Try again when you're ready to bind.");
      return;
    }
    setError(result.error);
  }

  return (
    <div className="min-h-screen text-white px-6 py-12"
         style={{ background: "linear-gradient(160deg, #05070A 0%, #0B1220 100%)" }}>
      <div className="max-w-2xl mx-auto">
        {/* Header — logo + identity + sign out */}
        <div className="flex items-center justify-between mb-10">
          <Link href="/" className="flex items-center gap-2">
            <span className="w-6 h-6 rounded-md bg-yellow flex items-center justify-center shadow-[0_0_12px_rgba(245,197,24,0.35)]">
              <span className="w-2.5 h-2.5 rounded-sm bg-navy/90" />
            </span>
            <span className="text-yellow font-bold text-base tracking-tight leading-none">Q402</span>
          </Link>
          <div className="flex items-center gap-3 text-xs text-white/45">
            <span>{email}</span>
            <button
              onClick={onSignOut}
              className="text-white/35 hover:text-white transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>

        {/* Claim card */}
        <div className="rounded-2xl border border-yellow/30 p-8"
             style={{ background: "linear-gradient(135deg, rgba(245,197,24,0.07) 0%, rgba(255,255,255,0.02) 100%)" }}>
          <div className="text-[10px] uppercase tracking-[0.2em] text-yellow font-bold mb-3">
            ✦ One step left — claim this account
          </div>
          <h1 className="text-2xl font-bold mb-3">Bind this wallet permanently?</h1>
          <p className="text-white/55 text-sm mb-6 leading-relaxed">
            Your email account <span className="text-white font-medium">{email}</span> is
            still temporary. Bind the wallet you just connected to make it
            permanent — your trial credits and API keys will live under this
            wallet from now on.
          </p>

          <div className="rounded-xl border border-white/10 p-4 mb-6"
               style={{ background: "rgba(255,255,255,0.03)" }}>
            <div className="text-[10px] uppercase tracking-widest text-white/35 font-bold mb-1.5">
              Wallet to bind
            </div>
            <div className="font-mono text-base text-yellow break-all">
              {connectedAddress}
            </div>
          </div>

          <div className="rounded-xl border border-white/8 p-4 mb-6"
               style={{ background: "rgba(255,255,255,0.02)" }}>
            <div className="text-[10px] uppercase tracking-widest text-white/45 font-bold mb-2">
              What this means
            </div>
            <ul className="text-white/55 text-sm space-y-1.5 leading-relaxed">
              <li className="flex items-start gap-2">
                <span className="text-yellow flex-shrink-0">·</span>
                <span>This wallet becomes the <strong>only</strong> wallet that can sign in to this account from now on</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-yellow flex-shrink-0">·</span>
                <span>Connecting a different wallet later will be blocked, not silently merged</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-yellow flex-shrink-0">·</span>
                <span>
                  Your trial credits + API keys <strong>stay reachable</strong> through
                  this email session — sign in via the email OR the wallet
                  alone
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-white/40 flex-shrink-0">·</span>
                <span className="text-white/45">
                  <em>Note:</em> a future update will migrate the trial data
                  onto the wallet so the wallet-alone sign-in surfaces it
                  directly. Today, wallet-alone sign-in shows the wallet&apos;s
                  own account (which may be empty if this is its first time)
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-red-400/85 flex-shrink-0">!</span>
                <span className="text-white/65"><strong>You cannot undo this from the UI</strong> — recovery is a support-only flow</span>
              </li>
            </ul>
          </div>

          {error && (
            <div className="rounded-xl border border-red-400/30 bg-red-400/8 px-4 py-3 mb-5 text-red-400/85 text-sm">
              {error}
            </div>
          )}

          <button
            onClick={handleBind}
            disabled={binding}
            className="w-full bg-yellow text-navy font-bold text-sm py-3.5 rounded-full hover:bg-yellow-hover transition-all disabled:opacity-60 disabled:cursor-not-allowed mb-3"
          >
            {binding ? "Signing…" : `Bind ${shortAddr(connectedAddress)} permanently →`}
          </button>

          <div className="flex gap-3">
            <button
              onClick={() => setShowWalletPicker(true)}
              className="flex-1 bg-white/5 border border-white/10 text-white/70 text-xs font-semibold py-2.5 rounded-full hover:bg-white/10 transition-colors"
            >
              Use a different wallet
            </button>
            <button
              onClick={onSkip}
              className="flex-1 bg-white/5 border border-white/10 text-white/40 text-xs font-semibold py-2.5 rounded-full hover:bg-white/10 hover:text-white/70 transition-colors"
            >
              Skip for now
            </button>
          </div>

          <p className="text-white/30 text-[11px] mt-5 leading-relaxed">
            &ldquo;Skip&rdquo; leaves you in trial-only mode for this session. The prompt
            comes back next time the dashboard loads. We chose this over a
            persistent skip flag so the bind decision doesn&apos;t silently disappear.
          </p>
        </div>
      </div>

      {showWalletPicker && (
        <WalletModal
          onClose={() => setShowWalletPicker(false)}
        />
      )}
    </div>
  );
}
