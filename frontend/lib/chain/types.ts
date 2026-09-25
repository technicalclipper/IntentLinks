import type { BeneficiaryMode } from "./config";

/** A capsule as read back from chain, with u64s widened to bigint. */
export interface CapsuleState {
  id: string;
  vaultId: string;
  issuer: string;

  /** Salted hash of the recipient's email. null = bearer. */
  boundRecipient: string | null;
  issuerNullifier: string;
  /** The accountable human. null until redeemed. */
  principal: string | null;
  /** The agent's address. null until redeemed. */
  holder: string | null;

  perActionCap: bigint;
  totalCap: bigint;
  /** Never exceeded by any path, including an approved escalation. */
  hardCap: bigint;
  spent: bigint;

  windowMs: bigint;
  perWindowCap: bigint;
  maxWindows: bigint;
  windowStartMs: bigint;
  windowSpent: bigint;
  windowsUsed: bigint;

  allowedPools: string[];
  maxSlippageBps: bigint;

  beneficiaryMode: BeneficiaryMode;
  beneficiaryAddr: string | null;

  notBefore: bigint;
  expiresAt: bigint;

  issuerPaused: boolean;
  principalPaused: boolean;
  revoked: boolean;
  surrendered: boolean;

  ensNode: string;
  /** Must match the ENS `il:policy` record or the agent refuses to run. */
  policyHash: string;
}

export interface VaultState {
  id: string;
  funder: string;
  balance: bigint;
  revoked: boolean;
}

/** Everything the UI needs to decide what to show, derived in one place. */
export interface CapsuleStatus {
  /** unclaimed → active → (paused | ended) */
  phase: "unclaimed" | "active" | "paused" | "ended";
  /** Why it ended, when it has. */
  endedBecause: "revoked" | "surrendered" | "expired" | "exhausted" | null;
  canExecute: boolean;
  windowRemaining: bigint;
  totalRemaining: bigint;
  msUntilExpiry: bigint;
  /** ms until the current budget window rolls; 0 if it already has. */
  msUntilWindowRoll: bigint;
}

export function capsuleStatus(c: CapsuleState, nowMs: number): CapsuleStatus {
  const now = BigInt(nowMs);

  const expired = now >= c.expiresAt;
  const exhausted = c.windowsUsed > c.maxWindows || c.spent >= c.totalCap;
  const paused = c.issuerPaused || c.principalPaused;

  let phase: CapsuleStatus["phase"];
  let endedBecause: CapsuleStatus["endedBecause"] = null;

  if (c.revoked) {
    phase = "ended";
    endedBecause = "revoked";
  } else if (c.surrendered) {
    phase = "ended";
    endedBecause = "surrendered";
  } else if (expired) {
    phase = "ended";
    endedBecause = "expired";
  } else if (exhausted) {
    phase = "ended";
    endedBecause = "exhausted";
  } else if (!c.holder) {
    phase = "unclaimed";
  } else if (paused) {
    phase = "paused";
  } else {
    phase = "active";
  }

  // The chain rolls the window lazily, on the next execution. Mirror that
  // here so the UI shows the budget the next action would actually get.
  const windowElapsed =
    c.windowsUsed > 0n && now >= c.windowStartMs + c.windowMs;
  const windowSpent = windowElapsed ? 0n : c.windowSpent;

  const windowRemaining =
    windowSpent >= c.perWindowCap ? 0n : c.perWindowCap - windowSpent;
  const totalRemaining = c.spent >= c.totalCap ? 0n : c.totalCap - c.spent;

  const nextRoll = c.windowStartMs + c.windowMs;
  const msUntilWindowRoll =
    c.windowsUsed === 0n || now >= nextRoll ? 0n : nextRoll - now;

  return {
    phase,
    endedBecause,
    canExecute: phase === "active" && windowRemaining > 0n && totalRemaining > 0n,
    windowRemaining,
    totalRemaining,
    msUntilExpiry: expired ? 0n : c.expiresAt - now,
    msUntilWindowRoll,
  };
}
