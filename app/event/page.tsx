"use client";

/**
 * /event — dedicated free-trial signup page (BNB-focus growth sprint).
 *
 * Lives outside the main landing intentionally — the main `/` keeps the
 * full multichain product narrative untouched, and all the sprint
 * marketing (Google OAuth, email magic-link, wallet signup, free-trial
 * activation, BNB-focus framing) is concentrated here. KOLs / marketing
 * channels link to /event; the main landing stays clean.
 *
 * When `EVENT_MODE` is false (post-sprint state), this page renders a
 * small "event ended" placeholder instead of returning a 404 — old links
 * keep working.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import Navbar from "@/app/components/Navbar";
import Footer from "@/app/components/Footer";
import GoogleSigninButton from "@/app/components/GoogleSigninButton";
import {
  EVENT_MODE,
  TRIAL_CREDITS,
  TRIAL_DURATION_DAYS,
} from "@/app/lib/feature-flags";

export default function EventPage() {
  const router = useRouter();
  const [signinError, setSigninError] = useState<string | null>(null);

  if (!EVENT_MODE) {
    return (
      <>
        <Navbar />
        <main className="min-h-screen flex items-center justify-center px-6 pt-20" style={{ background: "linear-gradient(160deg, #06060C 0%, #0A0E1C 100%)" }}>
          <div className="max-w-md text-center">
            <h1 className="text-3xl font-bold mb-3">Event ended</h1>
            <p className="text-white/45 text-sm mb-6">
              The BNB-focus free-trial sprint has wrapped. The full multichain
              Q402 product is back to its usual home on the main landing —
              7 chains, USDC / USDT / RLUSD, gasless as always.
            </p>
            <Link
              href="/"
              className="inline-block bg-yellow text-navy font-bold text-sm px-6 py-3 rounded-full hover:bg-yellow-hover transition-colors"
            >
              Back to Q402 →
            </Link>
          </div>
        </main>
        <Footer />
      </>
    );
  }

  return (
    <>
      <Navbar />
      <main
        className="min-h-screen pt-20 pb-16 relative overflow-hidden"
        style={{
          background:
            "radial-gradient(ellipse at 18% 12%, rgba(240,185,11,0.12) 0%, transparent 55%), radial-gradient(ellipse at 85% 88%, rgba(245,158,11,0.08) 0%, transparent 60%), linear-gradient(160deg, #06060C 0%, #0A0E1C 45%, #10142A 100%)",
        }}
      >
        {/* Background atmosphere */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <motion.div
            className="absolute top-1/3 left-[15%] w-[600px] h-[600px] rounded-full blur-[160px]"
            animate={{ opacity: [0.5, 0.85, 0.5] }}
            transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
            style={{ background: "rgba(240,185,11,0.08)" }}
          />
          <div
            className="absolute inset-0 opacity-[0.07]"
            style={{
              backgroundImage:
                "linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)",
              backgroundSize: "56px 56px",
              maskImage: "radial-gradient(ellipse at center, black 55%, transparent 100%)",
              WebkitMaskImage: "radial-gradient(ellipse at center, black 55%, transparent 100%)",
            }}
          />
        </div>

        <div className="relative max-w-5xl mx-auto px-6 py-10">
          {/* Sprint ribbon */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="inline-flex items-center gap-2 mb-7 px-3.5 py-1.5 rounded-full"
            style={{
              background: "linear-gradient(120deg, rgba(240,185,11,0.10) 0%, rgba(245,158,11,0.08) 100%)",
              border: "1px solid rgba(240,185,11,0.30)",
              boxShadow: "0 0 24px rgba(240,185,11,0.10)",
            }}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-yellow animate-pulse" />
            <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-yellow/95">
              BNB-focus sprint
            </span>
            <span className="text-white/25 text-xs">·</span>
            <span className="text-xs text-white/65">
              {TRIAL_DURATION_DAYS} days · {TRIAL_CREDITS.toLocaleString()} gasless TX · Q402 covers gas
            </span>
          </motion.div>

          {/* Headline */}
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.05 }}
            className="text-4xl md:text-6xl font-extrabold leading-[1.05] mb-4 tracking-tight"
          >
            Free trial.{" "}
            <span className="text-shimmer">No gas. No card.</span>
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.15 }}
            className="text-lg text-white/55 font-light tracking-wide max-w-2xl mb-10"
          >
            {TRIAL_CREDITS.toLocaleString()} gasless transactions on BNB Chain (USDC + USDT) for
            the next {TRIAL_DURATION_DAYS} days. <span className="text-green-400 font-semibold">Q402 covers the gas</span> —
            you don&apos;t fund a gas tank. Sandbox API key in 30 seconds with Google or email;
            wallet connect unlocks live payments.
          </motion.p>

          {/* Two-column: CTA stack + benefits */}
          <div className="grid lg:grid-cols-2 gap-10 items-start mb-16">
            {/* LEFT — Signup CTA stack */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.25 }}
              className="rounded-2xl p-7 border border-white/8"
              style={{ background: "rgba(255,255,255,0.02)" }}
            >
              <div className="text-[10px] uppercase tracking-[0.2em] text-yellow font-bold mb-3">
                Sign up — pick one
              </div>
              <h2 className="text-xl font-bold mb-6">Get your API key</h2>

              <div className="space-y-3">
                <GoogleSigninButton
                  width={368}
                  onSuccess={() => router.push("/dashboard?signin=google")}
                  onError={msg => setSigninError(msg)}
                />
                <p className="text-white/30 text-[11px] text-center">
                  Prefer a wallet? Click <span className="text-yellow font-semibold">Connect</span> in the top nav.
                </p>
              </div>

              {signinError && (
                <p className="text-red-400 text-xs mt-4">{signinError}</p>
              )}

              <p className="text-white/30 text-[11px] mt-5 leading-relaxed">
                Google gives you the <span className="text-white/55">sandbox</span> API key
                immediately. Connecting a wallet activates the live trial —
                same 2,000 TX cap, real on-chain settlements, gasless for the
                payer. One wallet, one live trial (ever).
              </p>
            </motion.div>

            {/* RIGHT — Benefits */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.35 }}
              className="space-y-5"
            >
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-white/35 font-bold mb-3">
                  What you get
                </div>
                <ul className="space-y-3 text-sm text-white/65">
                  {[
                    {
                      title: `${TRIAL_CREDITS.toLocaleString()} gasless transactions`,
                      desc: `Stablecoin transfers (USDC / USDT) on BNB Chain. The payer signs once off-chain, Q402's relayer pays gas, the recipient gets the full amount.`,
                    },
                    {
                      title: `${TRIAL_DURATION_DAYS}-day window`,
                      desc: `Trial credits live for ${TRIAL_DURATION_DAYS} days from activation. Convert to a paid plan inside that window to keep credits flowing without interruption.`,
                    },
                    {
                      title: "Q402 covers all gas",
                      desc: "You never deposit BNB into a gas tank. Trial relays draw from the platform's gas budget — sender pays $0, recipient gets 100%.",
                    },
                    {
                      title: "Both live + sandbox API keys",
                      desc: "Live key signs real on-chain TX. Sandbox key (q402_test_*) returns mock results — use it for integration tests without burning real credits.",
                    },
                  ].map((b, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <span className="text-yellow font-bold text-xs mt-1 flex-shrink-0">0{i + 1}</span>
                      <div>
                        <div className="text-white font-medium mb-0.5">{b.title}</div>
                        <div className="text-white/40 text-xs leading-relaxed">{b.desc}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-xl border border-white/8 px-4 py-3" style={{ background: "rgba(74,222,128,0.04)" }}>
                <p className="text-green-400 text-xs font-semibold mb-1">After the trial</p>
                <p className="text-white/45 text-xs leading-relaxed">
                  Trial credits don&apos;t roll over — top up at <Link href="/payment" className="text-yellow hover:underline">Pricing</Link> to
                  keep gasless payments live. Live key auto-expires {TRIAL_DURATION_DAYS} days
                  after activation if not converted; sandbox key stays active forever.
                </p>
              </div>
            </motion.div>
          </div>

          {/* Bottom CTA — Docs + Claude */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.45 }}
            className="border-t border-white/8 pt-8 flex flex-wrap items-center justify-between gap-4"
          >
            <p className="text-white/45 text-sm">
              Want to see what the full multichain product looks like?{" "}
              <Link href="/" className="text-yellow hover:underline">Back to main →</Link>
            </p>
            <div className="flex items-center gap-5 text-xs text-white/40">
              <Link href="/docs" className="hover:text-white">Docs</Link>
              <Link href="/claude" className="hover:text-orange-300">Claude × Q402</Link>
              <Link href="/agents" className="hover:text-green-400">Agents</Link>
            </div>
          </motion.div>
        </div>
      </main>
      <Footer />

    </>
  );
}
