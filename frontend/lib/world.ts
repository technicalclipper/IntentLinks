import type { IDKitResult } from "@worldcoin/idkit-core";

/**
 * World ID, server side.
 *
 * Proofs are checked here and only here. Verifying in the browser would be
 * verifying nothing — the client could simply report that it passed.
 *
 * Two trust moments in this product, and it is worth being precise about
 * which is which:
 *
 *   redemption  — one link, one human. Stops a forwarded link being claimed
 *                 repeatedly by one person with many Google accounts. Google
 *                 proves *which* account, never *how many people*.
 *
 *   escalation  — the agent cannot approve its own privilege escalation. It
 *                 needs a fresh proof that the human who set the limit is
 *                 present. This is the one that is genuinely load-bearing:
 *                 every other approval mechanism is a bearer credential, and
 *                 a bearer credential can be handed to the very agent you
 *                 are trying to constrain.
 *
 * IDKit v4 is protocol-level rather than widget-level. Requests are signed
 * by the relying party (see /api/world/request), and results carry an array
 * of credential responses with RP-scoped nullifiers instead of the single
 * nullifier_hash of v3.
 */

const APP_ID = process.env.NEXT_PUBLIC_WORLD_APP_ID;
const ACTION = process.env.NEXT_PUBLIC_WORLD_ACTION_IDENTITY ?? "intentlink-identity";
const VERIFY_URL = "https://developer.worldcoin.org/api/v2/verify";

export interface WorldVerification {
  ok: boolean;
  /** RP-scoped, stable per human. The same person always yields the same one. */
  nullifier?: string;
  credential?: string;
  protocolVersion?: string;
  error?: string;
}

interface V4Response {
  identifier: string;
  nullifier: string;
  proof: string[];
  signal_hash?: string;
  issuer_schema_id?: number;
}

/**
 * Check a proof with World.
 *
 * `expectSignal` welds an approval to one exact request — for escalation
 * that is hash(capsule, amount, nonce), so a "yes" to 26 cannot be replayed
 * as a "yes" to 260.
 */
export async function verifyWorldProof(
  result: IDKitResult,
  opts: { action?: string; expectSignal?: string } = {},
): Promise<WorldVerification> {
  if (!APP_ID) return { ok: false, error: "NEXT_PUBLIC_WORLD_APP_ID is not set" };

  const action = opts.action ?? ACTION;
  const r = result as unknown as {
    protocol_version?: string;
    action?: string;
    nonce?: string;
    responses?: V4Response[];
  };

  // The action is signed into the RP context, so a proof produced for one
  // action cannot stand in for another.
  if (r.action && r.action !== action) {
    return { ok: false, error: `proof is for action "${r.action}", not "${action}"` };
  }

  const credential = r.responses?.[0];
  if (!credential?.nullifier) {
    return { ok: false, error: "proof contains no credential response" };
  }

  if (opts.expectSignal && credential.signal_hash !== opts.expectSignal) {
    return {
      ok: false,
      error: "this approval was issued for a different request",
    };
  }

  const res = await fetch(`${VERIFY_URL}/${APP_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...r, action }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    code?: string;
    detail?: string;
  };

  if (!res.ok || body.success === false) {
    return {
      ok: false,
      error: body.detail ?? body.code ?? `World rejected the proof (${res.status})`,
    };
  }

  return {
    ok: true,
    nullifier: credential.nullifier,
    credential: credential.identifier,
    protocolVersion: r.protocol_version,
  };
}

/** Bind an escalation approval to one exact request. */
export function escalationSignal(capsuleId: string, amount: string, nonce: string): string {
  return `${capsuleId}:${amount}:${nonce}`;
}
