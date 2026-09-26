import { bcs } from "@mysten/sui/bcs";
import { Transaction, type TransactionObjectArgument } from "@mysten/sui/transactions";
import { CLOCK_ID, target, type BeneficiaryMode } from "./config";

export const SUI_COIN = "0x2::sui::SUI";

const optionBytes = bcs.option(bcs.vector(bcs.u8()));
const optionAddress = bcs.option(bcs.Address);

const bytes = (hexOrUtf8: string): number[] =>
  hexOrUtf8.startsWith("0x")
    ? Array.from(Buffer.from(hexOrUtf8.slice(2), "hex"))
    : Array.from(Buffer.from(hexOrUtf8, "utf8"));

const maybeBytes = (v: string | null): number[] | null =>
  v === null ? null : bytes(v);

// ===== Vault =====================================================

/** Create and share a vault funded with `coin`. Returns the vault id. */
export function createVault(
  tx: Transaction,
  coin: TransactionObjectArgument,
  coinType = SUI_COIN,
) {
  return tx.moveCall({
    target: target("create_vault"),
    typeArguments: [coinType],
    arguments: [coin],
  });
}

export function fundVault(
  tx: Transaction,
  vaultId: string,
  coin: TransactionObjectArgument,
  coinType = SUI_COIN,
) {
  return tx.moveCall({
    target: target("fund_vault"),
    typeArguments: [coinType],
    arguments: [tx.object(vaultId), coin],
  });
}

/** Issuer only. Returns a Coin the caller must route somewhere. */
export function withdraw(
  tx: Transaction,
  vaultId: string,
  amount: bigint,
  coinType = SUI_COIN,
) {
  return tx.moveCall({
    target: target("withdraw"),
    typeArguments: [coinType],
    arguments: [tx.object(vaultId), tx.pure.u64(amount)],
  });
}

// ===== Capsule ===================================================

export interface MintCapsuleArgs {
  vaultId: string;
  /** Salted hash of the recipient's normalised email. null = bearer. */
  boundRecipient: string | null;
  issuerNullifier: string;
  perActionCap: bigint;
  totalCap: bigint;
  hardCap: bigint;
  windowMs: bigint;
  perWindowCap: bigint;
  maxWindows: bigint;
  allowedPools: string[];
  maxSlippageBps: bigint;
  beneficiaryMode: BeneficiaryMode;
  beneficiaryAddr: string | null;
  notBefore: bigint;
  expiresAt: bigint;
  ensNode: string;
  policyHash: string;
  coinType?: string;
}

export function mintCapsule(tx: Transaction, a: MintCapsuleArgs) {
  return tx.moveCall({
    target: target("mint_capsule"),
    typeArguments: [a.coinType ?? SUI_COIN],
    arguments: [
      tx.object(a.vaultId),
      tx.pure(optionBytes.serialize(maybeBytes(a.boundRecipient))),
      tx.pure.vector("u8", bytes(a.issuerNullifier)),
      tx.pure.u64(a.perActionCap),
      tx.pure.u64(a.totalCap),
      tx.pure.u64(a.hardCap),
      tx.pure.u64(a.windowMs),
      tx.pure.u64(a.perWindowCap),
      tx.pure.u64(a.maxWindows),
      tx.pure.vector("id", a.allowedPools),
      tx.pure.u64(a.maxSlippageBps),
      tx.pure.u8(a.beneficiaryMode),
      tx.pure(optionAddress.serialize(a.beneficiaryAddr)),
      tx.pure.u64(a.notBefore),
      tx.pure.u64(a.expiresAt),
      tx.pure.vector("u8", bytes(a.ensNode)),
      tx.pure.vector("u8", bytes(a.policyHash)),
    ],
  });
}

// ===== Redemption ================================================

/**
 * Bind a capsule to a human and an agent. Requires the VerifierCap, because
 * the checks that matter — a World proof and a Google id_token — happened
 * off-chain in the backend.
 */
