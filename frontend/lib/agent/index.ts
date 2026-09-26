import type { Signer } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import {
  agentAddress,
  agentKeypair,
  signAndExecute,
  suiClient,
} from "../chain/client";
import { Beneficiary, DEMO_POOL_ID, SkipReason } from "../chain/config";
import { executeSponsored } from "../chain/sponsor";
import { decodeAbort } from "../chain/errors";
import { readCapsule } from "../chain/read";
import { executeSwap, logSkip } from "../chain/tx";
import type { CapsuleState } from "../chain/types";

/**
 * The agent.
 *
 * It reads the pool, decides what to do, and proposes an action. Everything
 * it decides is its own business — the strategy is not constrained and does
 * not need to be. What is constrained is what the chain will let it do, and
 * that is enforced whether the agent is well-behaved, mistaken, or hostile.
 *
 * The pre-check below mirrors the Move asserts. It exists for the interface,
 * not for safety: it lets the console say *why* something will fail before
 * spending gas finding out. It is not a security boundary and removing it
 * would change nothing about what the agent can do.
 */

export type AgentEvent =
  | { kind: "propose"; text: string; amount: string; meta?: string }
  | { kind: "engine"; ok: boolean; reason: string }
  | { kind: "executed"; digest: string; amountIn: string; text: string }
  | { kind: "blocked"; code: string; message: string; text: string }
  | { kind: "skipped"; reason: string; text: string }
  | { kind: "info"; text: string };

// Mirrors demo_pool::quote — constant product, 0.30% fee.
const FEE_BPS = 30n;
const BPS = 10_000n;

function quote(reserveIn: bigint, reserveOut: bigint, amountIn: bigint): bigint {
  if (reserveIn === 0n || reserveOut === 0n) return 0n;
  const afterFee = amountIn * (BPS - FEE_BPS);
  return (afterFee * reserveOut) / (reserveIn * BPS + afterFee);
}

/** The pool is a price feed — the agent reads it and decides for itself. */
export async function poolQuote(amountIn: bigint, poolId = DEMO_POOL_ID) {
  const res = await suiClient().core.getObject({
    objectId: poolId,
    include: { json: true },
  });
  const json = (res.object?.json ?? {}) as Record<string, unknown>;
  const f = (json.fields as Record<string, unknown>) ?? json;

  const reserveA = BigInt((f.reserve_a as string) ?? 0);
  const reserveB = BigInt((f.reserve_b as string) ?? 0);
  return {
    reserveA,
    reserveB,
    out: quote(reserveA, reserveB, amountIn),
  };
}

export interface Proposal {
  amount: bigint;
  poolId: string;
  recipient: string;
  slippageBps: bigint;
}

export interface Verdict {
  ok: boolean;
  reason: string;
}

/**
 * Pre-check, mirroring the Move asserts.
 *
 * Deliberately a mirror rather than the source of truth: the chain decides,
 * this only predicts. If the two ever disagree the chain is right and this
 * is a bug in the console, not a hole in the capability.
 */
export function check(c: CapsuleState, p: Proposal, nowMs: number): Verdict {
  const now = BigInt(nowMs);

  if (!c.holder) return { ok: false, reason: "not redeemed yet" };
  if (c.revoked) return { ok: false, reason: "revoked" };
  if (c.surrendered) return { ok: false, reason: "handed back" };
  if (c.issuerPaused || c.principalPaused) return { ok: false, reason: "paused" };
  if (now < c.notBefore) return { ok: false, reason: "not started" };
  if (now >= c.expiresAt) return { ok: false, reason: "expired" };

  // The window rolls lazily on chain, so mirror that before judging spend.
  const rolled = c.windowsUsed > 0n && now >= c.windowStartMs + c.windowMs;
  const windowSpent = rolled ? 0n : c.windowSpent;
  const windowsUsed = rolled
    ? c.windowsUsed + (now - c.windowStartMs) / c.windowMs
    : c.windowsUsed || 1n;

  if (windowsUsed > c.maxWindows) return { ok: false, reason: "no periods left" };
  if (p.amount === 0n) return { ok: false, reason: "zero amount" };
  if (p.amount > c.perActionCap) return { ok: false, reason: "over the per-action cap" };
  if (p.amount > c.hardCap) return { ok: false, reason: "over the hard ceiling" };
  if (windowSpent + p.amount > c.perWindowCap) {
    return { ok: false, reason: "over today's limit" };
  }
  if (c.spent + p.amount > c.totalCap) return { ok: false, reason: "over the total limit" };

  const norm = (s: string) => s.toLowerCase().replace(/^0x0*/, "");
  if (!c.allowedPools.some((x) => norm(x) === norm(p.poolId))) {
    return { ok: false, reason: "pool out of scope" };
  }
  if (p.slippageBps > c.maxSlippageBps) return { ok: false, reason: "slippage too high" };

  const beneficiary =
    c.beneficiaryMode === Beneficiary.PRINCIPAL
      ? c.principal
      : c.beneficiaryMode === Beneficiary.FIXED
        ? c.beneficiaryAddr
        : c.issuer;
  if (!beneficiary || norm(p.recipient) !== norm(beneficiary)) {
    return { ok: false, reason: "proceeds may not go there" };
  }

  return { ok: true, reason: "within bounds" };
}

