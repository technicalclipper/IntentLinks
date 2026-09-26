import fs from "node:fs";
import path from "node:path";
import type { Policy } from "./policy";

/**
 * A JSON file on disk.
 *
 * Deliberately not a database. Almost everything that matters already lives
 * on one of the two chains — the vault, the capsule, the bounds, the status,
 * the whole event history. What is left is genuinely local: the per-capsule
 * salt (which must stay secret or the recipient commitment is guessable) and
 * the policy document we serve for verification.
 *
 * If this file is lost, capabilities keep working. Only redemption of bound
 * links and policy verification break, which is the right blast radius for
 * a hackathon's worth of persistence.
 */
export interface IntentRecord {
  /** ENS label, e.g. "cap-5ae33d25". The name is the primary key. */
  label: string;
  name: string;
  vaultId: string;
  capsuleId: string;
  policy: Policy;
  policyHash: string;
  /** Salt for the recipient email commitment. Secret. */
  salt: string;
  /** Plain address, server-side only — the public record carries a mask. */
  recipientEmail: string | null;
  issuerAddress: string;
  /**
   * The World session the issuer proved under at mint.
   *
   * A session nullifier is stable for one human across every proof in the
   * session, so binding a later escalation to this same session is what
   * makes "the same human who wrote the limit approved raising it" a
   * check rather than an aspiration. Per-action nullifiers cannot do it:
   * they differ by construction between two actions.
   */
  worldSessionId?: string | null;
  createdAt: number;
  /**
   * The agent's outstanding ask, if any.
   *
   * The authoritative record is the EscalationRequested event on chain —
   * this is a local index so the issuer's page can find it without
   * scanning events, and it is deliberately not trusted for anything. The
   * approval asserts against the capsule, not against this.
   */
  escalation?: {
    amount: string;
    reason: string;
    nonce: string;
    signalHash: string;
    requestedAt: number;
    approvedAt?: number;
  } | null;
}

const FILE = path.join(process.cwd(), ".data", "intents.json");

function load(): Record<string, IntentRecord> {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<string, IntentRecord>;
  } catch {
    return {};
  }
}

function save(all: Record<string, IntentRecord>): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}

export function putIntent(record: IntentRecord): void {
  const all = load();
  all[record.label] = record;
  save(all);
}

export function getIntent(label: string): IntentRecord | null {
  return load()[label] ?? null;
}

export function setEscalation(
  label: string,
  escalation: IntentRecord["escalation"],
): void {
  const all = load();
  const r = all[label];
  if (!r) return;
  all[label] = { ...r, escalation };
  save(all);
}

export function listIntents(issuerAddress?: string): IntentRecord[] {
  const all = Object.values(load());
  const filtered = issuerAddress
    ? all.filter((r) => r.issuerAddress.toLowerCase() === issuerAddress.toLowerCase())
    : all;
  return filtered.sort((a, b) => b.createdAt - a.createdAt);
}

/** Everything safe to hand to a browser. No salt, no plain email. */
export function publicView(r: IntentRecord) {
  return {
    label: r.label,
    name: r.name,
    vaultId: r.vaultId,
    capsuleId: r.capsuleId,
    policy: r.policy,
    policyHash: r.policyHash,
    boundTo: r.policy.boundTo,
    createdAt: r.createdAt,
  };
}
