/**
 * A second pool, used as the venue the issuer never approved.
 *
 * The out-of-scope demo needs a real Pool object: a made-up id fails while
 * the transaction is still being built ("object not found"), which is not
 * the same thing as the capsule refusing it — and it reads as a crash rather
 * than a guarantee.
 */
import { Transaction } from "@mysten/sui/transactions";
import { createdId, signAndExecute, sponsorAddress, sponsorKeypair } from "../lib/chain/client";
import { PACKAGE_ID } from "../lib/chain/config";

async function main() {
  const treasury = process.env.DUSD_TREASURY_CAP;
  if (!treasury) throw new Error("DUSD_TREASURY_CAP is not set");

  const tx = new Transaction();
  const dusd = tx.moveCall({
    target: `${PACKAGE_ID}::dusd::mint`,
    arguments: [tx.object(treasury), tx.pure.u64(50_000_000_000n)],
  });
  const [sui] = tx.splitCoins(tx.gas, [tx.pure.u64(25_000_000n)]);
  tx.moveCall({
    target: `${PACKAGE_ID}::demo_pool::create_pool`,
    typeArguments: ["0x2::sui::SUI", `${PACKAGE_ID}::dusd::DUSD`],
    arguments: [sui, dusd],
  });
  tx.setSender(sponsorAddress());
  tx.setGasBudget(200_000_000);

  const r = await signAndExecute(tx, sponsorKeypair());
  if (!r.success) throw new Error(r.error ?? "failed");
  console.log(`\nNEXT_PUBLIC_RIVAL_POOL_ID=${createdId(r, "::demo_pool::Pool")}\n`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
