"use client";

import { fromBase64 } from "@mysten/sui/utils";
import { signAsZkLogin, type ActiveSession } from "./zklogin/client";
import type { DecodedAbort } from "./chain/errors";

export interface SentResult {
  digest: string;
  success: boolean;
  error: string | null;
  created: { objectId: string; type: string }[];
  /** The assert that refused it, when one did. */
  abort: DecodedAbort | null;
}

/**
 * prepare → sign → execute.
 *
 * The server builds and sponsors; the browser signs. Three steps instead of
 * one, and worth it: the alternative is holding the user's key, and then
 * "only the issuer can revoke" would not be true.
 */
export async function sendAction(
  action: unknown,
  session: ActiveSession,
): Promise<SentResult> {
  const prep = await fetch("/api/tx/prepare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, sender: session.address }),
  });
  const prepared = (await prep.json()) as {
    bytes?: string;
    gasCoin?: string;
    error?: string;
  };
  if (!prep.ok || !prepared.bytes) throw new Error(prepared.error ?? "could not prepare");

  const signature =
    session.mode === "demo"
      ? await signViaServer(prepared.bytes, session)
      : await signAsZkLogin(session, fromBase64(prepared.bytes));

  const res = await fetch("/api/tx/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bytes: prepared.bytes,
      signature,
      gasCoin: prepared.gasCoin,
    }),
  });
  const out = (await res.json()) as SentResult & { error?: string };
  if (!res.ok && !out.abort) throw new Error(out.error ?? "could not execute");
  return out;
}

export function createdOfType(r: SentResult, needle: string): string | undefined {
  return r.created.find((c) => c.type.includes(needle))?.objectId;
}

/**
 * Demo mode: the server holds a key derived from the Google account and
 * signs after re-verifying the id_token.
 */
async function signViaServer(bytes: string, session: ActiveSession): Promise<string> {
  const res = await fetch("/api/tx/sign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bytes, idToken: session.idToken }),
  });
  const out = (await res.json()) as { signature?: string; error?: string };
  if (!res.ok || !out.signature) throw new Error(out.error ?? "could not sign");
  return out.signature;
}
