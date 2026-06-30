"use client";

import { useEffect, useState } from "react";
import { getAuthCreds } from "@/app/lib/auth-client";
import { useIsMobile } from "@/app/lib/use-is-mobile";
import { v2, subCard, fs, type V2ViewId, type Scope } from "../theme";
import { SectionHead, shortAddr } from "../primitives";

interface RefereeEntry {
  address: string;
  ts: number;
}
interface LbEntry {
  address: string;
  count: number;
}
interface ReferralStats {
  code: string;
  count: number;
  referees: RefereeEntry[];
  rank: number | null;
  totalInviters: number;
  leaderboard: LbEntry[];
  needsWallet?: boolean;
}

const SHARE_TEXT = "Give your AI agents a gasless wallet that pays on 11 chains. Create yours on Q402:";
const NEW_WINDOW_MS = 48 * 3600 * 1000;

function fmtDate(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
function relTime(ts: number, now: number): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 90) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d ago`;
  return fmtDate(ts);
}

/** Deterministic gradient + block avatar from an address (no library). */
function Avatar({ address, size = 28 }: { address: string; size?: number }) {
  const a = address.toLowerCase().replace(/^0x/, "").padEnd(16, "0");
  const h1 = parseInt(a.slice(0, 6), 16) % 360;
  const h2 = parseInt(a.slice(6, 12), 16) % 360;
  const bits = parseInt(a.slice(12, 16), 16);
  const id = `av-${a.slice(0, 12)}-${size}`;
  const blocks = [];
  for (let i = 0; i < 4; i++) {
    if ((bits >> i) & 1) {
      const x = 8 + (i % 2) * 9;
      const y = 8 + Math.floor(i / 2) * 9;
      blocks.push(<rect key={i} x={x} y={y} width="5.5" height="5.5" rx="1.2" fill="#fff" opacity={0.5 + 0.12 * i} />);
    }
  }
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" style={{ flex: "none" }} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={`hsl(${h1} 70% 58%)`} />
          <stop offset="1" stopColor={`hsl(${h2} 64% 50%)`} />
        </linearGradient>
      </defs>
      <rect width="30" height="30" rx="15" fill={`url(#${id})`} />
      {blocks}
    </svg>
  );
}

// Medal-gradient rank badge for the top 3, plain number otherwise.
const BADGE = {
  1: { bg: "linear-gradient(135deg,#f9d64a,#caa416)", color: "#241c00" },
  2: { bg: "linear-gradient(135deg,#dfe6ef,#aab4c4)", color: "#1b222c" },
  3: { bg: "linear-gradient(135deg,#e0a368,#b06f38)", color: "#241402" },
} as const;

/** One leaderboard row: medal/number badge + relative-count bar + avatar +
 *  address + count. The viewer's row is highlighted. */
