"use client";

/**
 * AgenticWalletRecurringSection — list + manage recurring rules for a
 * single Agent Wallet. Lives INSIDE the wallet card (not a top-of-page
 * strip) so pending fires surface in context with the rest of the
 * wallet state.
 *
 * Pending-fire row reads "⏱ Fires in 18h — Skip · Cancel" right inside
 * the rules list. No separate notification surface, no popup.
 */

import { useCallback, useEffect, useState } from "react";

import { getActionAuth } from "@/app/lib/auth-client";
import { AgenticWalletRecurringModal } from "./AgenticWalletRecurringModal";

interface RuleView {
  ruleId: string;
  walletId: string;
  label: string | null;
  frequency: string;
  chain: string;
  token: string;
  recipient: string;
  amount: string;
  cancelWindowHours: number;
  nextRunAt: number;
  pendingFireAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
  totalFiredCount: number;
  totalSpentUsd: number;
  status:
    | "active"
    | "paused"
    | "paused-by-archive"
    | "cancelled"
    | "fired-cap-exceeded";
  createdAt: number;
  cancelledAt: number | null;
}

interface Props {
  walletId: string;
  ownerAddress: string;
  signMessage: (message: string) => Promise<string | null>;
  perTxMaxUsd?: number | null;
  hasMultichainScope: boolean;
  /** Wallet is archived → reads still work but rules are paused-by-archive. */
  walletArchived: boolean;
}

const FREQUENCY_LABEL: Record<string, string> = {
  daily: "Every day",
  "weekly:mon": "Every Monday",
  "weekly:tue": "Every Tuesday",
  "weekly:wed": "Every Wednesday",
  "weekly:thu": "Every Thursday",
  "weekly:fri": "Every Friday",
  "weekly:sat": "Every Saturday",
  "weekly:sun": "Every Sunday",
  "monthly:last": "Last day of every month",
};

function formatFrequency(f: string): string {
  if (FREQUENCY_LABEL[f]) return FREQUENCY_LABEL[f];
  if (f.startsWith("monthly:")) {
    const n = Number(f.slice("monthly:".length));
    if (Number.isFinite(n)) {
      const suffix = (n % 10 === 1 && n !== 11) ? "st"
                   : (n % 10 === 2 && n !== 12) ? "nd"
                   : (n % 10 === 3 && n !== 13) ? "rd" : "th";
      return `${n}${suffix} of every month`;
    }
  }
  return f;
}

function formatNextRun(rule: RuleView): string {
  if (rule.status === "cancelled") return "Cancelled";
  if (rule.status === "fired-cap-exceeded") return "Stopped — fix and resume";
  if (rule.status === "paused") return "Paused by you";
  if (rule.status === "paused-by-archive") return "Paused — wallet archived";

  const d = new Date(rule.nextRunAt);
  const now = Date.now();
  const diff = rule.nextRunAt - now;
  // Pending fire — alert sent, cancel window running out.
  if (rule.pendingFireAt !== null) {
    const fireAt = rule.pendingFireAt + rule.cancelWindowHours * 60 * 60 * 1000;
    const remainingMs = fireAt - now;
    const remainingHrs = Math.max(0, Math.floor(remainingMs / (60 * 60 * 1000)));
    return `⏱ Fires in ${remainingHrs}h · ${d.toUTCString().slice(5, 22)} UTC`;
  }
  if (diff < 24 * 60 * 60 * 1000) {
    const hrs = Math.max(0, Math.floor(diff / (60 * 60 * 1000)));
    return `Next: in ${hrs}h · ${d.toUTCString().slice(5, 22)} UTC`;
  }
  return `Next: ${d.toUTCString().slice(5, 22)} UTC`;
}

