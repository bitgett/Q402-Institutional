/**
 * ipfs-pin.ts — minimal Pinata JWT pinning client.
 *
 * Used by the ERC-8004 agent-registration flow to upload the agent's
 * metadata JSON (the file `tokenURI` resolves to) and return an
 * `ipfs://CID` URI ready to pass into `register(agentURI)`.
 *
 * Requires `PINATA_JWT` env (long-lived JWT, scope: pinFileToIPFS +
 * pinJSONToIPFS). Set via Vercel encrypted env.
 *
 * Pinata pricing: free tier 1 GB / 100k pin operations per month.
 * Plenty for agent-registration usage (each pin is ~1 KB JSON).
 */

const PINATA_BASE = "https://api.pinata.cloud";

export type PinResult =
  | { ok: true; cid: string; uri: string; size: number }
  | { ok: false; reason: string };

export interface PinnerConfig {
  jwt?: string;
}

function jwtFromEnv(): string | null {
  return process.env.PINATA_JWT ?? null;
}

/**
 * Pin a JSON object. Returns `ipfs://<CID>` on success — that's the
 * value the user passes to `register(agentURI)` on the IdentityRegistry.
 */
export async function pinJson(
  payload: unknown,
  cfg: PinnerConfig = {},
): Promise<PinResult> {
  const jwt = cfg.jwt ?? jwtFromEnv();
  if (!jwt) {
    return { ok: false, reason: "PINATA_JWT env var not set" };
  }

  let body: string;
  try {
    body = JSON.stringify({
      pinataContent: payload,
      pinataMetadata: { name: "q402-agent-metadata" },
      pinataOptions: { cidVersion: 1 },
    });
  } catch (e) {
    return { ok: false, reason: `serialize: ${e instanceof Error ? e.message : String(e)}` };
  }

  let res: Response;
  try {
    res = await fetch(`${PINATA_BASE}/pinning/pinJSONToIPFS`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body,
    });
  } catch (e) {
    return { ok: false, reason: `transport: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, reason: `pinata ${res.status}: ${text.slice(0, 200)}` };
  }

  const data = (await res.json().catch(() => null)) as
    | { IpfsHash?: string; PinSize?: number }
    | null;
  if (!data?.IpfsHash) {
    return { ok: false, reason: "pinata response missing IpfsHash" };
  }
  return {
    ok: true,
    cid: data.IpfsHash,
    uri: `ipfs://${data.IpfsHash}`,
    size: data.PinSize ?? body.length,
  };
}

/** Quick env-readiness probe used by /api/wallet/agentic/register-agent
 *  to return a clean 503 instead of leaking the env name to the client. */
export function isPinnerReady(): boolean {
  return jwtFromEnv() !== null;
}
