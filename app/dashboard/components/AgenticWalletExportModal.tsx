"use client";

/**
 * AgenticWalletExportModal — step-up auth + one-time private-key reveal.
 *
 * Flow:
 *   1. User confirms the warning (separate gate so a misclicked button
 *      doesn't slide into the signer prompt).
 *   2. Browser fetches a fresh one-time challenge from /api/auth/challenge.
 *   3. User signs the challenge with their MetaMask / OKX EOA.
 *   4. POST /api/wallet/agentic/export consumes the challenge atomically
 *      and returns the decrypted private key.
 *   5. Modal renders the key behind a reveal toggle, with copy + a 30 s
 *      auto-clear timer so the value doesn't linger if the user walks
 *      away from the screen.
 *
 * The plaintext key never leaves this component's state and is overwritten
 * on close. Q402's standard `recordExportEvent` audit fires server-side.
 */

import { useEffect, useState } from "react";
import { getFreshChallenge } from "@/app/lib/auth-client";

interface Props {
  walletAddress: string;
  ownerAddress: string;
  signMessage: (message: string) => Promise<string | null>;
  onClose: () => void;
}

type Stage = "warn" | "loading" | "reveal" | "error";
const AUTO_CLEAR_MS = 30_000;

export function AgenticWalletExportModal({
  walletAddress,
  ownerAddress,
  signMessage,
  onClose,
}: Props) {
  const [stage, setStage] = useState<Stage>("warn");
  const [pk, setPk] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [remaining, setRemaining] = useState(Math.floor(AUTO_CLEAR_MS / 1000));

  // Auto-clear the revealed key after AUTO_CLEAR_MS. The countdown
  // resets via an internal ref tied to the deadline so we avoid calling
  // setState during the effect's setup phase (eslint
  // react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!pk) return;
    const deadline = Date.now() + AUTO_CLEAR_MS;
    const tick = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
    }, 1000);
    const expire = setTimeout(() => {
      setPk(null);
      setShow(false);
      setStage("warn");
    }, AUTO_CLEAR_MS);
    return () => {
      clearInterval(tick);
      clearTimeout(expire);
    };
  }, [pk]);

  async function runExport() {
    setStage("loading");
    setError(null);
    try {
      const fresh = await getFreshChallenge(ownerAddress, signMessage);
      if (!fresh) {
        setError("Could not obtain a fresh challenge — try again.");
        setStage("error");
        return;
      }
      const res = await fetch("/api/wallet/agentic/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerAddress,
          challenge: fresh.challenge,
          signature: fresh.signature,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Export failed (HTTP ${res.status}).`);
        setStage("error");
        return;
      }
      if (!data.privateKey) {
        setError("Server did not return a private key.");
        setStage("error");
        return;
      }
      setPk(String(data.privateKey));
      setStage("reveal");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  }

  async function copy() {
    if (!pk) return;
    try {
      await navigator.clipboard.writeText(pk);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(2,6,15,0.78)" }}
      onClick={() => {
        // Don't allow click-out close while pk is revealed — force the
        // user to acknowledge via "Done" button so the auto-clear runs
        // before the modal disappears.
        if (stage !== "reveal") onClose();
      }}
    >
      <div
        className="w-full max-w-md rounded-2xl border p-6 space-y-4"
        style={{ background: "#0F1929", borderColor: "rgba(248,113,113,0.30)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="text-white font-semibold text-lg">Export private key</div>
            <div className="text-[11px] text-white/45 font-mono mt-0.5">
              {walletAddress.slice(0, 10)}…{walletAddress.slice(-6)}
            </div>
          </div>
          {stage !== "reveal" && (
            <button
              type="button"
              onClick={onClose}
              className="text-white/40 hover:text-white text-lg leading-none"
              aria-label="Close"
            >
              ×
            </button>
          )}
        </div>

        {stage === "warn" && (
          <>
            <div className="rounded-md border px-3 py-3 text-sm leading-relaxed"
              style={{ background: "rgba(248,113,113,0.06)", borderColor: "rgba(248,113,113,0.25)", color: "#fecaca" }}
            >
              <div className="font-semibold mb-1">This is the master key for the wallet.</div>
              Anyone who has it can spend the wallet&apos;s USDC / USDT immediately,
              on any chain. Q402&apos;s gas sponsorship does not stop a malicious
              key holder.
            </div>
            <ul className="text-[12px] text-white/55 space-y-1.5 leading-relaxed list-disc list-inside">
              <li>Save it to a hardware wallet or a password manager — not chat, email, or screenshots.</li>
              <li>Once exported you may want to archive this Agent Wallet and rotate to a new one.</li>
              <li>You&apos;ll sign a one-time challenge to confirm — that signature cannot be reused.</li>
            </ul>
            <button
              type="button"
              onClick={runExport}
              className="w-full px-3 py-2 rounded-md text-sm font-semibold bg-red-500/80 text-white hover:bg-red-500"
            >
              Sign challenge and reveal
            </button>
          </>
        )}

        {stage === "loading" && (
          <div className="text-sm text-white/55 py-6 text-center">Waiting for signature…</div>
        )}

        {stage === "reveal" && pk && (
          <>
            <div
              className="rounded-md border px-3 py-3 font-mono text-[12px] break-all leading-relaxed"
              style={{ background: "rgba(8,17,30,0.7)", borderColor: "rgba(74,222,128,0.22)", color: "#E2E8F0" }}
            >
              {show ? pk : "•".repeat(64)}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="flex-1 px-3 py-2 rounded-md text-sm font-medium border"
                style={{ borderColor: "rgba(255,255,255,0.12)", color: "rgba(226,232,240,0.85)" }}
              >
                {show ? "Hide" : "Reveal"}
              </button>
              <button
                type="button"
                onClick={copy}
                disabled={!show}
                className="flex-1 px-3 py-2 rounded-md text-sm font-semibold bg-emerald-400 text-slate-900 hover:bg-emerald-300 disabled:opacity-40"
              >
                {copied ? "copied ✓" : "Copy"}
              </button>
            </div>
            <div className="text-[11px] text-white/45 text-center">
              Auto-clears in {remaining}s
            </div>
            <button
              type="button"
              onClick={() => {
                setPk(null);
                setShow(false);
                onClose();
              }}
              className="w-full px-3 py-2 rounded-md text-sm font-medium text-white/55 hover:text-white border border-white/10"
            >
              I&apos;ve saved it, close
            </button>
          </>
        )}

        {stage === "error" && (
          <>
            <div className="rounded-md border px-3 py-3 text-sm text-red-200/85"
              style={{ background: "rgba(248,113,113,0.06)", borderColor: "rgba(248,113,113,0.25)" }}
            >
              {error ?? "Something went wrong."}
            </div>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setStage("warn");
              }}
              className="w-full px-3 py-2 rounded-md text-sm font-medium border border-white/12 text-white/75"
            >
              Try again
            </button>
          </>
        )}
      </div>
    </div>
  );
}
