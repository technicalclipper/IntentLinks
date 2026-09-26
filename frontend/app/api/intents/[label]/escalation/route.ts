import { getIntent, setEscalation } from "@/lib/store";

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

/**
 * Mark the ask as answered.
 *
 * Purely the local index catching up with the chain. Clearing it grants
 * nothing and forging it takes nothing away — the Permit either exists as
 * an object owned by the agent or it does not, and execute_elevated
 * consumes it by value either way.
 *
 * Without this the card reappears on refresh and a second approval mints
 * a second permit, which is a real way to hand an agent twice what you
 * meant to.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ label: string }> },
) {
  const { label } = await params;
  const record = getIntent(label);
  if (!record) return Response.json({ error: "not found" }, { status: 404 });
  if (!record.escalation) return Response.json({ ok: true });

  setEscalation(label, { ...record.escalation, approvedAt: Date.now() });
  return Response.json({ ok: true });
}
