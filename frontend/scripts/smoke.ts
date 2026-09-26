/**
 * End-to-end smoke test against real testnet.
 *
 * Move unit tests prove the logic. This proves the TypeScript client speaks
 * to it correctly — argument order, BCS encoding, Option wrapping, shared
 * object refs. All the things a unit test cannot catch.
 *
 *   npx tsx --env-file=.env.local scripts/smoke.ts
 */
import { Transaction } from "@mysten/sui/transactions";
import {
  agentAddress, agentKeypair, createdId, signAndExecute,
  sponsorAddress, sponsorKeypair, suiClient, type ExecResult,
} from "../lib/chain/client";
import { Beneficiary, SkipReason, VERIFIER_CAP_ID } from "../lib/chain/config";
import { decodeAbort } from "../lib/chain/errors";
import { readCapsule, readVault } from "../lib/chain/read";
import { capsuleStatus } from "../lib/chain/types";
import * as il from "../lib/chain/tx";

const MIST = 1_000_000_000n;
const DAY = 86_400_000n;

const POOL_OK = "0x00000000000000000000000000000000000000000000000000000000000900d1";
const POOL_BAD = "0x0000000000000000000000000000000000000000000000000000000000000bad";

const client = suiClient();
const sponsor = sponsorKeypair();
const agent = agentKeypair();

let pass = 0;
let fail = 0;

