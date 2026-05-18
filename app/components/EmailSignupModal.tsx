"use client";

/**
 * EmailSignupModal — secondary signup path for users who prefer not to use
 * Google. Posts to /api/auth/email/signup which sends a magic link. Once
 * the link is clicked, /api/auth/email/callback issues a session cookie
 * just like the Google path.
 *
 * Friction-shaped on purpose: this is the second option in the Hero, so we
 * keep the copy short and the success state obvious ("check your inbox").
 * In dev mode (no RESEND_API_KEY) the API returns `devLink` and we render
 * a click-through button — no need to scrape stderr while iterating.
 */

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface Props {
  onClose: () => void;
}

export default function EmailSignupModal({ onClose }: Props) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);

  async function submit() {
    if (!email.trim()) {
      setError("Enter your email address.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/email/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not send sign-in link.");
        return;
      }
      setSent(true);
      if (typeof data.devLink === "string") setDevLink(data.devLink);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send sign-in link.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
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

          {!sent && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-yellow font-bold mb-2">
                Sign in with email
              </div>
              <h2 className="text-2xl font-bold mb-2">Start your free trial</h2>
              <p className="text-white/45 text-sm mb-6">
                We&apos;ll send a one-time sign-in link. Click it and the 30-day / 2,000-TX
                trial activates immediately on the email account — live + sandbox API keys
                ready to use. Connecting a wallet later is optional, only needed if you
                want the trial to follow a wallet identity too.
              </p>
              <label className="block text-[11px] uppercase tracking-widest text-white/35 font-semibold mb-2">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") submit();
                }}
                placeholder="you@company.com"
                className="w-full bg-white/5 border border-white/8 rounded-xl px-4 py-3 text-sm text-white outline-none focus:border-yellow/40 placeholder-white/20 mb-5"
              />
              {error && <p className="text-red-400 text-xs mb-4">{error}</p>}
              <button
                onClick={submit}
                disabled={submitting}
                className="w-full bg-yellow text-navy font-bold text-sm py-3 rounded-full hover:bg-yellow-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {submitting ? "Sending…" : "Send sign-in link →"}
              </button>
            </div>
          )}

          {sent && (
            <div>
              <div className="w-14 h-14 rounded-full bg-green-400/15 flex items-center justify-center mb-4">
                <span className="text-green-400 text-2xl">✓</span>
              </div>
              <h2 className="text-2xl font-bold mb-2">Check your inbox</h2>
              <p className="text-white/55 text-sm mb-5">
                We sent a one-time sign-in link to <span className="text-white font-medium">{email}</span>.
                The link expires in 15 minutes and works once.
              </p>
              {devLink && (
                <a
                  href={devLink}
                  className="block w-full text-center bg-white/5 border border-white/10 text-white/70 text-xs py-3 rounded-full hover:bg-white/8 transition-colors mb-3"
                >
                  Dev link: continue without email →
                </a>
              )}
              <button
                onClick={onClose}
                className="w-full bg-yellow text-navy font-bold text-sm py-3 rounded-full hover:bg-yellow-hover transition-colors"
              >
                OK
              </button>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
