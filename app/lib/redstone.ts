/**
 * RedStone signed-feed reader — the off-chain data source for NAV / price
 * triggers and the RedStone-backed conditional-oracle hook.
 *
 * RedStone is a modular oracle: nodes sign price/NAV data packages off-chain and
 * publish them to public gateways. Unlike an on-chain feed we don't need a
 * contract read — we pull a signed package over REST and verify the signer
 * OFF-CHAIN against the data service's authorized signer set. This is exactly
 * the model RedStone RWA/NAV feeds use (equities, commodities, tokenized-fund
 * NAV) and it lets Q402 gate a gasless payout on a NAV update with nothing to
 * deploy.
 *
 * Fail policy — this THROWS on every uncertainty so a settlement path fails
 * CLOSED: feature disabled, feed not allowlisted, gateway unreadable, too few
 * authorized signatures, recovered signer not trusted, package stale, or price
 * out of its sane band. An unverifiable feed must NEVER fire a payout. A short
 * in-memory cache avoids hammering the gateway on a burst of triggers.
 *
 * ENV (all optional except the gate):
 *   REDSTONE_ENABLED=1                 feature gate; unset ⇒ every read throws
 *   REDSTONE_ALLOWED_FEEDS=ETH,BTC     allowlist of feed ids; unset/empty ⇒ nothing readable
 *   REDSTONE_DATA_SERVICE_ID           data service (default redstone-primary-prod)
 *   REDSTONE_UNIQUE_SIGNERS            min authorized signatures required (default 2)
 *   REDSTONE_STALE_AFTER_SEC           max package age in seconds (default 180)
 *   REDSTONE_BAND_<FEED>=min:max       per-feed sanity band, e.g. REDSTONE_BAND_ETH=100:100000
 *   REDSTONE_GATEWAYS=url1,url2         override gateway urls (SDK default used when unset)
 */
import {
  requestDataPackages,
  getSignersForDataServiceId,
} from "@redstone-finance/sdk";

const DEFAULT_DATA_SERVICE_ID = "redstone-primary-prod";
const DEFAULT_UNIQUE_SIGNERS = 2;
const DEFAULT_STALE_AFTER_SEC = 180;
const CACHE_TTL_MS = 45_000;

export class RedStoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedStoneError";
  }
}

/** Feature gate. Off by default — a caller must opt in via REDSTONE_ENABLED. */
export function redstoneEnabled(): boolean {
  return process.env.REDSTONE_ENABLED === "1";
}

function dataServiceId(): string {
  return process.env.REDSTONE_DATA_SERVICE_ID?.trim() || DEFAULT_DATA_SERVICE_ID;
}

function uniqueSignersRequired(): number {
  const raw = Number(process.env.REDSTONE_UNIQUE_SIGNERS);
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_UNIQUE_SIGNERS;
}

