import { suiClient } from "@/lib/chain/client";

/**
 * Current epoch, so the browser can pick a `maxEpoch` for its ephemeral
 * zkLogin session. Epochs are roughly a day; the session dies with it.
 */
export async function GET() {
  try {
    const state = (await suiClient().core.getCurrentSystemState()) as unknown as Record<
      string,
      unknown
    >;
    const inner = (state.SystemState ?? state.systemState ?? state) as Record<string, unknown>;
    const epoch = Number(inner.epoch ?? inner.currentEpoch ?? 0);

    if (!epoch) throw new Error("could not read the current epoch");
    return Response.json({ epoch });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
