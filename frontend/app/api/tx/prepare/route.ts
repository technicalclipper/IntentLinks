import { prepare, type Action } from "@/lib/chain/prepare";

/**
 * Build a sponsored transaction for the user to sign.
 *
 * The user's key stays in their browser. We build and pay; they authorise.
 */
export async function POST(request: Request) {
  try {
    const { action, sender } = (await request.json()) as {
      action?: Action;
      sender?: string;
    };
    if (!action || !sender) {
      return Response.json({ error: "action and sender are required" }, { status: 400 });
    }
    return Response.json(await prepare(action, sender));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
