import crypto from "node:crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

/**
 * Bring your own agent.
 *
 * Until now the `holder` — the only address a capsule will execute for —
 * was always our agent's key. Nothing in the contract required that;
 * `claim` takes an arbitrary address and every spend asserts the caller is
 * it. We were the only thing assuming.
 *
 * So a capability can be handed to an agent we did not write and have
 * never seen, and every guarantee holds unchanged, because they were
 * always asserts about an address rather than trust in a program.
 *
 * Two ways to hold one:
 *
 *   delegated — we derive a keypair for this capsule alone and the MCP
 *               session signs with it. One line of config for the user and
 *               no key handling, which is the difference between a feature
 *               people try and one they read about.
 *
 *   external  — they name their own agent's address. We never hold a key;
 *               their agent signs for itself. Purer, more setup.
 *
 * The delegated key sounds like the dangerous option and is close to
 * worthless on its own. It cannot exceed a cap, reach an unapproved pool,
 * or move proceeds anywhere but the beneficiary fixed at mint, and it dies
 * the moment the human revokes. Stealing it buys you bounded trades into
 * someone else's wallet. That is not an accident of our design — it is
 * what a capability *is*, and the reason handing one to a stranger's agent
 * is a reasonable thing to do.
 */

const SECRET = process.env.ZKLOGIN_SALT_SECRET;

export type AgentMode = "managed" | "delegated" | "external";

/**
 * The signing key for a delegated agent.
 *
 * Derived from the capsule id, so it is stable across restarts without
 * being stored anywhere, and distinct per capability — one leaked session
 * cannot touch a second permission.
 */
export function delegatedKeypair(capsuleId: string): Ed25519Keypair {
  if (!SECRET) throw new Error("ZKLOGIN_SALT_SECRET is not set");
  const seed = crypto
    .createHmac("sha256", SECRET)
    .update(`byoa|${capsuleId}`)
    .digest();
  return Ed25519Keypair.fromSecretKey(new Uint8Array(seed));
}

export function delegatedAddress(capsuleId: string): string {
  return delegatedKeypair(capsuleId).toSuiAddress();
}

/**
 * The connection token an agent presents.
 *
 * Derived rather than random, so it survives a restart of a server whose
 * only persistence is a JSON file, and it is a bearer credential for the
 * MCP session — which is exactly as much authority as the capsule allows
 * and not one unit more.
 */
export function connectionToken(capsuleId: string): string {
  if (!SECRET) throw new Error("ZKLOGIN_SALT_SECRET is not set");
  const mac = crypto
    .createHmac("sha256", SECRET)
    .update(`mcp|${capsuleId}`)
    .digest("hex");
  return `ilk_${mac.slice(0, 40)}`;
}

/** Constant-time, because comparing secrets with === leaks their prefix. */
export function tokenMatches(token: string, capsuleId: string): boolean {
  const expected = connectionToken(capsuleId);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A Sui address, as a shape. Rejects the near-misses people paste. */
export function isSuiAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(v.trim());
}
