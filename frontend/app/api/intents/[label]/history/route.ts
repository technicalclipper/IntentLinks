import { readHistory } from "@/lib/chain/events";
import { getIntent } from "@/lib/store";

/**
 * What actually happened, from Sui.
 *
 * Unauthenticated, like the intent page it sits on. Both parties to a link
 * see the same list — the recipient is accountable for what the agent did
 * with their authority and the issuer is paying for it, so a history only
 * one of them can audit serves neither.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ label: string }> },
) {
  const { label } = await params;
  const record = await getIntent(label);
  if (!record) return Response.json({ error: "not found" }, { status: 404 });

  try {
    const entries = await readHistory(record.capsuleId, record.vaultId);
    return Response.json({ entries });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
