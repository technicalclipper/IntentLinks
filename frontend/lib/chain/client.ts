/**
 * gRPC, not JSON-RPC.
 *
 * JSON-RPC on public Sui fullnodes is deprecated and returns MethodNotFound —
 * every v1 tutorial you will find is dead against testnet today. SDK v2 also
 * renamed the client and moved reads under `client.core`.
 */
import { GrpcWebFetchTransport, SuiGrpcClient } from "@mysten/sui/grpc";
import type { Signer } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import {
  AGENT_PRIVATE_KEY,
  SPONSOR_PRIVATE_KEY,
  SUI_NETWORK,
  SUI_RPC_URL,
} from "./config";

export type SuiClient = SuiGrpcClient;

let _client: SuiGrpcClient | null = null;

export function suiClient(): SuiGrpcClient {
  if (!_client) {
    _client = new SuiGrpcClient({
      network: SUI_NETWORK,
      transport: new GrpcWebFetchTransport({ baseUrl: SUI_RPC_URL }),
    });
  }
  return _client;
}

export interface ExecResult {
  digest: string;
  success: boolean;
  /** Raw node error string — feed to decodeAbort to get the assert that fired. */
  error: string | null;
  /** Object ids created by this transaction, keyed by their Move type. */
  created: { objectId: string; type: string }[];
  events: unknown[];
}

/**
 * Build, sign, execute, and wait.
 *
 * A refused transaction is a normal outcome here, not an exception — the
 * whole product is the chain saying no — so this resolves with
 * `success: false` and the error rather than throwing.
 */
export async function signAndExecute(
  tx: Transaction,
  signer: Signer,
): Promise<ExecResult> {
  const client = suiClient();
  const bytes = await tx.build({ client });
  const { signature } = await signer.signTransaction(bytes);

  const raw = (await client.core.executeTransaction({
    transaction: bytes,
    signatures: [signature],
    include: { effects: true, events: true, objectTypes: true },
  })) as unknown as Record<string, unknown>;

  // gRPC returns a tagged union: { $kind: "Transaction", Transaction: {...} }.
  // Unwrap it, but tolerate a flat payload in case the shape changes again.
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

  // `objectTypes` is not always populated. Without a type we cannot tell a
  // Vault from a Capsule, so look them up rather than guessing by position.
  if (created.length && created.some((c) => !c.type)) {
    try {
      const fetched = await client.core.getObjects({
        objectIds: created.map((c) => c.objectId),
      });
      (fetched.objects ?? []).forEach((o, i) => {
        const t = (o as { type?: string })?.type;
        if (t && !created[i].type) created[i].type = t;
      });
    } catch {
      // leave types blank; callers that need them will report a clear failure
    }
  }

  // A fullnode reports a transaction as executed before its reads catch up:
  // objects it just created answer NOT_FOUND, and mutated shared objects
  // still serve the previous version. Settle both before returning so
  // callers can chain transactions without sprinkling sleeps everywhere.
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

/**
 * Poll until the node serves `objectId` at `version` or later.
 *
 * A deleted object never arrives, so this gives up quietly rather than
 * hanging — `execute_elevated` destroys its permit, and that is a success.
 */
export async function waitForVersion(
  objectId: string,
  version: bigint,
  attempts = 25,
): Promise<boolean> {
  const client = suiClient();
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await client.core.getObject({ objectId });
      const v = (r.object as { version?: string } | undefined)?.version;
      if (v && BigInt(v) >= version) return true;
    } catch {
      // not indexed yet, or deleted
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** First created object whose Move type contains `needle`. */
export function createdId(r: ExecResult, needle: string): string | undefined {
  return r.created.find((c) => c.type.includes(needle))?.objectId;
}

function keypairFrom(secret: string | undefined, label: string): Ed25519Keypair {
  if (!secret) {
    throw new Error(
      `${label} is not configured. Set it in .env.local — this is a server-only value.`,
    );
  }
  return Ed25519Keypair.fromSecretKey(secret);
}

/**
 * Gas station. Pays for every user-facing transaction so nobody ever needs
 * SUI of their own — half of the "no wallet, no seed phrase, no gas" claim.
 *
 * Also holds the VerifierCap, so it is the identity that attests redemptions
 * and mints escalation permits.
 *
 * Server-only.
 */
export function sponsorKeypair(): Ed25519Keypair {
  return keypairFrom(SPONSOR_PRIVATE_KEY, "SUI_SPONSOR_PRIVATE_KEY");
}

/**
 * The agent's own long-lived key — the `holder` on a redeemed capsule.
 *
 * Deliberately separate from any human's. zkLogin sessions expire within
 * days, so an agent running a 30-day capability cannot sign as the person it
 * acts for and must have its own address.
 *
 * Server-only.
 */
export function agentKeypair(): Ed25519Keypair {
  return keypairFrom(AGENT_PRIVATE_KEY, "SUI_AGENT_PRIVATE_KEY");
}

export function sponsorAddress(): string {
  return sponsorKeypair().toSuiAddress();
}

export function agentAddress(): string {
  return agentKeypair().toSuiAddress();
}
