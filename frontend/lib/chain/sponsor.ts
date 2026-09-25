/**
 * Gas station.
 *
 * Sponsored transactions are a Sui protocol feature, not an Enoki one: the
 * sender signs the transaction, a sponsor signs it too and supplies the gas
 * coin, and both signatures go up together. That is the whole mechanism —
 * no third-party service required.
 *
 * This is half of "no wallet, no seed phrase, no gas". A user with a zero
 * balance can drive the entire product.
 */
import type { Signer } from "@mysten/sui/cryptography";
import type { Transaction } from "@mysten/sui/transactions";
import {
  createdId,
  sponsorAddress,
  sponsorKeypair,
  suiClient,
  waitForVersion,
  type ExecResult,
} from "./client";

const GAS_BUDGET = 100_000_000n;

/** Pick a sponsor coin large enough to cover the budget. */
async function gasCoin(budget: bigint) {
  const res = await suiClient().core.listCoins({
    owner: sponsorAddress(),
    coinType: "0x2::sui::SUI",
  });

  const coins = (res.objects ?? []) as {
    objectId: string;
    version: string;
    digest: string;
    balance: string;
  }[];

  const coin = coins.find((c) => BigInt(c.balance) >= budget);
  if (!coin) {
    const total = coins.reduce((a, c) => a + BigInt(c.balance), 0n);
    throw new Error(
      `Gas station is out of funds. Sponsor ${sponsorAddress()} holds ${total} MIST ` +
        `across ${coins.length} coin(s); needs at least ${budget} in one coin. Top it up.`,
    );
  }

  return { objectId: coin.objectId, version: coin.version, digest: coin.digest };
}

/**
 * Execute `tx` with `sender` as the author and the gas station paying.
 *
 * `sender` never needs a SUI balance — it only signs.
 */
export async function executeSponsored(
  tx: Transaction,
  sender: Signer,
  budget = GAS_BUDGET,
): Promise<ExecResult> {
  const client = suiClient();
  const sponsor = sponsorKeypair();

  tx.setSender(sender.toSuiAddress());
  tx.setGasOwner(sponsor.toSuiAddress());
  tx.setGasBudget(budget);
  tx.setGasPayment([await gasCoin(budget)]);

  const bytes = await tx.build({ client });

  // Both parties sign the same bytes: the sender authorises the action, the
  // sponsor authorises spending their coin on its gas.
  const senderSig = (await sender.signTransaction(bytes)).signature;
  const sponsorSig = (await sponsor.signTransaction(bytes)).signature;

  const raw = (await client.core.executeTransaction({
    transaction: bytes,
    signatures: [senderSig, sponsorSig],
    include: { effects: true, events: true, objectTypes: true },
  })) as unknown as Record<string, unknown>;

  return normalise(raw);
}

/** Same unwrapping as signAndExecute — gRPC returns a tagged union. */
async function normalise(raw: Record<string, unknown>): Promise<ExecResult> {
  interface TxPayload {
    digest?: string;
    status?: { success?: boolean; error?: unknown };
    effects?: {
      status?: { success?: boolean; error?: unknown };
      changedObjects?: {
        objectId: string;
        idOperation?: string;
        inputState?: string;
        outputVersion?: string;
      }[];
    };
    objectTypes?: Record<string, string>;
    events?: unknown[];
  }
  const res = ((raw.Transaction ?? raw.transaction ?? raw) as TxPayload) ?? {};
  const status = res.status ?? res.effects?.status;
  const types = res.objectTypes ?? {};

  const created = (res.effects?.changedObjects ?? [])
    .filter((c) => c.idOperation === "Created" || c.inputState === "DoesNotExist")
    .map((c) => ({ objectId: c.objectId, type: types[c.objectId] ?? "" }));

  const touched = (res.effects?.changedObjects ?? [])
    .filter((c) => c.outputVersion)
    .map((c) => ({ objectId: c.objectId, version: BigInt(c.outputVersion!) }));

  if (touched.length) {
    await Promise.all(touched.map((t) => waitForVersion(t.objectId, t.version)));
  }

  return {
    digest: res.digest ?? "",
    success: status?.success === true,
    error: status?.error
      ? typeof status.error === "string"
        ? status.error
        : JSON.stringify(status.error)
      : null,
    created,
    events: res.events ?? [],
  };
}

export { createdId };
