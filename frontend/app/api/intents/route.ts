import { readCapsule } from "@/lib/chain/read";
import { describe, type Policy } from "@/lib/policy";
import { issueCapsuleName, labelFor } from "@/lib/ens";
import { getIntent, listIntents, publicView, putIntent } from "@/lib/store";

/**
 * Finalise an intent: publish the name once the chain state exists.
 *
 * Deliberately after the Sui transactions, not before — a name pointing at a
 * capsule that failed to mint would be worse than no name at all.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      vaultId?: string;
      capsuleId?: string;
      policy?: Policy;
      policyHash?: string;
      salt?: string;
      recipientEmail?: string | null;
      issuerAddress?: string;
    };

    const { vaultId, capsuleId, policy, policyHash, salt, issuerAddress } = body;
    if (!vaultId || !capsuleId || !policy || !policyHash || !salt || !issuerAddress) {
      return Response.json({ error: "missing fields" }, { status: 400 });
    }

    // The capsule must actually carry the hash we are about to publish,
    // otherwise the cross-chain check would fail the moment an agent looked.
    const capsule = await readCapsule(capsuleId);
    const norm = (s: string) => s.toLowerCase().replace(/^0x/, "");
    if (norm(capsule.policyHash) !== norm(policyHash)) {
      return Response.json(
        {
          error: "refusing to publish: the capsule on Sui commits to a different policy",
          onChain: capsule.policyHash,
          submitted: policyHash,
        },
        { status: 409 },
      );
    }

    const label = labelFor(capsuleId);
    const ens = await issueCapsuleName(label, {
      vault: vaultId,
      capsule: capsuleId,
      policy: policyHash,
      status: "unclaimed",
      expires: policy.expiresAt,
      chain: "sui:testnet",
      description: describe(policy),
    });

    putIntent({
      label,
      name: ens.name,
      vaultId,
      capsuleId,
      policy,
      policyHash,
      salt,
      recipientEmail: body.recipientEmail ?? null,
      issuerAddress,
      createdAt: Date.now(),
    });

    return Response.json({
      label,
      name: ens.name,
      url: `/i/${label}`,
      registerTx: ens.registerTx,
      recordsTx: ens.recordsTx,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function GET(request: Request) {
  const issuer = new URL(request.url).searchParams.get("issuer") ?? undefined;
  return Response.json({ intents: listIntents(issuer).map(publicView) });
}

export { getIntent };
