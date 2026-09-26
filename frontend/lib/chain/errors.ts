/**
 * Move abort codes, mirrored from sources/intentlink.move.
 *
 * These are not error handling — they are the product. When the chain refuses
 * an action, this is what the execution console renders, and the refusal is
 * the thing we want the user to see clearly.
 *
 * Keep in sync with the constants in the Move module.
 */

export const AbortCode = {
  NOT_ISSUER: 1,
  REVOKED: 2,
  VAULT_MISMATCH: 3,
  INSUFFICIENT_VAULT: 4,
  ALREADY_CLAIMED: 5,
  BAD_BENEFICIARY_MODE: 6,
  BAD_CAPS: 7,
  BAD_WINDOW: 8,
  BAD_LIFETIME: 9,
  WRONG_RECIPIENT: 10,
  NOT_CLAIMED: 11,
  NOT_HOLDER: 12,
  PAUSED: 13,
  SURRENDERED: 14,
  NOT_YET: 15,
  EXPIRED: 16,
  WINDOWS_EXHAUSTED: 17,
  OVER_ACTION_CAP: 18,
  OVER_WINDOW_CAP: 19,
  OVER_TOTAL_CAP: 20,
  OVER_HARD_CAP: 21,
  POOL_NOT_SCOPED: 22,
  SLIPPAGE: 23,
  WRONG_BENEFICIARY: 24,
  ZERO_AMOUNT: 25,
  NOT_PRINCIPAL: 26,
  PERMIT_WRONG_CAPSULE: 27,
  PERMIT_EXPIRED: 28,
  PERMIT_AMOUNT: 29,
  NOT_SAME_HUMAN: 30,
  DEPRECATED: 31,
} as const;

export type AbortCodeValue = (typeof AbortCode)[keyof typeof AbortCode];

const NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(AbortCode).map(([name, code]) => [code, `E_${name}`]),
);

/** Plain-language, written for the person watching the console. */
const MESSAGES: Record<number, string> = {
  [AbortCode.NOT_ISSUER]: "Only the issuer can do that.",
  [AbortCode.REVOKED]: "This capability was revoked.",
  [AbortCode.VAULT_MISMATCH]: "That capsule does not belong to this vault.",
  [AbortCode.INSUFFICIENT_VAULT]: "The vault does not hold that much.",
  [AbortCode.ALREADY_CLAIMED]: "This link has already been redeemed.",
  [AbortCode.BAD_BENEFICIARY_MODE]: "Invalid settlement configuration.",
  [AbortCode.BAD_CAPS]: "Those limits are inconsistent.",
  [AbortCode.BAD_WINDOW]: "Invalid recurrence window.",
  [AbortCode.BAD_LIFETIME]: "Invalid start or expiry time.",
  [AbortCode.WRONG_RECIPIENT]: "This link was issued to a different account.",
  [AbortCode.NOT_CLAIMED]: "This link has not been redeemed yet.",
  [AbortCode.NOT_HOLDER]: "Only the agent holding this capability can act.",
  [AbortCode.PAUSED]: "Paused.",
  [AbortCode.SURRENDERED]: "This capability was handed back.",
  [AbortCode.NOT_YET]: "This capability has not started yet.",
  [AbortCode.EXPIRED]: "This capability has expired.",
  [AbortCode.WINDOWS_EXHAUSTED]: "No budget periods remain.",
  [AbortCode.OVER_ACTION_CAP]: "Over the per-action limit.",
  [AbortCode.OVER_WINDOW_CAP]: "Over the limit for this period.",
  [AbortCode.OVER_TOTAL_CAP]: "Over the total limit.",
  [AbortCode.OVER_HARD_CAP]: "Over the absolute ceiling — nothing can lift this.",
  [AbortCode.POOL_NOT_SCOPED]: "That pool is out of scope.",
  [AbortCode.SLIPPAGE]: "Slippage above the permitted maximum.",
  [AbortCode.WRONG_BENEFICIARY]: "Proceeds may not be sent there.",
  [AbortCode.ZERO_AMOUNT]: "Amount must be greater than zero.",
  [AbortCode.NOT_PRINCIPAL]: "Only the person this was issued to can do that.",
  [AbortCode.PERMIT_WRONG_CAPSULE]: "That approval was for a different capability.",
  [AbortCode.PERMIT_EXPIRED]: "That approval expired before it was used.",
  [AbortCode.PERMIT_AMOUNT]: "Above the amount that was approved.",
  [AbortCode.NOT_SAME_HUMAN]:
    "A different person approved this than the one who set the limit.",
  [AbortCode.DEPRECATED]: "That entry point was retired.",
};

export interface DecodedAbort {
  code: number;
  /** e.g. "E_OVER_WINDOW_CAP" — shown verbatim in the console. */
  name: string;
  message: string;
}

/**
 * Pull the abort code out of a Sui execution error.
 *
 * The node reports these as a long string ending in something like
 * `MoveAbort(MoveLocation { ... }, 19) in command 0`.
 */
export function decodeAbort(err: unknown): DecodedAbort | null {
  const text =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : JSON.stringify(err ?? "");

  // Two shapes in the wild:
  //   gRPC      "MoveAbort in 1st command, abort code: 19, in '0x2f9b…'"
  //   JSON-RPC  "MoveAbort(MoveLocation { … }, 19) in command 0"
  const match =
    /abort code:\s*(\d+)/i.exec(text) ??
    /MoveAbort\([^)]*\)\s*,?\s*(\d+)\)/.exec(text) ??
    /MoveAbort.*?,\s*(\d+)\)/.exec(text);

  if (!match) return null;
  const code = Number(match[1]);
  if (!NAMES[code]) return null;

  return {
    code,
    name: NAMES[code],
    message: MESSAGES[code] ?? "Refused by the capability.",
  };
}

export function abortName(code: number): string {
  return NAMES[code] ?? `ABORT_${code}`;
}

export function abortMessage(code: number): string {
  return MESSAGES[code] ?? "Refused by the capability.";
}
