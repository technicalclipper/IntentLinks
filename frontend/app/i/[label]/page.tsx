"use client";

import {
  IDKitRequestWidget,
  deviceLegacy,
  orbLegacy,
  proofOfHuman,
  type IDKitResult,
  type RpContext,
} from "@worldcoin/idkit";
import { use, useEffect, useState } from "react";
import { Badge, Copy, Field, Meter, Mono, Shell, Stat } from "@/components/ui";
import { useZkLogin } from "@/lib/zklogin/useZkLogin";

const APP_ID = process.env.NEXT_PUBLIC_WORLD_APP_ID as `app_${string}`;
const SUI = 1_000_000_000;

/**
 * Which credential to ask for.
 *
 * proofOfHuman() is a World ID v4 credential and an action created through
 * the portal the ordinary way is not provisioned for it — World answers
 * "this attribute is required". The *Legacy presets map to the v3
 * verification levels the portal actually knows about.
 *
 * deviceLegacy is the permissive one: it accepts an orb-verified human too,
 * so nobody is turned away, which matters when the demo runs on whichever
 * phone is to hand. Production would ask for orb on a standing authority.
 */
const CREDENTIAL =
  (
    {
      device: deviceLegacy,
      orb: orbLegacy,
      human: proofOfHuman,
    } as const
  )[process.env.NEXT_PUBLIC_WORLD_CREDENTIAL ?? "device"] ?? deviceLegacy;

interface Intent {
  name: string;
  capsuleId: string;
  vaultId: string;
  policy: {
    goal: string;
    asset: string;
    perWindowCap: string;
    totalCap: string;
    hardCap: string;
    maxWindows: string;
    maxSlippageBps: string;
    boundTo: string | null;
    expiresAt: string;
  };
  chain: {
    holder: string | null;
    principal: string | null;
    revoked: boolean;
    expiresAt: string;
    vaultBalance: string;
    spent: string;
    windowSpent: string;
    windowsUsed: string;
    perWindowCap: string;
    totalCap: string;
    maxWindows: string;
  };
  status: {
    phase: string;
    endedBecause: string | null;
    windowRemaining: string;
    totalRemaining: string;
  };
  verification: { hashesAgree: boolean; fieldsAgree: boolean };
}

const sui = (raw: string) =>
  (Number(raw) / SUI).toLocaleString(undefined, { maximumFractionDigits: 4 });