function staleAfterSec(): number {
  const raw = Number(process.env.REDSTONE_STALE_AFTER_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_AFTER_SEC;
}

/** Parse REDSTONE_ALLOWED_FEEDS into an uppercased set. Absent ⇒ empty set ⇒
 *  nothing is readable (fail closed by default). */
function allowedFeeds(): Set<string> {
  const raw = process.env.REDSTONE_ALLOWED_FEEDS || "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

/** Per-feed sanity band from REDSTONE_BAND_<FEED>=min:max. No band ⇒ null
 *  (only the universal finite/positive check applies). */
function bandFor(feedId: string): { min: number; max: number } | null {
  const raw = process.env[`REDSTONE_BAND_${feedId.toUpperCase()}`];
  if (!raw) return null;
  const [minS, maxS] = raw.split(":");
  const min = Number(minS);
  const max = Number(maxS);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max <= min) {
    throw new RedStoneError(`invalid REDSTONE_BAND_${feedId}: ${raw}`);
  }
  return { min, max };
}

/** Optional gateway override (comma-separated). Unset ⇒ SDK defaults. */
function gatewayUrls(): string[] | undefined {
  const raw = process.env.REDSTONE_GATEWAYS;
  if (!raw) return undefined;
  const urls = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return urls.length ? urls : undefined;
}

export interface RedStoneReading {
  feedId: string;
  value: number;
  /** Package timestamp (ms since epoch) — the feed's own observation time. */
  timestampMs: number;
  /** Distinct authorized signers whose signatures were verified for this read. */
  signers: string[];
  dataServiceId: string;
}

const cache = new Map<string, { reading: RedStoneReading; at: number }>();

/**
 * Read one RedStone feed's current value, verifying signatures off-chain.
 *
 * Throws (fail closed) when: the feature is disabled, the feed is not
 * allowlisted, the gateway can't serve enough authorized signatures, a recovered
 * signer is not in the trusted set, the package is older than the staleness
 * bound, or the value is out of its sane band. A short cache serves repeat
 * reads of the same feed within CACHE_TTL_MS.
 */
export async function redstonePrice(feedId: string): Promise<RedStoneReading> {
  if (!redstoneEnabled()) {
    throw new RedStoneError("RedStone disabled (set REDSTONE_ENABLED=1)");
  }
  const id = feedId.trim().toUpperCase();
  if (!id) throw new RedStoneError("empty feed id");

  const allow = allowedFeeds();
  if (!allow.has(id)) {
    throw new RedStoneError(`feed not allowlisted: ${id} (set REDSTONE_ALLOWED_FEEDS)`);
  }

  const cached = cache.get(id);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.reading;

  const svc = dataServiceId();
  const minSigners = uniqueSignersRequired();

  // Authorized signer set for this data service (from the SDK's oracle
  // registry). If we can't resolve it we cannot verify — fail closed.
  let authorizedSigners: string[];
  try {
    // The SDK types dataServiceId as a fixed literal union; svc is env-driven
    // (default redstone-primary-prod). A bad env value throws here → caught →
    // fail closed, so the cast is safe.
    authorizedSigners = getSignersForDataServiceId(
      svc as Parameters<typeof getSignersForDataServiceId>[0],
    );
  } catch (e) {
    throw new RedStoneError(`no authorized signers for data service ${svc}: ${String(e)}`);
  }
  if (!authorizedSigners.length) {
    throw new RedStoneError(`empty authorized signer set for ${svc}`);
  }
  if (minSigners > authorizedSigners.length) {
    throw new RedStoneError(
      `REDSTONE_UNIQUE_SIGNERS=${minSigners} exceeds available signers ${authorizedSigners.length} for ${svc}`,
    );
  }

  // requestDataPackages itself enforces authorizedSigners + uniqueSignersCount:
  // it throws if it can't collect that many valid signatures from the trusted
  // set. We still re-verify below (belt and suspenders).
  let packages;
  try {
    packages = await requestDataPackages({
      dataServiceId: svc,
      dataPackagesIds: [id],
      uniqueSignersCount: minSigners,
      authorizedSigners,
      ...(gatewayUrls() ? { urls: gatewayUrls() } : {}),
    });
  } catch (e) {
    // Gateway unreachable / not enough signatures / SDK error — all transient
    // from our side and MUST NOT fire a payout.
    throw new RedStoneError(`RedStone fetch failed for ${id}: ${String(e)}`);
  }

  const signed = packages[id];
  if (!signed || !signed.length) {
    throw new RedStoneError(`no data packages returned for ${id}`);
  }

  const trusted = new Set(authorizedSigners.map((a) => a.toLowerCase()));
  const staleMs = staleAfterSec() * 1000;
  const now = Date.now();

  const seenSigners = new Set<string>();
  const values: number[] = [];
  let newestTs = 0;

  for (const pkg of signed) {
    // Re-recover and re-check the signer ourselves rather than trusting the
    // gateway's assertion.
    let signer: string;
    try {
      signer = pkg.recoverSignerAddress();
    } catch (e) {
      throw new RedStoneError(`signer recovery failed for ${id}: ${String(e)}`);
    }
    if (!trusted.has(signer.toLowerCase())) {
      throw new RedStoneError(`untrusted signer for ${id}: ${signer}`);
    }
    seenSigners.add(signer.toLowerCase());

    const ts = pkg.dataPackage.timestampMilliseconds;
    if (!Number.isFinite(ts) || now - ts > staleMs) {
      throw new RedStoneError(
        `stale package for ${id}: age ${Math.round((now - ts) / 1000)}s > ${staleAfterSec()}s`,
      );
    }
    if (ts > newestTs) newestTs = ts;

    // A package carries one data point for a single-feed request.
    const point = pkg.dataPackage.dataPoints.find(
      (dp) => dp.dataFeedId?.toUpperCase() === id,
    );
    if (!point) {
      throw new RedStoneError(`package missing data point for ${id}`);
    }
    const value = Number(point.toObj().value);
    if (!Number.isFinite(value) || value <= 0) {
      throw new RedStoneError(`non-finite/non-positive value for ${id}: ${value}`);
    }
    values.push(value);
  }

  if (seenSigners.size < minSigners) {
    throw new RedStoneError(
      `only ${seenSigners.size} distinct trusted signers for ${id}, need ${minSigners}`,
    );
  }

  // Median of the per-signer values. With an ODD count (uniqueSigners >= 3) the
  // median is fully robust to one outlier signer; with an EVEN count it's the
  // mean of the two middle values, so at the default minimum of 2 a single bad
  // signer can pull it halfway. The per-feed band (below) is the backstop, and
  // production docs recommend REDSTONE_UNIQUE_SIGNERS >= 3 for true single-
  // outlier robustness. See docs/redstone-triggers.md.
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const value =
    values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;

  const band = bandFor(id);
  if (band && (value < band.min || value > band.max)) {
    throw new RedStoneError(
      `value out of band for ${id}: ${value} not in [${band.min}, ${band.max}]`,
    );
  }

  const reading: RedStoneReading = {
    feedId: id,
    value,
    timestampMs: newestTs,
    signers: [...seenSigners],
    dataServiceId: svc,
  };
  cache.set(id, { reading, at: now });
  return reading;
}

/** Discovery helper for the (future) MCP feeds tool + docs: what is readable
 *  right now, given the current env. Never throws. */
export function redstoneConfig(): {
  enabled: boolean;
  dataServiceId: string;
  allowedFeeds: string[];
  uniqueSigners: number;
  staleAfterSec: number;
} {
  return {
    enabled: redstoneEnabled(),
    dataServiceId: dataServiceId(),
    allowedFeeds: [...allowedFeeds()],
    uniqueSigners: uniqueSignersRequired(),
    staleAfterSec: staleAfterSec(),
  };
}

/** Clears the in-memory cache. Test seam + a safety hatch for config flips. */
export function __clearRedstoneCache(): void {
  cache.clear();
}

/** Test seam — pure config parsing, no network. */
export const __test = { allowedFeeds, bandFor, uniqueSignersRequired, staleAfterSec };
