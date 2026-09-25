/** Split the sponsor's balance into a pool of gas coins.
 *    npx tsx --env-file=.env.local scripts/gas-pool.ts        */
import { sponsorAddress, suiClient } from "../lib/chain/client";
import { ensureGasPool } from "../lib/chain/gaspool";

async function main() {
  const before = await suiClient().core.listCoins({
    owner: sponsorAddress(), coinType: "0x2::sui::SUI",
  });
  const coins = (before.objects ?? []) as unknown as { balance: string }[];
  const total = coins.reduce((a, c) => a + BigInt(c.balance), 0n);
  console.log(`\nsponsor ${sponsorAddress()}`);
  console.log(`before: ${coins.length} coin(s), ${Number(total) / 1e9} SUI`);

  const n = await ensureGasPool();
  console.log(`after:  ${n} usable gas coins\n`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
