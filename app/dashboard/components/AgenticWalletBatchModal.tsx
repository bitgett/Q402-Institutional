"use client";

/**
 * AgenticWalletBatchModal — multi-recipient send for the Agent tab, Command-
 * deck system.
 *
 * Up to 20 rows per submission, one chain + token for the whole batch. The
 * batch is multichain-tier — the backend rejects BNB-only trial subscriptions
 * with 402 SUBSCRIPTION_REQUIRED. Submission idempotency is server-side
 * (keccak fingerprint of owner+chain+token+rows), so "Submit" doubles as a
 * safe retry if the network blips.
 */

import { useEffect, useRef, useState } from "react";
import { getActionAuth } from "@/app/lib/auth-client";
import { agenticBatchFingerprint } from "@/app/lib/agentic-batch-fingerprint";
import { explorerTxUrl, explorerLabel } from "@/app/lib/eip7702";
import { friendlyError, type FriendlyError, type BackendError } from "@/app/lib/agentic-wallet-friendly-error";
import { ThemedSelect } from "./ThemedSelect";
import type { ChainKey } from "@/app/lib/relayer";
import { ModalShell, Field, Segmented, PrimaryCTA, AlertBox, inputStyle, MonoAddr, GOLD, GOLD_TEXT } from "./modal-kit";
import { BatchGlyph } from "./action-icons";

interface Props {
  walletAddress: string;
  walletId: string;
  ownerAddress: string;
  signMessage: (message: string) => Promise<string | null>;
  onClose: () => void;
  onSent: () => void;
}

type Token = "USDC" | "USDT";

interface ChainOption {
  key: ChainKey;
  label: string;
  tokens: readonly Token[];
}

const CHAIN_OPTIONS: ChainOption[] = [
  { key: "bnb",       label: "BNB Chain", tokens: ["USDT", "USDC"] },
  { key: "eth",       label: "Ethereum",  tokens: ["USDT", "USDC"] },
  { key: "avax",      label: "Avalanche", tokens: ["USDT", "USDC"] },
  { key: "xlayer",    label: "X Layer",   tokens: ["USDT", "USDC"] },
  { key: "stable",    label: "Stable",    tokens: ["USDT", "USDC"] },
  { key: "mantle",    label: "Mantle",    tokens: ["USDT", "USDC"] },
  { key: "injective", label: "Injective", tokens: ["USDT", "USDC"] },
  { key: "monad",     label: "Monad",     tokens: ["USDT", "USDC"] },
  { key: "scroll",    label: "Scroll",    tokens: ["USDT", "USDC"] },
  { key: "arbitrum",  label: "Arbitrum",  tokens: ["USDT", "USDC"] },
  { key: "base",      label: "Base",      tokens: ["USDT", "USDC"] },
];

const MAX_ROWS = 20;

interface Row {
  to: string;
  amount: string;
}

interface BatchResultRow {
  to: string;
  amount: string;
  ok: boolean;
  txHash?: string;
  error?: string;
}

interface BatchResponse {
  batchId?: string;
  status?: "processing" | "complete";
  results?: BatchResultRow[];
  settled?: number;
  failed?: number;
  idempotent?: boolean;
}

function isAddress(s: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(s.trim());
}

function isDecimalAmount(s: string) {
  return /^\d+(\.\d+)?$/.test(s.trim()) && Number(s) > 0;
}

