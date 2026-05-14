/**
 * google-auth.ts — verify Google ID tokens issued by the
 * "Continue with Google" button on the Hero page.
 *
 * No library dependency: we use Google's public `tokeninfo` endpoint, which
 * verifies the JWT signature against Google's rotating JWKS and returns the
 * parsed payload over HTTPS. The trade-off versus local JWT verification:
 *
 *   tokeninfo (this file)     local verification (jose / jsonwebtoken)
 *   ──────────────────────    ──────────────────────────────────────
 *   one HTTPS call per login  zero network calls per login
 *   no library to pin/audit   pulls a JWT library
 *   ~50ms server latency      ~1ms after JWKS cache
 *
 * For our scale (early-stage product, login is a once-per-session event)
 * the latency cost is invisible to the user and the zero-dep posture is
 * worth more than the milliseconds saved. If login traffic ever justifies
 * it, we swap to JWKS-cached verification without changing callers.
 *
 * The endpoint returns 200 + parsed claims on a valid token, 4xx on
 * invalid/expired. We additionally verify:
 *   - `aud` matches our GOOGLE_CLIENT_ID (rejects tokens issued to a
 *     different OAuth client — replay across apps)
 *   - `iss` is accounts.google.com or https://accounts.google.com
 *   - `email_verified` is true (Google has confirmed the user owns the
 *     mailbox — without this we'd accept unverified Gmail accounts)
 */

const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";

export interface GoogleIdentity {
  /** Google's stable user id (sub claim) — never changes for a given user. */
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

export type VerifyResult =
  | { ok: true; identity: GoogleIdentity }
  | { ok: false; error: string };

/**
 * Verify a Google ID token end-to-end. Returns { ok: false } for any
 * verification failure — caller maps the error to an HTTP response.
 *
 * Never throws on network/Google issues; the function is intentionally
 * fail-closed so a tokeninfo outage rejects the login (better UX than a
 * 500) and any retry is the user's choice.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<VerifyResult> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return { ok: false, error: "Google sign-in is not configured" };
  }
  if (typeof idToken !== "string" || idToken.length < 32 || idToken.length > 4096) {
    return { ok: false, error: "Malformed id_token" };
  }

  let resp: Response;
  try {
    resp = await fetch(
      `${TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`,
      { signal: AbortSignal.timeout(5000) },
    );
  } catch {
    return { ok: false, error: "Google verification unreachable" };
  }
  if (!resp.ok) {
    return { ok: false, error: "Token rejected by Google" };
  }

  let payload: {
    aud?: string;
    iss?: string;
    sub?: string;
    email?: string;
    email_verified?: string | boolean;
    name?: string;
    picture?: string;
    exp?: string | number;
  };
  try {
    payload = await resp.json();
  } catch {
    return { ok: false, error: "Invalid tokeninfo payload" };
  }

  if (payload.aud !== clientId) {
    return { ok: false, error: "Token audience does not match this app" };
  }
  if (
    payload.iss !== "accounts.google.com" &&
    payload.iss !== "https://accounts.google.com"
  ) {
    return { ok: false, error: "Token issuer is not Google" };
  }
  // tokeninfo returns "true" as a string for verified mailboxes — accept both
  // forms so a Google response shape change doesn't quietly block sign-in.
  const verified =
    payload.email_verified === true || payload.email_verified === "true";
  if (!verified) {
    return { ok: false, error: "Google account email is not verified" };
  }
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
    return { ok: false, error: "Token payload is missing sub or email" };
  }
  if (payload.exp !== undefined) {
    const exp = typeof payload.exp === "string" ? parseInt(payload.exp, 10) : payload.exp;
    if (Number.isFinite(exp) && exp * 1000 < Date.now()) {
      return { ok: false, error: "Token has expired" };
    }
  }

  return {
    ok: true,
    identity: {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: verified,
      name: payload.name,
      picture: payload.picture,
    },
  };
}
