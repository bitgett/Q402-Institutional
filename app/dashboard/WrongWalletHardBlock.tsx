"use client";

/**
 * WrongWalletHardBlock — Phase 1 dashboard State G.
 *
 * Rendered when:
 *   - emailSession exists
 *   - session is bound to wallet X (session.address = X)
 *   - browser is connected to wallet Y (Y !== X)
 *
 * This is the gate that closes the "two identities, one screen" audit
 * finding. The dashboard MUST NOT fetch or render any multichain data
 * from the currently-connected mismatched wallet — doing so leaks paid-
 * plan / gas-tank / tx-history state across identities that the server
 * already treats as separate subscription records.
 *
 * No data is fetched from Y. The page is a deliberate dead-end with two
 * exits: switch wallets back to X (handled in the wallet extension, we
 * can only nudge), or sign out and use a different account from scratch.
 * Recovery for "lost wallet X" is a Phase 2 endpoint (support only today).
 */

import Link from "next/link";

interface Props {
  email: string;
  boundAddress: string;
  connectedAddress: string;
  onSignOut: () => void;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function WrongWalletHardBlock({
  email,
  boundAddress,
  connectedAddress,
  onSignOut,
}: Props) {
  return (
    <div className="min-h-screen text-white px-6 py-12 relative overflow-hidden"
         style={{ background: "linear-gradient(160deg, #0A0506 0%, #1A0A0F 100%)" }}>
      {/* subtle red glow accent */}
      <div className="absolute inset-0 pointer-events-none opacity-30"
           style={{ background: "radial-gradient(circle at 50% 30%, rgba(248,113,113,0.08) 0%, transparent 60%)" }} />

      <div className="max-w-2xl mx-auto relative">
        {/* Header — logo + identity */}
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

        {/* Hard-block card */}
        <div className="rounded-2xl border border-red-400/30 p-8"
             style={{ background: "linear-gradient(135deg, rgba(248,113,113,0.06) 0%, rgba(0,0,0,0.2) 100%)" }}>
          <div className="text-[10px] uppercase tracking-[0.2em] text-red-400 font-bold mb-3">
            ⚠ Wrong wallet connected
          </div>
          <h1 className="text-2xl font-bold mb-3">This isn&apos;t the wallet bound to your account</h1>
          <p className="text-white/55 text-sm mb-6 leading-relaxed">
            We&apos;re blocking dashboard access until the bound wallet is back in
            the browser. Showing a different wallet&apos;s data on this account
            would let one user juggle multiple identities under a single email
            — operationally and security-wise we close that gap on purpose.
          </p>

          {/* Two-row identity comparison */}
          <div className="space-y-3 mb-6">
            <div className="rounded-xl border border-yellow/25 p-4"
                 style={{ background: "rgba(245,197,24,0.05)" }}>
              <div className="text-[10px] uppercase tracking-widest text-yellow font-bold mb-1.5 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-yellow animate-pulse" />
                Account is bound to
              </div>
              <div className="font-mono text-base text-yellow break-all">
                {boundAddress}
              </div>
            </div>
            <div className="rounded-xl border border-red-400/25 p-4"
                 style={{ background: "rgba(248,113,113,0.04)" }}>
              <div className="text-[10px] uppercase tracking-widest text-red-400/85 font-bold mb-1.5 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
                You&apos;re connected to
              </div>
              <div className="font-mono text-base text-red-400/85 break-all">
                {connectedAddress}
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="rounded-xl border border-white/8 p-4 mb-5"
               style={{ background: "rgba(255,255,255,0.02)" }}>
            <div className="text-[10px] uppercase tracking-widest text-white/45 font-bold mb-2">
              To continue
            </div>
            <ol className="text-white/65 text-sm space-y-2 leading-relaxed list-decimal pl-4">
              <li>Open your wallet extension</li>
              <li>Switch active account back to <span className="font-mono text-yellow/90">{shortAddr(boundAddress)}</span></li>
              <li>This screen reloads automatically once the bound wallet is selected</li>
            </ol>
          </div>

          <button
            onClick={onSignOut}
            className="w-full bg-white/5 border border-white/15 text-white/70 text-xs font-semibold py-2.5 rounded-full hover:bg-white/10 hover:text-white transition-colors"
          >
            Sign out and use a different account
          </button>

          <div className="mt-6 pt-5 border-t border-white/8">
            <p className="text-white/35 text-xs leading-relaxed">
              <strong className="text-white/55">Lost access to {shortAddr(boundAddress)}?</strong>{" "}
              Wallet recovery is a Phase 2 feature — for now,{" "}
              <a href="mailto:business@quackai.ai" className="text-yellow hover:underline">
                email support
              </a>{" "}
              and we&apos;ll walk you through the manual re-pair process.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
