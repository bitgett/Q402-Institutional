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

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { getActionAuth } from "@/app/lib/auth-client";
import { TimerIcon } from "../v2/logos";
import { AgenticWalletRecurringModal } from "./AgenticWalletRecurringModal";

interface RuleView {
  ruleId: string;
  walletId: string;
  label: string | null;
  frequency: string;
  chain: string;
  token: string;
  recipients: Array<{ to: string; amount: string }>;
  recipientCount: number;
  /** Sum of all row amounts, stringified. Server-computed. */
  amountPerFire: string;
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

interface RuleFire {
  firedAt: number;
  slot: number;
  amountUsd: number;
  txHashes: string[];
  settledCount: number;
  failedCount: number;
  partialFailureNote: string | null;
}

// Per-chain explorer base for tx links. Mirrors CHAIN_META in
// AgenticWalletSendModal — kept in sync manually; the table is short
// and the duplication is preferable to threading a shared module just
// for two callsites. Unknown chains fall through to BscScan since 95%+
// of recurring rules are BNB.
const TX_EXPLORER: Record<string, { base: string; label: string }> = {
  bnb:       { base: "https://bscscan.com/tx/",                  label: "BscScan" },
  eth:       { base: "https://etherscan.io/tx/",                 label: "Etherscan" },
  avax:      { base: "https://snowtrace.io/tx/",                 label: "Snowtrace" },
  xlayer:    { base: "https://www.oklink.com/xlayer/tx/",        label: "OKLink" },
  stable:    { base: "https://stablescan.xyz/tx/",               label: "StableScan" },
  mantle:    { base: "https://explorer.mantle.xyz/tx/",          label: "Mantle Explorer" },
  injective: { base: "https://blockscout.injective.network/tx/", label: "Blockscout" },
  monad:     { base: "https://monadscan.com/tx/",                label: "MonadScan" },
  scroll:    { base: "https://scrollscan.com/tx/",               label: "ScrollScan" },
  arbitrum:  { base: "https://arbiscan.io/tx/",                  label: "Arbiscan" },
};

function explorerFor(chain: string) {
  return TX_EXPLORER[chain] ?? TX_EXPLORER.bnb;
}

function shortHash(h: string): string {
  if (h.length < 14) return h;
  return `${h.slice(0, 8)}…${h.slice(-6)}`;
}

function formatFiredAt(ms: number): string {
  const d = new Date(ms);
  const diffMs = Date.now() - ms;
  const mins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);
  let rel = "";
  if (days >= 2) rel = `${days}d ago`;
  else if (hours >= 1) rel = `${hours}h ago`;
  else if (mins >= 1) rel = `${mins}m ago`;
  else rel = "just now";
  return `${rel} · ${d.toUTCString().slice(5, 22)} UTC`;
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
  if (f.startsWith("hourly:")) {
    const n = Number(f.slice("hourly:".length));
    if (Number.isFinite(n)) {
      return n === 1 ? "Every hour" : `Every ${n} hours`;
    }
  }
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

function formatNextRun(rule: RuleView): ReactNode {
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
    return (
      <span className="inline-flex items-center gap-1">
        <TimerIcon size={12} />
        Fires in {remainingHrs}h · {d.toUTCString().slice(5, 22)} UTC
      </span>
    );
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
    <div>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <ClockIcon className="w-3.5 h-3.5 text-emerald-300" />
            <div className="text-[12px] uppercase tracking-[0.18em] text-emerald-300 font-semibold">
              Recurring payments
            </div>
          </div>
          <div className="text-[11.5px] text-white/82 leading-snug">
            Payouts, subscriptions, or treasury sweeps — your AI fires each with a cancel window first.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          disabled={walletArchived || !hasMultichainScope}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: "rgba(247,202,22,0.14)",
            color: "#f9d64a",
            border: "1px solid rgba(247,202,22,0.38)",
          }}
          title={
            walletArchived
              ? "Restore the wallet to add new schedules"
              : !hasMultichainScope
                ? "Recurring requires the paid Multichain subscription (any chain, including BNB). Upgrade your plan to enable schedules."
                : undefined
          }
        >
          + New schedule {!hasMultichainScope && !walletArchived && <span className="text-[10px] opacity-70">(Paid)</span>}
        </button>
      </div>

      {loading && (
        <div className="text-[12px] text-white/60 py-3 text-center">Loading schedules…</div>
      )}

      {!loading && error && (
        <div className="rounded-md border border-rose-400/40 bg-rose-400/[0.08] p-3 text-[12px] text-rose-100">
          {error}
        </div>
      )}

      {!loading && !error && visibleRules.length === 0 && (
        <div
          className="mt-3 pt-3 border-t"
          style={{ borderColor: "rgba(255,255,255,0.08)" }}
        >
          <div className="text-[12px] text-white/82 mb-2">
            No schedules yet — try one of these patterns:
          </div>
          {/* Vertical list — one pattern per row (icon chip + title + copy).
              Replaces the old multi-column grid, which overlapped inside the
              narrow v2 right-rail. Stacks cleanly in any container width. */}
          <div className="flex flex-col gap-1.5">
            {[
              { Icon: ClockIcon,    title: "Hourly heartbeat",      copy: "Every N hours → service / API" },
              { Icon: CalendarIcon, title: "Weekly payouts",        copy: "Every Friday → contractor list" },
              { Icon: RefreshIcon,  title: "Monthly subscriptions", copy: "1st of the month → vendor" },
              { Icon: VaultIcon,    title: "Treasury sweep",        copy: "Last day → ops wallet" },
            ].map(({ Icon, title, copy }) => (
              <div
                key={title}
                className="flex items-center gap-3 rounded-md border px-3 py-2"
                style={{
                  background: "rgba(255,255,255,0.025)",
                  borderColor: "rgba(255,255,255,0.08)",
                }}
              >
                <span
                  className="grid place-items-center rounded-md shrink-0"
                  style={{ width: 28, height: 28, background: "rgba(247,202,22,0.10)" }}
                >
                  <Icon className="w-4 h-4 text-emerald-300" />
                </span>
                <div className="min-w-0">
                  <div className="text-[12.5px] text-white/95 font-medium leading-tight">{title}</div>
                  <div className="text-[11px] text-white/72 leading-snug">{copy}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && actionError && (
        <div className="rounded-md border border-rose-400/40 bg-rose-400/[0.08] p-2 mb-2 text-[12px] text-rose-100">
          {actionError}
        </div>
      )}

      {!loading && visibleRules.map((rule) => (
        <RuleRow
          key={rule.ruleId}
          rule={rule}
          actionBusy={actionBusy}
          walletArchived={walletArchived}
          ownerAddress={ownerAddress}
          signMessage={signMessage}
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
  ownerAddress,
  signMessage,
  onAction,
}: {
  rule: RuleView;
  actionBusy: string | null;
  walletArchived: boolean;
  ownerAddress: string;
  signMessage: (message: string) => Promise<string | null>;
  onAction: (action: "pause" | "resume" | "skip-next" | "cancel") => void;
}) {
  const busy = (action: string) => actionBusy === `${rule.ruleId}:${action}`;
  const anyBusy = actionBusy !== null && actionBusy.startsWith(`${rule.ruleId}:`);
  const pending = rule.pendingFireAt !== null && rule.status === "active";
  const ringClass = pending
    ? "border-amber-400/40 bg-amber-400/[0.05]"
    : "border-white/12 bg-white/[0.025]";

  const recipientCount = rule.recipientCount ?? rule.recipients.length;
  const single = recipientCount === 1;
  const summaryText = single
    ? `${rule.amountPerFire} ${rule.token} → ${formatRecipient(rule.recipients[0]?.to ?? "")}`
    : `${rule.amountPerFire} ${rule.token} → ${recipientCount} recipients`;
  const [expanded, setExpanded] = useState(false);

  // ── Fire log state ──────────────────────────────────────────────────
  // Lazy-fetched on first expand. Cached in component state so a re-open
  // doesn't re-roundtrip. The cron writes new entries server-side so the
  // user can manually refresh; we don't poll.
  const [firesOpen, setFiresOpen] = useState(false);
  const [fires, setFires] = useState<RuleFire[] | null>(null);
  const [firesLoading, setFiresLoading] = useState(false);
  const [firesError, setFiresError] = useState<string | null>(null);
  const explorer = explorerFor(rule.chain);

  async function loadFires() {
    setFiresLoading(true);
    setFiresError(null);
    try {
      const { getAuthCreds } = await import("@/app/lib/auth-client");
      const creds = await getAuthCreds(ownerAddress, signMessage);
      if (!creds) {
        setFiresError("Sign the wallet challenge to view fire history.");
        return;
      }
      const url = new URL(
        `/api/wallet/agentic/${rule.walletId}/recurring/${rule.ruleId}/fires`,
        window.location.origin,
      );
      url.searchParams.set("address", ownerAddress);
      url.searchParams.set("nonce", creds.nonce);
      url.searchParams.set("sig", creds.signature);
      const res = await fetch(url.toString());
      const data = (await res.json().catch(() => null)) as { fires?: RuleFire[]; error?: string } | null;
      if (!res.ok) {
        setFiresError(data?.error ?? `Failed to load fire history (${res.status}).`);
        return;
      }
      setFires(Array.isArray(data?.fires) ? data.fires : []);
    } catch (e) {
      setFiresError(e instanceof Error ? e.message : String(e));
    } finally {
      setFiresLoading(false);
    }
  }

  async function toggleFires() {
    if (!firesOpen && fires === null) await loadFires();
    setFiresOpen((v) => !v);
  }

  return (
    <div className={`mb-2 rounded-md border ${ringClass} p-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-[13px] text-white font-medium truncate">
              {rule.label ?? summaryText}
            </div>
            {pending && (
              <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-semibold bg-amber-400/20 text-amber-100">
                pending
              </span>
            )}
            {rule.status === "paused" && (
              <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-semibold bg-white/12 text-white/75">
                paused
              </span>
            )}
            {rule.status === "paused-by-archive" && (
              <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-semibold bg-white/12 text-white/75">
                paused · archive
              </span>
            )}
            {rule.status === "fired-cap-exceeded" && (
              <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-semibold bg-rose-400/20 text-rose-100">
                stopped
              </span>
            )}
          </div>

          <div className="mt-1 text-[11.5px] text-white/70">
            {formatFrequency(rule.frequency)} · {rule.amountPerFire} {rule.token} on {rule.chain.toUpperCase()}
            {single ? (
              <> → <code className="font-mono text-white/80">{formatRecipient(rule.recipients[0]?.to ?? "")}</code></>
            ) : (
              <>
                {" "}·{" "}
                <button
                  type="button"
                  onClick={() => setExpanded((e) => !e)}
                  className="text-emerald-300 hover:text-emerald-200 transition-colors"
                >
                  {recipientCount} recipients {expanded ? "▾" : "▸"}
                </button>
              </>
            )}
          </div>

          {!single && expanded && (
            <div
              className="mt-2 rounded-md border p-2 space-y-1"
              style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.10)" }}
            >
              {rule.recipients.map((r, i) => (
                <div key={`${r.to}-${i}`} className="flex items-center justify-between text-[10.5px] font-mono">
                  <span className="text-white/80">{r.to}</span>
                  <span className="text-emerald-300">{r.amount} {rule.token}</span>
                </div>
              ))}
            </div>
          )}

          <div className="mt-1 text-[11.5px] text-white/65">
            {formatNextRun(rule)}
            {rule.totalFiredCount > 0 && (
              <>
                {" "}·{" "}
                <button
                  type="button"
                  onClick={toggleFires}
                  className="text-emerald-300 hover:text-emerald-200 transition-colors"
                  title="Show last 50 fires for this rule"
                >
                  {rule.totalFiredCount} fired {firesOpen ? "▾" : "▸"}
                </button>
                {" "}· ${rule.totalSpentUsd.toFixed(2)} total
              </>
            )}
          </div>

          {rule.lastError && (
            <div className="mt-1 text-[11.5px] text-rose-200/95">
              Last attempt: {rule.lastError}
            </div>
          )}

          {firesOpen && (
            <div
              className="mt-2 rounded-md border p-2.5 space-y-1.5"
              style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.09)" }}
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="text-[10.5px] uppercase tracking-[0.18em] text-emerald-300 font-semibold">
                  Recent fires
                </div>
                <button
                  type="button"
                  onClick={loadFires}
                  disabled={firesLoading}
                  className="text-[10.5px] text-white/65 hover:text-white transition-colors disabled:opacity-40"
                >
                  {firesLoading ? "Loading…" : "Refresh"}
                </button>
              </div>
              {firesError && (
                <div className="text-[11px] text-rose-200/95">{firesError}</div>
              )}
              {!firesError && !firesLoading && (fires?.length ?? 0) === 0 && (
                <div className="text-[11px] text-white/60">
                  No fires recorded yet. (Older fires beyond the 50-entry window are not listed; on-chain history remains intact.)
                </div>
              )}
              {!firesError && fires && fires.length > 0 && (
                <div className="space-y-1">
                  {fires.map((f, i) => {
                    const partial = f.failedCount > 0;
                    return (
                      <div
                        key={`${f.firedAt}-${i}`}
                        className="flex items-center justify-between gap-3 rounded px-2 py-1.5"
                        style={{
                          background: partial ? "rgba(244,63,94,0.05)" : "rgba(255,255,255,0.02)",
                          border: partial ? "1px solid rgba(244,63,94,0.18)" : "1px solid rgba(255,255,255,0.05)",
                        }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-[11px] text-white/85">
                            ${f.amountUsd.toFixed(2)} {rule.token}
                            {partial && (
                              <span className="ml-1.5 text-[10px] text-rose-200/90 uppercase tracking-wider">
                                {f.settledCount}/{f.settledCount + f.failedCount} settled
                              </span>
                            )}
                          </div>
                          <div className="text-[10.5px] text-white/55 mt-0.5">{formatFiredAt(f.firedAt)}</div>
                        </div>
                        <div className="flex flex-col items-end gap-0.5 shrink-0">
                          {f.txHashes.map((h, j) => (
                            <a
                              key={`${h}-${j}`}
                              href={`${explorer.base}${h}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-[10.5px] text-emerald-300 hover:text-emerald-200 transition-colors"
                              title={`Open on ${explorer.label}`}
                            >
                              {shortHash(h)} ↗
                            </a>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col items-end gap-1 shrink-0 text-[11.5px]">
          {rule.status === "active" && pending && (
            <button
              onClick={() => onAction("skip-next")}
              disabled={anyBusy || walletArchived}
              className="text-amber-200 hover:text-amber-100 transition-colors disabled:opacity-40"
            >
              {busy("skip-next") ? "…" : "Skip this run"}
            </button>
          )}
          {rule.status === "active" && (
            <button
              onClick={() => onAction("pause")}
              disabled={anyBusy || walletArchived}
              className="text-white/75 hover:text-white transition-colors disabled:opacity-40"
            >
              {busy("pause") ? "…" : "Pause"}
            </button>
          )}
          {(rule.status === "paused" ||
            rule.status === "paused-by-archive" ||
            rule.status === "fired-cap-exceeded") && (
            <button
              onClick={() => onAction("resume")}
              disabled={anyBusy || walletArchived}
              className="text-emerald-300 hover:text-emerald-200 transition-colors disabled:opacity-40"
              title={
                rule.status === "fired-cap-exceeded"
                  ? "Resume after raising the per-tx cap or re-subscribing"
                  : undefined
              }
            >
              {busy("resume") ? "…" : "Resume"}
            </button>
          )}
          <button
            onClick={() => onAction("cancel")}
            disabled={anyBusy || walletArchived}
            className="text-rose-300 hover:text-rose-200 transition-colors disabled:opacity-40"
          >
            {busy("cancel") ? "…" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Inline icons ──────────────────────────────────────────────────────────
// Hand-rolled SVGs to replace the emoji used earlier — emoji rendered
// platform-specific (Apple vs Windows vs Linux) and broke the tonal
// match with the rest of the emerald-on-dark UI. Keep them tiny + tinted.

function ClockIcon(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function CalendarIcon(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className} aria-hidden>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

function RefreshIcon(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className} aria-hidden>
      <path d="M20 11a8 8 0 0 0-14.6-4M4 5v5h5" />
      <path d="M4 13a8 8 0 0 0 14.6 4M20 19v-5h-5" />
    </svg>
  );
}

function VaultIcon(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className} aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 8.5v-1M12 16.5v-1M15.5 12h1M7.5 12h1" />
    </svg>
  );
}
