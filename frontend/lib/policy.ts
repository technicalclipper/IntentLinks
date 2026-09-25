import crypto from "node:crypto";

/**
 * The policy document.
 *
 * This is the human-readable statement of what an agent may do, and its hash
 * is committed to both chains — `il:policy` on ENS and `policy_hash` on the
 * Sui Capsule. Publishing it is what turns "two hashes match" into something
 * a third party can actually check: fetch this, hash it, compare to both
 * chains, then compare its claims field-by-field against the capsule.
 */
export interface Policy {
  version: 1;
  goal: string;
  asset: string;
  /** All amounts are base units (MIST for SUI), as decimal strings. */
  perActionCap: string;
  perWindowCap: string;
  totalCap: string;
  hardCap: string;
  windowMs: string;
  maxWindows: string;
  allowedPools: string[];
  maxSlippageBps: string;
  beneficiary: "vault" | "recipient" | string;
  notBefore: string;
  expiresAt: string;
  /** Masked, never the plain address — this document is public. */
  boundTo: string | null;
}

/**
 * Canonical form: sorted keys, no whitespace.
 *
 * Both chains commit to the hash of this exact byte string, so it has to be
 * reproducible by anyone who fetches the document. Key order is the usual
 * way that quietly breaks.
 */
export function canonical(policy: Policy): string {
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, val]) => [k, sortDeep(val)]),
      );
    }
    return v;
  };
  return JSON.stringify(sortDeep(policy));
}

export function policyHash(policy: Policy): string {
  return "0x" + crypto.createHash("sha256").update(canonical(policy)).digest("hex");
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "•••";
  return `${local.slice(0, 1)}•••@${domain}`;
}

/** Field-by-field check that the published document matches the enforced object. */
export interface PolicyMismatch {
  field: string;
  published: string;
  enforced: string;
}

export function comparePolicyToCapsule(
  policy: Policy,
  capsule: {
    perActionCap: bigint;
    perWindowCap: bigint;
    totalCap: bigint;
    hardCap: bigint;
    windowMs: bigint;
    maxWindows: bigint;
    allowedPools: string[];
    maxSlippageBps: bigint;
    notBefore: bigint;
    expiresAt: bigint;
  },
): PolicyMismatch[] {
  const out: PolicyMismatch[] = [];
  const cmp = (field: string, published: string, enforced: bigint) => {
    if (BigInt(published) !== enforced) {
      out.push({ field, published, enforced: enforced.toString() });
    }
  };

  cmp("perActionCap", policy.perActionCap, capsule.perActionCap);
  cmp("perWindowCap", policy.perWindowCap, capsule.perWindowCap);
  cmp("totalCap", policy.totalCap, capsule.totalCap);
  cmp("hardCap", policy.hardCap, capsule.hardCap);
  cmp("windowMs", policy.windowMs, capsule.windowMs);
  cmp("maxWindows", policy.maxWindows, capsule.maxWindows);
  cmp("maxSlippageBps", policy.maxSlippageBps, capsule.maxSlippageBps);
  cmp("notBefore", policy.notBefore, capsule.notBefore);
  cmp("expiresAt", policy.expiresAt, capsule.expiresAt);

  const norm = (s: string) => s.toLowerCase().replace(/^0x0*/, "");
  const pub = policy.allowedPools.map(norm).sort();
  const enf = capsule.allowedPools.map(norm).sort();
  if (pub.join(",") !== enf.join(",")) {
    out.push({
      field: "allowedPools",
      published: policy.allowedPools.join(","),
      enforced: capsule.allowedPools.join(","),
    });
  }

  return out;
}

/** One line of plain English, for the ENS `description` record. */
export function describe(policy: Policy): string {
  const sui = (v: string) => (Number(v) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 });
  const days = Number(policy.windowMs) === 86_400_000 ? "day" : `${Number(policy.windowMs) / 3_600_000}h`;
  return `${policy.goal} · up to ${sui(policy.perWindowCap)} ${policy.asset}/${days} · ${policy.maxWindows} periods · revocable`;
}
