"use client";

/**
 * WalletModal — wallet-only picker dialog used by Dashboard,
 * TrialActivationModal, and ClaimWalletPrompt. The Connect modal
 * presents the same wallets inline alongside Google + Email; this
 * dialog exists for surfaces where only a wallet connection makes
 * sense (e.g. claim-the-canonical-wallet prompts).
 *
 * The wallet rows themselves come from <WalletList /> so a single
 * source of truth covers brand icons, detection flags, and connect
 * handling.
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import WalletList from "./WalletList";

interface Props {
  onClose: () => void;
  /** Called with the connected address after a successful connect. */
  onConnected?: (address: string) => void;
}

export default function WalletModal({ onClose, onConnected }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

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
        {/* Gradient border — wrapper + inner div trick since CSS does
            not give us linear-gradient borders directly. */}
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

        {/* Soft ambient glow behind the panel for depth. */}
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

          <WalletList
            onConnected={(addr) => {
              onConnected?.(addr);
              onClose();
            }}
          />

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
