"use client";

import { useEffect, useState } from "react";
import { getAuthCreds } from "@/app/lib/auth-client";
import { v2, subCard, fs, type V2ViewId, type Scope } from "../theme";
import { SectionHead, shortAddr } from "../primitives";

interface RefereeEntry {
  address: string;
  ts: number;
}
interface ReferralStats {
  code: string;
  count: number;
  referees: RefereeEntry[];
  rank: number | null;
  totalInviters: number;
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
function Avatar({ address }: { address: string }) {
  const a = address.toLowerCase().replace(/^0x/, "").padEnd(16, "0");
  const h1 = parseInt(a.slice(0, 6), 16) % 360;
  const h2 = (parseInt(a.slice(6, 12), 16) % 360);
  const bits = parseInt(a.slice(12, 16), 16);
  const id = `av-${a.slice(0, 12)}`;
  const blocks = [];
  for (let i = 0; i < 4; i++) {
    if ((bits >> i) & 1) {
      const x = 8 + (i % 2) * 9;
      const y = 8 + Math.floor(i / 2) * 9;
      blocks.push(<rect key={i} x={x} y={y} width="5.5" height="5.5" rx="1.2" fill="#fff" opacity={0.5 + 0.12 * i} />);
    }
  }
  return (
    <svg width="30" height="30" viewBox="0 0 30 30" style={{ flex: "none" }} aria-hidden>
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

/** A labeled stat chip (Invited / Rank). Module-level so it isn't recreated per
 *  render (react-hooks/static-components). */
function Stat({ n, label, color }: { n: string; label: string; color: string }) {
  return (
    <div style={{ background: "rgba(255,255,255,.025)", border: `1px solid ${v2.line}`, borderRadius: 11, padding: "9px 15px", textAlign: "center", minWidth: 76 }}>
      <div style={{ fontFamily: "var(--font-grotesk)", fontSize: 24, fontWeight: 600, color, lineHeight: 1, letterSpacing: "-.02em" }}>{n}</div>
      <div style={{ fontSize: 9.5, letterSpacing: ".13em", textTransform: "uppercase", color: v2.muted2, marginTop: 5 }}>{label}</div>
    </div>
  );
}

/**
 * Referral view (top-level dashboard tab). Invite link with one-tap share (X /
 * Telegram / copy), the owner's running count + leaderboard rank, a short how-it
 * works strip, and the list of users who joined through the link. A referral link
 * requires the owner to have created an Agent Wallet (the server returns an empty
 * code otherwise) → that case shows a create-a-wallet prompt.
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
  // "now" captured once at mount (lazy init) so the relative times stay pure for
  // render — react-hooks/purity forbids Date.now() in the render body.
  const [now] = useState(() => Date.now());

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
  const accentBtn = {
    border: `1px solid var(--v2-accent-line)`,
    background: "var(--v2-accent-fill)",
    color: v2.yellow,
    borderRadius: 10,
    fontWeight: 600,
    cursor: "pointer",
  } as const;
  const iconBtn = {
    width: 42,
    minWidth: 42,
    border: `1px solid ${v2.line}`,
    background: "rgba(255,255,255,.025)",
    borderRadius: 10,
    display: "grid",
    placeItems: "center",
    cursor: "pointer",
  } as const;

  const STEPS = [
    { n: "1", t: "Share your link", d: "X, Telegram, DM — anywhere." },
    { n: "2", t: "They create a wallet", d: "Their first Agent Wallet via your link." },
    { n: "3", t: "It counts", d: "Shows up below, one per new user." },
  ];

  return (
    <div style={{ maxWidth: 720, marginTop: 14 }}>
      <SectionHead title="Referral" meta="Invite builders to Q402" />

      {!ownerAddress ? (
        <div style={{ ...card, color: v2.muted, fontSize: fs.body }}>Connect your wallet to see your referrals.</div>
      ) : loading ? (
        <div style={{ ...card, color: v2.muted, fontSize: fs.body }}>Loading your referrals…</div>
      ) : err ? (
        <div style={{ ...card, color: v2.muted2, fontSize: fs.label }}>{err}</div>
      ) : needsWallet ? (
        <div style={card}>
          <div style={{ fontSize: fs.cardTitle, fontWeight: 600, color: v2.text }}>Create an Agent Wallet to unlock your link</div>
          <div style={{ color: v2.muted, fontSize: fs.label, marginTop: 6, lineHeight: 1.55, maxWidth: 480 }}>
            Your referral link is tied to your account. Create your first Agent Wallet, then your invite link appears here.
          </div>
          <button type="button" onClick={() => onNavigate?.("wallets")} style={{ ...accentBtn, marginTop: 14, padding: "9px 16px", fontSize: fs.body }}>
            Go to Wallets
          </button>
        </div>
      ) : (
        <>
          {/* HERO — link + share + stats. */}
          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: fs.cardTitle, fontWeight: 600, color: v2.text }}>Your invite link</div>
                <div style={{ color: v2.muted, fontSize: fs.label, marginTop: 5, lineHeight: 1.55, maxWidth: 340 }}>
                  Share it anywhere. When someone creates their first Agent Wallet through your link, it counts here.
                </div>
              </div>
              <div style={{ display: "flex", gap: 9, flex: "none" }}>
                <Stat n={String(stats?.count ?? 0)} label="Invited" color={v2.yellow} />
                <Stat n={stats?.rank ? `#${stats.rank}` : "—"} label="Rank" color="#58c7f4" />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 15 }}>
              <input
                readOnly
                value={link}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Your referral link"
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: "rgba(255,255,255,.02)",
                  border: `1px solid ${v2.line}`,
                  borderRadius: 10,
                  padding: "11px 13px",
                  color: v2.text,
                  fontSize: fs.body,
                  fontFamily: "var(--font-grotesk)",
                  textOverflow: "ellipsis",
                }}
              />
              <button type="button" onClick={copy} style={{ ...accentBtn, padding: "11px 16px", fontSize: fs.body, display: "inline-flex", alignItems: "center", gap: 7, whiteSpace: "nowrap" }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
                {copied ? "Copied" : "Copy"}
              </button>
              <button type="button" onClick={() => share("x")} title="Share on X" aria-label="Share on X" style={iconBtn}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" /></svg>
              </button>
              <button type="button" onClick={() => share("tg")} title="Share on Telegram" aria-label="Share on Telegram" style={iconBtn}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="#58c7f4"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71l-4.14-3.05-1.99 1.93c-.23.23-.42.42-.83.42z" /></svg>
              </button>
            </div>
          </div>

          {/* HOW IT WORKS */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 12 }}>
            {STEPS.map((s) => (
              <div key={s.n} style={{ ...subCard(13), padding: 14 }}>
                <div style={{ width: 22, height: 22, borderRadius: 7, background: "var(--v2-accent-fill)", border: `1px solid var(--v2-accent-line)`, color: v2.yellow, fontFamily: "var(--font-grotesk)", fontWeight: 600, fontSize: 12, display: "grid", placeItems: "center" }}>{s.n}</div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "rgba(255,255,255,.9)", marginTop: 9 }}>{s.t}</div>
                <div style={{ fontSize: 11, color: v2.muted, marginTop: 3, lineHeight: 1.5 }}>{s.d}</div>
              </div>
            ))}
          </div>

          {/* JOINED LIST */}
          <div style={{ ...card, marginTop: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontSize: fs.cardTitle, fontWeight: 600, color: v2.text }}>Joined through your link</div>
              <div style={{ fontSize: fs.micro, color: v2.muted2 }}>{stats?.count ?? 0} total</div>
            </div>
            {!stats || stats.referees.length === 0 ? (
              <div style={{ color: v2.muted, fontSize: fs.label, marginTop: 10 }}>No one yet. Share your link to get started.</div>
            ) : (
              <div style={{ marginTop: 4 }}>
                {stats.referees
                  .slice()
                  .reverse()
                  .map((r, i) => {
                    const isNew = now - r.ts < NEW_WINDOW_MS;
                    return (
                      <div key={`${r.address}-${i}`} style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 0", borderTop: i === 0 ? "none" : `1px solid ${v2.line}` }}>
                        <Avatar address={r.address} />
                        <span style={{ fontFamily: "var(--font-grotesk)", fontSize: 13.5, color: v2.text }}>{shortAddr(r.address)}</span>
                        {isNew && (
                          <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".08em", color: "#55e6a5", background: "rgba(85,230,165,.12)", borderRadius: 5, padding: "2px 7px" }}>NEW</span>
                        )}
                        <span style={{ marginLeft: "auto", textAlign: "right" }}>
                          <span style={{ display: "block", fontSize: 12, color: "rgba(255,255,255,.8)" }}>{fmtDate(r.ts)}</span>
                          <span style={{ fontSize: 10.5, color: v2.muted2 }}>{relTime(r.ts, now)}</span>
                        </span>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
