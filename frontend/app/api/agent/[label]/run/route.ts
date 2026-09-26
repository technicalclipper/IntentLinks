import { agentAddress } from "@/lib/chain/client";
import { DEMO_POOL_ID, RIVAL_POOL_ID } from "@/lib/chain/config";
import { readCapsule } from "@/lib/chain/read";
import { attempt, beneficiaryOf, poolQuote, skip, type AgentEvent } from "@/lib/agent";
import { getIntent } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Run the agent and stream what happens.
 *
 * Server-sent events rather than websockets: this is one direction, and SSE
 * is far less to go wrong live.
 *
 * The sequence is chosen so the refusals are visible. A demo where everything
 * succeeds proves nothing that a plain script could not — the interesting
 * frames are the ones where the chain says no, and there are four different
 * reasons it can.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ label: string }> },
) {
  const { label } = await params;
  const record = await getIntent(label);
  if (!record) return new Response("not found", { status: 404 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: AgentEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

      try {
        const c = await readCapsule(record.capsuleId);
        if (!c.holder) {
          send({ kind: "info", text: "This intent has not been redeemed yet." });
          controller.close();
          return;
        }

        const beneficiary = beneficiaryOf(c);
        const cap = c.perWindowCap;
        const base = { poolId: DEMO_POOL_ID, recipient: beneficiary, slippageBps: c.maxSlippageBps };

        const { reserveA, reserveB } = await poolQuote(cap);
        send({
          kind: "info",
          text: `Pool reserves ${(Number(reserveA) / 1e9).toFixed(3)} SUI / ${(Number(reserveB) / 1e9).toFixed(1)} DUSD — the agent reads this and decides.`,
        });
        await pause(600);

        // 1 — an ordinary action, well inside the bounds.
        const portion = cap / 2n > 0n ? cap / 2n : 1n;
        for (const e of await attempt(record.capsuleId, record.vaultId, { ...base, amount: portion }, {
          label: "sell SUI for DUSD",
        })) {
          send(e);
          await pause(280);
        }
        await pause(500);

        // 2 — the same again, which now exceeds today's budget.
        for (const e of await attempt(record.capsuleId, record.vaultId, { ...base, amount: cap }, {
          label: "sell again, same day",
        })) {
          send(e);
          await pause(280);
        }
        await pause(500);

        // 3 — a venue the issuer never approved.
        for (const e of await attempt(
          record.capsuleId,
          record.vaultId,
          {
            ...base,
            amount: portion,
            poolId: RIVAL_POOL_ID,
          },
          { label: "route through another pool" },
        )) {
          send(e);
          await pause(280);
        }
        await pause(500);

        // 4 — a legitimate trade whose proceeds go to the agent instead.
        for (const e of await attempt(
          record.capsuleId,
          record.vaultId,
          { ...base, amount: portion, recipient: agentAddress() },
          { label: "keep the proceeds" },
        )) {
          send(e);
          await pause(280);
        }
        await pause(500);

        // 5 — a decision not to act, which the chain cannot verify either way.
        send(await skip(record.capsuleId, "spread wider than the 7-day average"));
        await pause(400);

        send({
          kind: "info",
          text: "Four refusals, one of them on a perfectly valid trade. None of it depended on the agent behaving.",
        });
      } catch (e) {
        send({ kind: "info", text: `stopped: ${(e as Error).message}` });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