function formatRecipient(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function AgenticWalletRecurringSection({
  walletId,
  ownerAddress,
  signMessage,
  perTxMaxUsd,
  hasMultichainScope,
  walletArchived,
}: Props) {
  const [rules, setRules] = useState<RuleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchRules = useCallback(async () => {
    setError(null);
    try {
      const creds = await import("@/app/lib/auth-client").then((m) =>
        m.getAuthCreds(ownerAddress, signMessage),
      );
      if (!creds) {
        setError("Wallet signature required to load schedules.");
        setRules([]);
        return;
      }
      const url = new URL(
        `/api/wallet/agentic/${walletId}/recurring`,
        window.location.origin,
      );
      url.searchParams.set("address", ownerAddress);
      url.searchParams.set("nonce", creds.nonce);
      url.searchParams.set("sig", creds.signature);
      const res = await fetch(url.toString());
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Failed to load schedules (${res.status}).`);
        setRules([]);
        return;
      }
      const data = (await res.json()) as { rules: RuleView[] };
      setRules(Array.isArray(data.rules) ? data.rules : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [walletId, ownerAddress, signMessage]);

  useEffect(() => { void fetchRules(); }, [fetchRules]);

  async function runAction(rule: RuleView, action: "pause" | "resume" | "skip-next" | "cancel") {
    setActionError(null);
    setActionBusy(`${rule.ruleId}:${action}`);
    try {
      const isCancel = action === "cancel";
      const authAction = isCancel ? "agentic.recurring.cancel" : "agentic.recurring.update";
      const intent: Record<string, string | number> = isCancel
        ? { walletId, ruleId: rule.ruleId }
        : { walletId, ruleId: rule.ruleId, action };
      const auth = await getActionAuth(ownerAddress, authAction, intent, signMessage);
      if (!auth) {
        setActionError("Sign the rule challenge in your wallet to confirm.");
        return;
      }
      const res = await fetch(
        `/api/wallet/agentic/${walletId}/recurring/${rule.ruleId}`,
        {
          method: isCancel ? "DELETE" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address: ownerAddress,
            nonce: auth.challenge,
            signature: auth.signature,
            ...(isCancel ? {} : { action }),
          }),
        },
      );
      const data = (await res.json().catch(() => null)) as { rule?: RuleView; error?: string; message?: string } | null;
      if (!res.ok) {
        setActionError(data?.message ?? data?.error ?? `Request failed (${res.status}).`);
        return;
      }
      await fetchRules();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
    }
  }

  const visibleRules = rules.filter((r) => r.status !== "cancelled");

  return (
    <div className="mt-4 pt-4 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] uppercase tracking-widest text-white/40 font-semibold">
          Recurring payments
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          disabled={walletArchived}
          className="text-[11px] text-emerald-300 hover:text-emerald-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title={walletArchived ? "Restore the wallet to add new schedules" : undefined}
        >
          + New schedule
        </button>
      </div>

      {loading && (
        <div className="text-[12px] text-white/40 py-2">Loading schedules…</div>
      )}

      {!loading && error && (
        <div className="rounded-md border border-rose-400/30 bg-rose-400/[0.05] p-3 text-[12px] text-rose-200/85">
          {error}
        </div>
      )}

      {!loading && !error && visibleRules.length === 0 && (
        <div className="text-[12px] text-white/40 py-2">
          No schedules yet. Set one up to automate weekly payouts, monthly subscriptions, or treasury sweeps.
        </div>
      )}

      {!loading && actionError && (
        <div className="rounded-md border border-rose-400/30 bg-rose-400/[0.05] p-2 mb-2 text-[12px] text-rose-200/85">
          {actionError}
        </div>
      )}

      {!loading && visibleRules.map((rule) => (
        <RuleRow
          key={rule.ruleId}
          rule={rule}
          actionBusy={actionBusy}
          walletArchived={walletArchived}
          onAction={(action) => runAction(rule, action)}
        />
      ))}

      {modalOpen && (
        <AgenticWalletRecurringModal
          walletId={walletId}
          ownerAddress={ownerAddress}
          signMessage={signMessage}
          perTxMaxUsd={perTxMaxUsd}
          hasMultichainScope={hasMultichainScope}
          onClose={() => setModalOpen(false)}
          onCreated={() => {
            setModalOpen(false);
            void fetchRules();
          }}
        />
      )}
    </div>
  );
}

function RuleRow({
  rule,
  actionBusy,
  walletArchived,
  onAction,
}: {
  rule: RuleView;
  actionBusy: string | null;
  walletArchived: boolean;
  onAction: (action: "pause" | "resume" | "skip-next" | "cancel") => void;
}) {
  const busy = (action: string) => actionBusy === `${rule.ruleId}:${action}`;
  const anyBusy = actionBusy !== null && actionBusy.startsWith(`${rule.ruleId}:`);
  const pending = rule.pendingFireAt !== null && rule.status === "active";
  const ringClass = pending
    ? "border-amber-400/40 bg-amber-400/[0.04]"
    : "border-white/10 bg-white/[0.02]";

  return (
    <div className={`mb-2 rounded-md border ${ringClass} p-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-[13px] text-white font-medium truncate">
              {rule.label ?? `${rule.amount} ${rule.token} → ${formatRecipient(rule.recipient)}`}
            </div>
            {pending && (
              <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-semibold bg-amber-400/15 text-amber-200">
                pending
              </span>
            )}
            {rule.status === "paused" && (
              <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-semibold bg-white/10 text-white/60">
                paused
              </span>
            )}
            {rule.status === "paused-by-archive" && (
              <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-semibold bg-white/10 text-white/60">
                paused · archive
              </span>
            )}
            {rule.status === "fired-cap-exceeded" && (
              <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-semibold bg-rose-400/15 text-rose-200">
                stopped
              </span>
            )}
          </div>

          <div className="mt-1 text-[11px] text-white/55">
            {formatFrequency(rule.frequency)} · {rule.amount} {rule.token} on {rule.chain.toUpperCase()} → <code className="font-mono text-white/65">{formatRecipient(rule.recipient)}</code>
          </div>

          <div className="mt-1 text-[11px] text-white/45">
            {formatNextRun(rule)}
            {rule.totalFiredCount > 0 && (
              <> · {rule.totalFiredCount} fired · ${rule.totalSpentUsd.toFixed(2)} total</>
            )}
          </div>

          {rule.lastError && (
            <div className="mt-1 text-[11px] text-rose-300/75">
              Last attempt: {rule.lastError}
            </div>
          )}
        </div>

        <div className="flex flex-col items-end gap-1 shrink-0 text-[11px]">
          {rule.status === "active" && pending && (
            <button
              onClick={() => onAction("skip-next")}
              disabled={anyBusy || walletArchived}
              className="text-amber-300 hover:text-amber-200 transition-colors disabled:opacity-40"
            >
              {busy("skip-next") ? "…" : "Skip this run"}
            </button>
          )}
          {rule.status === "active" && (
            <button
              onClick={() => onAction("pause")}
              disabled={anyBusy || walletArchived}
              className="text-white/55 hover:text-white transition-colors disabled:opacity-40"
            >
              {busy("pause") ? "…" : "Pause"}
            </button>
          )}
          {(rule.status === "paused" || rule.status === "paused-by-archive") && (
            <button
              onClick={() => onAction("resume")}
              disabled={anyBusy || walletArchived}
              className="text-emerald-300 hover:text-emerald-200 transition-colors disabled:opacity-40"
            >
              {busy("resume") ? "…" : "Resume"}
            </button>
          )}
          <button
            onClick={() => onAction("cancel")}
            disabled={anyBusy || walletArchived}
            className="text-rose-300/75 hover:text-rose-200 transition-colors disabled:opacity-40"
          >
            {busy("cancel") ? "…" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
