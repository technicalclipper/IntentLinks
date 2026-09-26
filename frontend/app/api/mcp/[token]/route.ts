import { Transaction } from "@mysten/sui/transactions";
import { executeSponsored } from "@/lib/chain/sponsor";
import { DEMO_POOL_ID } from "@/lib/chain/config";
import { readCapsule, readVault } from "@/lib/chain/read";
import { capsuleStatus } from "@/lib/chain/types";
import { readHistory } from "@/lib/chain/events";
import { requestEscalation } from "@/lib/chain/tx";
import { attempt, beneficiaryOf, poolQuote } from "@/lib/agent";
import { delegatedAddress, delegatedKeypair, tokenMatches } from "@/lib/agent/byoa";
import { escalationSignal } from "@/lib/world";
import { listIntents, setEscalation, type IntentRecord } from "@/lib/store";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";

/**
 * A capability, as an MCP server.
 *
 * Any agent that speaks MCP — Claude Desktop, Cursor, something someone
 * wrote this morning — can connect to one of these and act inside the
 * permission, with no code and no key handling. One line of config.
 *
 * There are two layers here and they are deliberately independent.
 *
 * The tool list is generated from the capsule, so an agent cannot see a
 * tool for something outside its scope, and every description carries the
 * live numbers. That is ergonomics: it stops an agent wasting its turn on
 * an action that was never going to land. It is soft, and an agent that
 * ignores it loses nothing.
 *
 * Underneath, `execute` builds the same transaction our own agent builds
 * and meets the same fifteen asserts. An agent that ignores every
 * description and asks for ten times the cap gets E_OVER_WINDOW_CAP and
 * moves no coin. That is the guarantee, and it does not depend on the
 * agent having read anything.
 *
 * This is why handing a capability to an agent we did not write is
 * reasonable rather than reckless.
 */

const PROTOCOL_VERSION = "2024-11-05";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const SUI = 1e9;
const sui = (v: bigint | string | number) => (Number(v) / SUI).toFixed(4);

function ok(id: RpcRequest["id"], result: unknown) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function err(id: RpcRequest["id"], code: number, message: string) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/** A tool result, in the shape MCP clients render. */
function text(payload: unknown, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
    isError,
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  let body: RpcRequest;
  try {
    body = (await request.json()) as RpcRequest;
  } catch {
    return err(null, -32700, "parse error");
  }

  // Find the capability this token belongs to. Tokens are derived from the
  // capsule id, so this is a scan over a handful of records rather than a
  // lookup table that can fall out of step with them.
  const record = listMatching(token);
  if (!record) return err(body.id, -32001, "unknown or revoked connection token");

  try {
    switch (body.method) {
      case "initialize":
        return ok(body.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: `intentlink:${record.label}`, version: "1.0.0" },
        });

      case "notifications/initialized":
        return new Response(null, { status: 204 });

      case "ping":
        return ok(body.id, {});

      case "tools/list":
        return ok(body.id, { tools: await tools(record) });

      case "tools/call":
        return ok(body.id, await call(record, body.params ?? {}));

      default:
        return err(body.id, -32601, `method not found: ${body.method}`);
    }
  } catch (e) {
    return err(body.id, -32603, (e as Error).message);
  }
}

/**
 * Which capability this token opens.
 *
 * Tokens are derived from the capsule id rather than stored, so this is a
 * scan over a handful of records instead of a lookup table that can fall
 * out of step with them. The comparison inside is constant-time.
 */
function listMatching(token: string): IntentRecord | null {
  for (const r of listIntents()) {
    if (tokenMatches(token, r.capsuleId)) return r;
  }
  return null;
}

/**
 * The tool list, written from the capsule.
 *
 * Descriptions carry the live figures rather than placeholders, because an
 * agent reads these once at connection and then reasons from them — a
 * description saying "up to your daily limit" teaches it nothing, while
 * "at most 0.0100 SUI right now" lets it plan a turn that can succeed.
 */
