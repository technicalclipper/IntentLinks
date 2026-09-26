import type { IDKitResult } from "@worldcoin/idkit-core";
import { hashSignal } from "@worldcoin/idkit-core";

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
const RP_ID = process.env.WORLD_RP_ID;
const ACTION = process.env.NEXT_PUBLIC_WORLD_ACTION_IDENTITY ?? "intentlink-identity";

/**
 * World ID 4.0 verification is keyed by **RP id**, not app id, and lives on
 * developer.world.org rather than the old developer.worldcoin.org.
 *
 * The v2 endpoint exists, accepts an app id, and answers "Action not found"
 * for actions that plainly do exist — because v4 actions live against the
 * RP, which v2 knows nothing about. That sends you looking at the portal
 * instead of at the URL.
 */
const VERIFY_URL = `https://developer.world.org/api/v4/verify/${RP_ID}`;

export interface WorldVerification {
  ok: boolean;
  /** RP-scoped, stable per human. The same person always yields the same one. */
  nullifier?: string;
  credential?: string;
  protocolVersion?: string;
  /** Present on session proofs; the handle a later proof binds to. */
  sessionId?: string;
  isSession?: boolean;
  error?: string;
}

interface ResponseItem {
  identifier: string;
  /** v3 hands back one hex string; v4 an array. */
  proof: string | string[];
  merkle_root?: string;
  /** Uniqueness proofs. Scoped to (human, app, action). */
  nullifier?: string;
  /**
   * Session proofs. [0] is the session nullifier — stable for one human
   * across every proof in the session — and [1] the generated action.
   */
  session_nullifier?: string[];
  signal_hash?: string;
}

/**
 * The verify endpoint speaks v3. A legacy credential identifier maps onto
 * the verification level it expects.
 */
function verificationLevel(identifier: string): string {
  const id = identifier.toLowerCase();
  if (id.includes("orb")) return "orb";
  if (id.includes("document") || id.includes("passport")) return "document";
  return "device";
}

/**
 * Check a proof with World.
 *
 * IDKit returns a wrapper — protocol version, nonce, action, and an array of
 * credential responses — while the verify endpoint wants a flat v3 payload
 * with `nullifier_hash`, `merkle_root`, `proof` and `verification_level`.
 * Forwarding the wrapper as-is gets "this attribute is required", which
 * sounds like a configuration problem rather than a shape mismatch.
 *
 * `expectSignal` welds an approval to one exact request — for escalation
 * that is hash(capsule, amount, nonce), so a "yes" to 26 cannot be replayed
 * as a "yes" to 260.
 *
 * The comparison has to be hash against hash. World returns `signal_hash`,
 * the hashed form, while we hold the plaintext signal — so the plaintext
 * never equals it and checking directly rejects every genuine approval.
 * hashSignal is the same function the widget applied on the way in.
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
    responses?: ResponseItem[];
  };

  console.log("[world] result", {
    protocol_version: r.protocol_version,
    action: r.action,
    responses: r.responses?.map((x) => ({
      identifier: x.identifier,
      proofType: Array.isArray(x.proof) ? `array(${x.proof.length})` : "string",
      hasMerkleRoot: Boolean(x.merkle_root),
      hasSignal: Boolean(x.signal_hash),
    })),
  });

  // The action is signed into the RP context, so a proof produced for one
  // action cannot stand in for another.
  const isSession = Boolean(r.responses?.[0]?.session_nullifier);
  if (!isSession && r.action && r.action !== action) {
    return { ok: false, error: `proof is for action "${r.action}", not "${action}"` };
  }

  const credential = r.responses?.[0];
  if (!credential) {
    return { ok: false, error: "proof contains no credential response" };
  }

  /*
   * A session proof carries `session_nullifier`, a uniqueness proof
   * `nullifier`. Only the session one is comparable across two separate
   * verifications by the same person, which is the entire reason to
   * prefer it — see approve_escalation.
   */
  const nullifier = credential.session_nullifier?.[0] ?? credential.nullifier;
  if (!nullifier) {
    return { ok: false, error: "proof carries no nullifier" };
  }

  if (opts.expectSignal) {
    /*
     * Accept either encoding of the same signal.
     *
     * The legacy (v3) presets and the v4 path do not hash identically, and
     * which one applies depends on the credential the phone chose — so
     * pinning a single form would reject genuine approvals depending on
     * how the person verified. Both candidates are derived from our own
     * plaintext, so this still binds the approval to this exact request:
     * a proof carrying any other signal matches neither.
     */
    const norm = (h: string) => h.toLowerCase().replace(/^0x/, "");
    const got = norm(credential.signal_hash ?? "");
    const accepted = [hashSignal(opts.expectSignal), opts.expectSignal].map(norm);

    if (!got || !accepted.includes(got)) {
      console.log("[world] signal mismatch", { got, accepted });
      return { ok: false, error: "this approval was issued for a different request" };
    }
  }

  // v4 takes the result whole — protocol version, nonce, action and the
  // credential responses. The flattening this used to do was for the v2
  // endpoint, which speaks a different dialect.
  const res = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(isSession ? r : { ...r, action }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    code?: string;
    detail?: string;
    attribute?: string;
  };

  if (!res.ok || body.success === false) {
    console.log("[world] verify rejected", res.status, body);
    return {
      ok: false,
      error:
        [body.detail, body.attribute && `(${body.attribute})`].filter(Boolean).join(" ") ||
        body.code ||
        `World rejected the proof (${res.status})`,
    };
  }

  return {
    ok: true,
    nullifier,
    credential: credential.identifier,
    protocolVersion: r.protocol_version,
    sessionId: (r as { session_id?: string }).session_id,
    isSession: Boolean(credential.session_nullifier),
  };
}

/** Bind an escalation approval to one exact request. */
export function escalationSignal(capsuleId: string, amount: string, nonce: string): string {
  return `${capsuleId}:${amount}:${nonce}`;
}
