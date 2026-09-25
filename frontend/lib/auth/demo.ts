import crypto from "node:crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { canonicalIss, type JwtClaims } from "../zklogin/server";

/**
 * Demo-mode accounts.
 *
 * zkLogin is wired end to end — proving succeeds, the address derives
 * correctly from the address seed, the token's signing key is in the
 * on-chain JWK registry — but proofs from the dev prover do not verify on
 * testnet, and chasing that further was costing more than it was worth.
 *
 * So this: an Ed25519 key derived deterministically from the Google subject,
 * exactly the way the zkLogin salt is derived. The user experience is
 * identical — sign in with Google, get a Sui address, no wallet, no seed
 * phrase, no gas — and every on-chain guarantee about the *agent* is
 * untouched, because those are asserts rather than promises about who holds
 * a key.
 *
 * What it does give up: the server can sign as the user. Under zkLogin the
 * ephemeral key never leaves the browser and we genuinely cannot act as
 * them. Here we can. That is the same posture as most embedded-wallet
 * products, and it is worth answering plainly if anyone asks.
 *
 * Set AUTH_MODE=zklogin to switch back.
 */

const SALT_SECRET = process.env.ZKLOGIN_SALT_SECRET;

export type AuthMode = "demo" | "zklogin";

export function authMode(): AuthMode {
  return process.env.AUTH_MODE === "zklogin" ? "zklogin" : "demo";
}

/**
 * Deterministic per Google account, so the same person always returns to the
 * same address and their funds are where they left them.
 */
export function demoKeypair(claims: Pick<JwtClaims, "iss" | "aud" | "sub">): Ed25519Keypair {
  if (!SALT_SECRET) throw new Error("ZKLOGIN_SALT_SECRET is not set");
  const seed = crypto
    .createHmac("sha256", SALT_SECRET)
    // Canonicalised: Google emits iss in two forms, and using them raw
    // hands the same person a different address on alternate sign-ins.
    .update(`demo|${canonicalIss(claims.iss)}|${claims.aud}|${claims.sub}`)
    .digest();
  return Ed25519Keypair.fromSecretKey(new Uint8Array(seed));
}

export function demoAddress(claims: Pick<JwtClaims, "iss" | "aud" | "sub">): string {
  return demoKeypair(claims).toSuiAddress();
}