async function tools(record: IntentRecord) {
  const c = await readCapsule(record.capsuleId);
  const s = capsuleStatus(c, Date.now());

  const base = [
    {
      name: "get_permission",
      description:
        `What this agent may do with capability ${record.name}, and what is left of it. ` +
        `Call this first; the limits move as you spend and as periods roll.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "get_history",
      description: "Everything this capability has already done, read from Sui.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];

  // Nothing further is offered once the capability is over. The chain would
  // refuse anyway; showing the tools would just invite a wasted turn.
  if (s.phase === "ended") return base;

  return [
    ...base,
    {
      name: "quote",
      description:
        "What the approved pool would pay for an amount of SUI, before committing to a trade.",
      inputSchema: {
        type: "object",
        properties: {
          amount_sui: { type: "number", description: "Amount of SUI to price." },
        },
        required: ["amount_sui"],
        additionalProperties: false,
      },
    },
    {
      name: "execute",
      description:
        `Sell SUI for DUSD through the approved pool and settle to the beneficiary. ` +
        `At most ${sui(s.windowRemaining)} SUI right now (${sui(c.perActionCap)} per action, ` +
        `${sui(c.perWindowCap)} per period). Larger amounts are refused by the chain, not by ` +
        `this tool — you will get an abort code and nothing will move.`,
      inputSchema: {
        type: "object",
        properties: {
          amount_sui: { type: "number", description: "Amount of SUI to sell." },
          reason: { type: "string", description: "Why, for the human's audit log." },
        },
        required: ["amount_sui"],
        additionalProperties: false,
      },
    },
    {
      name: "request_escalation",
      description:
        `Ask the person who issued this capability to allow a single action above the ` +
        `usual limit, up to the hard ceiling of ${sui(c.hardCap)} SUI. You cannot approve ` +
        `this yourself: it requires their key and a fresh proof that they are present. ` +
        `Expect to wait, or to be refused.`,
      inputSchema: {
        type: "object",
        properties: {
          amount_sui: { type: "number", description: "Amount to ask for." },
          reason: { type: "string", description: "Why the limit should be lifted, once." },
        },
        required: ["amount_sui", "reason"],
        additionalProperties: false,
      },
    },
  ];
}

async function call(record: IntentRecord, params: Record<string, unknown>) {
  const name = String(params.name ?? "");
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  const c = await readCapsule(record.capsuleId);
  const s = capsuleStatus(c, Date.now());
  const holder = delegatedAddress(record.capsuleId);

  /*
   * Reads stay open; only the acting tools require being the holder.
   *
   * Everything get_permission and get_history return is already public on
   * the intent page and in Sui's event log, so gating them protects
   * nothing and makes a misconfigured connection impossible to diagnose —
   * the agent would be told "no" without being told what it is.
   *
   * execute and request_escalation are a different matter, and the chain
   * would refuse them anyway with E_NOT_HOLDER. Saying so here turns a
   * cryptic abort into a sentence naming the actual problem.
   */
  const acting = name === "execute" || name === "request_escalation";
  if (acting && c.holder && c.holder.toLowerCase() !== holder.toLowerCase()) {
    return text(
      `This capability is held by ${c.holder}, which is not this connection's agent ` +
        `(${holder}). It was redeemed with a different agent, and the chain would refuse ` +
        `any action signed here with E_NOT_HOLDER. Reading is still fine.`,
      true,
    );
  }

  switch (name) {
    case "get_permission": {
      const v = await readVault(record.vaultId);
      return text({
        capability: record.name,
        goal: record.policy.goal,
        status: s.endedBecause ?? s.phase,
        may_spend_now_sui: Number(sui(s.windowRemaining)),
        per_action_cap_sui: Number(sui(c.perActionCap)),
        per_period_cap_sui: Number(sui(c.perWindowCap)),
        total_cap_sui: Number(sui(c.totalCap)),
        hard_cap_sui: Number(sui(c.hardCap)),
        spent_sui: Number(sui(c.spent)),
        vault_balance_sui: Number(sui(v.balance)),
        periods_used: Number(c.windowsUsed),
        max_periods: Number(c.maxWindows),
        max_slippage_bps: Number(c.maxSlippageBps),
        approved_pools: c.allowedPools,
        proceeds_go_to: beneficiaryOf(c),
        expires_at: new Date(Number(c.expiresAt)).toISOString(),
        enforced_by:
          "Move asserts on Sui. These are not guidelines — exceeding any of them " +
          "aborts the transaction and moves nothing.",
      });
    }

    case "get_history": {
      const h = await readHistory(record.capsuleId, record.vaultId);
      return text(
        h.map((e) => ({
          what: e.kind,
          detail: e.detail,
          at: e.atMs ? new Date(e.atMs).toISOString() : null,
          tx: e.digest,
        })),
      );
    }

    case "quote": {
      const amount = toMist(args.amount_sui);
      if (amount === null) return text("amount_sui must be a positive number", true);
      const pool = c.allowedPools[0] ?? DEMO_POOL_ID;
      const { out } = await poolQuote(amount, pool);
      return text({
        amount_in_sui: Number(sui(amount)),
        expected_out_dusd: Number(sui(out)),
        pool,
        note: "A quote, not a promise. execute commits to a floor and reverts below it.",
      });
    }

    case "execute": {
      const amount = toMist(args.amount_sui);
      if (amount === null) return text("amount_sui must be a positive number", true);

      const events = await attempt(
        record.capsuleId,
        record.vaultId,
        {
          amount,
          poolId: c.allowedPools[0] ?? DEMO_POOL_ID,
          recipient: beneficiaryOf(c),
          slippageBps: c.maxSlippageBps,
        },
        { label: String(args.reason ?? "agent trade") },
        delegatedKeypair(record.capsuleId),
      );

      const blocked = events.find((e) => e.kind === "blocked");
      if (blocked && "code" in blocked) {
        // Returned as a tool error so the agent treats it as a wall rather
        // than as output to summarise. The abort code is the honest answer
        // to "why not", and far more useful than a sentence from us.
        return text(
          {
            refused_by: "the Sui contract",
            abort: blocked.code,
            meaning: blocked.message,
            nothing_moved: true,
          },
          true,
        );
      }

      const done = events.find((e) => e.kind === "executed");
      if (!done || !("digest" in done)) return text({ result: "no action taken" }, true);

      return text({
        executed: true,
        amount_in: done.amountIn,
        transaction: done.digest,
        settled_to: beneficiaryOf(c),
      });
    }

    case "request_escalation": {
      const amount = toMist(args.amount_sui);
      if (amount === null) return text("amount_sui must be a positive number", true);
      if (!c.holder) return text("this capability has not been redeemed", true);

      const nonce = crypto.randomBytes(8).toString("hex");
      const signalHash = escalationSignal(record.capsuleId, amount.toString(), nonce);

      const tx = new Transaction();
      requestEscalation(tx, {
        capsuleId: record.capsuleId,
        amount,
        reasonCode: 1,
        signalHash,
      });
      // Sponsored, for the same reason execute is: a delegated key has no
      // SUI and should never need any.
      const res = await executeSponsored(tx, delegatedKeypair(record.capsuleId));
      if (!res.success) return text({ asked: false, error: res.error }, true);

      setEscalation(record.label, {
        amount: amount.toString(),
        reason: String(args.reason ?? "the agent gave no reason"),
        nonce,
        signalHash,
        requestedAt: Date.now(),
      });

      return text({
        asked: true,
        amount_sui: Number(sui(amount)),
        transaction: res.digest,
        next: "The issuer must approve with their own key and a fresh World ID proof. " +
          "You cannot approve this. Poll get_permission, or carry on within your limits.",
      });
    }

    default:
      return text(`unknown tool: ${name}`, true);
  }
}

function toMist(v: unknown): bigint | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return BigInt(Math.round(n * SUI));
}
