"use client";

/**
 * AgenticWalletAgentModal — ERC-8004 agent registration ("graduate").
 *
 * Three-step flow:
 *   1. Name + description form → POST /register-agent (prepare)
 *      • Server pins metadata to IPFS, returns calldata
 *   2. User signs the register tx through their MetaMask
 *      (the NFT mints to msg.sender, gas ~$0.05 on BSC)
 *   3. After receipt → POST /register-agent/confirm
 *      • Server parses the Registered event, persists agentId on the
 *        Agent Wallet record, returns the 8004scan URL
 *
 * Network: BSC mainnet only for v1. The dashboard signals which
 * IdentityRegistry address + chainId to switch to.
 */

import { useState } from "react";
import { getAuthCreds } from "@/app/lib/auth-client";
import { ensureWalletChain } from "@/app/lib/wallet";
import type { WalletChainKey } from "@/app/lib/wallet";

interface Props {
  walletAddress: string;
  ownerAddress: string;
  signMessage: (message: string) => Promise<string | null>;
  onClose: () => void;
  onRegistered: (agentId: string, scanUrl: string) => void;
}

type Stage = "form" | "preparing" | "awaiting-sign" | "confirming" | "done" | "error";

/**
 * Discriminator for the error stage's visual tone.
 *
 *   • "rejected"      — user clicked Reject in MetaMask/OKX. Soft amber
 *                       framing, not red — this is a normal user choice,
 *                       not a system failure.
 *   • "insufficient"  — owner EOA can't pay BSC gas. Red + actionable
 *                       top-up copy.
 *   • "generic"       — anything else. Red, raw message.
 */
type ErrorKind = "rejected" | "insufficient" | "generic";

interface PrepareResponse {
  network: "bsc";
  registry: string;
  chainId: number;
  agentURI: string;
  calldata: string;
}

interface ConfirmResponse {
  network: string;
  agentId: string;
  scanUrl: string;
}

interface EthereumProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

function getProvider(): EthereumProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { ethereum?: EthereumProvider; okxwallet?: EthereumProvider };
  return w.ethereum ?? w.okxwallet ?? null;
}