export function AgenticWalletBatchModal({
  walletAddress,
  walletId,
  ownerAddress,
  signMessage,
  onClose,
  onSent,
}: Props) {
  const [chain, setChain] = useState<ChainKey>("bnb");
  const chainCfg = CHAIN_OPTIONS.find((c) => c.key === chain) ?? CHAIN_OPTIONS[0];
  const allowedTokens = chainCfg.tokens;
  const [token, setToken] = useState<Token>("USDT");
  useEffect(() => {
    if (!allowedTokens.includes(token)) setToken(allowedTokens[0]);
  }, [allowedTokens, token]);
  const [rows, setRows] = useState<Row[]>([{ to: "", amount: "" }]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [resp, setResp] = useState<BatchResponse | null>(null);
  const inFlightRef = useRef(false);

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((rs) => (rs.length >= MAX_ROWS ? rs : [...rs, { to: "", amount: "" }]));
  }
  function removeRow(i: number) {
    setRows((rs) => (rs.length === 1 ? rs : rs.filter((_, idx) => idx !== i)));
  }

  const trimmedRows = rows.map((r) => ({ to: r.to.trim(), amount: r.amount.trim() }));
  const validRows = trimmedRows.length > 0 && trimmedRows.every((r) => isAddress(r.to) && isDecimalAmount(r.amount));
  const total = trimmedRows.reduce((s, r) => (isDecimalAmount(r.amount) ? s + Number(r.amount) : s), 0);
  const canSubmit = !submitting && validRows;

  async function submit() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    if (!validRows) {
      setError({ headline: "All rows need a valid 0x recipient and a positive decimal amount." });
      inFlightRef.current = false;
      return;
    }
    setSubmitting(true);
    try {
      // Fingerprint matches the server's batch idempotency key; mixes
      // owner+walletId so two wallets share no cache slot.
      const fp = agenticBatchFingerprint(`${ownerAddress.toLowerCase()}:${walletId}`, chain, token, trimmedRows);
      const auth = await getActionAuth(
        ownerAddress,
        "agentic.batch",
        { walletId, chain, token, rows: String(trimmedRows.length), fp },
        signMessage,
      );
      if (!auth) {
        setError({ headline: "Sign the batch challenge in your wallet to authorize. The signature is bound to this exact recipient set." });
        return;
      }
      const res = await fetch("/api/wallet/agentic/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletId,
          chain,
          token,
          recipients: trimmedRows,
          ownerAddress,
          nonce: auth.challenge,
          signature: auth.signature,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as BatchResponse & BackendError;
      if (!res.ok) {
        // Relay outcome uncertain — some rows may have settled even though we
        // lost the response. Tell the user NOT to retry (the server's
        // idempotency guard already refuses to re-fire THIS exact batch).
        if ((data as { status?: string }).status === "uncertain") {
          setError({ headline: "Couldn't confirm whether these payments settled. The relay didn't respond after they may have been broadcast — check your wallet history on-chain BEFORE sending again, because re-sending could pay twice." });
          return;
        }
        setError(friendlyError(res.status, data));
        return;
      }
      setResp(data as BatchResponse);
    } catch (e) {
      setError({ headline: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
      inFlightRef.current = false;
    }
  }

  const settled = resp?.settled ?? 0;
  const failed = resp?.failed ?? 0;

  let body: React.ReactNode;
  let footer: React.ReactNode;

  if (resp) {
    body = (
      <>
        <AlertBox variant="success">
          Batch processed — {settled} settled, {failed} failed.{resp.idempotent ? " (Returned from idempotency cache.)" : ""}
        </AlertBox>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(resp.results ?? []).map((r, i) => (
            <div
              key={`${r.to}-${i}`}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 12, borderRadius: 10, padding: "8px 11px", border: `1px solid ${r.ok ? "rgba(88,199,244,.24)" : "rgba(248,113,113,.26)"}`, background: r.ok ? "rgba(88,199,244,.06)" : "rgba(248,113,113,.05)" }}
            >
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: "rgba(255,255,255,.75)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.to.slice(0, 8)}…{r.to.slice(-4)} · {r.amount} {token}
              </span>
              {r.ok && r.txHash ? (
                <a href={explorerTxUrl(chain, r.txHash)} target="_blank" rel="noopener noreferrer" style={{ flexShrink: 0, color: GOLD_TEXT, fontSize: 11, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                  {r.txHash.slice(0, 8)}… · {explorerLabel(chain)}
                </a>
              ) : (
                <span style={{ color: "rgba(252,165,165,.8)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "40%" }}>{r.error ?? "failed"}</span>
              )}
            </div>
          ))}
        </div>
      </>
    );
    footer = <PrimaryCTA onClick={onSent}>Done</PrimaryCTA>;
  } else {
    body = (
      <>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Chain">
            <ThemedSelect<ChainKey> value={chain} onChange={setChain} options={CHAIN_OPTIONS.map((c) => ({ value: c.key, label: c.label }))} ariaLabel="Chain" />
          </Field>
          <Field label="Token">
            <Segmented cols={2} value={token} onChange={setToken} options={(["USDT", "USDC"] as Token[]).map((t) => ({ value: t, label: t, disabled: !allowedTokens.includes(t) }))} />
          </Field>
        </div>

        <div style={{ fontSize: 11, color: "rgba(255,255,255,.4)" }}>Batch sends require an active multichain subscription — trial keys hit the gate.</div>

        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.09em", textTransform: "uppercase", color: "rgba(255,255,255,.5)" }}>Recipients ({rows.length} / {MAX_ROWS})</span>
            <button type="button" onClick={addRow} disabled={rows.length >= MAX_ROWS} className="transition-colors disabled:opacity-40 disabled:cursor-not-allowed" style={{ fontSize: 12, fontWeight: 600, color: GOLD_TEXT, background: "transparent" }}>
              + Add row
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rows.map((row, i) => {
              const recipientOk = row.to === "" || isAddress(row.to);
              const amountOk = row.amount === "" || isDecimalAmount(row.amount);
              return (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <input
                    type="text"
                    value={row.to}
                    onChange={(e) => updateRow(i, { to: e.target.value })}
                    placeholder="0x…"
                    spellCheck={false}
                    className="placeholder-white/25"
                    style={{ ...inputStyle({ mono: true, invalid: !recipientOk }), flex: 1 }}
                  />
                  <input
                    type="text"
                    value={row.amount}
                    onChange={(e) => updateRow(i, { amount: e.target.value })}
                    placeholder="1.50"
                    inputMode="decimal"
                    className="placeholder-white/25"
                    style={{ ...inputStyle({ mono: true, invalid: !amountOk }), width: 104 }}
                  />
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    disabled={rows.length === 1}
                    aria-label="Remove row"
                    className="transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{ flexShrink: 0, width: 30, height: 38, display: "grid", placeItems: "center", color: "rgba(255,255,255,.4)", fontSize: 18, lineHeight: 1, background: "transparent" }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, color: "rgba(255,255,255,.55)", paddingTop: 10, borderTop: "1px solid rgba(255,255,255,.06)" }}>
          <span>Total</span>
          <span style={{ color: "#fff", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{total.toFixed(2)} {token}</span>
        </div>

        {error && (
          <AlertBox variant="error" action={error.next ? <a href={error.next.href} style={{ color: GOLD_TEXT, textDecoration: "underline", textUnderlineOffset: 2 }}>{error.next.label}</a> : undefined}>
            {error.headline}
          </AlertBox>
        )}

        <div style={{ fontSize: 11, color: "rgba(255,255,255,.3)", textAlign: "center" }}>Gas sponsored by Q402&apos;s relayer. Each row is one on-chain transfer.</div>
      </>
    );
    footer = (
      <PrimaryCTA onClick={submit} disabled={!canSubmit} busy={submitting}>
        Send {total > 0 ? total.toFixed(2) : "—"} {token} to {rows.length} recipient{rows.length === 1 ? "" : "s"}
      </PrimaryCTA>
    );
  }

  return (
    <ModalShell
      icon={<BatchGlyph size={19} color={GOLD} />}
      title="Batch send"
      subtitle={<MonoAddr>{walletAddress.slice(0, 10)}…{walletAddress.slice(-6)}</MonoAddr>}
      size="lg"
      onClose={onClose}
      closeDisabled={submitting}
      footer={footer}
    >
      {body}
    </ModalShell>
  );
}
