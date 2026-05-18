import { NextRequest, NextResponse } from "next/server";
import { getSubscription, setSubscription, generateSandboxKey, getQuotaCredits } from "@/app/lib/db";
import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { isOwnerWallet } from "@/app/lib/owners";
import { kv } from "@vercel/kv";
import { TRIAL_CREDITS } from "@/app/lib/feature-flags";

const walletEmailLinkKey = (addr: string) => `wallet_email_link:${addr.toLowerCase()}`;
const emailToAddrKey = (email: string) => `email_to_addr:${email.toLowerCase()}`;

/**
 * Read-side bridge — load the email pseudo-account that is bridged to this
 * wallet (if any) so the dashboard can surface its trial credits + keys
 * even on a wallet-only login (no q402_sid cookie). Returns null when:
 *   - no wallet_email_link index entry (most wallets)
 *   - the link points at an email with no email_to_addr entry (rare drift)
 *   - the pseudo subscription is gone (manually wiped, Phase 2 migrated)
 *
 * This is read-only. The pseudo record stays where it is — Phase 2 (the
 * real migration) is what eventually consolidates them.
 */
async function loadBoundEmailTrial(addr: string): Promise<
  | null
  | {
      email: string;
      pseudoAddr: string;
      apiKey: string | null;
      sandboxApiKey: string | null;
      credits: number;
      totalCredits: number;
      trialExpiresAt: string | null;
    }
> {
  const linkedEmail = await kv.get<string>(walletEmailLinkKey(addr));
  if (!linkedEmail) return null;
  const pseudoAddr = await kv.get<string>(emailToAddrKey(linkedEmail));
  if (!pseudoAddr) return null;
  const pseudoSub = await getSubscription(pseudoAddr);
  if (!pseudoSub) return null;
  // Only bridge the trial state — if the pseudo has been wiped or its
  // trialExpiresAt is gone, return null so the dashboard's Trial view
  // falls back to "no active trial" cleanly.
  const trialApiKey = pseudoSub.trialApiKey ?? pseudoSub.apiKey ?? null;
  const trialSandboxApiKey = pseudoSub.trialSandboxApiKey ?? pseudoSub.sandboxApiKey ?? null;
  if (!trialApiKey && !trialSandboxApiKey) return null;
  const credits = await getQuotaCredits(pseudoAddr);
  return {
    email: linkedEmail,
    pseudoAddr,
    apiKey: trialApiKey || null,
    sandboxApiKey: trialSandboxApiKey || null,
    credits,
    totalCredits: TRIAL_CREDITS,
    trialExpiresAt: pseudoSub.trialExpiresAt ?? null,
  };
}

