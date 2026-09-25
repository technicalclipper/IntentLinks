import { Transaction } from "@mysten/sui/transactions";
import { agentAddress, signAndExecute, sponsorKeypair } from "@/lib/chain/client";
import { VERIFIER_CAP_ID } from "@/lib/chain/config";
import { decodeAbort } from "@/lib/chain/errors";
import { readCapsule } from "@/lib/chain/read";
import { claim } from "@/lib/chain/tx";
import { setStatus } from "@/lib/ens";
import { getIntent } from "@/lib/store";
import { recipientHash, verifyGoogleIdToken } from "@/lib/zklogin/server";
import { verifyWorldProof } from "@/lib/world";
import type { IDKitResult } from "@worldcoin/idkit-core";

/**
 * Redeem a capability.
 *
 * Three checks, answering three different questions, none of which can
 * substitute for another:
 *
 *   World ID  — is this one unique human? Stops a forwarded link being
 *               claimed repeatedly by one person with many accounts.
 *   Google    — is this the *specific* person it was addressed to? World
 *               cannot tell you which human, only that there is one.
 *   on-chain  — has it already been claimed? assert!(holder.is_none())
 *
 * Only the server sees the proofs, and only the server holds the VerifierCap
 * that can bind a capsule. That is a real trust boundary and it is worth
 * being explicit that it exists: this key can attest a human was verified.
 * It cannot move funds, widen a bound, or exceed a hard cap.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ label: string }> },
) {
  const { label } = await params;
  const record = getIntent(label);
  if (!record) return Response.json({ error: "not found" }, { status: 404 });

  try {
    const body = (await request.json()) as {
      worldProof?: IDKitResult;
      idToken?: string;
      principal?: string;
    };
    const { worldProof, idToken, principal } = body;

    if (!worldProof) return Response.json({ error: "World verification is required" }, { status: 400 });
    if (!idToken || !principal) {
      return Response.json({ error: "sign in with Google first" }, { status: 400 });
    }

    // --- one unique human --------------------------------------
    const world = await verifyWorldProof(worldProof);
    if (!world.ok) {
      return Response.json({ error: `World: ${world.error}` }, { status: 403 });
    }

    // --- which human -------------------------------------------
    const claims = await verifyGoogleIdToken(idToken);
    if (!claims.email || !claims.email_verified) {
      return Response.json(
        { error: "your Google account has no verified email address" },
        { status: 403 },
      );
    }

    // Bound capsules commit to a salted hash of the recipient's address. An
    // unsalted hash on a public chain would be trivially brute-forced.
    let boundHash: string | null = null;
    if (record.policy.boundTo) {
      boundHash = recipientHash(claims.email, record.salt);
      const onChain = await readCapsule(record.capsuleId);
      const norm = (s: string | null) => (s ?? "").toLowerCase().replace(/^0x/, "");
      if (norm(onChain.boundRecipient) !== norm(boundHash)) {
        return Response.json(
          {
            error: "wrong_recipient",
            message: "This intent was issued to a different account.",
            issuedTo: record.policy.boundTo,
            signedInAs: claims.email,
          },
          { status: 403 },
        );
      }
    }

    // --- bind it -----------------------------------------------
    const tx = new Transaction();
    claim(tx, {
      verifierCapId: VERIFIER_CAP_ID!,
      capsuleId: record.capsuleId,
      principal,
      holder: agentAddress(),
      recipientHash: boundHash,
    });
    tx.setSender(sponsorKeypair().toSuiAddress());
    tx.setGasBudget(100_000_000);

    const r = await signAndExecute(tx, sponsorKeypair());
    if (!r.success) {
      const abort = decodeAbort(r.error ?? "");
      return Response.json(
        { error: abort?.message ?? r.error ?? "claim failed", abort },
        { status: 409 },
      );
    }

    // The name now says it is live. Best-effort — the capability is already
    // bound on Sui, and that is the half that enforces anything.
    await setStatus(label, "active").catch(() => {});

    return Response.json({
      success: true,
      digest: r.digest,
      principal,
      holder: agentAddress(),
      nullifier: world.nullifier,
      credential: world.credential,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
