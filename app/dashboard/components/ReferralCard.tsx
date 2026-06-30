"use client";

import { useEffect, useState } from "react";
import { getAuthCreds } from "@/app/lib/auth-client";
import { v2, subCard, fs } from "../v2/theme";

interface ReferralStats {
  code: string;
  count: number;
  referees: { address: string; ts: number }[];
}

/**
 * Referral card — the owner's invite link + how many new users joined through
 * it. Reads /api/referral/stats with the cached session sig (no popup if a
 * session already exists). Counting happens server-side when a referee creates
 * their FIRST Agent Wallet; this card just displays the running total.
 */
export function ReferralCard({
  ownerAddress,
  signMessage,
}: {
  ownerAddress: string;
  signMessage: (message: string) => Promise<string | null>;
}) {
  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const creds = await getAuthCreds(ownerAddress, signMessage);
        if (!creds || cancelled) return;
        const qs = new URLSearchParams({ address: ownerAddress, nonce: creds.nonce, sig: creds.signature });
        const res = await fetch(`/api/referral/stats?${qs.toString()}`);
        if (!res.ok) {
          if (!cancelled) setErr("Couldn't load your referrals.");
          return;
        }
        const data = (await res.json()) as ReferralStats;
        if (!cancelled) setStats(data);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerAddress, signMessage]);

  const origin = typeof window !== "undefined" ? window.location.origin : "https://q402.quackai.ai";
  // No code until the owner has a wallet (server returns code:"" then) → no link.
  const link = stats?.code ? `${origin}/?ref=${stats.code}` : "";

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

  return (
    <div style={{ ...subCard(13), padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontSize: fs.cardTitle, fontWeight: 600, color: v2.text }}>Invite</div>
        <div style={{ fontFamily: "var(--font-grotesk)", fontSize: fs.title, fontWeight: 600, color: v2.yellow, lineHeight: 1 }}>
          {stats ? stats.count : "—"}
          <span style={{ fontSize: fs.label, color: v2.muted, fontWeight: 400 }}> joined</span>
        </div>
      </div>
      <div style={{ color: v2.muted, fontSize: fs.label, marginTop: 4, lineHeight: 1.5 }}>
        Share your link. When someone creates their first Agent Wallet through it, it counts here.
      </div>
      <div style={{ display: "flex", gap: 7, marginTop: 11 }}>
        <input
          readOnly
          value={link || "Loading your link…"}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Your referral link"
          style={{
            flex: 1,
            minWidth: 0,
            background: "rgba(255,255,255,.02)",
            border: `1px solid ${v2.line}`,
            borderRadius: 8,
            padding: "8px 10px",
            color: v2.text,
            fontSize: fs.label,
            fontFamily: "var(--font-grotesk)",
            textOverflow: "ellipsis",
          }}
        />
        <button
          type="button"
          onClick={copy}
          disabled={!link}
          style={{
            border: `1px solid var(--v2-accent-line)`,
            background: "var(--v2-accent-fill)",
            color: v2.yellow,
            borderRadius: 8,
            padding: "8px 16px",
            fontSize: fs.label,
            fontWeight: 600,
            cursor: link ? "pointer" : "not-allowed",
            opacity: link ? 1 : 0.5,
            whiteSpace: "nowrap",
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {err && <div style={{ color: v2.muted2, fontSize: fs.micro, marginTop: 6 }}>{err}</div>}
    </div>
  );
}
