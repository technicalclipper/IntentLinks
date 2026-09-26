import { getIntent } from "@/lib/store";

/**
 * The agent's outstanding ask, for the issuer's page to render.
 *
 * Read-only and unauthenticated on purpose: it reveals nothing the chain
 * does not already publish as an `EscalationRequested` event. Nothing here
 * grants anything — `approve_escalation` asserts the sender is the
 * capsule's issuer, so knowing about a request is not being able to act
 * on one.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ label: string }> },
) {
  const { label } = await params;
  const record = getIntent(label);
  if (!record) return Response.json({ error: "not found" }, { status: 404 });

  const e = record.escalation;
  if (!e || e.approvedAt) {
    return Response.json({ pending: null, worldSessionId: record.worldSessionId ?? null });
  }

  return Response.json({
    // Proving under the session the issuer used at mint is what makes the
    // returned nullifier comparable to the one on the capsule.
    worldSessionId: record.worldSessionId ?? null,
    pending: {
      amount: e.amount,
      reason: e.reason,
      nonce: e.nonce,
      signalHash: e.signalHash,
      requestedAt: e.requestedAt,
    },
  });
}
