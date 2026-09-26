/**
 * Mint a fresh set of World actions and rewrite .env.local.
 *
 *   npx tsx --env-file=.env.local scripts/world-actions.ts
 *
 * Actions created through the portal default to one verification per human,
 * and the API offers no way to change it. That is the right default for most
 * things and exactly wrong here: uniqueness is already enforced on-chain by
 * assert!(holder.is_none()), so all we want from World is "a unique human",
 * not "a human who has never used this app".
 *
 * Until that setting is changed in the portal, run this whenever a run burns
 * them. Each moment in the flow gets its own action so one person can play
 * issuer, recipient and approver in a single demo without colliding.
 */
import fs from "node:fs";

const KEY = process.env.WORLD_API_KEY!;
const APP = process.env.NEXT_PUBLIC_WORLD_APP_ID!;
const ENV_PATH = ".env.local";

const MOMENTS = [
  ["NEXT_PUBLIC_WORLD_ACTION_ISSUE", "issue", "Create an IntentLink permission"],
  ["NEXT_PUBLIC_WORLD_ACTION_IDENTITY", "redeem", "Claim an IntentLink permission"],
  ["NEXT_PUBLIC_WORLD_ACTION_ESCALATION", "escalate", "Approve an agent to exceed its limit"],
] as const;

async function createAction(action: string, description: string) {
  const res = await fetch("https://developer.world.org/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_world_id_action",
        arguments: { app_id: APP, action, description, environment: "production" },
      },
    }),
  });
  const body = (await res.json()) as {
    result?: { content?: { text?: string }[] };
    error?: { message?: string };
  };
  if (body.error) throw new Error(body.error.message ?? "create failed");
  return JSON.parse(body.result?.content?.[0]?.text ?? "{}").action?.id as string;
}

async function main() {
  if (!KEY || !APP) throw new Error("WORLD_API_KEY and NEXT_PUBLIC_WORLD_APP_ID are required");

  const stamp = Math.floor(Date.now() / 1000).toString(36);
  let env = fs.readFileSync(ENV_PATH, "utf8");

  console.log();
  for (const [varName, slug, description] of MOMENTS) {
    const action = `intentlink-${slug}-${stamp}`;
    const id = await createAction(action, description);
    env = env.replace(new RegExp(`^${varName}=.*$`, "m"), `${varName}=${action}`);
    if (!new RegExp(`^${varName}=`, "m").test(env)) env += `\n${varName}=${action}\n`;
    console.log(`  ${varName.padEnd(36)} ${action}  ${id ? "✓" : "?"}`);
  }

  fs.writeFileSync(ENV_PATH, env);
  console.log("\n  .env.local updated — restart the dev server.\n");
}

main().catch((e) => {
  console.error("\n  " + (e as Error).message + "\n");
  process.exit(1);
});
