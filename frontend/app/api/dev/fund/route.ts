import { Transaction } from "@mysten/sui/transactions";
import { signAndExecute, sponsorAddress, sponsorKeypair } from "@/lib/chain/client";
import { releaseGasCoin, reserveGasCoin } from "@/lib/chain/gaspool";

/**
 * Dev-only faucet.
 *
 * The issuer genuinely needs coins — they are funding a vault — and a fresh
 * zkLogin address has none. On mainnet they would already hold SUI; on
 * testnet this stands in for that. The receiver never needs this: their side
 * is sponsored end to end.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return Response.json({ error: "not available" }, { status: 404 });
  }

  try {
    const { address, amount } = (await request.json()) as {
      address?: string;
      amount?: string;
    };
    if (!address) return Response.json({ error: "address is required" }, { status: 400 });

    const value = BigInt(amount ?? 200_000_000); // 0.2 SUI

    // Take a coin from the pool rather than letting the SDK auto-select —
    // it would happily pick one that a prepared transaction is already
    // pinned to, and invalidate that signature's gas version.
    const budget = value + 50_000_000n;
    const gas = await reserveGasCoin(budget);
    try {
      const tx = new Transaction();
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(value)]);
      tx.transferObjects([coin], tx.pure.address(address));
      tx.setSender(sponsorAddress());
      tx.setGasBudget(50_000_000);
      tx.setGasPayment([gas]);

      const r = await signAndExecute(tx, sponsorKeypair());
      return Response.json({ success: r.success, digest: r.digest, error: r.error });
    } finally {
      releaseGasCoin(gas.objectId);
    }
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
