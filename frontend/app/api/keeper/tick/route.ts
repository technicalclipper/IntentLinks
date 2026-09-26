import { DEMO_POOL_ID } from "@/lib/chain/config";
import { readCapsule } from "@/lib/chain/read";
import { capsuleStatus } from "@/lib/chain/types";
import { attempt, beneficiaryOf } from "@/lib/agent";
import { listIntents } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * One pass over every live capability.
 *
 * A standing authority is only worth having if something acts on it while
 * nobody is watching, and until now every action in this product needed a
 * human to press a button — which quietly made the recurrence in "0.02 SUI
 * a day for 30 days" a claim the UI made rather than a thing that happened.
 *
 * The keeper is deliberately dumb and deliberately unprivileged. It holds
 * no authority of its own: it signs as the agent, and the agent's bounds
 * are the capsule's. If this endpoint were called a thousand times a
 * second it could still never exceed a daily cap, touch an unapproved
 * pool, or send proceeds anywhere the capsule does not name — every one of
 * those is an abort, not a policy we are trusting the keeper to respect.
 *
 * Idempotence comes from the chain rather than from bookkeeping here. A
 * capsule whose window is already spent refuses the next action with
 * E_OVER_WINDOW_CAP, so running twice in a period is safe by construction.
 */

export interface KeeperResult {
  label: string;
  did: "executed" | "skipped" | "refused" | "idle";
  detail: string;
}

export async function POST() {
  const results: KeeperResult[] = [];

  for (const record of listIntents()) {
    try {
      const c = await readCapsule(record.capsuleId);
      const s = capsuleStatus(c, Date.now());

      if (!c.holder) {
        results.push({ label: record.label, did: "idle", detail: "not redeemed" });
        continue;
      }
      if (s.phase !== "active") {
        results.push({ label: record.label, did: "idle", detail: s.endedBecause ?? s.phase });
        continue;
      }

      // Spend what this period allows and no more. The chain would refuse
      // anything larger anyway; asking for it would just burn gas proving
      // a point we already prove elsewhere.
      const budget = s.windowRemaining;
      if (budget <= 0n) {
        results.push({ label: record.label, did: "idle", detail: "this period is spent" });
        continue;
      }

      /*
       * Trade in a pool the capsule actually allows.
       *
       * Hardcoding the demo pool made the keeper propose an out-of-scope
       * trade to every older capability, which the chain refused with
       * E_POOL_NOT_SCOPED — correct, and a pure waste of gas repeated
       * every tick. The scope is on the capsule; read it.
       */
      const poolId = c.allowedPools[0] ?? DEMO_POOL_ID;

      const amount = budget > c.perActionCap ? c.perActionCap : budget;
      const events = await attempt(
        record.capsuleId,
        record.vaultId,
        {
          amount,
          poolId,
          recipient: beneficiaryOf(c),
          slippageBps: c.maxSlippageBps,
        },
        { label: "scheduled buy" },
      );

      const blocked = events.find((e) => e.kind === "blocked");
      const done = events.find((e) => e.kind === "executed");
      results.push({
        label: record.label,
        did: blocked ? "refused" : done ? "executed" : "skipped",
        detail:
          blocked && "code" in blocked
            ? blocked.code
            : done && "amountIn" in done
              ? done.amountIn
              : "no action",
      });
    } catch (e) {
      results.push({ label: record.label, did: "idle", detail: (e as Error).message.slice(0, 90) });
    }
  }

  return Response.json({ at: new Date().toISOString(), results });
}