/** Where the capsule says proceeds must land. */
export function beneficiaryOf(c: CapsuleState): string {
  if (c.beneficiaryMode === Beneficiary.PRINCIPAL) return c.principal ?? c.issuer;
  if (c.beneficiaryMode === Beneficiary.FIXED) return c.beneficiaryAddr ?? c.issuer;
  return c.issuer;
}

/**
 * Attempt one action and report what happened.
 *
 * A refusal is a normal outcome, not an exception — the whole product is the
 * chain saying no — so it comes back as an event rather than a throw.
 */
export async function attempt(
  capsuleId: string,
  vaultId: string,
  p: Proposal,
  opts: { label: string; permitId?: string } = { label: "swap" },
  /**
   * Who signs, when it is not our own agent.
   *
   * A capsule executes for exactly one address — its holder — so a
   * capability handed to someone else's agent is driven by their key, not
   * ours. Passing the signer in is the whole of what "bring your own
   * agent" costs on this side: everything below is identical, because the
   * limits were never about which program was asking.
   */
  signer?: Signer,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const c = await readCapsule(capsuleId);
  const sui = (v: bigint) => (Number(v) / 1e9).toFixed(4);

  const { out } = await poolQuote(p.amount, p.poolId);
  // The agent commits to a floor. settle() checks the coin that actually
  // came back against it, so a fill worse than this reverts the whole thing.
  const minOut = (out * (10_000n - p.slippageBps)) / 10_000n;

  events.push({
    kind: "propose",
    text: opts.label,
    amount: `${sui(p.amount)} SUI`,
    meta: out > 0n ? `expects ≥ ${sui(minOut)} DUSD` : undefined,
  });

  const verdict = check(c, p, Date.now());
  events.push({ kind: "engine", ok: verdict.ok, reason: verdict.reason });

  const tx = new Transaction();
  executeSwap(tx, {
    vaultId,
    capsuleId,
    poolId: p.poolId,
    amount: p.amount,
    minOut,
    recipient: p.recipient,
    slippageBps: p.slippageBps,
    permitId: opts.permitId,
  });
  /*
   * A delegated agent holds no SUI and should never have to.
   *
   * Our own agent funds its own gas, but a key derived for one capability
   * starts empty, and "top up this address before your agent can act"
   * would undo the whole point of pasting one line of config. The gas
   * station pays: the agent signs the action, the sponsor signs for the
   * coin, and the chain sees two signatures on identical bytes.
   */
  try {
    const r = signer
      ? await executeSponsored(tx, signer, 200_000_000n)
      : await (async () => {
          tx.setSender(agentAddress());
          tx.setGasBudget(200_000_000);
          return signAndExecute(tx, agentKeypair());
        })();
    if (r.success) {
      events.push({
        kind: "executed",
        digest: r.digest,
        amountIn: `${sui(p.amount)} SUI`,
        text: opts.label,
      });
    } else {
      const abort = decodeAbort(r.error ?? "");
      events.push({
        kind: "blocked",
        code: abort?.name ?? "ABORTED",
        message: abort?.message ?? "refused by the capability",
        text: opts.label,
      });
    }
  } catch (e) {
    const abort = decodeAbort(e);
    events.push({
      kind: "blocked",
      code: abort?.name ?? "ABORTED",
      message: abort?.message ?? String((e as Error).message).slice(0, 120),
      text: opts.label,
    });
  }

  return events;
}

/**
 * Record a decision not to act.
 *
 * Attested, never enforced. Nothing can make a chain witness a non-action,
 * and the history page marks these differently for that reason.
 */
export async function skip(
  capsuleId: string,
  reason: string,
  code: number = SkipReason.MARKET_CONDITION,
): Promise<AgentEvent> {
  const tx = new Transaction();
  logSkip(tx, { capsuleId, reasonCode: code, detail: reason });
  tx.setSender(agentAddress());
  tx.setGasBudget(50_000_000);

  try {
    await signAndExecute(tx, agentKeypair());
  } catch {
    // The refusal already happened; failing to record it changes nothing.
  }
  return { kind: "skipped", reason, text: "declined to trade" };
}