/**
 * POST /api/keys/provision
 *
 * Returns the API keys for the caller's wallet address, creating them if needed.
 * Requires nonce-based EIP-191 proof-of-ownership to prevent address spoofing.
 *
 * Body: { address, nonce, signature }
 *   signature = personal_sign(
 *     "Q402 Auth\nAddress: {addr}\nNonce: {nonce}",
 *     address
 *   )
 *   nonce obtained from GET /api/auth/nonce?address={addr}
 *
 * NEW accounts receive a sandbox key only.
 * Live API key is issued only after on-chain payment via /api/payment/activate.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "provision", 10, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { address?: string; nonce?: string; signature?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const authResult = await requireAuth(body.address, body.nonce, body.signature);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const addr = authResult;

  // ── Existing account ──────────────────────────────────────────────────────
  const existing = await getSubscription(addr);
  if (existing) {
    // Ensure sandbox key exists (may be missing on very old accounts).
    // We provision the paid-side sandbox key here — trial sandbox keys are
    // minted by the trial-activation paths, not retroactively.
    if (!existing.sandboxApiKey) {
      const sandboxApiKey = await generateSandboxKey(addr, existing.plan);
      await setSubscription(addr, { ...existing, sandboxApiKey });
      existing.sandboxApiKey = sandboxApiKey;
    }

    // Trial scope: live whenever trialExpiresAt is in the future, regardless
    // of whether the user has also paid. A user mid-trial who pays gets BOTH
    // keys back so the dashboard can show them side-by-side until the trial
    // expires. Legacy accounts that only have `apiKey`/`sandboxApiKey` set
    // (pre-migration) fall back through to those slots.
    const isTrialActive =
      existing.plan === "trial" &&
      !!existing.trialExpiresAt &&
      new Date(existing.trialExpiresAt) > new Date();
    const trialApiKey = existing.trialApiKey
      ?? (isTrialActive ? existing.apiKey : "")
      ?? "";
    const trialSandboxApiKey = existing.trialSandboxApiKey
      ?? (isTrialActive ? existing.sandboxApiKey : "")
      ?? "";
    const paidApiKey =
      (existing.amountUSD ?? 0) > 0
        ? existing.apiKey || ""
        : "";

    // hasPaid means "paid plan active" — independent of trial. The dashboard
    // uses this to decide whether the Multichain card shows the unlocked
    // state or the Locked placeholder.
    const isPaid = (existing.amountUSD ?? 0) > 0 && !!paidApiKey;

    // Read-side bridge to the email pseudo-account, if one is linked.
    // The wallet keeps its own subscription record AND the pseudo keeps
    // its own — provision just unions the pseudo's trial state into the
    // response so a wallet-only login can render the Trial view that
    // would otherwise be invisible (the pseudo's quota counter sits at
    // `quota:email:<sub>`, not `quota:{wallet}`).
    const boundEmailTrial = !trialApiKey ? await loadBoundEmailTrial(addr) : null;

    return NextResponse.json({
      // Legacy field — prefers paid key, then own trial key, then the
      // bridged trial key (for wallet-only logins of bound users).
      apiKey:             paidApiKey
                            || (isTrialActive ? trialApiKey : null)
                            || boundEmailTrial?.apiKey
                            || null,
      sandboxApiKey:      existing.sandboxApiKey || boundEmailTrial?.sandboxApiKey || null,
      trialApiKey:        trialApiKey || boundEmailTrial?.apiKey || null,
      trialSandboxApiKey: trialSandboxApiKey || boundEmailTrial?.sandboxApiKey || null,
      isTrialActive:      isTrialActive || !!(boundEmailTrial && boundEmailTrial.trialExpiresAt
                            && new Date(boundEmailTrial.trialExpiresAt) > new Date()),
      // Explicit bound-email-trial surface so the dashboard can label the
      // source ("Trial data from your email account user@x.com") and
      // include the bridged keys in tx-history filtering.
      boundEmailTrial:    boundEmailTrial
        ? {
            email: boundEmailTrial.email,
            credits: boundEmailTrial.credits,
            totalCredits: boundEmailTrial.totalCredits,
            trialExpiresAt: boundEmailTrial.trialExpiresAt,
          }
        : null,
      plan:               existing.plan,
      hasPaid:            isPaid,
      isOwner:            isOwnerWallet(addr),
      quotaBonus:         existing.quotaBonus ?? 0,
      paidAt:             existing.paidAt,
      isNew:              false,
    });
  }

  // ── New account — sandbox key only ────────────────────────────────────────
  // Live key is issued only after a verified on-chain payment (activate route).
  // amountUSD: 0 → hasPaid: false → relay credit check blocks live relay.
  // paidAt: ""  → expiry check skipped for this account.
  const sandboxApiKey = await generateSandboxKey(addr, "starter");
  await setSubscription(addr, {
    paidAt:       "",
    apiKey:       "",        // no live key until payment
    sandboxApiKey,
    plan:         "starter",
    txHash:       "provisioned",
    amountUSD:    0,
  });

  // Brand-new wallet sub, but the wallet itself may already be bound to
  // an email pseudo via /api/auth/wallet-bind (the bind writes the
  // wallet_email_link index before this wallet ever calls provision).
  // Bridge the pseudo's trial state in so a wallet-only login of a
  // bound user can immediately see their existing trial credits.
  const boundEmailTrial = await loadBoundEmailTrial(addr);

  return NextResponse.json({
    apiKey:             boundEmailTrial?.apiKey ?? null,
    sandboxApiKey:      sandboxApiKey,
    trialApiKey:        boundEmailTrial?.apiKey ?? null,
    trialSandboxApiKey: boundEmailTrial?.sandboxApiKey ?? null,
    isTrialActive:      !!(boundEmailTrial && boundEmailTrial.trialExpiresAt
                          && new Date(boundEmailTrial.trialExpiresAt) > new Date()),
    boundEmailTrial:    boundEmailTrial
      ? {
          email: boundEmailTrial.email,
          credits: boundEmailTrial.credits,
          totalCredits: boundEmailTrial.totalCredits,
          trialExpiresAt: boundEmailTrial.trialExpiresAt,
        }
      : null,
    plan:               "starter",
    hasPaid:            false,
    isOwner:            isOwnerWallet(addr),
    isNew:              true,
    quotaBonus:         0,
    paidAt:             "",
  });
}
