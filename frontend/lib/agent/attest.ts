import { readCapsuleName } from "../ens";
import { policyAgrees } from "../ens";

/**
 * The cross-chain check the agent runs before it acts.
 *
 * Two chains describe the same permission. Ethereum publishes the terms as
 * ENS text records; Sui holds the object that enforces them. Both carry a
 * hash of the same canonical policy document, written in the same flow at
 * mint.
 *
 * If they disagree, something is wrong that the agent cannot resolve from
 * where it stands — a record edited after issue, a name pointed at the
 * wrong capsule, a capability mid-migration. The useful response is to
 * stop, not to guess which chain to believe.
 *
 * Cached briefly because this runs before every action and a Sepolia
 * round-trip per trade is a tax on the keeper for information that
 * changes at most once per capability lifecycle.
 */

interface Cached {
  at: number;
  ok: boolean;
  reason: string | null;
}

const TTL_MS = 60_000;
const cache = new Map<string, Cached>();

export interface Attestation {
  ok: boolean;
  /** Why it refused to proceed, in words a person can act on. */
  reason: string | null;
  /** True when ENS published nothing — unverified, which is not the same as wrong. */
  unpublished: boolean;
}

/**
 * Does the published policy still match the enforced one?
 *
 * A missing record is *not* a failure. Plenty of capabilities are minted
 * before their name resolves, and a naming layer being briefly behind is
 * not evidence that the capsule is wrong. Only a hash that is present and
 * *different* is a contradiction, and only that stops the agent.
 */
export async function attestPolicy(
  ensName: string,
  suiPolicyHash: string,
): Promise<Attestation> {
  const hit = cache.get(ensName);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return { ok: hit.ok, reason: hit.reason, unpublished: false };
  }

  let published: string | undefined;
  try {
    const records = (await readCapsuleName(ensName)) as Record<string, string>;
    published = records.policy;
  } catch {
    // Sepolia unreachable. Refusing to trade because a testnet RPC is down
    // would be its own kind of wrong — the enforcing chain is still Sui,
    // and every limit still holds there.
    return { ok: true, reason: null, unpublished: true };
  }

  if (!published) return { ok: true, reason: null, unpublished: true };

  const agrees = policyAgrees(published, suiPolicyHash);
  const result: Cached = {
    at: Date.now(),
    ok: agrees,
    reason: agrees
      ? null
      : `ENS and Sui disagree about this capability. ${ensName} publishes ` +
        `${published.slice(0, 14)}…, the capsule enforces ${suiPolicyHash.slice(0, 14)}…. ` +
        `Halting rather than acting on terms that are not the published ones.`,
  };
  cache.set(ensName, result);
  return { ...result, unpublished: false };
}

/** Forget a cached verdict — used after records are rewritten. */
export function forgetAttestation(ensName: string): void {
  cache.delete(ensName);
}
