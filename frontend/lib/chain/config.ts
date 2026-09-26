/**
 * Chain configuration, read once from the environment.
 *
 * Anything NEXT_PUBLIC_* is safe in the browser. The keypairs and the
 * VerifierCap id are server-only and will be undefined on the client — that
 * is deliberate, not a bug.
 */

export const PACKAGE_ID = process.env.NEXT_PUBLIC_INTENTLINK_PACKAGE_ID!;
export const MODULE = "intentlink";

export const SUI_NETWORK = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet") as
  | "testnet"
  | "mainnet"
  | "devnet"
  | "localnet";

export const SUI_RPC_URL =
  process.env.NEXT_PUBLIC_SUI_RPC_URL ?? "https://fullnode.testnet.sui.io:443";

/** The shared Clock object. Fixed address on every Sui network. */
export const CLOCK_ID = "0x6";

/** Server-only. */
export const VERIFIER_CAP_ID = process.env.INTENTLINK_VERIFIER_CAP_ID;
export const SPONSOR_PRIVATE_KEY = process.env.SUI_SPONSOR_PRIVATE_KEY;
export const AGENT_PRIVATE_KEY = process.env.SUI_AGENT_PRIVATE_KEY;

export function target(fn: string): `${string}::${string}::${string}` {
  return `${PACKAGE_ID}::${MODULE}::${fn}`;
}

/** Where proceeds are allowed to land. Mirrors the Move constants. */
export const Beneficiary = {
  /** Back to the issuer — they are having an agent manage their own money. */
  VAULT: 0,
  /** To the redeeming human — the issuer is sending them value. */
  PRINCIPAL: 1,
  /** To an address fixed at mint. */
  FIXED: 2,
} as const;

export type BeneficiaryMode = (typeof Beneficiary)[keyof typeof Beneficiary];

/** Why the agent declined to act. Attested by the agent, never enforced. */
export const SkipReason = {
  UNSPECIFIED: 0,
  WOULD_EXCEED_WINDOW: 1,
  WOULD_EXCEED_TOTAL: 2,
  OUT_OF_SCOPE_POOL: 3,
  SLIPPAGE_TOO_HIGH: 4,
  COUNTERPARTY_SCREENED: 5,
  ESCALATION_DENIED: 6,
  MARKET_CONDITION: 7,
} as const;

/** The demo quote asset and pool the agent trades against. */
export const DUSD_TYPE = `${PACKAGE_ID}::dusd::DUSD`;
export const DEMO_POOL_ID = process.env.NEXT_PUBLIC_DEMO_POOL_ID ?? "";

export function poolTarget(fn: string): `${string}::${string}::${string}` {
  return `${PACKAGE_ID}::demo_pool::${fn}`;
}
