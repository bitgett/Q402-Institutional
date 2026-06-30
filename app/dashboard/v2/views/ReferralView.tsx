"use client";

import { useEffect, useState } from "react";
import { getAuthCreds } from "@/app/lib/auth-client";
import { v2, subCard, fs, type V2ViewId, type Scope } from "../theme";
import { SectionHead, shortAddr } from "../primitives";

interface ReferralStats {
  code: string;
  count: number;
  referees: { address: string; ts: number }[];
  needsWallet?: boolean;
}

function fmtDate(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

/**
 * Referral view (top-level dashboard tab). The owner's invite link + how many
 * new users joined through it + the referee list. Reads /api/referral/stats with
 * the cached session sig. A referral link requires the owner to have created an
 * Agent Wallet (server returns an empty code otherwise) → that case shows a
 * create-a-wallet prompt instead of a link.
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

  const accentBtn = {
    border: `1px solid var(--v2-accent-line)`,
    background: "var(--v2-accent-fill)",
    color: v2.yellow,
    borderRadius: 9,
    fontWeight: 600,
    cursor: "pointer",
  } as const;

  return (
    // Cap the width (the referral surface is light — a link + a list — so the
    // shell's 1500px would stretch it) and add top breathing room since this view
    // starts with a bare SectionHead right under the nav.
    <div style={{ maxWidth: 720, marginTop: 14 }}>
      <SectionHead title="Referral" meta="Invite builders to Q402" />

      {!ownerAddress ? (
        <div style={{ ...subCard(13), padding: 18, color: v2.muted, fontSize: fs.body }}>Connect your wallet to see your referrals.</div>
      ) : loading ? (
        <div style={{ ...subCard(13), padding: 18, color: v2.muted, fontSize: fs.body }}>Loading your referrals…</div>
      ) : err ? (
        <div style={{ ...subCard(13), padding: 18, color: v2.muted2, fontSize: fs.label }}>{err}</div>
      ) : needsWallet ? (
        <div style={{ ...subCard(13), padding: 18 }}>
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
          {/* Invite card — link + running count. */}
          <div style={{ ...subCard(13), padding: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: fs.cardTitle, fontWeight: 600, color: v2.text }}>Your invite link</div>
                <div style={{ color: v2.muted, fontSize: fs.label, marginTop: 4, lineHeight: 1.55, maxWidth: 460 }}>
                  Share it. When someone creates their first Agent Wallet through your link, it counts below.
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontFamily: "var(--font-grotesk)", fontSize: fs.h2, fontWeight: 600, color: v2.yellow, lineHeight: 1, letterSpacing: "-.03em" }}>
                  {stats?.count ?? 0}
                </div>
                <div style={{ color: v2.muted, fontSize: fs.micro, marginTop: 3 }}>joined</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
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
                  borderRadius: 9,
                  padding: "10px 12px",
                  color: v2.text,
                  fontSize: fs.body,
                  fontFamily: "var(--font-grotesk)",
                  textOverflow: "ellipsis",
                }}
              />
              <button type="button" onClick={copy} style={{ ...accentBtn, padding: "10px 20px", fontSize: fs.body, whiteSpace: "nowrap" }}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          {/* Referee list. */}
          <div style={{ ...subCard(13), padding: 18, marginTop: 13 }}>
            <div style={{ fontSize: fs.cardTitle, fontWeight: 600, color: v2.text }}>Joined through your link</div>
            {!stats || stats.referees.length === 0 ? (
              <div style={{ color: v2.muted, fontSize: fs.label, marginTop: 10 }}>No one yet. Share your link to get started.</div>
            ) : (
              <div style={{ marginTop: 8 }}>
                {stats.referees
                  .slice()
                  .reverse()
                  .map((r, i) => (
                    <div
                      key={`${r.address}-${i}`}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "9px 0",
                        borderTop: i === 0 ? "none" : `1px solid ${v2.line}`,
                      }}
                    >
                      <span style={{ fontFamily: "var(--font-grotesk)", fontSize: fs.body, color: v2.text }}>{shortAddr(r.address)}</span>
                      <span style={{ color: v2.muted, fontSize: fs.label }}>{fmtDate(r.ts)}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