export function claim(
  tx: Transaction,
  args: {
    verifierCapId: string;
    capsuleId: string;
    principal: string;
    holder: string;
    /** Salted email hash. Required if the capsule is bound. */
    recipientHash: string | null;
  },
) {
  return tx.moveCall({
    target: target("claim"),
    arguments: [
      tx.object(args.verifierCapId),
      tx.object(args.capsuleId),
      tx.pure.address(args.principal),
      tx.pure.address(args.holder),
      tx.pure(optionBytes.serialize(maybeBytes(args.recipientHash))),
      tx.object(CLOCK_ID),
    ],
  });
}

// ===== Execution =================================================

export interface ExecuteArgs {
  vaultId: string;
  capsuleId: string;
  amount: bigint;
  recipient: string;
  poolId: string;
  slippageBps: bigint;
  coinType?: string;
}

export function execute(tx: Transaction, a: ExecuteArgs) {
  return tx.moveCall({
    target: target("execute"),
    typeArguments: [a.coinType ?? SUI_COIN],
    arguments: [
      tx.object(a.vaultId),
      tx.object(a.capsuleId),
      tx.object(CLOCK_ID),
      tx.pure.u64(a.amount),
      tx.pure.address(a.recipient),
      tx.pure.id(a.poolId),
      tx.pure.u64(a.slippageBps),
    ],
  });
}

/** Consumes the permit. There is no second use — it is destroyed here. */
export function executeElevated(
  tx: Transaction,
  a: ExecuteArgs & { permitId: string },
) {
  return tx.moveCall({
    target: target("execute_elevated"),
    typeArguments: [a.coinType ?? SUI_COIN],
    arguments: [
      tx.object(a.vaultId),
      tx.object(a.capsuleId),
      tx.object(a.permitId),
      tx.object(CLOCK_ID),
      tx.pure.u64(a.amount),
      tx.pure.address(a.recipient),
      tx.pure.id(a.poolId),
      tx.pure.u64(a.slippageBps),
    ],
  });
}

/** Agent-attested refusal. Recorded, never enforced. */
export function logSkip(
  tx: Transaction,
  args: { capsuleId: string; reasonCode: number; detail: string },
) {
  return tx.moveCall({
    target: target("log_skip"),
    arguments: [
      tx.object(args.capsuleId),
      tx.object(CLOCK_ID),
      tx.pure.u8(args.reasonCode),
      tx.pure.vector("u8", bytes(args.detail)),
    ],
  });
}

// ===== Escalation ================================================

/**
 * The agent asks. Signed by the agent's own key, which is the whole of its
 * authority here — it puts the request on chain where the issuer can see it
 * and can do nothing else with it.
 */
export function requestEscalation(
  tx: Transaction,
  args: {
    capsuleId: string;
    amount: bigint;
    reasonCode: number;
    signalHash: string;
  },
) {
  return tx.moveCall({
    target: target("request_escalation"),
    arguments: [
      tx.object(args.capsuleId),
      tx.pure.u64(args.amount),
      tx.pure.u8(args.reasonCode),
      tx.pure.vector("u8", bytes(args.signalHash)),
      tx.object(CLOCK_ID),
    ],
  });
}

/**
 * The issuer approves, and must sign it themselves — `approve_escalation`
 * asserts the sender is the capsule's issuer, so this transaction is
 * worthless unless their key signs it.
 *
 * `signalHash` is hash(capsule_id, amount, nonce) from the World proof,
 * welding the approval to one request. `approverNullifier` is the optional
 * same-human check: pass an empty string when the World action would not
 * let the issuer verify a second time.
 */
export function approveEscalation(
  tx: Transaction,
  args: {
    capsuleId: string;
    maxAmount: bigint;
    ttlMs: bigint;
    signalHash: string;
    approverNullifier?: string;
  },
) {
  return tx.moveCall({
    target: target("approve_escalation"),
    arguments: [
      tx.object(args.capsuleId),
      tx.pure.u64(args.maxAmount),
      tx.pure.u64(args.ttlMs),
      tx.pure.vector("u8", bytes(args.signalHash)),
      tx.pure.vector("u8", bytes(args.approverNullifier ?? "")),
      tx.object(CLOCK_ID),
    ],
  });
}

// ===== Control ===================================================

