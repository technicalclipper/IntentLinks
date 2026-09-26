import { readCapsule, readVault } from "@/lib/chain/read";
import { capsuleStatus } from "@/lib/chain/types";
import { listIntents } from "@/lib/store";
import { normaliseEmail, verifyGoogleIdToken } from "@/lib/zklogin/server";
import { demoKeypair } from "@/lib/auth/demo";

/**
 * Every capability this person is a party to, on either side.
 *
 * Standing authority you cannot see is standing authority you cannot
 * govern. The issuer needs one place that answers "what have I left
 * running, and how much of it has been spent"; the recipient needs the
 * same, because a capability they hold is a thing they are accountable for
 * and may want to hand back.
 *
 * The id_token is re-verified here rather than read — a browser claiming to
 * be someone is not evidence, and this endpoint reveals the recipient of
 * every link a person issued.
 *
 * Roles are not exclusive. Issuing a link to yourself puts the same record
 * in both lists, which is exactly what happens in the demo, so the page has
 * to handle it rather than pick.
 */

/** A demo's worth. Enough that the page is honest about what it shows. */
const MAX = 60;

export async function POST(request: Request) {
  try {
    const { idToken } = (await request.json()) as { idToken?: string };
    if (!idToken) return Response.json({ error: "sign in first" }, { status: 401 });

    const claims = await verifyGoogleIdToken(idToken);
    const email = claims.email ? normaliseEmail(claims.email) : null;
    const address = demoKeypair(claims).toSuiAddress();

    const all = await listIntents();
    const records = all.slice(0, MAX);

    // One read per capability, all at once. A failed read must not blank the
    // whole page — a capability whose chain state we cannot fetch is still
    // worth listing, flagged, rather than silently dropped.
    const rows = await Promise.all(
      records.map(async (r) => {
        try {
          const [capsule, vault] = await Promise.all([
            readCapsule(r.capsuleId),
            readVault(r.vaultId),
          ]);
          const status = capsuleStatus(capsule, Date.now());

          return {
            label: r.label,
            name: r.name,
            goal: r.policy.goal,
            createdAt: r.createdAt,
            capsuleId: r.capsuleId,
            vaultId: r.vaultId,
            boundTo: r.policy.boundTo,
            issuerAddress: r.issuerAddress,
            recipientEmail: r.recipientEmail ? normaliseEmail(r.recipientEmail) : null,
            principal: capsule.principal,
            holder: capsule.holder,
            phase: status.phase,
            endedBecause: status.endedBecause,
            paused: capsule.issuerPaused || capsule.principalPaused,
            issuerPaused: capsule.issuerPaused,
            principalPaused: capsule.principalPaused,
            spent: capsule.spent.toString(),
            totalCap: capsule.totalCap.toString(),
            perWindowCap: capsule.perWindowCap.toString(),
            windowRemaining: status.windowRemaining.toString(),
            windowsUsed: capsule.windowsUsed.toString(),
            maxWindows: capsule.maxWindows.toString(),
            vaultBalance: vault.balance.toString(),
            expiresAt: capsule.expiresAt.toString(),
            unreadable: false as const,
          };
        } catch {
          return {
            label: r.label,
            name: r.name,
            goal: r.policy.goal,
            createdAt: r.createdAt,
            capsuleId: r.capsuleId,
            vaultId: r.vaultId,
            boundTo: r.policy.boundTo,
            issuerAddress: r.issuerAddress,
            recipientEmail: r.recipientEmail ? normaliseEmail(r.recipientEmail) : null,
            unreadable: true as const,
          };
        }
      }),
    );

    const mine = (a: string | null | undefined) =>
      Boolean(a && a.toLowerCase() === address.toLowerCase());

    const issued = rows.filter((r) => mine(r.issuerAddress));

    // Addressed to them, or already claimed by them. The first covers a link
    // nobody has opened yet, which still belongs on their page — it is money
    // waiting on them to act.
    const received = rows.filter(
      (r) =>
        (email !== null && r.recipientEmail === email) ||
        mine("principal" in r ? r.principal : null),
    );

    return Response.json({
      address,
      email: claims.email ?? null,
      issued,
      received,
      truncated: all.length > MAX,
    });
  } catch (e) {
    const message = (e as Error).message;

    /*
     * Tell "sign in again" apart from "the chain read failed".
     *
     * A Google id_token lasts an hour and this is the first screen that
     * needs a fresh one merely to *read*, so an expired session is the
     * ordinary case here rather than an exotic one. Returning it as a plain
     * 400 left the page saying "Reading the chain…" forever — blaming the
     * chain for something that was only ever an expired token.
     */
    const isAuth = /expired|signature|malformed|unknown key|issuer|different application/i.test(
      message,
    );
    return Response.json(
      { error: message, code: isAuth ? "auth" : "read" },
      { status: isAuth ? 401 : 400 },
    );
  }
}
