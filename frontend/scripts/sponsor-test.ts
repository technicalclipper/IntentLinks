/**
 * Proves the headline claim: an address holding zero SUI can drive the whole
 * product, because the gas station pays.
 *
 *   npx tsx --env-file=.env.local scripts/sponsor-test.ts
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import {
  createdId,
  signAndExecute,
  sponsorAddress,
  sponsorKeypair,
  suiClient,
} from "../lib/chain/client";
import { Beneficiary, VERIFIER_CAP_ID } from "../lib/chain/config";
import { decodeAbort } from "../lib/chain/errors";
import { readCapsule } from "../lib/chain/read";
import { executeSponsored } from "../lib/chain/sponsor";
import * as il from "../lib/chain/tx";

const MIST = 1_000_000_000n;
const DAY = 86_400_000n;
const POOL = "0x00000000000000000000000000000000000000000000000000000000000900d1";

let pass = 0;
let fail = 0;
const ok = (m: string, d = "") => (pass++, console.log(`  \x1b[32mPASS\x1b[0m  ${m}${d ? `  ${d}` : ""}`));
const bad = (m: string, d = "") => (fail++, console.log(`  \x1b[31mFAIL\x1b[0m  ${m}${d ? `  ${d}` : ""}`));

async function main() {
  const client = suiClient();
  const sponsor = sponsorKeypair();

  // A brand new key that has never held a coin. This stands in for a
  // zkLogin address a moment after someone signs in with Google.
  const pauper = Ed25519Keypair.generate();
  const pauperAddr = pauper.toSuiAddress();

  console.log(`\nsponsor  ${sponsorAddress()}`);
  console.log(`pauper   ${pauperAddr}  (never funded)\n`);

  const bal = await client.core.getBalance({
    owner: pauperAddr,
    coinType: "0x2::sui::SUI",
  });
  const balance = BigInt((bal as { balance?: { balance?: string } }).balance?.balance ?? 0);
  balance === 0n ? ok("pauper holds zero SUI") : bad("pauper holds zero SUI", String(balance));

  // --- sponsor sets up a capsule whose holder is the pauper ------
  console.log("\nsetup (paid by sponsor)");
  let tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(MIST / 50n)]);
  il.createVault(tx, coin);
  tx.setSender(sponsorAddress());
  tx.setGasBudget(100_000_000);
  let r = await signAndExecute(tx, sponsor);
  const vaultId = createdId(r, "::Vault<")!;
  vaultId ? ok("vault") : bad("vault", r.error ?? "");

  tx = new Transaction();
  il.mintCapsule(tx, {
    vaultId,
    boundRecipient: null,
    issuerNullifier: "0xfeed",
    perActionCap: 20n,
    totalCap: 600n,
    hardCap: 250n,
    windowMs: DAY,
    perWindowCap: 20n,
    maxWindows: 30n,
    allowedPools: [POOL],
    maxSlippageBps: 100n,
    beneficiaryMode: Beneficiary.PRINCIPAL,
    beneficiaryAddr: null,
    notBefore: 0n,
    expiresAt: BigInt(Date.now()) + 30n * DAY,
    ensNode: "0xabc",
    policyHash: "0x3f3f",
  });
  tx.setSender(sponsorAddress());
  tx.setGasBudget(100_000_000);
  r = await signAndExecute(tx, sponsor);
  const capsuleId = createdId(r, "::Capsule")!;
  capsuleId ? ok("capsule") : bad("capsule", r.error ?? "");

  tx = new Transaction();
  il.claim(tx, {
    verifierCapId: VERIFIER_CAP_ID!,
    capsuleId,
    principal: pauperAddr,
    holder: pauperAddr, // pauper acts as both here, to isolate the gas question
    recipientHash: null,
  });
  tx.setSender(sponsorAddress());
  tx.setGasBudget(100_000_000);
  r = await signAndExecute(tx, sponsor);
  r.success ? ok("claim") : bad("claim", r.error ?? "");

  // --- the point -------------------------------------------------
  console.log("\nsponsored execution");
  tx = new Transaction();
  il.execute(tx, {
    vaultId,
    capsuleId,
    amount: 12n,
    recipient: pauperAddr,
    poolId: POOL,
    slippageBps: 100n,
  });
  r = await executeSponsored(tx, pauper);
  r.success
    ? ok("zero-balance address executed", r.digest.slice(0, 12) + "…")
    : bad("zero-balance address executed", r.error ?? "");

  const c = await readCapsule(capsuleId);
  c.spent === 12n ? ok("the action really happened", `spent=${c.spent}`) : bad("spent", String(c.spent));

  // The balance aggregator lags object availability, so poll briefly.
  let afterBal = 0n;
  for (let i = 0; i < 15 && afterBal === 0n; i++) {
    const after = await client.core.getBalance({
      owner: pauperAddr,
      coinType: "0x2::sui::SUI",
    });
    afterBal = BigInt((after as { balance?: { balance?: string } }).balance?.balance ?? 0);
    if (afterBal === 0n) await new Promise((r) => setTimeout(r, 400));
  }
  afterBal === 12n
    ? ok("pauper received the proceeds and paid no gas", `${afterBal} MIST`)
    : bad("pauper balance", String(afterBal));

  // --- sponsorship does not weaken the bounds --------------------
  console.log("\nbounds still apply when sponsored");
  tx = new Transaction();
  il.execute(tx, {
    vaultId,
    capsuleId,
    amount: 50n,
    recipient: pauperAddr,
    poolId: POOL,
    slippageBps: 100n,
  });
  try {
    const rr = await executeSponsored(tx, pauper);
    const d = decodeAbort(rr.error ?? "");
    d?.name === "E_OVER_ACTION_CAP"
      ? ok("over-cap still refused", `→ ${d.name}`)
      : bad("over-cap still refused", d?.name ?? rr.error ?? "succeeded");
  } catch (e) {
    const d = decodeAbort(e);
    d?.name === "E_OVER_ACTION_CAP"
      ? ok("over-cap still refused", `→ ${d.name}`)
      : bad("over-cap still refused", d?.name ?? String(e).slice(0, 100));
  }

  console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\ncrashed:\n", e);
  process.exit(1);
});
