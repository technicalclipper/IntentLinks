/**
 * Issues a real capability subname on Sepolia and reads it back.
 *   npx tsx --env-file=.env.local scripts/ens-test.ts
 */
import { issueCapsuleName, policyAgrees, readCapsuleName, setStatus } from "../lib/ens";

let pass = 0, fail = 0;
const ok = (m: string, d = "") => (pass++, console.log(`  \x1b[32mPASS\x1b[0m  ${m}${d ? `  ${d}` : ""}`));
const bad = (m: string, d = "") => (fail++, console.log(`  \x1b[31mFAIL\x1b[0m  ${m}${d ? `  ${d}` : ""}`));

async function main() {
  const label = `cap-${Date.now().toString(36)}`;
  const POLICY = "0x3f3f3f3f";

  const records = {
    vault: "0x1c7121189abcdef0000000000000000000000000000000000000000000000001",
    capsule: "0x5ae33d25abcdef00000000000000000000000000000000000000000000000002",
    policy: POLICY,
    status: "unclaimed" as const,
    expires: String(Math.floor(Date.now() / 1000) + 30 * 86400),
    description: "Swap up to 20 SUI/day on Cetus · 30 days · revocable",
  };

  console.log(`\nissuing ${label}.intentlink.eth\n`);

  try {
    const r = await issueCapsuleName(label, records);
    ok("register", r.registerTx.slice(0, 14) + "…");
    ok("records written", r.recordsTx.slice(0, 14) + "…");
    console.log(`\n  ${r.name}`);
    console.log(`  node ${r.node}\n`);

    const read = await readCapsuleName(r.name);
    read.vault === records.vault ? ok("il:vault round-trips") : bad("il:vault", String(read.vault));
    read.capsule === records.capsule ? ok("il:capsule round-trips") : bad("il:capsule", String(read.capsule));
    read.policy === POLICY ? ok("il:policy round-trips") : bad("il:policy", String(read.policy));
    read.status === "unclaimed" ? ok("il:status round-trips") : bad("il:status", String(read.status));

    policyAgrees(read.policy, POLICY) ? ok("ENS and Sui agree on the policy") : bad("policy cross-check");
    !policyAgrees(read.policy, "0xdeadbeef") ? ok("disagreement is detected") : bad("disagreement not detected");

    await setStatus(label, "revoked");
    const after = await readCapsuleName(r.name);
    after.status === "revoked" ? ok("status flips to revoked") : bad("status flip", String(after.status));
  } catch (e) {
    bad("threw", (e as Error).message.split("\n").slice(0, 3).join(" | ").slice(0, 400));
  }

  console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crashed:", e); process.exit(1); });
