/**
 * zkLogin, server side.
 *
 * Enoki bundles three things: a prover, salt management, and gas
 * sponsorship. It is a paid subscription, and none of the three are
 * protocol requirements — this file does the first two, lib/chain/sponsor.ts
 * does the third.
 *
 * Nothing here ever runs in the browser. The salt secret is the one value
 * that must not leak: it derives every user's address.
 */
import crypto from "node:crypto";
import { computeZkLoginAddress, decodeJwt, genAddressSeed } from "@mysten/sui/zklogin";

/**
 * Use the *dev* prover for testnet.
 *
 * prover.mystenlabs.com is the mainnet endpoint and allowlists OAuth
 * audiences — it rejects any Google client id Mysten has not registered,
 * with "The audience … is not supported". prover-dev serves testnet and
 * devnet and accepts ours. Getting this wrong looks like a broken sign-in
 * rather than a misconfigured URL, so it is worth stating plainly.
 */
const PROVER_URL =
  process.env.ZKLOGIN_PROVER_URL ?? "https://prover-dev.mystenlabs.com/v1";
const SALT_SECRET = process.env.ZKLOGIN_SALT_SECRET;
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

const GOOGLE_ISS = "https://accounts.google.com";

/**
 * Google emits `iss` as either "accounts.google.com" or
 * "https://accounts.google.com" and both are valid. Anything deriving a
 * stable identity from it has to pick one, or the same person gets a
 * different address depending on which form arrived — which looks exactly
 * like "my wallet changed when I signed in again".
 */
export function canonicalIss(iss: string): string {
  return iss === "accounts.google.com" ? GOOGLE_ISS : iss;
}
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";

export interface JwtClaims {
  iss: string;
  aud: string;
  /** Stable, opaque, permanent id for the Google account. */
  sub: string;
  email?: string;
  email_verified?: boolean;
  nonce?: string;
  exp: number;
}

// ===== Salt ======================================================

/**
 * salt = HMAC(secret, iss|aud|sub), truncated to 128 bits.
 *
 * Deterministic, so the same Google account always derives the same Sui
 * address. Without a salt the address would be a plain hash of the OAuth
 * claims and anyone knowing someone's `sub` could compute their address.
 *
 * The trade-off is stated plainly in the README: lose this secret and every
 * user's address becomes unreachable. Production wants user-held or
 * threshold salt; this is the one place we are a custody risk.
 */
export function deriveSalt(claims: Pick<JwtClaims, "iss" | "aud" | "sub">): bigint {
  if (!SALT_SECRET) throw new Error("ZKLOGIN_SALT_SECRET is not set");
  const mac = crypto
    .createHmac("sha256", SALT_SECRET)
    .update(`${canonicalIss(claims.iss)}|${claims.aud}|${claims.sub}`)
    .digest();
  // zkLogin salt must fit in 128 bits.
  return BigInt("0x" + mac.subarray(0, 16).toString("hex"));
}

// ===== JWT verification ==========================================

/** Node's crypto.JsonWebKey, not the DOM one — they are not the same type. */
type Jwk = crypto.JsonWebKey & { kid: string };

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

