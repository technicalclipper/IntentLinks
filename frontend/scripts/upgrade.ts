/**
 * Upgrade the published package.
 *
 * The Sui CLI refuses to talk to testnet — the network is on protocol 137
 * and the homebrew binary tops out at 126 — but `sui move build` is entirely
 * local and still works. So the bytecode is compiled by the CLI and the
 * transaction is submitted through the SDK, which speaks the current
 * protocol.
 *
 *   sui move build --dump-bytecode-as-base64 | tail -1 > /tmp/pkg.json
 *   npx tsx --env-file=.env.local scripts/upgrade.ts /tmp/pkg.json
 *
 * An upgrade mints a NEW package id. Both matter afterwards and they are not
 * interchangeable:
 *
 *   original id — type identity. `Vault`, `Capsule`, `DUSD` are all named
 *                 after the package that first defined them, forever. Point
 *                 a type argument at the new id and nothing resolves.
 *   latest id   — code. Calls dispatch to the version they name, so calling
 *                 the original id runs the original bytecode and will not
 *                 find a function added today.
 *
 * Hence two env vars rather than one, and a loud warning if this script is
 * ever asked to overwrite the original.
 */

import { readFileSync } from "node:fs";
import { Transaction, UpgradePolicy } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { signAndExecute } from "../lib/chain/client";

const PACKAGE_ID = process.env.NEXT_PUBLIC_INTENTLINK_PACKAGE_ID!;
const UPGRADE_CAP = process.env.INTENTLINK_UPGRADE_CAP_ID!;

async function main() {
  const path = process.argv[2] ?? "/tmp/pkg.json";
  const { modules, dependencies, digest } = JSON.parse(readFileSync(path, "utf8")) as {
    modules: string[];
    dependencies: string[];
    digest: number[];
  };

  const secret = process.env.SUI_DEPLOYER_PRIVATE_KEY;
  if (!secret) throw new Error("SUI_DEPLOYER_PRIVATE_KEY is not set");
  const signer = Ed25519Keypair.fromSecretKey(secret);
  const sender = signer.toSuiAddress();

  console.log(`upgrading ${PACKAGE_ID}`);
  console.log(`  modules: ${modules.length}  deps: ${dependencies.length}`);
  console.log(`  sender:  ${sender}`);

  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasBudget(900_000_000);

  const cap = tx.object(UPGRADE_CAP);

  // The digest commits to the exact bytecode being authorised, so the
  // ticket cannot be reused to install something else.
  const ticket = tx.moveCall({
    target: "0x2::package::authorize_upgrade",
    arguments: [
      cap,
      tx.pure.u8(UpgradePolicy.COMPATIBLE),
      tx.pure(bcs.vector(bcs.u8()).serialize(digest)),
    ],
  });

  const receipt = tx.upgrade({ modules, dependencies, package: PACKAGE_ID, ticket });

  // Without this the UpgradeCap keeps pointing at the old version and the
  // next upgrade is rejected.
  tx.moveCall({ target: "0x2::package::commit_upgrade", arguments: [cap, receipt] });

  const res = await signAndExecute(tx, signer);

  // normaliseExecResult flattens effects rather than surfacing
  // objectChanges, so the new package arrives as a created object typed
  // "package" instead of a "published" change.
  const created = (res as { created?: { objectId: string; type: string }[] }).created ?? [];
  const published = created.find((c) => c.type === "package");

  if (!published?.objectId) {
    console.error("no package in objectChanges");
    console.error(JSON.stringify(res.effects ?? res, null, 2).slice(0, 2000));
    process.exit(1);
  }

  console.log(`\nupgraded.`);
  console.log(`  digest: ${res.digest}`);
  console.log(`\nadd to .env.local — do NOT touch NEXT_PUBLIC_INTENTLINK_PACKAGE_ID,`);
  console.log(`every existing Vault, Capsule and DUSD coin is typed against it:\n`);
  console.log(`NEXT_PUBLIC_INTENTLINK_PACKAGE_LATEST=${published.objectId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