function ok(label: string, detail = "") {
  pass++;
  console.log(`  \x1b[32mPASS\x1b[0m  ${label}${detail ? `  ${detail}` : ""}`);
}
function bad(label: string, detail = "") {
  fail++;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? `  ${detail}` : ""}`);
}

async function run(tx: Transaction, signer = sponsor): Promise<ExecResult> {
  tx.setSender(signer.toSuiAddress());
  tx.setGasBudget(100_000_000);
  return signAndExecute(tx, signer);
}

/** Run a transaction we expect the chain to refuse, and report which assert fired. */
async function expectAbort(label: string, expected: string, tx: Transaction, signer = sponsor) {
  try {
    const r = await run(tx, signer);
    if (!r.success) {
      const d = decodeAbort(r.error ?? "");
      d?.name === expected
        ? ok(label, `→ ${d.name}`)
        : bad(label, `expected ${expected}, got ${d?.name ?? r.error}`);
    } else {
      bad(label, "transaction succeeded but should have aborted");
    }
  } catch (e) {
    const d = decodeAbort(e);
    d?.name === expected
      ? ok(label, `→ ${d.name}`)
      : bad(label, `expected ${expected}, got ${d?.name ?? String(e).slice(0, 120)}`);
  }
}

async function main() {
  console.log(`\nsponsor  ${sponsorAddress()}`);
  console.log(`agent    ${agentAddress()}`);
  console.log(`verifier ${VERIFIER_CAP_ID}\n`);

  // --- create a funded vault -------------------------------------
  console.log("vault + capsule");
  let tx = new Transaction();
  // The test moves raw units (12, 20, 60), so the vault only needs to be
  // non-trivial, not large. Keeps the sponsor's gas budget intact.
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(MIST / 50n)]);
  il.createVault(tx, coin);
  let r = await run(tx);

  const vaultId = createdId(r, "::Vault<")!;
  if (!vaultId) {
    console.log("    debug:", JSON.stringify({ success: r.success, error: r.error, created: r.created }, null, 2));
  }
  vaultId ? ok("create_vault", vaultId.slice(0, 10) + "…") : bad("create_vault");

  // --- mint a capsule --------------------------------------------
  const now = BigInt(Date.now());
  tx = new Transaction();
  il.mintCapsule(tx, {
    vaultId,
    boundRecipient: null, // bearer
    issuerNullifier: "0xdeadbeef",
    perActionCap: 20n,
    totalCap: 600n,
    hardCap: 250n,
    windowMs: DAY,
    perWindowCap: 20n,
    maxWindows: 30n,
    allowedPools: [POOL_OK],
    maxSlippageBps: 100n,
    beneficiaryMode: Beneficiary.PRINCIPAL,
    beneficiaryAddr: null,
    notBefore: 0n,
    expiresAt: now + 30n * DAY,
    ensNode: "0xabc123",
    policyHash: "0x3f3f3f",
  });
  r = await run(tx);

  const capsuleId = createdId(r, "::Capsule")!;
  capsuleId ? ok("mint_capsule", capsuleId.slice(0, 10) + "…") : bad("mint_capsule");

  // --- reader round-trips the policy -----------------------------
  console.log("\nreaders");
  const c0 = await readCapsule(capsuleId);
  c0.perWindowCap === 20n && c0.hardCap === 250n && c0.allowedPools.length === 1
    ? ok("readCapsule decodes the policy")
    : bad("readCapsule", JSON.stringify({ w: c0.perWindowCap, h: c0.hardCap }));
  c0.holder === null ? ok("capsule starts unclaimed") : bad("capsule starts unclaimed");
  capsuleStatus(c0, Date.now()).phase === "unclaimed"
    ? ok("status = unclaimed")
    : bad("status = unclaimed");

  // --- cannot execute before redemption --------------------------
  console.log("\nthe bounds");
  tx = new Transaction();
  il.execute(tx, {
    vaultId, capsuleId, amount: 5n,
    recipient: sponsorAddress(), poolId: POOL_OK, slippageBps: 100n,
  });
  await expectAbort("execute before redemption", "E_NOT_CLAIMED", tx, agent);

  // --- redeem ----------------------------------------------------
  tx = new Transaction();
  il.claim(tx, {
    verifierCapId: VERIFIER_CAP_ID!,
    capsuleId,
    principal: sponsorAddress(), // stand-in for the human
    holder: agentAddress(),
    recipientHash: null,
  });
  r = await run(tx);
  r.success ? ok("claim") : bad("claim", r.error ?? undefined);

  const c1 = await readCapsule(capsuleId);
  c1.holder === agentAddress() ? ok("holder = agent") : bad("holder = agent", c1.holder ?? "null");

  // --- happy path ------------------------------------------------
  tx = new Transaction();
  il.execute(tx, {
    vaultId, capsuleId, amount: 12n,
    recipient: sponsorAddress(), poolId: POOL_OK, slippageBps: 100n,
  });
  r = await run(tx, agent);
  r.success
    ? ok("execute 12 inside bounds")
    : bad("execute 12", r.error ?? undefined);

  const c2 = await readCapsule(capsuleId);
  c2.spent === 12n && c2.windowSpent === 12n
    ? ok("accounting", `spent=${c2.spent} window=${c2.windowSpent}`)
    : bad("accounting", `spent=${c2.spent}`);

  // --- each refusal ----------------------------------------------
  tx = new Transaction();
  il.execute(tx, {
    vaultId, capsuleId, amount: 12n,
    recipient: sponsorAddress(), poolId: POOL_OK, slippageBps: 100n,
  });
  await expectAbort("second 12 in the same window", "E_OVER_WINDOW_CAP", tx, agent);

  tx = new Transaction();
  il.execute(tx, {
    vaultId, capsuleId, amount: 21n,
    recipient: sponsorAddress(), poolId: POOL_OK, slippageBps: 100n,
  });
  await expectAbort("over the per-action cap", "E_OVER_ACTION_CAP", tx, agent);

  tx = new Transaction();
  il.execute(tx, {
    vaultId, capsuleId, amount: 5n,
    recipient: sponsorAddress(), poolId: POOL_BAD, slippageBps: 100n,
  });
  await expectAbort("out-of-scope pool", "E_POOL_NOT_SCOPED", tx, agent);

  tx = new Transaction();
  il.execute(tx, {
    vaultId, capsuleId, amount: 5n,
    recipient: sponsorAddress(), poolId: POOL_OK, slippageBps: 500n,
  });
  await expectAbort("excess slippage", "E_SLIPPAGE", tx, agent);

  tx = new Transaction();
  il.execute(tx, {
    vaultId, capsuleId, amount: 5n,
    recipient: agentAddress(), poolId: POOL_OK, slippageBps: 100n,
  });
  await expectAbort("agent keeping the proceeds", "E_WRONG_BENEFICIARY", tx, agent);

  tx = new Transaction();
  il.execute(tx, {
    vaultId, capsuleId, amount: 5n,
    recipient: sponsorAddress(), poolId: POOL_OK, slippageBps: 100n,
  });
  await expectAbort("someone other than the holder", "E_NOT_HOLDER", tx, sponsor);

  // --- skip log --------------------------------------------------
  console.log("\nattested refusals");
  tx = new Transaction();
  il.logSkip(tx, {
    capsuleId,
    reasonCode: SkipReason.MARKET_CONDITION,
    detail: "spread too wide",
  });
  r = await run(tx, agent);
  r.success ? ok("log_skip") : bad("log_skip", r.error ?? undefined);

  // --- escalation ------------------------------------------------
  console.log("\nescalation");
  // The agent may ask, and signs that itself.
  tx = new Transaction();
  il.requestEscalation(tx, {
    capsuleId,
    amount: 60n,
    reasonCode: SkipReason.WOULD_EXCEED_WINDOW,
    signalHash: "0x2222",
  });
  r = await run(tx, agent);
  r.success ? ok("request_escalation (agent)") : bad("request_escalation", r.error ?? undefined);

  // ...and may not answer itself. This is the assert the whole escalation
  // story rests on, so it gets exercised against the live chain.
  tx = new Transaction();
  il.approveEscalation(tx, {
    capsuleId, maxAmount: 60n, ttlMs: 120_000n, signalHash: "0x2222",
  });
  await expectAbort("agent cannot approve its own request", "E_NOT_ISSUER", tx, agent);

  // A different human at the issuer's own keyboard is refused too.
  tx = new Transaction();
  il.approveEscalation(tx, {
    capsuleId, maxAmount: 60n, ttlMs: 120_000n, signalHash: "0x2222",
    approverNullifier: "0xfeedface", // capsule was minted with 0xdeadbeef
  });
  await expectAbort("a different human cannot approve", "E_NOT_SAME_HUMAN", tx);

  tx = new Transaction();
  il.approveEscalation(tx, {
    capsuleId,
    maxAmount: 300n, // above the 250 hard cap
    ttlMs: 120_000n,
    signalHash: "0x1111",
  });
  await expectAbort("permit above the hard cap", "E_OVER_HARD_CAP", tx);

  // The matching nullifier — same account AND same human, both checked.
  tx = new Transaction();
  il.approveEscalation(tx, {
    capsuleId, maxAmount: 60n, ttlMs: 120_000n, signalHash: "0x2222",
    approverNullifier: "0xdeadbeef",
  });
  r = await run(tx);
  const permitId = createdId(r, "::Permit")!;
  permitId ? ok("approve_escalation", permitId.slice(0, 10) + "…") : bad("approve_escalation");

  tx = new Transaction();
  il.executeElevated(tx, {
    vaultId, capsuleId, permitId, amount: 60n,
    recipient: sponsorAddress(), poolId: POOL_OK, slippageBps: 100n,
  });
  r = await run(tx, agent);
  r.success
    ? ok("execute_elevated 60 over a 20 cap")
    : bad("execute_elevated", r.error ?? undefined);

  const c3 = await readCapsule(capsuleId);
  c3.spent === 72n ? ok("elevated spend booked", `spent=${c3.spent}`) : bad("elevated spend", `spent=${c3.spent}`);

  let permitGone = false;
  try {
    const o = await client.core.getObject({ objectId: permitId });
    permitGone = !o.object;
  } catch { permitGone = true; }
  permitGone ? ok("permit destroyed on use") : bad("permit destroyed on use");

  // --- revoke ----------------------------------------------------
  console.log("\nrevocation");
  const vBefore = await readVault(vaultId);
  tx = new Transaction();
  il.revokeVault(tx, vaultId);
  r = await run(tx);
  r.success ? ok("revoke_vault") : bad("revoke_vault", r.error ?? undefined);

  const vAfter = await readVault(vaultId);
  vAfter.balance === 0n && vAfter.revoked
    ? ok("swept in the same transaction", `${vBefore.balance} → 0`)
    : bad("swept", `balance=${vAfter.balance}`);

  tx = new Transaction();
  il.execute(tx, {
    vaultId, capsuleId, amount: 1n,
    recipient: sponsorAddress(), poolId: POOL_OK, slippageBps: 100n,
  });
  await expectAbort("execute after revocation", "E_REVOKED", tx, agent);

  console.log(
    `\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m\n`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nsmoke test crashed:\n", e);
  process.exit(1);
});
