/**
 * zkLogin, browser side.
 *
 * The ephemeral keypair lives here and only here. If it lived on our server
 * we would be custodial, and "a real Sui address the user controls" would
 * not be true. Sending it to the backend would be the easy shortcut and the
 * dishonest one.
 *
 * Session lifetime is bounded by `maxEpoch` — a few days at most. That is
 * exactly why an agent running a 30-day capability cannot sign as the human
 * it acts for and needs its own long-lived key.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  generateNonce,
  generateRandomness,
  getExtendedEphemeralPublicKey,
  getZkLoginSignature,
} from "@mysten/sui/zklogin";

const STORAGE_KEY = "intentlink.zklogin";

export interface EphemeralSession {
  /** bech32 `suiprivkey1…` for the throwaway keypair. Never leaves the browser. */
  secretKey: string;
  maxEpoch: number;
  randomness: string;
  nonce: string;
}

export interface ActiveSession extends EphemeralSession {
  /**
   * The extended ephemeral public key the proof was generated for.
   *
   * A zkLogin proof commits to one ephemeral key and one maxEpoch. If the
   * stored proof and the stored secret ever drift apart — two sign-ins
   * racing, a half-finished callback — the validator rejects it with
   * "Groth16 proof verify failed", which says nothing about the cause. This
   * lets us catch it here and re-authenticate instead.
   */
  provedFor: string;
  address: string;
  email: string;
  proof: unknown;
  /**
   * Kept so the server can re-verify identity at a later step — redemption
   * checks the email against the capsule's commitment, and it will not take
   * the browser's word for who is signed in.
   */
  idToken: string;
}

function store(): Storage | null {
  return typeof window === "undefined" ? null : window.sessionStorage;
}

export function loadSession(): ActiveSession | null {
  const raw = store()?.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as ActiveSession;
    return s.proof ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s: EphemeralSession | ActiveSession): void {
  store()?.setItem(STORAGE_KEY, JSON.stringify(s));
}

export function clearSession(): void {
  store()?.removeItem(STORAGE_KEY);
}

export function loadEphemeral(): EphemeralSession | null {
  const raw = store()?.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as EphemeralSession) : null;
}

export function keypairFromSession(s: EphemeralSession): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(s.secretKey);
}

/**
 * Start a sign-in.
 *
 * The nonce commits to the ephemeral public key, so the id_token Google
 * returns is cryptographically bound to this browser session and cannot be
 * lifted into another one.
 */
export function beginLogin(opts: {
  clientId: string;
  redirectUri: string;
  currentEpoch: number;
  /** How many epochs the session stays valid. Roughly a day each. */
  epochs?: number;
}): { url: string; session: EphemeralSession } {
  const keypair = Ed25519Keypair.generate();
  const maxEpoch = opts.currentEpoch + (opts.epochs ?? 5);
  const randomness = generateRandomness();
  const nonce = generateNonce(keypair.getPublicKey(), maxEpoch, randomness);

  const session: EphemeralSession = {
    // getSecretKey() returns bech32, not bytes, and fromSecretKey takes it back.
    secretKey: keypair.getSecretKey(),
    maxEpoch,
    randomness,
    nonce,
  };
  saveSession(session);

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "id_token");
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("nonce", nonce);

  return { url: url.toString(), session };
}

/** Base64, as the SDK returns it. Used locally to detect proof/key drift. */
export function extendedPublicKey(s: EphemeralSession): string {
  return getExtendedEphemeralPublicKey(keypairFromSession(s).getPublicKey());
}

/**
 * The same key as a decimal bigint string, which is what the prover wants.
 *
 * getExtendedEphemeralPublicKey returns base64; the proving API expects the
 * big-endian integer. Sending base64 does not fail — the prover accepts it,
 * misparses it, and returns a perfectly well-formed proof committing to a
 * key nobody holds. The transaction then dies at the validator with
 * "Groth16 proof verify failed", which points at the proof rather than at
 * the encoding two steps upstream.
 */
export function extendedPublicKeyDecimal(s: EphemeralSession): string {
  const b64 = extendedPublicKey(s);
  const bytes =
    typeof atob === "function"
      ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      : new Uint8Array(Buffer.from(b64, "base64"));

  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return BigInt("0x" + hex).toString();
}

/**
 * Wrap an ephemeral signature in the zkLogin proof so validators accept it
 * as coming from the user's address.
 */
export class StaleSessionError extends Error {
  constructor() {
    super("Your sign-in expired. Sign in again.");
    this.name = "StaleSessionError";
  }
}

export async function signAsZkLogin(
  s: ActiveSession,
  txBytes: Uint8Array,
): Promise<string> {
  const keypair = keypairFromSession(s);

  // The proof is only valid for the key it was generated against.
  if (s.provedFor && extendedPublicKey(s) !== s.provedFor) {
    clearSession();
    throw new StaleSessionError();
  }

  const { signature: userSignature } = await keypair.signTransaction(txBytes);

  return getZkLoginSignature({
    inputs: s.proof as Parameters<typeof getZkLoginSignature>[0]["inputs"],
    maxEpoch: s.maxEpoch,
    userSignature,
  });
}
