import type { IDKitResult } from "@worldcoin/idkit-core";
import { verifyWorldProof } from "@/lib/world";

/**
 * Verify a World proof and hand back the nullifier.
 *
 * Used at mint, where the issuer proves personhood and we record their
 * nullifier on the capsule. That recording is the whole point: at escalation
 * we compare a fresh proof against it, so the guarantee is not "a human
 * approved" but "the same human who wrote this limit approved".
 *
 * Verification happens here rather than in the browser for the obvious
 * reason — a client asserting it passed is not evidence of anything.
 */
export async function POST(request: Request) {
  try {
    const { proof, action, signal } = (await request.json()) as {
      proof?: IDKitResult;
      action?: string;
      signal?: string;
    };
    if (!proof) return Response.json({ error: "proof is required" }, { status: 400 });

    const result = await verifyWorldProof(proof, { action, expectSignal: signal });
    if (!result.ok) return Response.json({ error: result.error }, { status: 403 });

    return Response.json({
      nullifier: result.nullifier,
      credential: result.credential,
      protocolVersion: result.protocolVersion,
      // The session handle, so a later proof can bind to the same session
      // and yield the same nullifier.
      sessionId: result.sessionId ?? null,
      isSession: Boolean(result.isSession),
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
