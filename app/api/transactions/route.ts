import { NextRequest, NextResponse } from "next/server";
import { getRelayedTxs } from "@/app/lib/db";
import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { kv } from "@vercel/kv";

/**
 * GET /api/transactions?address=0x...&nonce=xxx&sig=0x...
 *
 * Returns relayed TX history for the given wallet address. Requires nonce-
 * based EIP-191 proof-of-ownership (nonce from /api/auth/nonce).
 *
 * Phase 1.5 read-side bridge: if this wallet has a wallet_email_link
 * reverse pointer to an email pseudo-account (set on /api/auth/wallet-bind
 * or /api/trial/activate's adopted-email path), this endpoint ALSO loads
 * the pseudo's tx history at `relaytx:email:<sub>:{YYYY-MM}` and merges
 * it into the response. Without this, a wallet-only login would see the
 * trial keys + credits (via /api/keys/provision's same bridge) but the
 * trial-era TX rows would appear missing — confusing half-merge state.
 *
 * The wallet's signed nonce auth here is the *only* gate; we do not
 * require a separate signature from the pseudo because the wallet-bind
 * step that established the bridge already proved the user owns this
 * wallet, and the pseudo is bound 1:1 to the wallet (see §13).
 *
 * Dedup is by relayTxHash — should not happen since pseudo and wallet
 * write into different month lists, but guards against any historical
 * drift where the same tx accidentally landed in both.
 */

const walletEmailLinkKey = (addr: string) => `wallet_email_link:${addr.toLowerCase()}`;
const emailToAddrKey = (email: string) => `email_to_addr:${email.toLowerCase()}`;

export async function GET(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "transactions", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const address   = req.nextUrl.searchParams.get("address");
  const nonce     = req.nextUrl.searchParams.get("nonce");
  const signature = req.nextUrl.searchParams.get("sig");

  const authResult = await requireAuth(address, nonce, signature);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const addr = authResult;

  const ownTxs = await getRelayedTxs(addr);

  // Bridge read: include the bound email pseudo's tx history if any.
  // Same null-return discipline as /api/keys/provision's loadBoundEmailTrial
  // — any missing index entry just degrades to "no bridge", never throws.
  let pseudoTxs: typeof ownTxs = [];
  let bridgedFromPseudo: string | null = null;
  try {
    const linkedEmail = await kv.get<string>(walletEmailLinkKey(addr));
    if (linkedEmail) {
      const pseudoAddr = await kv.get<string>(emailToAddrKey(linkedEmail));
      if (pseudoAddr && pseudoAddr !== addr) {
        pseudoTxs = await getRelayedTxs(pseudoAddr);
        bridgedFromPseudo = pseudoAddr;
      }
    }
  } catch {
    /* bridge load failed — fall through with own txs only */
  }

  // Dedup defence: pseudo and wallet write into different per-address
  // month lists (`relaytx:0xabc:..` vs `relaytx:email:..`), so duplicates
  // shouldn't be possible in theory. Belt-and-suspenders via relayTxHash
  // catches any historical drift if a tx was somehow recorded under both.
  const seen = new Set(ownTxs.map(t => t.relayTxHash?.toLowerCase()));
  const mergedTxs = [
    ...ownTxs,
    ...pseudoTxs.filter(t => {
      const h = t.relayTxHash?.toLowerCase();
      if (!h || seen.has(h)) return false;
      seen.add(h);
      return true;
    }),
  ];

  const now        = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonthCount = mergedTxs.filter(tx => new Date(tx.relayedAt) >= monthStart).length;

  return NextResponse.json({
    txs: mergedTxs,
    thisMonthCount,
    totalCount: mergedTxs.length,
    // Lets the client label tx rows by source if it ever needs to. Today
    // the dashboard's trial-vs-paid filter already routes off tx.apiKey
    // (trial keys go to Trial view, paid keys to Multichain view), so
    // this field is informational.
    bridgedFromPseudo,
  });
}