async function googleKeys(): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < 60 * 60 * 1000) {
    return jwksCache.keys;
  }
  const res = await fetch(GOOGLE_JWKS);
  if (!res.ok) throw new Error(`could not fetch Google JWKS: ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Verify a Google id_token properly: signature against Google's published
 * keys, issuer, audience, and expiry.
 *
 * Skipping any of these turns "sign in with Google" into "paste any JSON you
 * like" — the audience check in particular is what stops a token minted for
 * a different app being replayed at ours.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<JwtClaims> {
  const [headerB64, payloadB64, sigB64] = idToken.split(".");
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error("malformed id_token");

  const header = JSON.parse(b64urlToBuf(headerB64).toString()) as { kid: string; alg: string };
  const claims = JSON.parse(b64urlToBuf(payloadB64).toString()) as JwtClaims;

  console.log("[zklogin] token kid =", header.kid, "alg =", header.alg);
  const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("id_token signed with an unknown key");

  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const signed = `${headerB64}.${payloadB64}`;
  const valid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(signed),
    key,
    b64urlToBuf(sigB64),
  );
  if (!valid) throw new Error("id_token signature is invalid");

  if (claims.iss !== GOOGLE_ISS && claims.iss !== "accounts.google.com") {
    throw new Error(`unexpected issuer ${claims.iss}`);
  }
  if (GOOGLE_CLIENT_ID && claims.aud !== GOOGLE_CLIENT_ID) {
    throw new Error("id_token was issued for a different application");
  }
  if (claims.exp * 1000 < Date.now()) throw new Error("id_token has expired");

  return claims;
}

// ===== Address ===================================================

export function zkLoginAddress(claims: JwtClaims, salt = deriveSalt(claims)): string {
  return computeZkLoginAddress({
    claimName: "sub",
    claimValue: claims.sub,
    iss: claims.iss,
    aud: claims.aud,
    userSalt: salt,
    // The pre-mainnet address scheme. Must stay false and must stay
    // consistent — flipping it silently moves every user's funds to an
    // address they can no longer reach.
    legacyAddress: false,
  });
}

/** Recipient binding: normalise, salt, hash. Never the bare email. */
export function normaliseEmail(email: string): string {
  let [local, domain] = email.trim().toLowerCase().split("@");
  local = local.split("+")[0];
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

/**
 * A bare hash of an email is trivially brute-forced — the address space is
 * small and enumerable. The per-capsule salt makes the commitment on a
 * public chain meaningless to an observer.
 */
export function recipientHash(email: string, capsuleSalt: string): string {
  return (
    "0x" +
    crypto
      .createHash("sha256")
      .update(`${normaliseEmail(email)}|${capsuleSalt}`)
      .digest("hex")
  );
}

export function newCapsuleSalt(): string {
  return crypto.randomBytes(16).toString("hex");
}

// ===== Prover ====================================================

export interface ProofRequest {
  idToken: string;
  /** From getExtendedEphemeralPublicKey on the browser side. */
  extendedEphemeralPublicKey: string;
  maxEpoch: number;
  jwtRandomness: string;
}

export interface ZkProof {
  proofPoints: { a: string[]; b: string[][]; c: string[] };
  issBase64Details: { value: string; indexMod4: number };
  headerBase64: string;
  addressSeed: string;
}

/**
 * Ask the prover for a proof.
 *
 * The public prover is free but may not accept every OAuth audience. If it
 * rejects our client id this is where the whole approach dies, so the error
 * says so explicitly rather than surfacing as a generic 4xx.
 */
export async function requestProof(req: ProofRequest): Promise<ZkProof> {
  const claims = decodeJwt(req.idToken) as unknown as JwtClaims;
  const salt = deriveSalt(claims);
  const addressSeed = genAddressSeed(salt, "sub", claims.sub, claims.aud).toString();

  console.log("[zklogin] prover payload", {
    extendedEphemeralPublicKey: req.extendedEphemeralPublicKey.slice(0, 24),
    isDecimal: /^\d+$/.test(req.extendedEphemeralPublicKey),
    maxEpoch: req.maxEpoch,
    jwtRandomness: req.jwtRandomness.slice(0, 20),
    salt: salt.toString().slice(0, 20),
  });

  const res = await fetch(PROVER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jwt: req.idToken,
      extendedEphemeralPublicKey: req.extendedEphemeralPublicKey,
      maxEpoch: String(req.maxEpoch),
      jwtRandomness: req.jwtRandomness,
      salt: salt.toString(),
      keyClaimName: "sub",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (/audience/i.test(body)) {
      throw new Error(
        `The prover at ${PROVER_URL} does not accept our Google client id. ` +
          `On testnet this almost always means ZKLOGIN_PROVER_URL is pointed at ` +
          `the mainnet prover — use https://prover-dev.mystenlabs.com/v1. ` +
          `Body: ${body.slice(0, 300)}`,
      );
    }
    throw new Error(`prover ${res.status}: ${body.slice(0, 400)}`);
  }

  const proof = (await res.json()) as Omit<ZkProof, "addressSeed">;
  return { ...proof, addressSeed };
}
