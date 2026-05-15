"use client";

/**
 * SignInModal — entry point for the Navbar's "Sign in / Sign up" button.
 *
 * Two paths, user picks:
 *   1. Continue with Google     → Google Identity Services button
 *   2. Continue with Email      → magic-link signup
 *   3. Continue with Wallet     → existing WalletModal picker (MetaMask / OKX)
 *
 * Replaces the bare "Connect Wallet" entry that lived on the Navbar
 * pre-event — wallet is still one of the choices, just no longer the
 * default-and-only one. The dashboard / relay flow gracefully handles
 * email-only sessions (sandbox key) and wallet-only sessions (full live).
 */

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import GoogleSigninButton from "./GoogleSigninButton";
import WalletModal from "./WalletModal";

interface Props {
  onClose: () => void;
}

export default function SignInModal({ onClose }: Props) {
  const router = useRouter();
  const [showWalletPicker, setShowWalletPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[18vh] sm:pt-[22vh] overflow-y-auto"
          style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)" }}
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.96 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="w-full max-w-md rounded-2xl border border-white/8 p-7 relative"
            style={{
              background: "linear-gradient(180deg, #0F1626 0%, #080E1C 100%)",
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

            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-yellow font-bold mb-2">
                Sign in / Sign up
              </div>
              <h2 className="text-2xl font-bold mb-2">Welcome to Q402</h2>
              <p className="text-white/45 text-sm mb-6">
                Pick how you want to sign in. Google delivers a sandbox API key
                in one click; wallet connect unlocks live gasless transactions.
              </p>

              <div className="space-y-3 mb-4">
                <GoogleSigninButton
                  width={368}
                  onSuccess={() => {
                    onClose();
                    router.push("/dashboard?signin=google");
                  }}
                  onError={msg => setError(msg)}
                />
                <button
                  onClick={() => {
                    setShowWalletPicker(true);
                  }}
                  className="w-full bg-yellow/8 border border-yellow/30 text-yellow font-medium text-sm py-3 rounded-full hover:bg-yellow/15 transition-colors"
                >
                  Continue with wallet
                </button>
              </div>

              {error && <p className="text-red-400 text-xs">{error}</p>}

              <p className="text-white/30 text-[11px] text-center mt-4">
                Wallet is still required to send gasless payments — Google
                sign-in gives you the sandbox key + dashboard access first.
              </p>
            </div>
          </motion.div>
        </motion.div>
      </AnimatePresence>

      {showWalletPicker && (
        <WalletModal
          onClose={() => {
            setShowWalletPicker(false);
            onClose();
          }}
        />
      )}
    </>
  );
}
