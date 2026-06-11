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

import { useEffect, useRef, useState } from "react";
import { getActionAuth } from "@/app/lib/auth-client";
import { useModalEscape } from "./useModalEscape";

interface Props {
  walletAddress: string;
  walletId: string;
  ownerAddress: string;
  signMessage: (message: string) => Promise<string | null>;
  onClose: () => void;
  onArchiveRequest?: () => void;
}

type Stage = "warn" | "loading" | "reveal" | "error";
const AUTO_CLEAR_MS = 30_000;

export function AgenticWalletExportModal({
  walletAddress,
  walletId,
  ownerAddress,
  signMessage,
  onClose,
  onArchiveRequest,
}: Props) {
  const [stage, setStage] = useState<Stage>("warn");
  // Block Escape while loading (in-flight POST) AND while revealing
  // (don't let a stray Escape bypass the explicit "I've saved it" /
  // "Archive wallet now" buttons before the auto-clear timer expires).
  useModalEscape(onClose, stage === "loading" || stage === "reveal");
  const [pk, setPk] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [remaining, setRemaining] = useState(Math.floor(AUTO_CLEAR_MS / 1000));
  /**
   * Double-click guard. Without it, a fast double-tap on
   * "Sign challenge and reveal" mints two action-challenges, opens
   * two wallet popups, and POSTs twice to /export — the second POST
   * uses a fresh signature against a different challenge so it can
   * also succeed, exposing the key TWICE (auditable as two separate
   * audit-log entries but UX-confusing + over-counts toward the
   * route's 5/300s rate limit).
   */
  const inFlightRef = useRef(false);

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
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setStage("loading");
    setError(null);
    try {
      // Action-scoped challenge — the signed bytes literally include
      // `Action: agentic.export` so a fresh-but-generic signature
      // (e.g. for archive or batch) cannot be redirected to reveal a
      // private key.
      const auth = await getActionAuth(
        ownerAddress,
        "agentic.export",
        { walletId },
        signMessage,
      );
      if (!auth) {
        setError("Could not obtain a fresh export challenge — try again.");
        setStage("error");
        return;
      }
      const res = await fetch("/api/wallet/agentic/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerAddress,
          walletId,
          challenge: auth.challenge,
          signature: auth.signature,
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
    } finally {
      inFlightRef.current = false;
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
              <li>
                After export, Q402 still holds the AES-256-GCM encrypted copy on the
                server. Archiving the wallet here (or right after reveal) starts a 7-day
                grace window; the daily hard-delete cron then sweeps Q402&apos;s copy on
                schedule.
              </li>
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
              style={{ background: "rgba(8,17,30,0.7)", borderColor: "rgba(247,202,22,0.22)", color: "#E2E8F0" }}
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
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <div className="text-[11px] text-white/45 text-center">
              Auto-clears in {remaining}s
            </div>
            <div
              className="rounded-md border px-3 py-2.5 text-[12px] leading-relaxed"
              style={{ background: "rgba(248,113,113,0.05)", borderColor: "rgba(248,113,113,0.22)", color: "#fecaca" }}
            >
              Q402 still holds an AES-encrypted copy of this key. If you want full custody,
              archive the Agent Wallet now — that starts a 7-day grace window, after which
              the daily hard-delete cron sweeps Q402&apos;s copy on schedule.
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setPk(null);
                  setShow(false);
                  onClose();
                }}
                className="flex-1 px-3 py-2 rounded-md text-sm font-medium text-white/55 hover:text-white border border-white/10"
              >
                I&apos;ve saved it, close
              </button>
              {onArchiveRequest && (
                <button
                  type="button"
                  onClick={() => {
                    setPk(null);
                    setShow(false);
                    onClose();
                    onArchiveRequest();
                  }}
                  className="flex-1 px-3 py-2 rounded-md text-sm font-semibold bg-red-500/80 text-white hover:bg-red-500"
                >
                  Archive wallet now
                </button>
              )}
            </div>
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