export function AgenticWalletAgentModal({
  walletAddress,
  ownerAddress,
  signMessage,
  onClose,
  onRegistered,
}: Props) {
  const [stage, setStage] = useState<Stage>("form");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<ErrorKind>("generic");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [result, setResult] = useState<ConfirmResponse | null>(null);

  function fail(message: string, kind: ErrorKind) {
    setError(message);
    setErrorKind(kind);
    setStage("error");
  }

  const valid = name.trim().length > 0 && name.trim().length <= 80;

  async function start() {
    if (!valid) {
      setError("Agent name is required (1–80 chars).");
      return;
    }
    setError(null);
    setStage("preparing");
    try {
      // ── Step 1: prepare (pins metadata, returns calldata) ─────────────
      const auth = await getAuthCreds(ownerAddress, signMessage);
      if (!auth) {
        fail("Sign the auth challenge to start registration.", "generic");
        return;
      }
      const prepRes = await fetch("/api/wallet/agentic/register-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: ownerAddress,
          nonce: auth.nonce,
          signature: auth.signature,
          name: name.trim(),
          description: description.trim() || undefined,
          network: "bsc",
        }),
      });
      const prep = (await prepRes.json().catch(() => ({}))) as
        | (PrepareResponse & { error?: string; message?: string })
        | Record<string, never>;
      if (!prepRes.ok) {
        fail(
          ("message" in prep ? prep.message : undefined) ??
            ("error" in prep ? prep.error : undefined) ??
            "Could not prepare registration.",
          "generic",
        );
        return;
      }

      // ── Step 2: user signs the mint tx through their wallet ───────────
      setStage("awaiting-sign");
      const provider = getProvider();
      if (!provider) {
        fail("No wallet provider found. Connect MetaMask or OKX and retry.", "generic");
        return;
      }
      // BSC mainnet is "bnb" in our internal chain map.
      const chainKey: WalletChainKey = "bnb";
      await ensureWalletChain(chainKey);

      const hash = (await provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: ownerAddress,
            to: prep.registry,
            data: prep.calldata,
            value: "0x0",
          },
        ],
      })) as string;
      setTxHash(hash);

      // ── Step 3: confirm — server reads receipt + persists agentId ─────
      setStage("confirming");
      // Small initial delay so the receipt is more likely indexed.
      await new Promise((r) => setTimeout(r, 4000));

      // Up to 6 polls × 5s = 30s window. BSC blocks are ~3s.
      let confirmed: ConfirmResponse | null = null;
      let lastErr = "";
      for (let i = 0; i < 6; i++) {
        const confRes = await fetch("/api/wallet/agentic/register-agent/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address: ownerAddress,
            nonce: auth.nonce,
            signature: auth.signature,
            txHash: hash,
            network: "bsc",
          }),
        });
        const conf = (await confRes.json().catch(() => ({}))) as
          | (ConfirmResponse & { error?: string; message?: string })
          | Record<string, never>;
        if (confRes.ok && "agentId" in conf) {
          confirmed = conf as ConfirmResponse;
          break;
        }
        if (confRes.status === 425) {
          // pending — wait + retry
          lastErr = "Waiting for confirmation…";
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        lastErr =
          ("message" in conf ? (conf as { message?: string }).message : undefined) ??
          ("error" in conf ? (conf as { error?: string }).error : undefined) ??
          `confirm HTTP ${confRes.status}`;
        break;
      }
      if (!confirmed) {
        fail(lastErr || "Could not confirm registration.", "generic");
        return;
      }
      setResult(confirmed);
      setStage("done");
      onRegistered(confirmed.agentId, confirmed.scanUrl);
    } catch (e) {
      // MetaMask + EIP-1193 providers throw *plain objects* (not Error
      // instances) so `String(e)` returns the useless "[object Object]"
      // and `e instanceof Error` is false. Normalise to a readable
      // string + extract the numeric code so we can branch on known
      // EIP-1193 cases (4001 = user rejected; -32000 family = insufficient
      // funds / rpc / etc).
      const norm = normaliseProviderError(e);
      if (norm.code === 4001 || /user rejected|User denied/i.test(norm.message)) {
        fail("You cancelled the signature in your wallet.", "rejected");
      } else if (
        norm.code === -32000 ||
        /insufficient funds|insufficient balance/i.test(norm.message)
      ) {
        fail(
          "Your owner EOA doesn't have enough BNB to pay the BSC gas (~$0.05). " +
            "Top up your owner EOA (NOT the Agent Wallet) on BNB Chain and try again.",
          "insufficient",
        );
      } else {
        fail(norm.message, "generic");
      }
    }
  }

  function normaliseProviderError(e: unknown): { message: string; code?: number } {
    if (e instanceof Error) {
      // ethers / viem also tuck the EIP-1193 code into Error.cause
      const c = (e as Error & { code?: unknown }).code;
      const code = typeof c === "number" ? c : undefined;
      return { message: e.message, code };
    }
    if (e && typeof e === "object") {
      const o = e as { message?: unknown; code?: unknown; reason?: unknown };
      const message =
        typeof o.message === "string"
          ? o.message
          : typeof o.reason === "string"
            ? o.reason
            : (() => {
                try { return JSON.stringify(o); } catch { return "Unexpected error."; }
              })();
      const code = typeof o.code === "number" ? o.code : undefined;
      return { message, code };
    }
    if (typeof e === "string") return { message: e };
    return { message: "Unexpected error." };
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(2,6,15,0.72)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border p-6 space-y-4"
        style={{ background: "#0F1929", borderColor: "rgba(74,222,128,0.25)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.22em] text-emerald-400/85 font-semibold">
              ERC-8004
            </div>
            <div className="text-white font-semibold text-lg leading-tight">
              Register as public agent
            </div>
            <div className="text-[11px] text-white/45 mt-1 leading-relaxed">
              Mints an agent NFT on BNB Chain · BSC gas ~$0.05
            </div>
          </div>
          {stage !== "preparing" && stage !== "confirming" && stage !== "awaiting-sign" && (
            <button onClick={onClose} className="text-white/40 hover:text-white text-lg leading-none">
              ×
            </button>
          )}
        </div>

        <div
          className="rounded-md border px-3 py-2 flex items-center gap-2 text-[11px]"
          style={{
            background: "rgba(74,222,128,0.04)",
            borderColor: "rgba(74,222,128,0.18)",
          }}
        >
          <span className="text-white/40 uppercase tracking-widest text-[9.5px] font-semibold">
            Endpoint
          </span>
          <code className="font-mono text-white/80 truncate">
            {walletAddress.slice(0, 10)}…{walletAddress.slice(-6)}
          </code>
          <span className="text-white/30 ml-auto text-[10px]">declared in metadata</span>
        </div>

        {stage === "form" && (
          <>
            <div>
              <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">Agent name</div>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Bookkeeper for QuackAI vendors"
                maxLength={80}
                className="w-full rounded-md border px-3 py-2 text-sm text-white placeholder-white/25"
                style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}
              />
              <div className="text-[10px] text-white/35 mt-1">{name.length}/80</div>
            </div>

            <div>
              <div className="text-[11px] text-white/45 uppercase tracking-widest mb-1">Description (optional)</div>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this agent does, who it pays, what it spends on."
                maxLength={500}
                rows={3}
                className="w-full rounded-md border px-3 py-2 text-sm text-white placeholder-white/25 resize-none"
                style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}
              />
              <div className="text-[10px] text-white/35 mt-1">{description.length}/500</div>
            </div>

            <div
              className="rounded-md border px-3 py-2.5 text-[11.5px] leading-relaxed"
              style={{ background: "rgba(74,222,128,0.05)", borderColor: "rgba(74,222,128,0.18)", color: "rgba(226,232,240,0.78)" }}
            >
              You&apos;ll sign one transaction with your MetaMask to mint the agent NFT.
              The NFT goes to your owner EOA; the Agent Wallet address gets declared
              in the metadata as the Q402 payment endpoint. BSC gas ~$0.05.
            </div>

            {error && <div className="text-[12px] text-red-300/80">{error}</div>}

            <button
              type="button"
              disabled={!valid}
              onClick={start}
              className="w-full px-3 py-2 rounded-md text-sm font-semibold bg-emerald-400 text-slate-900 hover:bg-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Continue
            </button>
          </>
        )}

        {(stage === "preparing" || stage === "awaiting-sign" || stage === "confirming") && (
          <div className="py-3 space-y-2 text-sm text-white/65">
            <StageLine
              label="Pinning agent metadata to IPFS"
              state={stage === "preparing" ? "active" : "done"}
            />
            <StageLine
              label="Waiting for your wallet signature"
              state={
                stage === "awaiting-sign" ? "active" : stage === "confirming" ? "done" : "pending"
              }
            />
            <StageLine
              label="Reading Registered event from chain"
              state={stage === "confirming" ? "active" : "pending"}
            />
            {txHash && (
              <div className="pt-2 text-[11px] text-white/45 font-mono break-all">
                tx {txHash.slice(0, 12)}…{txHash.slice(-8)}{" "}
                <a
                  href={`https://bscscan.com/tx/${txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-400 hover:underline"
                >
                  ↗
                </a>
              </div>
            )}
          </div>
        )}

        {stage === "done" && result && (
          <div className="space-y-3">
            <div className="rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2 text-sm text-green-200">
              Registered as Agent <span className="font-mono">#{result.agentId}</span>.
            </div>
            <a
              href={result.scanUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-center text-xs text-emerald-400 hover:underline font-mono break-all"
            >
              {result.scanUrl} ↗
            </a>
            <button
              type="button"
              onClick={onClose}
              className="w-full px-3 py-2 rounded-md text-sm font-semibold bg-emerald-400 text-slate-900 hover:bg-emerald-300"
            >
              Done
            </button>
          </div>
        )}

        {stage === "error" && (() => {
          const palette =
            errorKind === "rejected"
              ? {
                  bg: "rgba(252,211,77,0.06)",
                  border: "rgba(252,211,77,0.28)",
                  text: "#fde68a",
                  title: "Cancelled in wallet",
                }
              : errorKind === "insufficient"
                ? {
                    bg: "rgba(248,113,113,0.06)",
                    border: "rgba(248,113,113,0.30)",
                    text: "#fecaca",
                    title: "Owner EOA needs BNB",
                  }
                : {
                    bg: "rgba(248,113,113,0.06)",
                    border: "rgba(248,113,113,0.25)",
                    text: "#fecaca",
                    title: "Registration failed",
                  };
          return (
            <div className="space-y-3">
              <div
                className="rounded-md border px-3 py-2.5 space-y-1"
                style={{ background: palette.bg, borderColor: palette.border, color: palette.text }}
              >
                <div className="text-[11px] uppercase tracking-widest font-semibold opacity-90">
                  {palette.title}
                </div>
                <div className="text-[13px] leading-relaxed">
                  {error ?? "Something went wrong."}
                </div>
                {errorKind === "insufficient" && (
                  <a
                    href={`https://bscscan.com/address/${ownerAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block text-[11px] underline hover:no-underline pt-0.5"
                  >
                    View your owner EOA on BscScan ↗
                  </a>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setStage("form");
                  }}
                  className="px-3 py-2 rounded-md text-sm font-medium border border-white/12 text-white/75 hover:text-white hover:border-white/25"
                >
                  Edit details
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    void start();
                  }}
                  className="px-3 py-2 rounded-md text-sm font-semibold bg-emerald-400 text-slate-900 hover:bg-emerald-300"
                >
                  Try again
                </button>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function StageLine({ label, state }: { label: string; state: "pending" | "active" | "done" }) {
  const icon = state === "done" ? "✓" : state === "active" ? "…" : "○";
  const color =
    state === "done"
      ? "rgba(134,239,172,0.85)"
      : state === "active"
        ? "#86efac"
        : "rgba(255,255,255,0.30)";
  return (
    <div className="flex items-center gap-2">
      <span className="text-[12px] w-4 text-center" style={{ color }}>{icon}</span>
      <span style={{ color: state === "pending" ? "rgba(255,255,255,0.35)" : "rgba(226,232,240,0.78)" }}>
        {label}
      </span>
    </div>
  );
}