function LbRow({ rank, address, count, max, isYou }: { rank: number; address: string; count: number; max: number; isYou: boolean }) {
  const badge = BADGE[rank as 1 | 2 | 3];
  const fillW = max > 0 ? Math.max(5, (count / max) * 100) : 0;
  return (
    <div style={{ position: "relative", borderRadius: 11, overflow: "hidden", border: isYou ? "1px solid var(--v2-accent-line)" : "1px solid transparent", background: isYou ? "rgba(247,202,22,.07)" : "transparent" }}>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${fillW}%`, background: "linear-gradient(90deg, rgba(247,202,22,.06), rgba(247,202,22,.012))" }} />
      <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, padding: "10px 12px" }}>
        <span style={{ width: 26, height: 26, borderRadius: 8, display: "grid", placeItems: "center", fontFamily: "var(--font-grotesk)", fontWeight: 700, fontSize: 13, flex: "none", background: badge?.bg ?? "transparent", color: badge?.color ?? v2.muted2 }}>{rank}</span>
        <Avatar address={address} size={30} />
        <span style={{ fontFamily: "var(--font-grotesk)", fontSize: 14, color: v2.text, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{shortAddr(address)}</span>
        {isYou && <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".06em", color: v2.yellow, flex: "none" }}>YOU</span>}
        <span style={{ marginLeft: "auto", textAlign: "right", flex: "none" }}>
          <span style={{ display: "block", fontFamily: "var(--font-grotesk)", fontWeight: 600, fontSize: 15, color: v2.text, lineHeight: 1.1 }}>{count}</span>
          <span style={{ fontSize: 9, color: v2.muted2, textTransform: "uppercase", letterSpacing: ".04em" }}>invited</span>
        </span>
      </div>
    </div>
  );
}

/** The big left-column leaderboard (the page's centerpiece). */
function Leaderboard({ entries, you, yourRank, yourCount, totalInviters }: { entries: LbEntry[]; you: string | null; yourRank: number | null; yourCount: number; totalInviters: number }) {
  const youL = (you ?? "").toLowerCase();
  const inTop = entries.some((e) => e.address.toLowerCase() === youL);
  const max = entries[0]?.count ?? 0;
  return (
    <div style={{ ...subCard(13), padding: "18px 18px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 34, height: 34, borderRadius: 10, background: "radial-gradient(circle at 35% 30%, rgba(247,202,22,.28), rgba(247,202,22,.07))", border: `1px solid var(--v2-accent-line)`, display: "grid", placeItems: "center", flex: "none" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f9d64a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z" /><path d="M17 5h2.5a1.5 1.5 0 0 1 0 5H17M7 5H4.5a1.5 1.5 0 0 0 0 5H7" /></svg>
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: "var(--font-grotesk)", fontSize: 17, fontWeight: 600, color: v2.text }}>Top inviters</div>
          <div style={{ fontSize: 11.5, color: v2.muted, marginTop: 1 }}>Most builders brought to Q402</div>
        </div>
        {totalInviters > 0 && (
          <div style={{ marginLeft: "auto", fontSize: 11, color: v2.muted, background: "rgba(255,255,255,.04)", border: `1px solid ${v2.line}`, borderRadius: 20, padding: "5px 11px", flex: "none" }}>
            <b style={{ color: v2.text, fontFamily: "var(--font-grotesk)" }}>{totalInviters}</b> inviter{totalInviters === 1 ? "" : "s"}
          </div>
        )}
      </div>
      {entries.length === 0 ? (
        <div style={{ color: v2.muted, fontSize: fs.label, lineHeight: 1.6, marginTop: 16, padding: "8px 0" }}>
          No inviters on the board yet. Share your link and be the first to bring a builder in.
        </div>
      ) : (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
          {entries.map((e, i) => (
            <LbRow key={e.address} rank={i + 1} address={e.address} count={e.count} max={max} isYou={e.address.toLowerCase() === youL} />
          ))}
          {!inTop && yourRank && youL && (
            <>
              <div style={{ textAlign: "center", color: v2.muted2, fontSize: 13, lineHeight: 1, padding: "1px 0" }}>···</div>
              <LbRow rank={yourRank} address={youL} count={yourCount} max={max} isYou />
            </>
          )}
        </div>
      )}
    </div>
  );
}

const STEP_ICONS = [
  <svg key="1" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f9d64a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" /><polyline points="16 6 12 2 8 6" /><line x1="12" y1="2" x2="12" y2="15" /></svg>,
  <svg key="2" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f9d64a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></svg>,
  <svg key="3" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f9d64a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>,
];
const STEPS = [
  { t: "Share your link", d: "X, Telegram, DM — anywhere builders are." },
  { t: "They create a wallet", d: "Their first Agent Wallet via your link." },
  { t: "You climb the board", d: "Counts toward your rank, one per new user." },
];

/**
 * Referral view (top-level dashboard tab). Leaderboard-first layout: the big
 * Top-Inviters board on the left is the centerpiece; the right column stacks the
 * invite link + one-tap share + Invited/Rank stats, a how-it-works strip, and the
 * list of who joined. A referral link requires an Agent Wallet (server returns an
 * empty code otherwise) → that case shows a create-a-wallet prompt.
 */
export function ReferralView({
  ownerAddress,
  signMessage,
  onNavigate,
}: {
  ownerAddress: string | null;
  signMessage: (message: string) => Promise<string | null>;
  // Accepted to match the shared viewProps shape ({...viewProps}); unused here.
  scope: Scope;
  onNavigate?: (view: V2ViewId) => void;
}) {
  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // "now" captured once at mount (lazy init) so relative times stay pure for
  // render — react-hooks/purity forbids Date.now() in the render body.
  const [now] = useState(() => Date.now());
  const isMobile = useIsMobile();

  useEffect(() => {
    let cancelled = false;
    if (!ownerAddress) return; // not connected → render shows a connect prompt
    (async () => {
      try {
        const creds = await getAuthCreds(ownerAddress, signMessage);
        if (!creds) {
          if (!cancelled) {
            setErr("Sign in to load your referrals.");
            setLoading(false);
          }
          return;
        }
        const qs = new URLSearchParams({ address: ownerAddress, nonce: creds.nonce, sig: creds.signature });
        const res = await fetch(`/api/referral/stats?${qs.toString()}`);
        if (!res.ok) {
          if (!cancelled) {
            setErr("Couldn't load your referrals.");
            setLoading(false);
          }
          return;
        }
        const data = (await res.json()) as ReferralStats;
        if (!cancelled) {
          setStats(data);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerAddress, signMessage]);

  const origin = typeof window !== "undefined" ? window.location.origin : "https://q402.quackai.ai";
  const link = stats?.code ? `${origin}/?ref=${stats.code}` : "";
  const linkShort = stats?.code ? `q402.quackai.ai/?ref=${stats.code}` : "";
  const needsWallet = !!stats && !stats.code;

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the field is selectable as a fallback */
    }
  }
  function share(kind: "x" | "tg") {
    if (!link) return;
    const url =
      kind === "x"
        ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(SHARE_TEXT)}&url=${encodeURIComponent(link)}`
        : `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(SHARE_TEXT)}`;
    if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
  }

  const card = { ...subCard(13), padding: 18 } as const;
  const stateCard = { ...card, maxWidth: 560 } as const;
  const accentBtn = {
    border: `1px solid var(--v2-accent-line)`,
    background: "var(--v2-accent-fill)",
    color: v2.yellow,
    borderRadius: 10,
    fontWeight: 600,
    cursor: "pointer",
  } as const;
  const iconBtn = {
    width: 39,
    minWidth: 39,
    height: 39,
    border: `1px solid ${v2.line}`,
    background: "rgba(255,255,255,.025)",
    borderRadius: 10,
    display: "grid",
    placeItems: "center",
    cursor: "pointer",
  } as const;

  return (
    // No width cap — fill the dashboard container (same width as the nav above).
    <div style={{ marginTop: 14 }}>
      <SectionHead title="Referral" meta="Invite builders to Q402" />

      {!ownerAddress ? (
        <div style={{ ...stateCard, color: v2.muted, fontSize: fs.body }}>Connect your wallet to see your referrals.</div>
      ) : loading ? (
        <div style={{ ...stateCard, color: v2.muted, fontSize: fs.body }}>Loading your referrals…</div>
      ) : err ? (
        <div style={{ ...stateCard, color: v2.muted2, fontSize: fs.label }}>{err}</div>
      ) : needsWallet ? (
        <div style={stateCard}>
          <div style={{ fontSize: fs.cardTitle, fontWeight: 600, color: v2.text }}>Create an Agent Wallet to unlock your link</div>
          <div style={{ color: v2.muted, fontSize: fs.label, marginTop: 6, lineHeight: 1.55, maxWidth: 480 }}>
            Your referral link is tied to your account. Create your first Agent Wallet, then your invite link appears here.
          </div>
          <button type="button" onClick={() => onNavigate?.("wallets")} style={{ ...accentBtn, marginTop: 14, padding: "9px 16px", fontSize: fs.body }}>
            Go to Wallets
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0,1.12fr) minmax(0,0.88fr)", gap: 13, alignItems: "start" }}>
          {/* LEFT — the big leaderboard. */}
          <Leaderboard entries={stats?.leaderboard ?? []} you={ownerAddress} yourRank={stats?.rank ?? null} yourCount={stats?.count ?? 0} totalInviters={stats?.totalInviters ?? 0} />

          {/* RIGHT — invite + how-it-works + joined. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
            {/* Invite */}
            <div style={{ ...subCard(13), padding: 17, position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", right: -50, top: -70, width: 230, height: 230, borderRadius: "50%", background: "radial-gradient(circle, rgba(247,202,22,.10), transparent 62%)", pointerEvents: "none" }} />
              <div style={{ fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase", color: v2.yellow, fontWeight: 600, position: "relative" }}>Referral program</div>
              <div style={{ fontFamily: "var(--font-grotesk)", fontSize: 18, fontWeight: 600, marginTop: 6, color: v2.text, position: "relative" }}>Invite builders to Q402</div>
              <div style={{ display: "flex", gap: 8, marginTop: 13, position: "relative" }}>
                <div style={{ flex: 1, background: "rgba(255,255,255,.025)", border: `1px solid ${v2.line}`, borderRadius: 11, padding: "10px 12px" }}>
                  <div style={{ fontFamily: "var(--font-grotesk)", fontSize: 22, fontWeight: 600, color: v2.yellow, lineHeight: 1 }}>{stats?.count ?? 0}</div>
                  <div style={{ fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", color: v2.muted2, marginTop: 5 }}>Invited</div>
                </div>
                <div style={{ flex: 1, background: "rgba(255,255,255,.025)", border: `1px solid ${v2.line}`, borderRadius: 11, padding: "10px 12px" }}>
                  <div style={{ fontFamily: "var(--font-grotesk)", fontSize: 22, fontWeight: 600, color: "#58c7f4", lineHeight: 1 }}>{stats?.rank ? `#${stats.rank}` : "—"}</div>
                  <div style={{ fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", color: v2.muted2, marginTop: 5 }}>Your rank</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 7, marginTop: 13, position: "relative" }}>
                <input
                  readOnly
                  value={linkShort}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Your referral link"
                  style={{ flex: 1, minWidth: 0, background: "rgba(255,255,255,.02)", border: `1px solid ${v2.line}`, borderRadius: 10, padding: "10px 12px", color: v2.text, fontSize: 12, fontFamily: "var(--font-grotesk)", textOverflow: "ellipsis" }}
                />
                <button type="button" onClick={copy} style={{ ...accentBtn, padding: "10px 14px", fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div style={{ display: "flex", gap: 7, marginTop: 7, position: "relative", alignItems: "center" }}>
                <button type="button" onClick={() => share("x")} title="Share on X" aria-label="Share on X" style={iconBtn}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="#fff"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" /></svg>
                </button>
                <button type="button" onClick={() => share("tg")} title="Share on Telegram" aria-label="Share on Telegram" style={iconBtn}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="#58c7f4"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71l-4.14-3.05-1.99 1.93c-.23.23-.42.42-.83.42z" /></svg>
                </button>
                <span style={{ fontSize: 11, color: v2.muted2 }}>Share on X or Telegram</span>
              </div>
            </div>

            {/* How it works */}
            <div style={{ ...subCard(13), padding: "16px 17px" }}>
              <div style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: v2.muted, fontWeight: 600, marginBottom: 11 }}>How it works</div>
              {STEPS.map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 11, padding: "8px 0", borderTop: i === 0 ? "none" : `1px solid ${v2.line}` }}>
                  <span style={{ width: 28, height: 28, borderRadius: 8, background: "var(--v2-accent-fill)", border: `1px solid var(--v2-accent-line)`, display: "grid", placeItems: "center", flex: "none" }}>{STEP_ICONS[i]}</span>
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: v2.text }}>{s.t}</div>
                    <div style={{ fontSize: 11, color: v2.muted, marginTop: 2, lineHeight: 1.45 }}>{s.d}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Joined */}
            <div style={{ ...subCard(13), padding: "16px 17px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: v2.text }}>Joined through your link</div>
                <div style={{ fontSize: 10.5, color: v2.muted2 }}>{stats?.count ?? 0} total</div>
              </div>
              {!stats || stats.referees.length === 0 ? (
                <div style={{ color: v2.muted, fontSize: fs.label, marginTop: 8 }}>No one yet. Share your link to get started.</div>
              ) : (
                <div>
                  {stats.referees
                    .slice()
                    .reverse()
                    .map((r, i) => {
                      const isNew = now - r.ts < NEW_WINDOW_MS;
                      return (
                        <div key={`${r.address}-${i}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: i === 0 ? "none" : `1px solid ${v2.line}` }}>
                          <Avatar address={r.address} size={26} />
                          <span style={{ fontFamily: "var(--font-grotesk)", fontSize: 12.5, color: v2.text }}>{shortAddr(r.address)}</span>
                          {isNew && (
                            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".07em", color: "#55e6a5", background: "rgba(85,230,165,.12)", borderRadius: 5, padding: "2px 6px" }}>NEW</span>
                          )}
                          <span style={{ marginLeft: "auto", textAlign: "right" }}>
                            <span style={{ display: "block", fontSize: 11, color: "rgba(255,255,255,.8)" }}>{fmtDate(r.ts)}</span>
                            <span style={{ fontSize: 9.5, color: v2.muted2 }}>{relTime(r.ts, now)}</span>
                          </span>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
