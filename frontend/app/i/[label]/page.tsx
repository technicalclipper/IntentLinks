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
import { useZkLogin } from "@/lib/zklogin/useZkLogin";

const APP_ID = process.env.NEXT_PUBLIC_WORLD_APP_ID as `app_${string}`;
const ACTION = process.env.NEXT_PUBLIC_WORLD_ACTION_IDENTITY ?? "intentlink-identity";
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
const CREDENTIAL = (
  {
    device: deviceLegacy,
    orb: orbLegacy,
    human: proofOfHuman,
  } as const
)[process.env.NEXT_PUBLIC_WORLD_CREDENTIAL ?? "device"] ?? deviceLegacy;


interface Intent {
  name: string;
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

const sui = (raw: string) => (Number(raw) / SUI).toLocaleString(undefined, { maximumFractionDigits: 4 });

export default function IntentPage({ params }: { params: Promise<{ label: string }> }) {
  const { label } = use(params);
  const { session, signIn } = useZkLogin();

  const [intent, setIntent] = useState<Intent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [rejected, setRejected] = useState<{ issuedTo: string; signedInAs: string } | null>(null);
  const [claimed, setClaimed] = useState(false);
  const [rp, setRp] = useState<RpContext | null>(null);
  const [worldOpen, setWorldOpen] = useState(false);

  // v4 proof requests must be signed by the relying party, so the browser
  // asks our server for a signed context before it can open the widget.
  useEffect(() => {
    fetch("/api/world/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: ACTION }),
    })
      .then((r) => r.json())
      .then((d) => d.rp_context && setRp(d.rp_context))
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

  if (error && !intent) return <Shell><p className="text-sm text-block">{error}</p></Shell>;
  if (!intent) return <Shell><p className="text-sm text-muted">Loading…</p></Shell>;

  const p = intent.policy;
  const ended = intent.status.phase === "ended";
  const live = Boolean(intent.chain.holder);

  return (
    <Shell>
      <p className="text-xs tracking-wide text-muted uppercase">Intent received</p>
      <h1 className="val mt-2 text-xl break-all">{intent.name}</h1>

      {p.boundTo && (
        <p className="mt-2 text-sm text-muted">
          For <span className="val">{p.boundTo}</span>
          {session?.email && (
            <span className={p.boundTo.split("@")[1] === session.email.split("@")[1] ? "text-pass" : ""}>
              {" · "}you are {session.email}
            </span>
          )}
        </p>
      )}

      <div className="panel mt-6 p-5">
        <p className="text-xs tracking-wide text-muted uppercase">Granted</p>
        <ul className="mt-3 space-y-1.5 text-sm">
          <Line ok>{p.goal}</Line>
          <Line ok>Up to <b className="val">{sui(p.perWindowCap)} {p.asset}</b> per day</Line>
          <Line ok><b className="val">{p.maxWindows}</b> daily periods</Line>
          <Line ok>Max <b className="val">{Number(p.maxSlippageBps) / 100}%</b> slippage</Line>
          <Line ok>One approved pool only</Line>
        </ul>

        <p className="mt-5 text-xs tracking-wide text-muted uppercase">Not granted</p>
        <ul className="mt-3 space-y-1.5 text-sm">
          <Line>Any other pool or asset</Line>
          <Line>More than <b className="val">{sui(p.perWindowCap)}</b> in a day</Line>
          <Line>More than <b className="val">{sui(p.hardCap)}</b> ever, in one action</Line>
          <Line>Anything after the sender revokes</Line>
        </ul>
      </div>

      {/* What the sender put in, and what is left of it. The recipient is
          the one bearing the consequence of it running out, so it should not
          take a block explorer to find out. */}
      {live && (
        <div className="panel mt-3 p-5">
          <p className="text-xs tracking-widest text-muted uppercase">Funds</p>

          <div className="mt-4 grid grid-cols-3 gap-4">
            <Figure k="Left in the vault" v={sui(intent.chain.vaultBalance)} unit="SUI" />
            <Figure k="Spent so far" v={sui(intent.chain.spent)} unit="SUI" />
            <Figure
              k="Available today"
              v={sui(intent.status.windowRemaining)}
              unit="SUI"
              accent
            />
          </div>

          <div className="mt-5">
            <div className="h-1.5 w-full bg-line">
              <div
                className="h-full bg-pass transition-[width] duration-500"
                style={{
                  width: `${Math.min(
                    100,
                    (Number(intent.chain.spent) / Math.max(1, Number(intent.chain.totalCap))) * 100,
                  )}%`,
                }}
              />
            </div>
            <div className="mt-2 flex justify-between text-xs text-muted">
              <span>
                period <span className="val">{intent.chain.windowsUsed || "0"}</span> of{" "}
                <span className="val">{intent.chain.maxWindows}</span>
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

      <div className="panel mt-3 p-4">
        <p className="text-xs text-muted">
          {intent.verification.hashesAgree && intent.verification.fieldsAgree ? (
            <span className="text-pass">
              ⛓ Verified — the published terms match what the chain enforces, field by field.
            </span>
          ) : (
            <span className="text-block">
              ⚠ The published terms do not match the on-chain object. Do not redeem this.
            </span>
          )}
        </p>
      </div>

      {ended ? (
        <p className="mt-6 text-sm text-block">
          This intent has ended ({intent.status.endedBecause}).
        </p>
      ) : claimed || live ? (
        <div className="mt-6">
          <p className="text-sm text-pass">Redeemed. The agent is live.</p>
          <a href={`/i/${label}/console`} className="mt-4 inline-block border border-ink bg-ink px-4 py-2 text-sm text-paper">
            Watch it work
          </a>
        </div>
      ) : rejected ? (
        <div className="panel mt-6 border-block p-5">
          <p className="text-sm text-block">This intent was issued to a different account.</p>
          <dl className="mt-3 space-y-1 text-sm">
            <Row k="Issued to" v={rejected.issuedTo} />
            <Row k="Signed in as" v={rejected.signedInAs} />
          </dl>
          <p className="mt-3 text-xs text-muted">Nothing was claimed. The funds are untouched.</p>
        </div>
      ) : !session ? (
        <div className="mt-6">
          <button onClick={signIn} className="border border-ink bg-ink px-4 py-2 text-sm text-paper">
            Continue with Google
          </button>
          <p className="mt-3 text-xs text-muted">No wallet. No seed phrase. No gas.</p>
        </div>
      ) : (
        <div className="mt-6">
          <button
            onClick={() => setWorldOpen(true)}
            disabled={claiming || !rp}
            className="border border-ink bg-ink px-4 py-2 text-sm text-paper disabled:opacity-40"
          >
            {claiming ? "Redeeming…" : !rp ? "Preparing…" : "Verify with World to redeem"}
          </button>

          {/* World's own modal — QR on desktop, deep link on mobile. */}
          {rp && (
            <IDKitRequestWidget
              open={worldOpen}
              onOpenChange={setWorldOpen}
              app_id={APP_ID}
              action={ACTION}
              rp_context={rp}
              allow_legacy_proofs
              action_description="Redeem an IntentLink permission"
              preset={CREDENTIAL()}
              onSuccess={redeem}
            />
          )}
          <p className="mt-3 text-xs text-muted">
            One link, one human — so a forwarded copy cannot be claimed twice.
          </p>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-block">{error}</p>}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh p-6">
      <div className="mx-auto max-w-lg pt-10">
        <a href="/" className="val text-sm text-accent">[→]</a>
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}

function Line({ ok, children }: { ok?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className={ok ? "text-pass" : "text-block"}>{ok ? "✓" : "✗"}</span>
      <span className={ok ? "" : "text-muted"}>{children}</span>
    </li>
  );
}

function Figure({
  k,
  v,
  unit,
  accent,
}: {
  k: string;
  v: string;
  unit: string;
  accent?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-muted">{k}</p>
      <p className={`figure mt-1 text-2xl ${accent ? "text-accent" : ""}`}>{v}</p>
      <p className="text-xs text-muted">{unit}</p>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{k}</dt>
      <dd className="val">{v}</dd>
    </div>
  );
}
