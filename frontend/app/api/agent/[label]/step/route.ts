import { agentAddress } from "@/lib/chain/client";
import { DEMO_POOL_ID, RIVAL_POOL_ID } from "@/lib/chain/config";
import { readCapsule } from "@/lib/chain/read";
import { attempt, beneficiaryOf, skip } from "@/lib/agent";
import { getIntent } from "@/lib/store";

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
      action?: "within" | "over" | "wrongPool" | "keepProceeds" | "decline";
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

    const events = await attempt(record.capsuleId, record.vaultId, plan.p, {
      label: plan.label,
    });
    return Response.json({ events });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
