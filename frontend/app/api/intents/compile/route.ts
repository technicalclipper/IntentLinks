/**
 * Compile plain English into a capability.
 *
 * The model's job is translation, not authority. It proposes; the issuer
 * confirms; the chain enforces. Nothing here decides anything — every number
 * it produces is shown back before a single transaction is built.
 *
 * The part that matters is the classification. A clause either becomes an
 * on-chain assert or it does not, and pretending otherwise would be the one
 * genuinely dishonest thing this product could do. So the model is required
 * to sort every constraint it finds into enforced, advisory, or rejected,
 * and the UI renders those three differently.
 */

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "goal",
    "perDay",
    "days",
    "maxSlippagePct",
    "beneficiary",
    "recipientEmail",
    "advisory",
    "rejected",
  ],
  properties: {
    goal: {
      type: "string",
      description: "One short line describing the action, e.g. 'Sell SUI for DUSD daily'.",
    },
    perDay: { type: "number", description: "SUI the agent may spend per day." },
    days: { type: "integer", description: "How many daily periods." },
    maxSlippagePct: { type: "number", description: "Maximum slippage percent." },
    beneficiary: {
      type: "string",
      enum: ["recipient", "vault"],
      description: "'recipient' if proceeds go to the person receiving the link.",
    },
    recipientEmail: {
      type: ["string", "null"],
      description: "Email if the text names one, otherwise null.",
    },
    advisory: {
      type: "array",
      description: "Constraints that cannot be enforced on-chain.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "why"],
        properties: {
          text: { type: "string" },
          why: { type: "string", description: "Why the chain cannot enforce it." },
        },
      },
    },
    rejected: {
      type: "array",
      description: "Requests this system cannot do at all.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "why"],
        properties: {
          text: { type: "string" },
          why: { type: "string" },
        },
      },
    },
  },
} as const;

const SYSTEM = `You translate a person's description of what an AI agent may do into a bounded capability.

The system sells SUI for DUSD on one approved pool. Money leaves a vault the issuer funds.

ENFORCED on-chain — extract these into fields:
- amount per day, number of days, max slippage percent
- who the proceeds go to (the recipient of the link, or back to the issuer)
- a recipient email address if one is named

ADVISORY — judgement the agent makes for itself, including anything about price or
market conditions. The agent CAN read the pool's live spot rate on-chain, so "buy the
dip", "when the market looks good", "if it doubles", "only if spreads are tight" are
all things it can genuinely watch for. What the chain cannot do is check that it
judged correctly. Say that, rather than claiming we cannot see prices.

REJECTED — only things the capability model itself forbids:
- spending more in one go than the stated per-day limit ("sell everything", "dump it
  all", "go all in"). Explain that this is their own limit refusing, and that the
  agent would have to ask them to approve exceeding it.
- buying SUI rather than selling it (the vault holds SUI)
- more than one asset, lending, staking, rebalancing to a target ratio

Never say "there is no oracle". The agent reads the pool price directly.

CRITICAL: advisory and rejected must contain ONLY clauses the person actually wrote.
Never list a capability they did not ask for. If they asked for nothing advisory,
return an empty array. Quote or closely paraphrase their own words in "text".

If a number is not given, choose a sensible small default and do not invent precision.
Be conservative: when a phrase is ambiguous between enforced and advisory, call it
advisory.`;

export async function POST(request: Request) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return Response.json({ error: "OPENAI_API_KEY is not set" }, { status: 500 });

  try {
    const { text } = (await request.json()) as { text?: string };
    if (!text?.trim()) return Response.json({ error: "say what the agent may do" }, { status: 400 });

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: text },
        ],
        // Structured output, so the result is a validated object rather than
        // JSON we have to hope parses. A malformed compile on stage would be
        // a bad way to open.
        response_format: {
          type: "json_schema",
          json_schema: { name: "capability", strict: true, schema: SCHEMA },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return Response.json(
        { error: `model error ${res.status}: ${body.slice(0, 300)}` },
        { status: 502 },
      );
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return Response.json({ error: "empty response" }, { status: 502 });

    const parsed = JSON.parse(content) as Record<string, unknown>;

    // Clamp to something sane regardless of what came back — the issuer is
    // about to fund this, and a stray zero should not become a vault.
    const perDay = Math.max(0.0001, Math.min(Number(parsed.perDay) || 0.02, 1000));
    const days = Math.max(1, Math.min(Number(parsed.days) || 30, 365));
    const slippage = Math.max(0.01, Math.min(Number(parsed.maxSlippagePct) || 1, 50));

    return Response.json({
      goal: String(parsed.goal ?? "Sell SUI for DUSD daily"),
      perDay,
      days,
      maxSlippagePct: slippage,
      beneficiary: parsed.beneficiary === "vault" ? "vault" : "recipient",
      recipientEmail: parsed.recipientEmail ?? null,
      advisory: onlyWhatTheyAsked(parsed.advisory, text),
      rejected: onlyWhatTheyAsked(parsed.rejected, text),
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

interface Clause {
  text: string;
  why: string;
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "if", "it", "to", "for", "of", "on", "in",
  "is", "be", "at", "by", "with", "this", "that", "not", "no", "than", "when",
  "system", "cannot", "only", "rather", "orders", "target",
]);

/**
 * Keep only clauses the person actually wrote.
 *
 * Told to list what it cannot do, the model helpfully enumerates every
 * limitation it was briefed on — so a request to sell SUI comes back also
 * refusing to lend, stake and rebalance, none of which anyone mentioned.
 * That reads as a system inventing objections, which is worse than saying
 * nothing.
 *
 * Prompting alone did not stop it, so this checks the overlap against the
 * original text and drops anything that is not grounded in it.
 */
function onlyWhatTheyAsked(items: unknown, source: string): Clause[] {
  if (!Array.isArray(items)) return [];
  const words = new Set(
    source.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean),
  );

  return (items as Clause[]).filter((c) => {
    const terms = String(c?.text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w));
    if (terms.length === 0) return false;
    const hits = terms.filter((w) => words.has(w)).length;
    return hits / terms.length >= 0.5;
  });
}
