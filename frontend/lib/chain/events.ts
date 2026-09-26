import { suiClient } from "./client";
import { MODULE, PACKAGE_ID, PACKAGE_LATEST } from "./config";

/**
 * The history, read from the chain rather than from us.
 *
 * Every consequential thing the contract does emits an event, so this
 * timeline is reconstructed from Sui and not from any record we keep. That
 * distinction is the point: a log our server writes is a claim about what
 * happened, and this is the thing that actually happened. Delete our
 * database and the history survives; disagree with it and the chain wins.
 *
 * Both package versions are queried, and that is not belt-and-braces.
 *
 * A struct that existed before an upgrade keeps the original package id in
 * its type forever — `Executed` is still `0x2df6…::intentlink::Executed`
 * even when emitted by the new bytecode. But a struct *introduced* by the
 * upgrade is named after the version that declared it, so
 * `EscalationRequested` is `0x095f…::intentlink::EscalationRequested` and
 * matches no filter built from the original id.
 *
 * Querying one package looks like it works — you get a plausible,
 * chronological, entirely incomplete history, missing exactly the events
 * added most recently. Which is to say, the ones you are most likely to be
 * demonstrating.
 */

export type HistoryKind =
  | "minted"
  | "redeemed"
  | "executed"
  | "swapped"
  | "escalation_requested"
  | "permit_minted"
  | "permit_consumed"
  | "window_rolled"
  | "skipped"
  | "revoked"
  | "vault_revoked"
  | "paused"
  | "surrendered"
  | "caps_reduced"
  | "funded"
  | "withdrawn";

export interface HistoryEntry {
  kind: HistoryKind;
  /** ms since epoch. Falls back to the checkpoint when the event has no clock. */
  atMs: number | null;
  digest: string;
  /** Who caused it, as far as the chain is concerned. */
  actor: string | null;
  amount: string | null;
  detail: string | null;
  /** Did this need an escalation permit? */
  elevated: boolean;
  fields: Record<string, unknown>;
}

/** Move event name → how we describe it. */
const KINDS: Record<string, HistoryKind> = {
  CapsuleMinted: "minted",
  CapsuleRedeemed: "redeemed",
  Executed: "executed",
  Swapped: "swapped",
  EscalationRequested: "escalation_requested",
  PermitMinted: "permit_minted",
  PermitConsumed: "permit_consumed",
  WindowRolled: "window_rolled",
  Skipped: "skipped",
  CapsuleRevoked: "revoked",
  VaultRevoked: "vault_revoked",
  PauseChanged: "paused",
  Surrendered: "surrendered",
  CapsReduced: "caps_reduced",
  VaultFunded: "funded",
  Withdrawn: "withdrawn",
};

/** Why the agent declined. Mirrors the SkipReason constants. */
const SKIP_REASONS: Record<number, string> = {
  0: "unspecified",
  1: "would exceed the daily budget",
  2: "would exceed the total budget",
  3: "pool not in scope",
  4: "slippage too high",
  5: "counterparty screened",
  6: "escalation denied",
  7: "market conditions",
};

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function bytesToText(v: unknown): string | null {
  if (typeof v === "string") {
    try {
      const t = Buffer.from(v, "base64").toString("utf8");
      return /^[\x20-\x7e]*$/.test(t) && t.length > 0 ? t : v;
    } catch {
      return v;
    }
  }
  if (Array.isArray(v)) {
    const t = Buffer.from(v.map(Number)).toString("utf8");
    return /^[\x20-\x7e]*$/.test(t) && t.length > 0 ? t : null;
  }
  return null;
}

/**
 * Everything that has happened to one capsule, oldest first.
 *
 * Both sides of a link see the same list. The recipient is accountable for
 * what the agent did with their authority and the issuer is paying for it,
 * so neither is well served by a history only the other can audit.
 */
