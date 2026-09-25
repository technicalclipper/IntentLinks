import { authMode, demoAddress } from "@/lib/auth/demo";
import {
  requestProof,
  verifyGoogleIdToken,
  zkLoginAddress,
} from "@/lib/zklogin/server";

/**
 * Turn a Google id_token into a Sui address and a zk proof.
 *
 * The salt never leaves this process, so the browser cannot derive its own
 * address and we cannot sign on the user's behalf — the ephemeral key that
 * actually signs stays in their tab.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      idToken?: string;
      extendedEphemeralPublicKey?: string;
      maxEpoch?: number;
      jwtRandomness?: string;
    };

    const { idToken, extendedEphemeralPublicKey, maxEpoch, jwtRandomness } = body;
    if (!idToken || !extendedEphemeralPublicKey || !maxEpoch || !jwtRandomness) {
      return Response.json({ error: "missing fields" }, { status: 400 });
    }

    // Verify before trusting anything in it — signature, issuer, audience,
    // expiry. Otherwise "sign in with Google" is "post any JSON you like".
    const claims = await verifyGoogleIdToken(idToken);

    // Demo mode needs no proof, which also makes sign-in instant instead of
    // a three-second wait on the prover.
    if (authMode() === "demo") {
      return Response.json({
        mode: "demo",
        address: demoAddress(claims),
        proof: null,
        email: claims.email ?? null,
        emailVerified: claims.email_verified ?? false,
      });
    }

    const address = zkLoginAddress(claims);
    const proof = await requestProof({
      idToken,
      extendedEphemeralPublicKey,
      maxEpoch,
      jwtRandomness,
    });

    // A Groth16 verify failure at signing time means the proof and the
    // address disagree, and the two are computed in different places. Log
    // enough to tell which side is wrong without logging the proof itself.
    console.log("[zklogin] proved", {
      address,
      addressSeed: proof.addressSeed,
      maxEpoch,
      iss: claims.iss,
      audTail: claims.aud.slice(-24),
      subTail: claims.sub.slice(-6),
      proofKeys: Object.keys(proof).join(","),
    });

    return Response.json({
      address,
      proof,
      email: claims.email ?? null,
      emailVerified: claims.email_verified ?? false,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