/** Kills every capsule on this vault and sweeps the remainder back, atomically. */
export function revokeVault(tx: Transaction, vaultId: string, coinType = SUI_COIN) {
  return tx.moveCall({
    target: target("revoke_vault"),
    typeArguments: [coinType],
    arguments: [tx.object(vaultId)],
  });
}

export function revokeCapsule(tx: Transaction, capsuleId: string) {
  return tx.moveCall({
    target: target("revoke_capsule"),
    arguments: [tx.object(capsuleId), tx.object(CLOCK_ID)],
  });
}

export function setIssuerPause(tx: Transaction, capsuleId: string, paused: boolean) {
  return tx.moveCall({
    target: target("set_issuer_pause"),
    arguments: [tx.object(capsuleId), tx.pure.bool(paused), tx.object(CLOCK_ID)],
  });
}

export function setPrincipalPause(tx: Transaction, capsuleId: string, paused: boolean) {
  return tx.moveCall({
    target: target("set_principal_pause"),
    arguments: [tx.object(capsuleId), tx.pure.bool(paused), tx.object(CLOCK_ID)],
  });
}

export function surrender(tx: Transaction, capsuleId: string) {
  return tx.moveCall({
    target: target("surrender"),
    arguments: [tx.object(capsuleId), tx.object(CLOCK_ID)],
  });
}

/** Either party may tighten. Nothing here can widen — the Move code refuses. */
export function reduceCaps(
  tx: Transaction,
  args: {
    capsuleId: string;
    perActionCap: bigint;
    perWindowCap: bigint;
    totalCap: bigint;
  },
) {
  return tx.moveCall({
    target: target("reduce_caps"),
    arguments: [
      tx.object(args.capsuleId),
      tx.pure.u64(args.perActionCap),
      tx.pure.u64(args.perWindowCap),
      tx.pure.u64(args.totalCap),
      tx.object(CLOCK_ID),
    ],
  });
}

export { Transaction };

// ===== Swap =======================================================

import { DUSD_TYPE, poolTarget } from "./config";

export interface SwapArgs {
  vaultId: string;
  capsuleId: string;
  poolId: string;
  amount: bigint;
  /** The agent's commitment. settle() refuses a worse fill. */
  minOut: bigint;
  recipient: string;
  slippageBps: bigint;
  coinType?: string;
  quoteType?: string;
  /** Consumes a one-shot escalation permit instead of the soft caps. */
  permitId?: string;
}

/**
 * Spend from the vault, trade, and settle — in one transaction.
 *
 * `begin_execute` hands back the coin *and* a hot potato. The PTB can do
 * whatever it likes with the coin in between, but the ticket has no abilities
 * and only `settle` can destroy it, so the transaction is structurally
 * incapable of finishing unless the proceeds land on the beneficiary.
 *
 * The swap in the middle is an ordinary Move call. Nothing in the capability
 * layer knows which venue it is, which is why substituting another one is a
 * change to this line and nothing else.
 */
export function executeSwap(tx: Transaction, a: SwapArgs) {
  const begin = a.permitId ? "begin_execute_elevated" : "begin_execute";

  const args = [
    tx.object(a.vaultId),
    tx.object(a.capsuleId),
    ...(a.permitId ? [tx.object(a.permitId)] : []),
    tx.object(CLOCK_ID),
    tx.pure.u64(a.amount),
    tx.pure.u64(a.minOut),
    tx.pure.address(a.recipient),
    tx.pure.id(a.poolId),
    tx.pure.u64(a.slippageBps),
  ];

  const [funds, ticket] = tx.moveCall({
    target: target(begin),
    typeArguments: [a.coinType ?? SUI_COIN],
    arguments: args,
  });

  const proceeds = tx.moveCall({
    target: poolTarget("swap_a_for_b"),
    typeArguments: [a.coinType ?? SUI_COIN, a.quoteType ?? DUSD_TYPE],
    arguments: [tx.object(a.poolId), funds],
  });

  return tx.moveCall({
    target: target("settle"),
    typeArguments: [a.quoteType ?? DUSD_TYPE],
    arguments: [ticket, proceeds, tx.object(CLOCK_ID)],
  });
}
