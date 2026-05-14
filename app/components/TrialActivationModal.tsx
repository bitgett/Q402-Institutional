"use client";

/**
 * TrialActivationModal — entry point for the BNB-focus sprint's free trial.
 *
 * Three states by step:
 *   1. wallet picker          (no connected wallet)
 *   2. trial form             (wallet connected — optional email + activate)
 *   3. success                (trial activated — show "Go to dashboard" CTA)
 *
 * The trial activation itself is one POST to /api/trial/activate gated by a
 * fresh wallet challenge (same auth pattern as the paid activate route). The
 * email field is genuinely optional: when set, a separate POST to
 * /api/auth/email/start mails a magic link AFTER the trial is activated, so
 * the trial flow never hangs on email transport.
 */

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import { useWallet } from "../context/WalletContext";
import WalletModal from "./WalletModal";
import { getFreshChallenge } from "../lib/auth-client";
import {
  TRIAL_CREDITS,
  TRIAL_DURATION_DAYS,
} from "../lib/feature-flags";

interface Props {
  onClose: () => void;
}

export default function TrialActivationModal({ onClose }: Props) {
  const { address, signMessage } = useWallet();
  const router = useRouter();

  const [step, setStep] = useState<"wallet" | "form" | "success">(
    address ? "form" : "wallet",
  );
  const [showWalletPicker, setShowWalletPicker] = useState(!address);
  const [email, setEmail] = useState("");
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [magicLinkSent, setMagicLinkSent] = useState(false);

  async function activate() {
    if (!address) {
      setError("Connect a wallet first.");
      return;
    }
    setActivating(true);
    setError(null);
    try {
      const chal = await getFreshChallenge(address, signMessage);
      if (!chal) {
        setError("Wallet signature was cancelled.");
        setActivating(false);
        return;
      }
      const { challenge, signature } = chal;

      const res = await fetch("/api/trial/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          challenge,
          signature,
          ...(email.trim() ? { email: email.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Trial activation failed.");
        setActivating(false);
        return;
      }

      // If the user provided an email, fire-and-forget the magic-link send.
      // We don't block trial success on email transport: the activation is
      // already committed server-side.
      if (email.trim()) {
        const chal2 = await getFreshChallenge(address, signMessage).catch(() => null);
        if (chal2) {
          fetch("/api/auth/email/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              address,
              challenge: chal2.challenge,
              signature: chal2.signature,
              email: email.trim(),
            }),
          })
            .then(() => setMagicLinkSent(true))
            .catch(() => {});
        }
      }

      setStep("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Trial activation failed.");
    } finally {
      setActivating(false);
    }
  }

  return (
    <>
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)" }}
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.96 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="w-full max-w-md rounded-2xl border border-white/8 p-7"
            style={{
              background:
                "linear-gradient(180deg, #0F1626 0%, #080E1C 100%)",
              boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
            }}
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={onClose}
              className="absolute top-4 right-4 text-white/40 hover:text-white/80 text-lg"
              aria-label="Close"
            >
              ×
            </button>

            {step === "wallet" && (
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-yellow font-bold mb-2">
                  Free trial · BNB Chain
                </div>
                <h2 className="text-2xl font-bold mb-2">Connect your wallet</h2>
                <p className="text-white/45 text-sm mb-6">
                  The trial issues an API key bound to your wallet. {TRIAL_CREDITS.toLocaleString()} gasless
                  transactions on BNB Chain (USDC + USDT), good for {TRIAL_DURATION_DAYS} days. One trial per wallet.
                </p>
                <button
                  onClick={() => setShowWalletPicker(true)}
                  className="w-full bg-yellow text-navy font-bold text-sm py-3 rounded-full hover:bg-yellow-hover transition-colors"
                >
                  Connect wallet →
                </button>
              </div>
            )}

            {step === "form" && (
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-yellow font-bold mb-2">
                  Free trial · BNB Chain
                </div>
                <h2 className="text-2xl font-bold mb-1">
                  Activate {TRIAL_CREDITS.toLocaleString()} free transactions
                </h2>
                <p className="text-white/45 text-sm mb-6">
                  {TRIAL_DURATION_DAYS} days of gasless USDC + USDT on BNB Chain. No card, no upfront payment.
                  Your wallet signs once to prove ownership.
                </p>

                <div className="bg-white/4 border border-white/6 rounded-xl px-4 py-3 mb-5 font-mono text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-white/35">Wallet</span>
                    <span className="text-white/85">
                      {address?.slice(0, 6)}…{address?.slice(-4)}
                    </span>
                  </div>
                </div>

                <label className="block text-[11px] uppercase tracking-widest text-white/35 font-semibold mb-2">
                  Email (optional — for trial reminders + upgrade tips)
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="w-full bg-white/5 border border-white/8 rounded-xl px-4 py-3 text-sm text-white outline-none focus:border-yellow/40 placeholder-white/20 mb-5"
                />

                {error && (
                  <p className="text-red-400 text-xs mb-4">{error}</p>
                )}

                <button
                  onClick={activate}
                  disabled={activating}
                  className="w-full bg-yellow text-navy font-bold text-sm py-3 rounded-full hover:bg-yellow-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {activating ? "Activating…" : "Start free trial →"}
                </button>
                <p className="text-white/30 text-[11px] text-center mt-3">
                  One signature to prove wallet ownership. No on-chain TX, no gas.
                </p>
              </div>
            )}

            {step === "success" && (
              <div>
                <div className="w-14 h-14 rounded-full bg-green-400/15 flex items-center justify-center mb-4">
                  <span className="text-green-400 text-2xl">✓</span>
                </div>
                <h2 className="text-2xl font-bold mb-2">Trial activated</h2>
                <p className="text-white/55 text-sm mb-5">
                  {TRIAL_CREDITS.toLocaleString()} gasless transactions are live on your account for
                  the next {TRIAL_DURATION_DAYS} days. Your API key is available on the dashboard.
                </p>
                {email && (
                  <p className="text-white/40 text-xs mb-5">
                    {magicLinkSent
                      ? `Magic-link sent to ${email} — click to confirm your email for trial reminders.`
                      : `Sending magic-link to ${email}…`}
                  </p>
                )}
                <button
                  onClick={() => {
                    onClose();
                    router.push("/dashboard");
                  }}
                  className="w-full bg-yellow text-navy font-bold text-sm py-3 rounded-full hover:bg-yellow-hover transition-colors"
                >
                  Go to dashboard →
                </button>
              </div>
            )}
          </motion.div>
        </motion.div>
      </AnimatePresence>

      {showWalletPicker && !address && (
        <WalletModal
          onClose={() => {
            setShowWalletPicker(false);
            // If wallet got connected during the picker, advance the step.
            // Otherwise stay on wallet step so the user can retry.
            setStep(address ? "form" : "wallet");
          }}
        />
      )}
    </>
  );
}
