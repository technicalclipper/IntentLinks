import { randomBytes } from "node:crypto";
import { Transaction } from "@mysten/sui/transactions";
import { agentAddress, agentKeypair, signAndExecute, suiClient } from "@/lib/chain/client";
import { DEMO_POOL_ID, RIVAL_POOL_ID } from "@/lib/chain/config";
import { findPermitFor, readCapsule } from "@/lib/chain/read";
import { attempt, beneficiaryOf, skip } from "@/lib/agent";
import { PACKAGE_ID } from "@/lib/chain/config";
import { requestEscalation } from "@/lib/chain/tx";
import { getIntent, setEscalation } from "@/lib/store";
import { escalationSignal } from "@/lib/world";

export const dynamic = "force-dynamic";

/**
 * Trigger one action on demand.
 *
 * The scripted run is the story; this is for driving it by hand. Waiting for
 * a real budget window to roll is not something a demo can do, and a judge
 * asking "what if it tries X" deserves an answer in two seconds rather than
 * a description.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ label: string }> },
) {
  const { label } = await params;
  const record = getIntent(label);
  if (!record) return Response.json({ error: "not found" }, { status: 404 });

  try {
    const { action } = (await request.json()) as {
      action?:
        | "within"
        | "over"
        | "wrongPool"
        | "keepProceeds"
        | "decline"
        | "escalate"
        | "usePermit";
    };

    const c = await readCapsule(record.capsuleId);
    if (!c.holder) {
      return Response.json({ error: "this intent has not been redeemed yet" }, { status: 409 });
    }

    const beneficiary = beneficiaryOf(c);
    const cap = c.perWindowCap;
    const half = cap / 2n > 0n ? cap / 2n : 1n;
    const base = {
      poolId: DEMO_POOL_ID,
      recipient: beneficiary,
      slippageBps: c.maxSlippageBps,
    };

    /*
     * The agent asks to exceed its cap.
     *
     * This is the entirety of what it can do about a limit: put the request
     * on chain, signed with its own key, where the issuer can see it. The
     * Permit it wants can only come from approve_escalation, which asserts
     * the sender is the issuer — so there is no path from here to there
     * that the agent can walk by itself.
     */
    if (action === "escalate") {
      const amount = c.perWindowCap * 2n;
      const nonce = randomBytes(8).toString("hex");
      const signalHash = escalationSignal(record.capsuleId, amount.toString(), nonce);

      const tx = new Transaction();
      requestEscalation(tx, {
        capsuleId: record.capsuleId,
        amount,
        reasonCode: 1,
        signalHash,
      });
      tx.setSender(agentAddress());
      const res = await signAndExecute(tx, agentKeypair());
      if (!res.success) {
        return Response.json({ error: res.error ?? "could not ask" }, { status: 400 });
      }

      setEscalation(label, {
        amount: amount.toString(),
        reason: "today's budget is spent and the spread is unusually good",
        nonce,
        signalHash,
        requestedAt: Date.now(),
      });

      return Response.json({
        events: [
          {
            kind: "propose",
            text: "ask the issuer to raise today's limit",
            amount: `${(Number(amount) / 1e9).toFixed(4)} SUI`,
            meta: "request_escalation · signed by the agent",
          },
          {
            kind: "skipped",
            text: "awaiting the issuer",
            reason: "asked — the agent cannot approve this itself",
          },
          {
            kind: "info",
            text: "On chain as an EscalationRequested event. A Permit can only be minted by approve_escalation, which asserts the sender is the capsule's issuer — so the agent has no path to one. Approve it from Your intents.",
          },
        ],
      });
    }

    /* Spend the one-shot Permit the issuer minted. */
    if (action === "usePermit") {
      const permitId = await findPermit(record.capsuleId);
      if (!permitId) {
        return Response.json(
          { error: "no permit — the issuer has not approved anything yet" },
          { status: 409 },
        );
      }
      const amount = c.perWindowCap * 2n;
      const events = await attempt(
        record.capsuleId,
        record.vaultId,
        { ...base, amount },
        { label: "sell above the daily limit, with the issuer's permit", permitId },
        undefined,
        record.name,
      );
      setEscalation(label, null);
      return Response.json({ events });
    }

    if (action === "decline") {
      return Response.json({
        events: [await skip(record.capsuleId, "spread wider than the 7-day average")],
      });
    }

    const plan = {
      within: { p: { ...base, amount: half }, label: "sell SUI for DUSD" },
      over: { p: { ...base, amount: cap * 2n }, label: "sell past the daily limit" },
      wrongPool: {
        p: { ...base, amount: half, poolId: RIVAL_POOL_ID },
        label: "route through another pool",
      },
      keepProceeds: {
        p: { ...base, amount: half, recipient: agentAddress() },
        label: "keep the proceeds",
      },
    }[action ?? "within"];

    const events = await attempt(
      record.capsuleId,
      record.vaultId,
      plan.p,
      { label: plan.label },
      undefined,
      record.name,
    );
    return Response.json({ events });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

/**
 * The Permit the issuer minted for *this* capsule, if there is one.
 *
 * Permits are transferred straight to the agent and have no `store`, so
 * this is the only place one can be — and Move will not let a second exist
 * for the same approval.
 */
async function findPermit(capsuleId: string): Promise<string | null> {
  // Type identity is fixed at definition, so a Permit minted by the
  // upgraded package is still named after the package that defined it.
  return findPermitFor(agentAddress(), capsuleId, `${PACKAGE_ID}::intentlink::Permit`);
}
