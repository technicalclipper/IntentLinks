import { readCapsule, readVault } from "@/lib/chain/read";
import { capsuleStatus } from "@/lib/chain/types";
import { readCapsuleName } from "@/lib/ens";
import { comparePolicyToCapsule } from "@/lib/policy";
import { getIntent, publicView } from "@/lib/store";

/**
 * Everything the intent page needs, assembled from both chains.
 *
 * Includes the verification the agent performs at boot, so the page can show
 * a visitor that the published terms and the enforced ones actually agree —
 * rather than asking them to take our word for it.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ label: string }> },
) {
  const { label } = await params;
  const record = await getIntent(label);
  if (!record) return Response.json({ error: "not found" }, { status: 404 });

  try {
    const [capsule, vault, ens] = await Promise.all([
      readCapsule(record.capsuleId),
      readVault(record.vaultId),
      readCapsuleName(record.name).catch(() => ({}) as Record<string, string>),
    ]);

    const status = capsuleStatus(capsule, Date.now());

    // Both halves of the cross-chain check: the hashes agree, and the
    // published document describes the object that is actually enforcing.
    const ensPolicy = (ens as { policy?: string }).policy;
    const norm = (s?: string) => (s ?? "").toLowerCase().replace(/^0x/, "");
    const hashesAgree = Boolean(ensPolicy) && norm(ensPolicy) === norm(capsule.policyHash);
    const mismatches = comparePolicyToCapsule(record.policy, capsule);

    return Response.json({
      ...publicView(record),
      chain: {
        holder: capsule.holder,
        principal: capsule.principal,
        spent: capsule.spent.toString(),
        windowSpent: capsule.windowSpent.toString(),
        windowsUsed: capsule.windowsUsed.toString(),
        perWindowCap: capsule.perWindowCap.toString(),
        totalCap: capsule.totalCap.toString(),
        hardCap: capsule.hardCap.toString(),
        maxWindows: capsule.maxWindows.toString(),
        expiresAt: capsule.expiresAt.toString(),
        vaultBalance: vault.balance.toString(),
        revoked: capsule.revoked || vault.revoked,
        surrendered: capsule.surrendered,
        paused: capsule.issuerPaused || capsule.principalPaused,
        // Split out, because the recipient's toggle must reflect *their*
        // pause and not the sender's — the chain needs both false to run.
        issuerPaused: capsule.issuerPaused,
        principalPaused: capsule.principalPaused,
        beneficiaryMode: capsule.beneficiaryMode,
      },
      status: {
        phase: status.phase,
        endedBecause: status.endedBecause,
        windowRemaining: status.windowRemaining.toString(),
        totalRemaining: status.totalRemaining.toString(),
        msUntilExpiry: status.msUntilExpiry.toString(),
      },
      verification: {
        ensPolicy: ensPolicy ?? null,
        suiPolicyHash: capsule.policyHash,
        hashesAgree,
        fieldsAgree: mismatches.length === 0,
        mismatches,
      },
      ens: {
        name: record.name,
        status: (ens as { status?: string }).status ?? null,
      },
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
