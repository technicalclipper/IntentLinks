import { signRequest } from "@worldcoin/idkit-core/signing";

/**
 * Sign a World ID v4 proof request.
 *
 * IDKit v4 is protocol-level: the relying party signs a nonce with its
 * registered key, and World App will only produce a proof for a request that
 * carries a valid RP signature. Our signing key never leaves the server,
 * which is the point — otherwise anyone could mint requests in our name.
 *
 * The signature also binds the `action`, so a proof produced for redemption
 * cannot be replayed as an escalation approval.
 */
export async function POST(request: Request) {
  try {
    const key = process.env.WORLD_PRIVATE_KEY;
    const rpId = process.env.WORLD_RP_ID;
    if (!key || !rpId) {
      return Response.json(
        { error: "WORLD_PRIVATE_KEY and WORLD_RP_ID must be set" },
        { status: 500 },
      );
    }

    const { action } = (await request.json().catch(() => ({}))) as { action?: string };
    const resolved =
      action ?? process.env.NEXT_PUBLIC_WORLD_ACTION_IDENTITY ?? "intentlink-identity";

    const { sig, nonce, createdAt, expiresAt } = signRequest({
      signingKeyHex: key,
      action: resolved,
      ttl: 300,
    });

    return Response.json({
      action: resolved,
      rp_context: {
        rp_id: rpId,
        nonce,
        created_at: createdAt,
        expires_at: expiresAt,
        signature: sig,
      },
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
