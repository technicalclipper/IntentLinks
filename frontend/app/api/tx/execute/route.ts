import { normaliseExecResult } from "@/lib/chain/client";
import { decodeAbort } from "@/lib/chain/errors";
import { execute } from "@/lib/chain/prepare";

/**
 * Co-sign with the gas station and submit.
 *
 * A refused transaction is not an error here — it is the product working —
 * so aborts come back as a normal response carrying the assert that fired,
 * for the console to render.
 */
export async function POST(request: Request) {
  try {
    const { bytes, signature } = (await request.json()) as {
      bytes?: string;
      signature?: string;
    };
    if (!bytes || !signature) {
      return Response.json({ error: "bytes and signature are required" }, { status: 400 });
    }

    const raw = await execute(bytes, signature);
    const result = await normaliseExecResult(raw);

    return Response.json({
      ...result,
      abort: result.error ? decodeAbort(result.error) : null,
    });
  } catch (e) {
    // Simulation catches most aborts before submission; surface them the same way.
    const abort = decodeAbort(e);
    if (abort) {
      return Response.json({
        digest: "",
        success: false,
        error: (e as Error).message,
        created: [],
        events: [],
        abort,
      });
    }
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