export async function readHistory(
  capsuleId: string,
  vaultId?: string,
  limit = 200,
): Promise<HistoryEntry[]> {
  type RawEvent = {
    eventType?: string;
    json?: Record<string, unknown>;
    transactionDigest?: string;
    sender?: string;
    eventIndex?: number;
  };

  /*
   * Both package versions, and that is not belt-and-braces.
   *
   * A struct that existed before an upgrade keeps the original package id
   * in its type forever — `Executed` is still `0x2df6…::intentlink::
   * Executed` even when emitted by the new bytecode. But a struct
   * *introduced* by the upgrade is named after the version that declared
   * it, so `EscalationRequested` is `0x095f…::intentlink::
   * EscalationRequested` and matches no filter built from the original id.
   *
   * Querying one package looks like it works. You get a plausible,
   * chronological, entirely incomplete history — missing precisely the
   * events added most recently, which are the ones you are most likely to
   * be demonstrating.
   */
  const modules = [...new Set([PACKAGE_ID, PACKAGE_LATEST])];
  const pages = await Promise.all(
    modules.map(async (pkg) => {
      try {
        const r = (await suiClient().core.listEvents({
          filter: { eventType: `${pkg}::${MODULE}` },
          limit,
        })) as unknown as { events?: RawEvent[] };
        return r.events ?? [];
      } catch {
        // A version that has emitted nothing of its own is not an error.
        return [] as RawEvent[];
      }
    }),
  );

  // One transaction can emit several events, so identity is digest + index.
  const seen = new Set<string>();
  const raw = pages.flat().filter((e) => {
    const key = `${e.transactionDigest}:${e.eventIndex ?? 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const out: HistoryEntry[] = [];

  for (const e of raw) {
    const name = (e.eventType ?? "").split("::").pop() ?? "";
    const kind = KINDS[name];
    if (!kind) continue;

    const f = (e.json ?? {}) as Record<string, unknown>;

    // Vault-level events carry no capsule id, so they are matched on the
    // vault instead — otherwise a revoke-and-sweep vanishes from the very
    // timeline that should record it.
    const onCapsule = str(f.capsule_id) === capsuleId;
    const onVault = Boolean(vaultId) && str(f.vault_id) === vaultId;
    if (!onCapsule && !onVault) continue;

    const at = f.at_ms ?? f.window_start_ms;
    out.push({
      kind,
      atMs: at === undefined || at === null ? null : Number(at),
      digest: e.transactionDigest ?? "",
      actor: str(f.by ?? f.holder ?? f.principal ?? f.funder ?? e.sender),
      amount: str(f.amount ?? f.amount_in ?? f.returned ?? f.max_amount ?? f.available),
      detail: describe(kind, f),
      elevated: Boolean(f.elevated),
      fields: f,
    });
  }

  // Oldest first — a history reads forwards. Events without a clock keep
  // their arrival order rather than being flung to one end.
  return out.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
}

function describe(kind: HistoryKind, f: Record<string, unknown>): string | null {
  switch (kind) {
    case "swapped":
      return `${sui(f.amount_in)} SUI → ${sui(f.amount_out)} DUSD`;
    case "executed":
      return `${sui(f.amount)} SUI · ${sui(f.total_spent)} spent in total`;
    case "skipped": {
      const code = Number(f.reason_code ?? 0);
      const extra = bytesToText(f.detail);
      return extra ?? SKIP_REASONS[code] ?? "declined";
    }
    case "escalation_requested":
      return `asked for ${sui(f.amount)} SUI`;
    case "permit_minted":
      return `approved up to ${sui(f.max_amount)} SUI, once`;
    case "permit_consumed":
      return `spent ${sui(f.amount)} of ${sui(f.max_amount)} SUI`;
    case "window_rolled":
      return `period ${str(f.window_index)} · ${sui(f.available)} SUI available`;
    case "paused":
      return f.issuer_paused || f.principal_paused ? "paused" : "resumed";
    case "revoked":
    case "surrendered":
      return `${sui(f.spent)} SUI had been spent`;
    case "vault_revoked":
      return `${sui(f.returned)} SUI returned to the sender`;
    case "caps_reduced":
      return `now ${sui(f.per_window_cap)} SUI per period`;
    case "redeemed":
      return "verified as a unique human";
    case "funded":
      return `${sui(f.amount)} SUI added`;
    case "withdrawn":
      return `${sui(f.amount)} SUI withdrawn`;
    default:
      return null;
  }
}

function sui(v: unknown): string {
  if (v === null || v === undefined) return "—";
  return (Number(v) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 });
}