export default function IntentPage({ params }: { params: Promise<{ label: string }> }) {
  const { label } = use(params);
  const { session, signIn } = useZkLogin();

  const [intent, setIntent] = useState<Intent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [rejected, setRejected] = useState<{ issuedTo: string; signedInAs: string } | null>(null);
  const [claimed, setClaimed] = useState(false);
  const [rp, setRp] = useState<RpContext | null>(null);
  // The server mints a fresh action per request, so a second verification is
  // never treated as a repeat of the first.
  const [action, setAction] = useState<string | null>(null);
  const [worldOpen, setWorldOpen] = useState(false);

  // v4 proof requests must be signed by the relying party, so the browser
  // asks our server for a signed context before it can open the widget.
  useEffect(() => {
    fetch("/api/world/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        purpose: "redeem",
        description: "Claim an IntentLink permission",
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.rp_context) return;
        setRp(d.rp_context);
        setAction(d.action);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const load = () =>
      fetch(`/api/intents/${label}`)
        .then((r) => r.json())
        .then((d) => (d.error ? setError(d.error) : setIntent(d)))
        .catch((e) => setError(String(e)));

    load();
    // The agent spends while this page is open, so the balance should move
    // without anyone reaching for refresh.
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [label, claimed]);

  async function redeem(proof: IDKitResult) {
    if (!session) return;
    setClaiming(true);
    setError(null);
    setRejected(null);

    try {
      const res = await fetch(`/api/intents/${label}/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          worldProof: proof,
          action,
          idToken: session.idToken,
          principal: session.address,
        }),
      });
      const out = await res.json();

      if (out.error === "wrong_recipient") {
        setRejected({ issuedTo: out.issuedTo, signedInAs: out.signedInAs });
      } else if (!res.ok) {
        setError(out.message ?? out.error ?? "could not redeem");
      } else {
        setClaimed(true);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setClaiming(false);
    }
  }

  if (error && !intent) {
    return (
      <Shell width="max-w-xl">
        <div className="panel border-block p-6">
          <p className="text-sm font-semibold text-block">{error}</p>
        </div>
      </Shell>
    );
  }
  if (!intent) {
    return (
      <Shell width="max-w-xl">
        <p className="waiting text-sm text-muted">Reading both chains…</p>
      </Shell>
    );
  }

  const p = intent.policy;
  const ended = intent.status.phase === "ended";
  const live = Boolean(intent.chain.holder);
  const verified = intent.verification.hashesAgree && intent.verification.fieldsAgree;

  return (
    <Shell width="max-w-xl">
      <span className="badge bg-sun">✉ intent received</span>

      <h1 className="mt-4 flex flex-wrap items-center gap-2 text-xl font-bold tracking-tight sm:text-3xl">
        <span className="val break-all">{intent.name}</span>
        <Copy value={intent.name} label="name" />
      </h1>

      {p.boundTo && (
        <p className="mt-2 text-sm text-muted">
          For <b className="val text-ink">{p.boundTo}</b>
          {session?.email && (
            <>
              {" · "}you are{" "}
              <b
                className={
                  p.boundTo.split("@")[1] === session.email.split("@")[1]
                    ? "text-pass"
                    : "text-ink"
                }
              >
                {session.email}
              </b>
            </>
          )}
        </p>
      )}

      {/* --- what the chain will and will not allow ------------- */}
      <div className="panel mt-6 overflow-hidden">
        <div className="border-b-2 border-ink bg-pass px-5 py-2.5">
          <p className="text-xs font-bold tracking-widest text-white uppercase">Granted</p>
        </div>
        <ul className="space-y-2 px-5 py-4 text-sm">
          <Line ok>{p.goal}</Line>
          <Line ok>
            Up to{" "}
            <b className="val">
              {sui(p.perWindowCap)} {p.asset}
            </b>{" "}
            per day
          </Line>
          <Line ok>
            <b className="val">{p.maxWindows}</b> daily periods
          </Line>
          <Line ok>
            Max <b className="val">{Number(p.maxSlippageBps) / 100}%</b> slippage
          </Line>
          <Line ok>One approved pool only</Line>
        </ul>

        <div className="border-y-2 border-ink bg-block px-5 py-2.5">
          <p className="text-xs font-bold tracking-widest text-white uppercase">Not granted</p>
        </div>
        <ul className="space-y-2 px-5 py-4 text-sm">
          <Line>Any other pool or asset</Line>
          <Line>
            More than <b className="val">{sui(p.perWindowCap)}</b> in a day
          </Line>
          <Line>
            More than <b className="val">{sui(p.hardCap)}</b> ever, in one action
          </Line>
          <Line>Anything after the sender revokes</Line>
        </ul>
      </div>

      {/* What the sender put in, and what is left of it. The recipient bears
          the consequence of it running out, so it should not take a block
          explorer to find out. */}
      {live && (
        <div className="panel mt-4 p-5">
          <p className="text-xs tracking-widest text-muted uppercase">Funds</p>

          <div className="mt-4 grid grid-cols-3 gap-4">
            <Stat k="Left in the vault" v={sui(intent.chain.vaultBalance)} unit="SUI" />
            <Stat k="Spent so far" v={sui(intent.chain.spent)} unit="SUI" />
            <Stat
              k="Available today"
              v={sui(intent.status.windowRemaining)}
              unit="SUI"
              tone="sui"
            />
          </div>

          <div className="mt-5">
            <Meter value={Number(intent.chain.spent)} max={Number(intent.chain.totalCap)} />
            <div className="mt-2 flex justify-between text-xs text-muted">
              <span>
                period <b className="val text-ink">{intent.chain.windowsUsed || "0"}</b> of{" "}
                <b className="val text-ink">{intent.chain.maxWindows}</b>
              </span>
              <span className="val">
                {sui(intent.chain.spent)} / {sui(intent.chain.totalCap)} SUI
              </span>
            </div>
          </div>

          <p className="mt-4 text-xs leading-relaxed text-muted">
            The sender funded this and can revoke at any moment — anything unspent
            returns to them in the same transaction.
          </p>
        </div>
      )}

      {/* --- the cross-chain check ----------------------------- */}
      <div className={`panel mt-4 p-4 ${verified ? "" : "border-block"}`}>
        <div className="flex items-start gap-3">
          <Badge tone={verified ? "pass" : "block"}>{verified ? "verified" : "mismatch"}</Badge>
          <p className="text-xs leading-relaxed text-muted">
            {verified
              ? "The published terms match what the chain enforces, field by field. ENS and Sui agree."
              : "The published terms do not match the on-chain object. Do not redeem this."}
          </p>
        </div>
      </div>

      {/* --- ids ----------------------------------------------- */}
      <details className="group mt-4">
        <summary className="val cursor-pointer list-none text-xs text-muted hover:text-sui-deep">
          ▸ ids &amp; addresses
        </summary>
        <div className="panel-flat mt-2 divide-y divide-line px-4 py-1">
          <Field k="capsule" value={intent.capsuleId} chars={10} />
          <Field k="vault" value={intent.vaultId} chars={10} />
          {intent.chain.principal && (
            <Field k="principal" value={intent.chain.principal} chars={10} />
          )}
          {intent.chain.holder && <Field k="agent" value={intent.chain.holder} chars={10} />}
        </div>
      </details>

      {/* --- the action ---------------------------------------- */}
      <div className="mt-8">
        {ended ? (
          <div className="panel border-block p-5">
            <Badge tone="block">{intent.status.endedBecause}</Badge>
            <p className="mt-3 text-sm text-muted">
              This intent has ended. Nothing further can be spent from it.
            </p>
          </div>
        ) : claimed || live ? (
          <div className="panel-tint p-5">
            <Badge tone="pass">redeemed</Badge>
            <p className="mt-3 text-sm">The agent is live and bounded.</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <a href={`/i/${label}/console`} className="btn btn-primary">
                Watch it work
              </a>
              <a href="/mine" className="btn">
                Your intents
              </a>
            </div>
          </div>
        ) : rejected ? (
          <div className="panel border-block p-5">
            <Badge tone="block">wrong recipient</Badge>
            <p className="mt-3 text-sm">This intent was issued to a different account.</p>
            <div className="panel-flat mt-3 divide-y divide-line px-3 py-1">
              <Field k="Issued to" value={rejected.issuedTo} full />
              <Field k="Signed in as" value={rejected.signedInAs} full />
            </div>
            <p className="mt-3 text-xs text-muted">
              Nothing was claimed. The funds are untouched.
            </p>
          </div>
        ) : !session ? (
          <div className="panel p-5">
            <h2 className="text-lg font-bold">Claim this intent</h2>
            <p className="mt-1 text-sm text-muted">
              No wallet. No seed phrase. No gas.
            </p>
            <button onClick={signIn} className="btn btn-primary mt-4">
              Continue with Google
            </button>
          </div>
        ) : (
          <div className="panel p-5">
            <h2 className="text-lg font-bold">One link, one human</h2>
            <p className="mt-1 text-sm text-muted">
              Verify with World so a forwarded copy cannot be claimed twice.
            </p>
            <button
              onClick={() => setWorldOpen(true)}
              disabled={claiming || !rp || !action}
              className="btn btn-primary mt-4"
            >
              {claiming ? "Redeeming…" : !rp ? "Preparing…" : "Verify with World to redeem"}
            </button>

            {/* World's own modal — QR on desktop, deep link on mobile. */}
            {rp && action && (
              <IDKitRequestWidget
                open={worldOpen}
                onOpenChange={setWorldOpen}
                app_id={APP_ID}
                action={action}
                rp_context={rp}
                allow_legacy_proofs
                action_description="Redeem an IntentLink permission"
                preset={CREDENTIAL()}
                onSuccess={redeem}
              />
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="pop panel mt-4 border-block bg-block p-3 text-sm font-semibold text-white">
          {error}
        </p>
      )}
    </Shell>
  );
}

function Line({ ok, children }: { ok?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className={`font-bold ${ok ? "text-pass" : "text-block"}`} aria-hidden>
        {ok ? "✓" : "✕"}
      </span>
      <span className={ok ? "" : "text-muted"}>{children}</span>
    </li>
  );
}
