import { suiClient } from "./client";
import type { BeneficiaryMode } from "./config";
import type { CapsuleState, VaultState } from "./types";

/**
 * Sui renders Move values into JSON inconsistently across SDK versions —
 * `Option` arrives as a bare value, as null, or wrapped in `{ vec: [...] }`,
 * and `vector<u8>` as either a number array or a base64 string. These
 * normalise all of it so the rest of the codebase never has to care.
 */

function opt<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && v !== null && "vec" in v) {
    const vec = (v as { vec: unknown[] }).vec;
    return Array.isArray(vec) && vec.length > 0 ? (vec[0] as T) : null;
  }
  if (typeof v === "object" && v !== null && "fields" in v) {
    return opt<T>((v as { fields: unknown }).fields);
  }
  return v as T;
}

function hex(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    // already hex, or base64 from some node versions
    if (v.startsWith("0x")) return v;
    try {
      return "0x" + Buffer.from(v, "base64").toString("hex");
    } catch {
      return v;
    }
  }
  if (Array.isArray(v)) {
    return "0x" + v.map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  }
  return String(v);
}

function optHex(v: unknown): string | null {
  const inner = opt<unknown>(v);
  return inner === null ? null : hex(inner);
}

const big = (v: unknown): bigint => BigInt((v ?? 0) as string | number);

async function jsonFields(objectId: string): Promise<Record<string, unknown>> {
  const res = await suiClient().core.getObject({
    objectId,
    include: { json: true },
  });
  const json = res.object?.json;
  if (!json) throw new Error(`object ${objectId} has no readable content`);
  // gRPC sometimes nests the struct under `fields`, sometimes not.
  return (json.fields as Record<string, unknown>) ?? json;
}

export async function readCapsule(id: string): Promise<CapsuleState> {
  const f = await jsonFields(id);

  return {
    id,
    vaultId: String(f.vault_id),
    issuer: String(f.issuer),

    boundRecipient: optHex(f.bound_recipient),
    issuerNullifier: hex(f.issuer_nullifier),
    principal: opt<string>(f.principal),
    holder: opt<string>(f.holder),

    perActionCap: big(f.per_action_cap),
    totalCap: big(f.total_cap),
    hardCap: big(f.hard_cap),
    spent: big(f.spent),

    windowMs: big(f.window_ms),
    perWindowCap: big(f.per_window_cap),
    maxWindows: big(f.max_windows),
    windowStartMs: big(f.window_start_ms),
    windowSpent: big(f.window_spent),
    windowsUsed: big(f.windows_used),

    allowedPools: ((f.allowed_pools as unknown[]) ?? []).map(String),
    maxSlippageBps: big(f.max_slippage_bps),

    beneficiaryMode: Number(f.beneficiary_mode) as BeneficiaryMode,
    beneficiaryAddr: opt<string>(f.beneficiary_addr),

    notBefore: big(f.not_before),
    expiresAt: big(f.expires_at),

    issuerPaused: Boolean(f.issuer_paused),
    principalPaused: Boolean(f.principal_paused),
    revoked: Boolean(f.revoked),
    surrendered: Boolean(f.surrendered),

    ensNode: hex(f.ens_node),
    policyHash: hex(f.policy_hash),
  };
}

export async function readVault(id: string): Promise<VaultState> {
  const f = await jsonFields(id);

  return {
    id,
    funder: String(f.funder),
    balance: big(f.balance),
    revoked: Boolean(f.revoked),
  };
}

/**
 * The agent's boot check: the policy published on ENS must match the policy
 * the chain will actually enforce. If they disagree, something is wrong and
 * the agent should refuse to act rather than guess which one is right.
 */
export function policyMatches(capsule: CapsuleState, ensPolicyHash: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/^0x/, "");
  return norm(capsule.policyHash) === norm(ensPolicyHash);
}

/**
 * The agent's permit for one specific capsule, if it holds one.
 *
 * Matching on `capsule_id` matters: a permit approved for a different
 * capability is refused on chain by E_PERMIT_WRONG_CAPSULE, which is
 * correct but reads as a bug when the agent simply picked up the wrong
 * one of several it happens to hold.
 */
export async function findPermitFor(
  owner: string,
  capsuleId: string,
  permitType: string,
): Promise<string | null> {
  const res = (await suiClient().core.listOwnedObjects({
    owner,
    type: permitType,
  })) as unknown as { objects?: { id?: string; objectId?: string }[] };

  for (const o of res.objects ?? []) {
    const id = o.id ?? o.objectId;
    if (!id) continue;
    try {
      const f = await jsonFields(id);
      if (String(f.capsule_id) === capsuleId) return id;
    } catch {
      /* A permit we cannot read is one we will not spend. */
    }
  }
  return null;
}
