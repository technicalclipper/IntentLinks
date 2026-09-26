import fs from "node:fs";
import path from "node:path";
import { get, put } from "@vercel/blob";
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
  /**
   * Whose agent holds this, decided once at redemption.
   *
   * Recorded so the interface can say "your agent" rather than implying
   * every capability is driven by ours. The chain is authoritative — the
   * capsule's `holder` is the fact — and this is the label for it.
   */
  agentMode?: "managed" | "delegated" | "external";
  agentAddress?: string;
  /**
   * The World nullifier of whoever redeemed this.
   *
   * Retained so a proof leaves a trace: it is what a one-per-person
   * campaign across several links would compare, and without keeping it
   * the verification at redemption is unauditable after the fact. It is
   * not currently compared against anything — one capsule can only be
   * claimed once regardless, and that is the chain's doing, not World's.
   */
  claimerNullifier?: string | null;
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

/**
 * Where the records live.
 *
 * Locally: a JSON file beside the project. Deployed: a private Vercel Blob.
 *
 * The file was not merely inconvenient in production, it was wrong. Vercel
 * runs each request on whichever instance is free, so a mint wrote to one
 * machine's /tmp and the click that followed read an empty disk on
 * another. The link 404'd while the capability it named was live on Sui —
 * the worst kind of failure, because the chain was fine and the index was
 * lying.
 *
 * The blob is private. These records hold per-capsule salts and plain
 * recipient emails, and a public blob with an unguessable name is not
 * privacy, it is a bet on nobody looking.
 */
const DATA_DIR =
  process.env.INTENTLINK_DATA_DIR ?? path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "intents.json");

const BLOB_KEY = "intents.json";
const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

/**
 * A short-lived cache.
 *
 * Every route reads the store at least once, and a blob round-trip per
 * call would put a network hop in front of pages that already wait on two
 * chains. Two seconds is long enough to collapse the reads inside one
 * request and short enough that a mint on another instance shows up
 * before anyone reloads.
 */
let cache: { at: number; data: Record<string, IntentRecord> } | null = null;
const TTL_MS = 2_000;

async function load(): Promise<Record<string, IntentRecord>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;

  let data: Record<string, IntentRecord> = {};
  if (useBlob()) {
    try {
      const res = await get(BLOB_KEY, { access: "private", useCache: false });
      if (res?.stream) {
        const text = await new Response(res.stream).text();
        if (text) data = JSON.parse(text) as Record<string, IntentRecord>;
      }
    } catch {
      // A store that has never been written has no blob yet. An empty map
      // is the correct reading of that, not an error.
    }
  } else {
    try {
      data = JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<string, IntentRecord>;
    } catch {
      data = {};
    }
  }

  cache = { at: Date.now(), data };
  return data;
}

async function save(all: Record<string, IntentRecord>): Promise<void> {
  // Update the cache first so a read inside the same request sees the
  // write, whether or not the round-trip has landed.
  cache = { at: Date.now(), data: all };

  const body = JSON.stringify(all, null, 2);
  if (useBlob()) {
    await put(BLOB_KEY, body, {
      access: "private",
      contentType: "application/json",
      allowOverwrite: true,
      addRandomSuffix: false,
    });
    return;
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, body);
}

export async function putIntent(record: IntentRecord): Promise<void> {
  const all = await load();
  all[record.label] = record;
  await save(all);
}

export async function getIntent(label: string): Promise<IntentRecord | null> {
  return (await load())[label] ?? null;
}

export async function setClaimer(label: string, claimerNullifier: string | null): Promise<void> {
  const all = await load();
  const r = all[label];
  if (!r) return;
  all[label] = { ...r, claimerNullifier };
  await save(all);
}

export async function setAgent(
  label: string,
  agentMode: IntentRecord["agentMode"],
  agentAddress: string,
): Promise<void> {
  const all = await load();
  const r = all[label];
  if (!r) return;
  all[label] = { ...r, agentMode, agentAddress };
  await save(all);
}

export async function setEscalation(
  label: string,
  escalation: IntentRecord["escalation"],
): Promise<void> {
  const all = await load();
  const r = all[label];
  if (!r) return;
  all[label] = { ...r, escalation };
  await save(all);
}

export async function listIntents(issuerAddress?: string): Promise<IntentRecord[]> {
  const all = Object.values(await load());
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
