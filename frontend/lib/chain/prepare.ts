import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { sponsorAddress, sponsorKeypair, suiClient } from "./client";
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

function build(action: Action, sender: string): Transaction {
  const tx = new Transaction();

  switch (action.kind) {
    case "createVault": {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(action.amount))]);
      il.createVault(tx, coin);
      break;
    }
    case "fundVault": {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(action.amount))]);
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

/** Build and sponsor. Returns bytes for the user to sign. */
export async function prepare(action: Action, sender: string): Promise<{ bytes: string }> {
  const client = suiClient();
  const sponsor = sponsorKeypair();
  const tx = build(action, sender);

  tx.setSender(sender);
  tx.setGasOwner(sponsorAddress());
  tx.setGasBudget(GAS_BUDGET);
  tx.setGasPayment([await gasCoin()]);

  return { bytes: toBase64(await tx.build({ client })) };
}

/** Co-sign with the gas station and submit. */
export async function execute(bytesB64: string, userSignature: string) {
  const client = suiClient();
  const sponsor = sponsorKeypair();
  const bytes = fromBase64(bytesB64);

  const sponsorSig = (await sponsor.signTransaction(bytes)).signature;

  const raw = (await client.core.executeTransaction({
    transaction: bytes,
    signatures: [userSignature, sponsorSig],
    include: { effects: true, events: true, objectTypes: true },
  })) as unknown as Record<string, unknown>;

  return raw;
}

async function gasCoin() {
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
  const coin = coins.find((c) => BigInt(c.balance) >= GAS_BUDGET);
  if (!coin) throw new Error("Gas station is out of funds — top up the sponsor address.");
  return { objectId: coin.objectId, version: coin.version, digest: coin.digest };
}

export { VERIFIER_CAP_ID };
