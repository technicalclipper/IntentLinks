/**
 * Checks the zkLogin pieces that do not need a browser or a real Google
 * token, then — if you paste a real id_token — the one thing that actually
 * carries risk: whether the public prover will accept our OAuth audience.
 *
 *   npx tsx --env-file=.env.local scripts/zklogin-check.ts
 *   npx tsx --env-file=.env.local scripts/zklogin-check.ts <id_token>
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  generateNonce,
  generateRandomness,
  getExtendedEphemeralPublicKey,
} from "@mysten/sui/zklogin";
import { suiClient } from "../lib/chain/client";
import {
  deriveSalt,
  normaliseEmail,
  recipientHash,
  requestProof,
  verifyGoogleIdToken,
  zkLoginAddress,
} from "../lib/zklogin/server";

let pass = 0;
let fail = 0;
const ok = (m: string, d = "") => (pass++, console.log(`  \x1b[32mPASS\x1b[0m  ${m}${d ? `  ${d}` : ""}`));
const bad = (m: string, d = "") => (fail++, console.log(`  \x1b[31mFAIL\x1b[0m  ${m}${d ? `  ${d}` : ""}`));

async function main() {
  console.log("\nephemeral session");

  const kp = Ed25519Keypair.generate();
  const secret = kp.getSecretKey();
  typeof secret === "string" && secret.startsWith("suiprivkey1")
    ? ok("getSecretKey returns bech32")
    : bad("getSecretKey format", typeof secret);

  const restored = Ed25519Keypair.fromSecretKey(secret);
  restored.toSuiAddress() === kp.toSuiAddress()
    ? ok("keypair round-trips through sessionStorage")
    : bad("keypair round-trip");

  const epochRes = (await suiClient().core.getCurrentSystemState()) as unknown as Record<string, unknown>;
  const inner = (epochRes.SystemState ?? epochRes.systemState ?? epochRes) as Record<string, unknown>;
  const epoch = Number(inner.epoch ?? inner.currentEpoch ?? 0);
  epoch > 0 ? ok("current epoch", String(epoch)) : bad("current epoch");

  const randomness = generateRandomness();
  const nonce = generateNonce(kp.getPublicKey(), epoch + 5, randomness);
  nonce?.length ? ok("nonce binds the ephemeral key", nonce.slice(0, 16) + "…") : bad("nonce");

  const ext = getExtendedEphemeralPublicKey(kp.getPublicKey());
  ext?.length ? ok("extended ephemeral public key") : bad("extended public key");

  console.log("\nsalt and address");

  const claims = {
    iss: "https://accounts.google.com",
    aud: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID!,
    sub: "1234567890",
  };
  const salt = deriveSalt(claims);
  const salt2 = deriveSalt(claims);
  salt === salt2 && salt < 2n ** 128n
    ? ok("salt is deterministic and 128-bit")
    : bad("salt", String(salt));

  deriveSalt({ ...claims, sub: "999" }) !== salt
    ? ok("different account, different salt")
    : bad("salt collides across accounts");

  const addr = zkLoginAddress({ ...claims, exp: 0 }, salt);
  addr.startsWith("0x") && addr.length === 66
    ? ok("derives a Sui address", addr)
    : bad("address", addr);

  console.log("\nrecipient binding");

  normaliseEmail("Bob.Smith+hack@GMail.com") === "bobsmith@gmail.com"
    ? ok("gmail dots and +tags normalised")
    : bad("normalise", normaliseEmail("Bob.Smith+hack@GMail.com"));

  const s = "abc123";
  recipientHash("bob@gmail.com", s) === recipientHash("b.o.b+x@googlemail.com", s)
    ? ok("same human, same hash")
    : bad("hash mismatch for equivalent addresses");

  recipientHash("bob@gmail.com", "salt-a") !== recipientHash("bob@gmail.com", "salt-b")
    ? ok("salt makes the commitment unguessable")
    : bad("hash ignores the salt");

  // --- the risky bit -------------------------------------------
  const idToken = process.argv[2];
  if (!idToken) {
    console.log("\nprover");
    console.log("  \x1b[33mSKIP\x1b[0m  needs a real id_token — sign in at http://localhost:3000");
    console.log("         then re-run with:  ... scripts/zklogin-check.ts <id_token>");
  } else {
    console.log("\nprover (the part that can kill this approach)");
    try {
      const verified = await verifyGoogleIdToken(idToken);
      ok("id_token verified", verified.email ?? verified.sub);

      const proof = await requestProof({
        idToken,
        extendedEphemeralPublicKey: ext,
        maxEpoch: epoch + 5,
        jwtRandomness: randomness,
      });
      proof.proofPoints ? ok("PROVER ACCEPTED OUR AUDIENCE") : bad("proof shape");
    } catch (e) {
      bad("prover", (e as Error).message.slice(0, 300));
    }
  }

  console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\ncrashed:\n", e);
  process.exit(1);
});
