import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { sponsorAddress, sponsorKeypair, suiClient } from "./client";
import { releaseGasCoin, reserveGasCoin } from "./gaspool";
import { VERIFIER_CAP_ID } from "./config";
import * as il from "./tx";

/**
 * Build-then-sign, so the user's key never leaves their browser.
 *
 * The server builds the transaction and sponsors its gas; the user signs it.
 * Doing the whole thing server-side would be one round trip instead of two,
 * and would make us custodial — the issuer has to actually be the issuer, or
 * "only Alice can revoke" is a lie.
 */

const GAS_BUDGET = 100_000_000n;

export type Action =
  | { kind: "createVault"; amount: string }
  | { kind: "mintCapsule"; args: MintArgs }
  | { kind: "revokeVault"; vaultId: string }
  | { kind: "revokeCapsule"; capsuleId: string }
  | { kind: "issuerPause"; capsuleId: string; paused: boolean }
  | { kind: "principalPause"; capsuleId: string; paused: boolean }
  | { kind: "surrender"; capsuleId: string }
  | { kind: "withdraw"; vaultId: string; amount: string }
  | { kind: "fundVault"; vaultId: string; amount: string };

export interface MintArgs {
  vaultId: string;
  boundRecipient: string | null;
  issuerNullifier: string;
  perActionCap: string;
  totalCap: string;
  hardCap: string;
  windowMs: string;
  perWindowCap: string;
  maxWindows: string;
  allowedPools: string[];
  maxSlippageBps: string;
  beneficiaryMode: number;
  beneficiaryAddr: string | null;
  notBefore: string;
  expiresAt: string;
  ensNode: string;
  policyHash: string;
}

/**
 * Coins belonging to the sender, merged into one input if needed.
 *
 * NOT `tx.gas` — under sponsorship that is the gas station's coin, so
 * splitting from it would fund the vault with our money instead of the
 * issuer's. Gas is sponsored; the contents of the vault are not.
 */
async function senderCoin(tx: Transaction, sender: string, amount: bigint) {
  const res = await suiClient().core.listCoins({
    owner: sender,
    coinType: "0x2::sui::SUI",
  });
  const coins = ((res.objects ?? []) as unknown as { objectId: string; balance: string }[])
    .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));

  const picked: string[] = [];
  let have = 0n;
  for (const c of coins) {
    picked.push(c.objectId);
    have += BigInt(c.balance);
    if (have >= amount) break;
  }

  if (have < amount) {
    // Naming the address matters: it is the issuer's own zkLogin address,
    // not the sponsor's, and there is nowhere in the UI to look it up.
    const short = (n: bigint) => (Number(n) / 1e9).toFixed(4);
    throw new Error(
      `Not enough SUI. ${sender} holds ${short(have)} SUI but the vault needs ` +
        `${short(amount)}. Gas is sponsored; the funds going into the vault ` +
        `are the issuer's own, so top up that address.`,
    );
  }

  const [primary, ...rest] = picked;
  if (rest.length) tx.mergeCoins(tx.object(primary), rest.map((id) => tx.object(id)));
  return tx.splitCoins(tx.object(primary), [tx.pure.u64(amount)]);
}

async function build(action: Action, sender: string): Promise<Transaction> {
  const tx = new Transaction();

  switch (action.kind) {
    case "createVault": {
      const [coin] = await senderCoin(tx, sender, BigInt(action.amount));
      il.createVault(tx, coin);
      break;
    }
    case "fundVault": {
      const [coin] = await senderCoin(tx, sender, BigInt(action.amount));
      il.fundVault(tx, action.vaultId, coin);
      break;
    }
    case "mintCapsule": {
      const a = action.args;
      il.mintCapsule(tx, {
        vaultId: a.vaultId,
        boundRecipient: a.boundRecipient,
        issuerNullifier: a.issuerNullifier,
        perActionCap: BigInt(a.perActionCap),
        totalCap: BigInt(a.totalCap),
        hardCap: BigInt(a.hardCap),
        windowMs: BigInt(a.windowMs),
        perWindowCap: BigInt(a.perWindowCap),
        maxWindows: BigInt(a.maxWindows),
        allowedPools: a.allowedPools,
        maxSlippageBps: BigInt(a.maxSlippageBps),
        beneficiaryMode: a.beneficiaryMode as 0 | 1 | 2,
        beneficiaryAddr: a.beneficiaryAddr,
        notBefore: BigInt(a.notBefore),
        expiresAt: BigInt(a.expiresAt),
        ensNode: a.ensNode,
        policyHash: a.policyHash,
      });
      break;
    }
    case "revokeVault":
      il.revokeVault(tx, action.vaultId);
      break;
    case "revokeCapsule":
      il.revokeCapsule(tx, action.capsuleId);
      break;
    case "issuerPause":
      il.setIssuerPause(tx, action.capsuleId, action.paused);
      break;
    case "principalPause":
      il.setPrincipalPause(tx, action.capsuleId, action.paused);
      break;
    case "surrender":
      il.surrender(tx, action.capsuleId);
      break;
    case "withdraw": {
      const coin = il.withdraw(tx, action.vaultId, BigInt(action.amount));
      tx.transferObjects([coin], tx.pure.address(sender));
      break;
    }
  }

  return tx;
}

/**
 * Build and sponsor. Returns bytes for the user to sign.
 *
 * The gas coin is reserved for the round trip — signing happens in the
 * browser, and anything that spends this coin in the meantime would make the
 * pinned version stale.
 */
export async function prepare(
  action: Action,
  sender: string,
): Promise<{ bytes: string; gasCoin: string }> {
  const client = suiClient();
  const tx = await build(action, sender);
  const coin = await reserveGasCoin(GAS_BUDGET);

  tx.setSender(sender);
  tx.setGasOwner(sponsorAddress());
  tx.setGasBudget(GAS_BUDGET);
  tx.setGasPayment([coin]);

  try {
    return { bytes: toBase64(await tx.build({ client })), gasCoin: coin.objectId };
  } catch (e) {
    releaseGasCoin(coin.objectId);
    throw e;
  }
}

/** Co-sign with the gas station and submit, then free the coin. */
export async function execute(
  bytesB64: string,
  userSignature: string,
  gasCoin?: string,
) {
  const client = suiClient();
  const sponsor = sponsorKeypair();
  const bytes = fromBase64(bytesB64);

  try {
    const sponsorSig = (await sponsor.signTransaction(bytes)).signature;
    return (await client.core.executeTransaction({
      transaction: bytes,
      signatures: [userSignature, sponsorSig],
      include: { effects: true, events: true, objectTypes: true },
    })) as unknown as Record<string, unknown>;
  } finally {
    if (gasCoin) releaseGasCoin(gasCoin);
  }
}

export { VERIFIER_CAP_ID };
