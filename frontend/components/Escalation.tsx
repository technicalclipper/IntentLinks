"use client";

import {
  IDKitRequestWidget,
  deviceLegacy,
  orbLegacy,
  proofOfHuman,
  type IDKitResult,
  type RpContext,
} from "@worldcoin/idkit";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui";
import { sendAction } from "@/lib/tx-client";
import type { ActiveSession } from "@/lib/zklogin/client";

const APP_ID = process.env.NEXT_PUBLIC_WORLD_APP_ID as `app_${string}`;
const CREDENTIAL =
  (
    { device: deviceLegacy, orb: orbLegacy, human: proofOfHuman } as const
  )[process.env.NEXT_PUBLIC_WORLD_CREDENTIAL ?? "device"] ?? deviceLegacy;

interface Pending {
  amount: string;
  reason: string;
  nonce: string;
  signalHash: string;
  requestedAt: number;
}

/**
 * The agent's ask, and the issuer's answer.
 *
 * Three separate things have to be true before a `Permit` exists, and no
 * two of them substitute for each other:
 *
 *   the contract   — approve_escalation asserts ctx.sender() == issuer, so
 *                    the transaction is worthless unless their key signs.
 *   World ID       — a fresh proof that a human is present *now*, with the
 *                    signal bound to hash(capsule, amount, nonce). A stored
 *                    credential cannot be replayed, and a yes to 26 cannot
 *                    be stretched into a yes to 260.
 *   the nullifier  — when the World action permits a second verification,
 *                    the same human as at mint. Optional by necessity: v4
 *                    actions allow one verification each.
 *
 * The agent can reach none of these. It can put a request on chain and
 * wait, which is the whole of its authority here.
 */
export function Escalation({
  label,
  capsuleId,
  session,
  onApproved,
}: {
  label: string;
  capsuleId: string;
  session: ActiveSession;
  onApproved: () => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [rp, setRp] = useState<RpContext | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/intents/${label}/escalation`)
      .then((r) => r.json())
      .then((d) => {
        const next: Pending | null = d.pending ?? null;
        // Replace only on a genuinely different request. Handing back an
        // equal-but-new object on every poll re-triggers everything keyed
        // to it — which is how the signed action changed underneath a
        // widget the user was already scanning.
        setPending((prev) =>
          prev?.signalHash === next?.signalHash ? prev : next,
        );
      })
      .catch(() => {});
  }, [label]);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      // Nothing may move while a proof is in flight.
      if (open || busy) return;
      load();
    }, 6000);
    return () => clearInterval(t);
  }, [load, open, busy]);

  // A per-request action, so approving twice in a demo is never refused as
  // a repeat verification.
  const signalHash = pending?.signalHash;
  useEffect(() => {
    if (!signalHash) return;
    fetch("/api/world/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        purpose: "escalate",
        description: "Approve an agent going past its limit",
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.rp_context) return;
        setRp(d.rp_context);
        setAction(d.action);
      })
      .catch(() => {});
  }, [signalHash]);

  async function approve(proof: IDKitResult) {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      // Verified server-side — a browser saying it passed is not evidence.
      // The signal is checked against this exact request, so the proof
      // cannot be carried over to a different amount.
      const v = await fetch("/api/world/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proof,
          // The action the proof was produced for, not whichever one this
          // component happens to be holding now.
          action: (proof as { action?: string }).action ?? action,
          signal: pending.signalHash,
        }),
      });
      const out = await v.json();
      if (!v.ok) throw new Error(out.error ?? "World rejected the proof");

      // Signed by the issuer. Our server builds and pays; it cannot author.
      const res = await sendAction(
        {
          kind: "approveEscalation",
          capsuleId,
          maxAmount: pending.amount,
          ttlMs: "600000",
          signalHash: pending.signalHash,
          approverNullifier: out.nullifier ?? "",
        },
        session,
      );
      if (res.abort) throw new Error(res.abort.message);
      if (!res.success) throw new Error(res.error ?? "could not approve");

      setDone(true);
      setPending(null);
      onApproved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="panel-tint mt-4 p-4">
        <Badge tone="pass">permit minted</Badge>
        <p className="mt-2 text-xs text-muted">
          One action, above the cap, expiring in ten minutes. It has no{" "}
          <span className="val">store</span> and no <span className="val">drop</span> — the
          agent cannot copy it, keep it, or quietly discard it.
        </p>
      </div>
    );
  }

  if (!pending) return null;

  const sui = (Number(pending.amount) / 1e9).toFixed(4);

  return (
    <div className="panel mt-4 border-pending p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge tone="pending">escalation requested</Badge>
        <span className="val text-xs text-muted">
          {new Date(pending.requestedAt).toLocaleTimeString()}
        </span>
      </div>

      <p className="mt-3 text-sm">
        The agent is asking for <b className="val">{sui} SUI</b>, above today&rsquo;s cap.
      </p>
      <p className="mt-1 text-xs text-muted">&ldquo;{pending.reason}&rdquo;</p>

      <button
        onClick={() => setOpen(true)}
        disabled={busy || !rp || !action}
        className="btn btn-primary btn-sm mt-4"
      >
        {busy ? "Approving…" : !rp ? "Preparing…" : "Verify with World & approve"}
      </button>

      <p className="mt-2 text-xs leading-relaxed text-muted">
        Only you can approve this — the contract asserts the sender is the issuer.
        World proves a human is here now, so a stored credential cannot stand in.
      </p>

      {rp && action && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={APP_ID}
          action={action}
          rp_context={rp}
          allow_legacy_proofs
          action_description={`Approve ${sui} SUI, once`}
          /* The signal rides inside the preset in v4, and it is what welds
             this approval to one request — the verifier compares the
             returned signal_hash against hash(capsule, amount, nonce). */
          preset={CREDENTIAL({ signal: pending.signalHash })}
          onSuccess={approve}
        />
      )}

      {error && <p className="mt-3 text-xs font-semibold text-block">{error}</p>}
    </div>
  );
}
