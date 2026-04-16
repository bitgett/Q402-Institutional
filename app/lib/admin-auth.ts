import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of a request's `x-admin-secret` header against
 * `process.env.ADMIN_SECRET`.
 *
 * Returns false when:
 *   - ADMIN_SECRET env var is unset or empty (fail-closed — never accept a
 *     missing-env "match")
 *   - the header is missing or empty
 *   - the provided secret differs from the expected value
 *
 * Previously each admin endpoint re-implemented this with `===`, which is
 * short-circuiting byte-compare at the V8 layer. When the endpoint lacks a
 * strict rate limit (/api/keys/generate, /topup, /gas-tank/withdraw all do)
 * an attacker can in principle probe length and byte-prefix timing. The
 * difference is microseconds over network — not a practical exploit in the
 * current threat model — but timing-safe compare is cheap and closes the
 * class of issue so nobody has to audit each admin route separately.
 */
export function checkAdminSecret(req: NextRequest): boolean {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) return false;

  const got = req.headers.get("x-admin-secret");
  if (!got) return false;

  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
