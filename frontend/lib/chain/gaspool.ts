import { Transaction } from "@mysten/sui/transactions";
import { signAndExecute, sponsorAddress, sponsorKeypair, suiClient } from "./client";

/**
 * Gas coin pool for the sponsor.
 *
 * A sponsored transaction pins a specific gas coin at a specific version
 * when it is built. But building happens on the server and signing happens
 * in the browser, so there is a real gap in between — and if anything else
 * spends that coin during it, the transaction fails with "provided version
 * doesn't match". One shared gas coin makes that failure the normal case
 * rather than a rare race.
 *
 * So: keep several coins, reserve one for the length of a prepare/execute
 * round trip, and release it afterwards. Reservations expire on their own so
 * a browser that never comes back cannot strand a coin.
 */

interface Coin {
  objectId: string;
  version: string;
  digest: string;
  balance: string;
}

/** objectId → when the reservation lapses. */
const reserved = new Map<string, number>();
const RESERVATION_MS = 90_000;

function sweepExpired() {
  const now = Date.now();
  for (const [id, until] of reserved) if (until < now) reserved.delete(id);
}

async function sponsorCoins(): Promise<Coin[]> {
  const res = await suiClient().core.listCoins({
    owner: sponsorAddress(),
    coinType: "0x2::sui::SUI",
  });
  return (res.objects ?? []) as unknown as Coin[];
}

/**
 * Split the sponsor's balance into a pool, so concurrent requests are not
 * fighting over one coin. Idempotent — does nothing once the pool is deep
 * enough.
 */
export async function ensureGasPool(size = 8, each = 200_000_000n): Promise<number> {
  const coins = await sponsorCoins();
  const usable = coins.filter((c) => BigInt(c.balance) >= each);
  if (usable.length >= size) return usable.length;

  const biggest = [...coins].sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1))[0];
  if (!biggest) throw new Error("Gas station has no coins at all — fund the sponsor address.");

  const want = size - usable.length;
  const affordable = Number(BigInt(biggest.balance) / each) - 1;
  const n = Math.max(0, Math.min(want, affordable));
  if (n === 0) {
    throw new Error(
      `Gas station is too low to split a pool. Sponsor holds ${biggest.balance} MIST.`,
    );
  }

  const tx = new Transaction();
  const parts = tx.splitCoins(
    tx.gas,
    Array.from({ length: n }, () => tx.pure.u64(each)),
  );
  tx.transferObjects(
    Array.from({ length: n }, (_, i) => parts[i]),
    tx.pure.address(sponsorAddress()),
  );
  tx.setSender(sponsorAddress());
  tx.setGasBudget(50_000_000);

  await signAndExecute(tx, sponsorKeypair());
  return (await sponsorCoins()).filter((c) => BigInt(c.balance) >= each).length;
}

/** Reserve a coin for one prepare/execute round trip. */
export async function reserveGasCoin(budget: bigint) {
  sweepExpired();

  let coins = (await sponsorCoins()).filter(
    (c) => BigInt(c.balance) >= budget && !reserved.has(c.objectId),
  );

  if (coins.length === 0) {
    // Either the pool was never built, or everything is momentarily in use.
    await ensureGasPool().catch(() => {});
    coins = (await sponsorCoins()).filter(
      (c) => BigInt(c.balance) >= budget && !reserved.has(c.objectId),
    );
  }

  const coin = coins[0];
  if (!coin) {
    throw new Error(
      "Gas station has no free coin right now. Either every coin is mid-flight, " +
        "or the sponsor needs topping up.",
    );
  }

  reserved.set(coin.objectId, Date.now() + RESERVATION_MS);

  // listCoins is served from a cache and can hand back a version that has
  // already moved — which fails as "provided version doesn't match" only
  // once the transaction is submitted, long after the build looked fine.
  // Read the coin directly so the version we pin is the authoritative one.
  const fresh = await freshRef(coin.objectId);
  return fresh ?? { objectId: coin.objectId, version: coin.version, digest: coin.digest };
}

export function releaseGasCoin(objectId: string): void {
  reserved.delete(objectId);
}

/** Which coin a built transaction is pinned to, so execute can release it. */
export function gasCoinOf(tx: { getData(): { gasData: { payment?: { objectId: string }[] } } }) {
  return tx.getData().gasData.payment?.[0]?.objectId;
}

/** The coin's current version and digest, straight from the node. */
async function freshRef(objectId: string) {
  try {
    const r = (await suiClient().core.getObject({ objectId })) as unknown as {
      object?: { objectId?: string; version?: string; digest?: string };
    };
    const o = r.object;
    if (!o?.version || !o?.digest) return null;
    return { objectId, version: o.version, digest: o.digest };
  } catch {
    return null;
  }
}
