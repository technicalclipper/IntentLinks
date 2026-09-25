/**
 * The naming layer.
 *
 * Every capability we issue is a subname under intentlink.eth, and its text
 * records are how the agent discovers what it is allowed to do. Resolving
 * the name needs no API key, no account, and no knowledge of us — which is
 * the difference between a portable capability and a row in our database.
 *
 * The record that matters most is `il:policy`. The same hash is stored in
 * the Sui Capsule, and the agent halts if they disagree. ENS is in the
 * verification path, not the presentation layer.
 */
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  encodeFunctionData,
  http,
  namehash,
  toHex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { packetToBytes } from "viem/ens";
import {
  CAPSULE_ROLES,
  PermissionedRegistryAbi,
  SubtreeResolverAbi,
  TextAbi,
} from "./abi";
import { ENS_NAME, RECORD } from "./config";

const RPC = process.env.SEPOLIA_RPC_URL!;
const SUBREGISTRY = process.env.ENS_SUBREGISTRY as Address | undefined;
const CONTROLLER_KEY = process.env.ENS_CONTROLLER_PRIVATE_KEY as `0x${string}` | undefined;

/** The resolver already on intentlink.eth. It authorises the whole subtree. */
const RESOLVER = (process.env.ENS_RESOLVER ??
  "0xB9DD72FFC2a75Ed1bcEE1716e04d6912B1B35aD4") as Address;

/** Writes address names by DNS wire format, not namehash. */
const dnsName = (name: string) => toHex(packetToBytes(name));

export function ensPublicClient() {
  return createPublicClient({ chain: sepolia, transport: http(RPC) });
}

function controller() {
  if (!CONTROLLER_KEY) throw new Error("ENS_CONTROLLER_PRIVATE_KEY is not set");
  if (!SUBREGISTRY) throw new Error("ENS_SUBREGISTRY is not set");
  const account = privateKeyToAccount(CONTROLLER_KEY);
  return {
    account,
    wallet: createWalletClient({ account, chain: sepolia, transport: http(RPC) }),
    registry: SUBREGISTRY,
  };
}

export function fullName(label: string): string {
  return `${label}.${ENS_NAME}`;
}

export interface CapsuleRecords {
  vault: string;
  capsule: string;
  /** Must equal the Capsule's policy_hash on Sui, or the agent refuses to run. */
  policy: string;
  status: "unclaimed" | "active" | "paused" | "revoked" | "expired";
  expires: string;
  chain?: string;
  parent?: string;
  description?: string;
}

/**
 * Issue a capability as a subname.
 *
 * One transaction to register it — passing the resolver inline so we do not
 * need a second call — then one multicall to write every record atomically.
 */
export async function issueCapsuleName(
  label: string,
  records: CapsuleRecords,
  opts: { expiresAt?: bigint } = {},
): Promise<{ name: string; node: `0x${string}`; registerTx: string; recordsTx: string }> {
  const { account, wallet, registry } = controller();
  const pub = ensPublicClient();

  const expires = opts.expiresAt ?? BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 3600);

  const registerTx = await wallet.writeContract({
    address: registry,
    abi: PermissionedRegistryAbi,
    functionName: "register",
    args: [
      label,
      account.address,
      "0x0000000000000000000000000000000000000000", // no child registry yet
      RESOLVER,
      CAPSULE_ROLES,
      expires,
    ],
  });
  await pub.waitForTransactionReceipt({ hash: registerTx });

  const node = namehash(fullName(label));
  const recordsTx = await writeRecords(label, records);

  return { name: fullName(label), node, registerTx, recordsTx };
}

/** Write or update records. One multicall, so the name is never half-updated. */
export async function writeRecords(
  label: string,
  records: Partial<CapsuleRecords>,
): Promise<string> {
  const { wallet } = controller();
  const pub = ensPublicClient();

  const pairs: [string, string][] = [];
  const add = (k: string, v: string | undefined) => v !== undefined && pairs.push([k, v]);

  add(RECORD.vault, records.vault);
  add(RECORD.capsule, records.capsule);
  add(RECORD.policy, records.policy);
  add(RECORD.status, records.status);
  add(RECORD.expires, records.expires);
  add(RECORD.chain, records.chain ?? "sui:testnet");
  add(RECORD.parent, records.parent);
  // Standard key, so the capsule renders in any ENS-aware tool, not just ours.
  add("description", records.description);

  const dns = dnsName(fullName(label));
  const calls = pairs.map(([key, value]) =>
    encodeFunctionData({
      abi: SubtreeResolverAbi,
      functionName: "setText",
      args: [dns, key, value],
    }),
  );

  const hash = await wallet.writeContract({
    address: RESOLVER,
    abi: SubtreeResolverAbi,
    functionName: "multicall",
    args: [calls],
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

/** Flip the publicly visible lifecycle state. */
export async function setStatus(
  label: string,
  status: CapsuleRecords["status"],
): Promise<string> {
  return writeRecords(label, { status });
}

/**
 * The agent's boot path: one name in, everything it may do out.
 *
 * No API key, no account, no dependency on us being online.
 */
export async function readCapsuleName(
  name: string,
): Promise<Partial<CapsuleRecords> & { node: `0x${string}` }> {
  const pub = ensPublicClient();
  const node = namehash(name);

  const keys = [
    RECORD.vault,
    RECORD.capsule,
    RECORD.policy,
    RECORD.status,
    RECORD.expires,
    RECORD.chain,
    RECORD.parent,
  ] as const;

  // ENSIP-10: wrap a text() call and hand it to resolve().
  const dns = dnsName(name);
  const values = await Promise.all(
    keys.map(async (key) => {
      try {
        const raw = await pub.readContract({
          address: RESOLVER,
          abi: SubtreeResolverAbi,
          functionName: "resolve",
          args: [dns, encodeFunctionData({ abi: TextAbi, functionName: "text", args: [node, key] })],
        });
        if (!raw || raw === "0x") return "";
        return decodeAbiParameters([{ type: "string" }], raw as `0x${string}`)[0];
      } catch {
        return "";
      }
    }),
  );

  const out: Record<string, string> = {};
  keys.forEach((k, i) => {
    if (values[i]) out[k.replace("il:", "")] = values[i] as string;
  });

  return { ...(out as Partial<CapsuleRecords>), node };
}

/**
 * Do ENS and Sui agree about what this capability permits?
 *
 * Neither chain is authoritative alone: ENS publishes the terms, Sui
 * enforces them. If they disagree, something is wrong and the honest move is
 * to stop rather than guess which one to believe.
 */
export function policyAgrees(ensPolicy: string | undefined, suiPolicyHash: string): boolean {
  if (!ensPolicy) return false;
  const norm = (s: string) => s.toLowerCase().replace(/^0x/, "");
  return norm(ensPolicy) === norm(suiPolicyHash);
}

/** URL-safe label from a capsule id. */
export function labelFor(capsuleId: string, prefix = "cap"): string {
  return `${prefix}-${capsuleId.replace(/^0x/, "").slice(0, 8)}`;
}
