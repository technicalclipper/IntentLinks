/**
 * Mint the demo quote asset and stand up a SUI/DUSD pool, so the agent has
 * somewhere real to trade.
 *
 *   npx tsx --env-file=.env.local scripts/create-pool.ts
 */
import { Transaction } from "@mysten/sui/transactions";
import { createdId, signAndExecute, sponsorAddress, sponsorKeypair } from "../lib/chain/client";
import { PACKAGE_ID } from "../lib/chain/config";

const SUI_LIQUIDITY = 100_000_000n; // 0.1 SUI
const DUSD_LIQUIDITY = 200_000_000_000n; // ~2000 DUSD per SUI

async function main() {
  const treasury = process.env.DUSD_TREASURY_CAP;
  if (!treasury) throw new Error("DUSD_TREASURY_CAP is not set");

  const sponsor = sponsorKeypair();
  const tx = new Transaction();

  const dusd = tx.moveCall({
    target: `${PACKAGE_ID}::dusd::mint`,
    arguments: [tx.object(treasury), tx.pure.u64(DUSD_LIQUIDITY)],
  });
  const [sui] = tx.splitCoins(tx.gas, [tx.pure.u64(SUI_LIQUIDITY)]);

  tx.moveCall({
    target: `${PACKAGE_ID}::demo_pool::create_pool`,
    typeArguments: ["0x2::sui::SUI", `${PACKAGE_ID}::dusd::DUSD`],
    arguments: [sui, dusd],
  });

  tx.setSender(sponsorAddress());
  tx.setGasBudget(200_000_000);

  const r = await signAndExecute(tx, sponsor);
  if (!r.success) throw new Error(r.error ?? "pool creation failed");

  const poolId = createdId(r, "::demo_pool::Pool");
  console.log(`\npool   ${poolId}`);
  console.log(`rate   ${Number(SUI_LIQUIDITY) / 1e9} SUI : ${Number(DUSD_LIQUIDITY) / 1e9} DUSD`);
  console.log(`\nadd to .env.local:\nNEXT_PUBLIC_DEMO_POOL_ID=${poolId}\n`);
}

main().catch((e) => {
  console.error("\n" + (e as Error).message + "\n");
  process.exit(1);
});
