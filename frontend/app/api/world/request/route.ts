import { signRequest } from "@worldcoin/idkit-core/signing";

/**
 * Sign a World ID proof request.
 *
 * Two things happen here.
 *
 * IDKit v4 is protocol-level: World App only produces a proof for a request
 * carrying a valid RP signature, so the nonce is signed with our registered
 * key. That key never leaves the server, or anyone could mint requests in
 * our name. The action is signed in too, so a proof made for redemption
 * cannot be replayed as an escalation approval.
 *
 * And the action itself is created on demand. Portal actions allow one
 * verification per human with no way to change it through the API, so a
 * fixed action name means each person can create exactly one intent and
 * redeem exactly one link — after which everything answers "you have already
 * verified for this action" and looks like a bug in us.
 *
 * Minting a fresh action per verification sidesteps that. Uniqueness is not
 * what we wanted from World anyway: one-link-one-human is already enforced
 * on chain by assert!(holder.is_none()). What we want is "a unique human",
 * and that is what the nullifier gives us regardless of which action it was
 * scoped to.
 */

const WORLD_MCP = "https://developer.world.org/api/mcp";

async function createAction(action: string, description: string): Promise<boolean> {
  const key = process.env.WORLD_API_KEY;
  const appId = process.env.NEXT_PUBLIC_WORLD_APP_ID;
  if (!key || !appId) return false;

  try {
    const res = await fetch(WORLD_MCP, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_world_id_action",
          arguments: { app_id: appId, action, description, environment: "production" },
        },
      }),
    });
    const body = (await res.json()) as { error?: unknown };
    return !body.error;
  } catch {
    return false;
  }
}

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

    const { action, purpose, description, mode } = (await request
      .json()
      .catch(() => ({}))) as {
      action?: string;
      purpose?: string;
      description?: string;
      mode?: "action" | "session";
    };

    /*
     * Session mode.
     *
     * A session proof carries no action at all — the RP signature simply
     * omits the field — and yields a `session_nullifier` that is stable
     * for one human across every proof in that session. That is the thing
     * the per-action nullifier could never be: comparable between the mint
     * and a later escalation, with no verification quota in the way.
     *
     * No action is minted here, because there is nothing to mint.
     */
    if (mode === "session") {
      const s = signRequest({ signingKeyHex: key, ttl: 300 });
      return Response.json({
        mode: "session",
        action: null,
        rp_context: {
          rp_id: rpId,
          nonce: s.nonce,
          created_at: s.createdAt,
          expires_at: s.expiresAt,
          signature: s.sig,
        },
      });
    }

    let resolved = action;
    if (!resolved) {
      // Unique per request, so a repeat verification is never a repeat.
      const nonce = Math.random().toString(36).slice(2, 8);
      const stamp = Math.floor(Date.now() / 1000).toString(36);
      resolved = `intentlink-${purpose ?? "verify"}-${stamp}${nonce}`;
      await createAction(resolved, description ?? "Verify with IntentLink");
    }

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
