/**
 * The keeper loop.
 *
 * Calls the tick endpoint on an interval so a standing authority actually
 * stands. It lives outside the app because that is what it would be in
 * production — a scheduler, not a page somebody has to keep open.
 *
 *   npx tsx --env-file=.env.local scripts/keeper.ts [intervalSeconds]
 *
 * It holds no keys and no authority of its own. Everything it triggers is
 * signed by the agent and bounded by the capsule, so the worst a runaway
 * keeper can manage is to waste gas being refused.
 */
const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const EVERY = Number(process.argv[2] ?? 60) * 1000;

async function tick() {
  const stamp = new Date().toLocaleTimeString();
  try {
    const res = await fetch(`${BASE}/api/keeper/tick`, { method: "POST" });
    const out = (await res.json()) as {
      results?: { label: string; did: string; detail: string }[];
      error?: string;
    };
    if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);

    const rs = out.results ?? [];
    const acted = rs.filter((r) => r.did !== "idle");
    console.log(`[${stamp}] ${rs.length} capabilities · ${acted.length} acted`);
    for (const r of acted) {
      console.log(`    ${r.label.padEnd(16)} ${r.did.padEnd(9)} ${r.detail}`);
    }
  } catch (e) {
    // A keeper that dies on one bad tick is not a keeper.
    console.log(`[${stamp}] tick failed: ${(e as Error).message.slice(0, 120)}`);
  }
}

console.log(`keeper → ${BASE} every ${EVERY / 1000}s. Ctrl-C to stop.`);
tick();
setInterval(tick, EVERY);
