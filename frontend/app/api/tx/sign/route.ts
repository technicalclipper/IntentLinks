import { fromBase64 } from "@mysten/sui/utils";
import { authMode, demoKeypair } from "@/lib/auth/demo";
import { verifyGoogleIdToken } from "@/lib/zklogin/server";

/**
 * Sign a prepared transaction on the user's behalf, in demo mode.
 *
 * The id_token is re-verified here rather than trusted from the request —
 * signature, issuer, audience, expiry — so holding a session in the browser
 * is not by itself authority to spend.
 *
 * Under AUTH_MODE=zklogin this refuses: there the key lives in the browser
 * and the server has nothing to sign with.
 */
export async function POST(request: Request) {
  if (authMode() !== "demo") {
    return Response.json(
      { error: "server-side signing is disabled under zkLogin" },
      { status: 403 },
    );
  }

  try {
    const { bytes, idToken } = (await request.json()) as {
      bytes?: string;
      idToken?: string;
    };
    if (!bytes || !idToken) {
      return Response.json({ error: "bytes and idToken are required" }, { status: 400 });
    }

    const claims = await verifyGoogleIdToken(idToken);
    const keypair = demoKeypair(claims);
    const { signature } = await keypair.signTransaction(fromBase64(bytes));

    return Response.json({ signature, address: keypair.toSuiAddress() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
