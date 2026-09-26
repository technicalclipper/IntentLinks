"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Copy, Field, Meter, Mono, Shell, phaseTone } from "@/components/ui";
import { sendAction } from "@/lib/tx-client";
import { useZkLogin } from "@/lib/zklogin/useZkLogin";

const SUI = 1_000_000_000;
const sui = (raw?: string) =>
  raw === undefined
    ? "—"
    : (Number(raw) / SUI).toLocaleString(undefined, { maximumFractionDigits: 4 });

interface Row {
  label: string;
  name: string;
  goal: string;
  createdAt: number;
  capsuleId: string;
  vaultId: string;
  boundTo: string | null;
  issuerAddress: string;
  recipientEmail: string | null;
  unreadable: boolean;
  principal?: string | null;
  holder?: string | null;
  phase?: string;
  endedBecause?: string | null;
  paused?: boolean;
  issuerPaused?: boolean;
  principalPaused?: boolean;
  spent?: string;
  totalCap?: string;
  perWindowCap?: string;
  windowRemaining?: string;
  windowsUsed?: string;
  maxWindows?: string;
  vaultBalance?: string;
  expiresAt?: string;
}

interface Mine {
  address: string;
  email: string | null;
  issued: Row[];
  received: Row[];
  truncated: boolean;
}

export default function MinePage() {
  const { session, signIn } = useZkLogin();
  const [data, setData] = useState<Mine | null>(null);
  const [error, setError] = useState<string | null>(null);
  /*
   * Distinguishing these matters. A section that says "Reading the chain…"
   * when the read already failed is claiming to still be working, and the
   * commonest cause here is not the chain at all — a Google id_token lasts
   * an hour, and this is the first screen that needs a fresh one to read.
   */
  const [phase, setPhase] = useState<"loading" | "ready" | "failed" | "expired">("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const res = await fetch("/api/intents/mine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken: session.idToken }),
      });
      const out = await res.json();
      if (res.status === 401 || out.code === "auth") {
        setPhase("expired");
        return;
      }
      if (!res.ok) throw new Error(out.error ?? "could not load");
      setData(out);
      setPhase("ready");
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      // Keep whatever we already showed; a failed refresh should not blank
      // a page someone may be reading a balance off.
      setPhase((p) => (p === "ready" ? "ready" : "failed"));
    }
  }, [session]);

  useEffect(() => {
    load();
    // The agent spends while this is open. A revoke button next to a stale
    // number is worse than no number at all.
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  // Re-signing in returns here, so the trip costs nothing but a click.
  useEffect(() => {
    if (phase !== "expired") return;
    sessionStorage.setItem("intentlink.next", "/mine");
  }, [phase]);

  /**
   * Every control here is signed by the person clicking it. The server
   * builds and pays for the transaction; it cannot author one. That is what
   * makes "only the issuer can revoke" a fact about the chain rather than a
   * promise about our code.
   */
  async function act(row: Row, action: unknown, verb: string) {
    if (!session) return;
    setBusy(row.label);
    setError(null);
    setNote(null);
    try {
      const out = await sendAction(action, session);
      if (out.abort) throw new Error(out.abort.message);
      if (!out.success) throw new Error(out.error ?? `could not ${verb}`);
      setNote(`${verb} · ${row.name}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!session) {
    return (
      <Shell>
        <h1 className="text-4xl font-bold tracking-tight">Your intents</h1>
        <p className="mt-3 max-w-md text-muted">
          Everything you have issued, and everything you hold. Sign in to see it.
        </p>
        <button onClick={signIn} className="btn btn-primary mt-6">
          Continue with Google
        </button>
      </Shell>
    );
  }

  if (phase === "expired") {
    return (
      <Shell>
        <h1 className="text-4xl font-bold tracking-tight">Your intents</h1>
        <div className="panel mt-6 p-6">
          <Badge tone="pending">session expired</Badge>
          <p className="mt-3 text-sm text-muted">
            Google sign-ins last an hour. Nothing has changed on chain — your
            intents are all still live, and so are their limits.
          </p>
          <button onClick={signIn} className="btn btn-primary mt-5">
            Sign in again
          </button>
        </div>
      </Shell>
    );
  }

  const issued = data?.issued;
  const received = data?.received;
  const live = issued?.filter((r) => r.phase === "active").length ?? 0;

  return (
    <Shell
      nav={
        <a href="/create" className="btn btn-sm btn-primary">
          Create
        </a>
      }
    >
      <h1 className="text-4xl font-bold tracking-tight">Your intents</h1>

      <div className="panel-tint mt-5 flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="text-xs tracking-widest text-muted uppercase">Signed in as</p>
          <p className="mt-0.5 truncate text-sm font-semibold">
            {data?.email ?? session.email}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-xs tracking-widest text-muted uppercase">Sui address</p>
          <div className="mt-0.5">
            <Mono value={data?.address ?? session.address} chars={8} label="address" />
          </div>
        </div>
        {issued && (
          <Badge tone={live > 0 ? "pass" : "idle"}>
            {live} live · {issued.length} issued
          </Badge>
        )}
      </div>

      {note && (
        <p className="pop panel mt-4 border-pass bg-pass p-3 text-sm font-semibold text-white">
          {note}
        </p>
      )}
      {error && (
        <p className="pop panel mt-4 border-block bg-block p-3 text-sm font-semibold text-white">
          {error}
        </p>
      )}

      <Section
        title="Issued by you"
        hint="You funded these. You can end them at any moment."
        empty="Nothing yet. Create your first intent."
        rows={issued}
        failed={phase === "failed"}
      >
        {(r) => (
          <Card key={r.label} row={r} side="issuer">
            {/* Pausing is reversible and revocation is not, so they do not
                get the same weight. */}
            <button
              className="btn btn-sm"
              disabled={busy === r.label || r.phase === "ended"}
              onClick={() =>
                act(
                  r,
                  { kind: "issuerPause", capsuleId: r.capsuleId, paused: !r.issuerPaused },
                  r.issuerPaused ? "resumed" : "paused",
                )
              }
            >
              {r.issuerPaused ? "Resume" : "Pause"}
            </button>
            <button
              className="btn btn-sm btn-danger"
              disabled={busy === r.label || r.phase === "ended"}
              onClick={() => act(r, { kind: "revokeCapsule", capsuleId: r.capsuleId }, "revoked")}
            >
              Revoke
            </button>
            <button
              className="btn btn-sm btn-danger"
              disabled={busy === r.label}
              onClick={() => act(r, { kind: "revokeVault", vaultId: r.vaultId }, "swept")}
            >
              Revoke &amp; sweep
            </button>
          </Card>
        )}
      </Section>

      <Section
        title="Held by you"
        hint="Authority someone gave you. A clean exit is what makes one safe to accept."
        empty="No intents have been issued to you."
        rows={received}
        failed={phase === "failed"}
      >
        {(r) => (
          <Card key={r.label} row={r} side="recipient">
            {!r.holder ? (
              <a href={`/i/${r.label}`} className="btn btn-sm btn-primary">
                Verify &amp; claim
              </a>
            ) : !samePrincipal(r, data) ? (
              /* Addressed to this person's email but claimed by a different
                 Sui address, so the chain will refuse them. Offering the
                 button anyway would only produce an abort they cannot act
                 on. True of links claimed before the canonicalIss fix. */
              <p className="text-xs text-muted">
                Claimed by <span className="val">{r.principal?.slice(0, 12)}…</span> — only
                that address can pause or hand it back.
              </p>
            ) : (
              <>
                <button
                  className="btn btn-sm"
                  disabled={busy === r.label || r.phase === "ended"}
                  onClick={() =>
                    act(
                      r,
                      {
                        kind: "principalPause",
                        capsuleId: r.capsuleId,
                        paused: !r.principalPaused,
                      },
                      r.principalPaused ? "resumed" : "paused",
                    )
                  }
                >
                  {r.principalPaused ? "Resume" : "Pause"}
                </button>
                {/* Not "revoke" — the funds were never theirs to reclaim.
                    This ends their authority and returns the rest. */}
                <button
                  className="btn btn-sm btn-danger"
                  disabled={busy === r.label || r.phase === "ended"}
                  onClick={() => act(r, { kind: "surrender", capsuleId: r.capsuleId }, "handed back")}
                >
                  Hand back
                </button>
              </>
            )}
          </Card>
        )}
      </Section>

      {data?.truncated && (
        <p className="mt-8 text-xs text-muted">
          Showing the 60 most recent. Older intents are still live on chain.
        </p>
      )}
    </Shell>
  );
}

/** Can this viewer actually exercise the principal's controls? */
function samePrincipal(r: Row, data: Mine | null): boolean {
  return Boolean(
    data?.address &&
      r.principal &&
      r.principal.toLowerCase() === data.address.toLowerCase(),
  );
}

function Section({
  title,
  hint,
  empty,
  rows,
  failed,
  children,
}: {
  title: string;
  hint: string;
  empty: string;
  rows?: Row[];
  failed?: boolean;
  children: (r: Row) => React.ReactNode;
}) {
  return (
    <section className="mt-12">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
        {rows && <span className="val text-sm text-muted">{rows.length}</span>}
      </div>
      <p className="mt-1 text-sm text-muted">{hint}</p>

      {!rows ? (
        <div className="panel-flat mt-4 p-6">
          {failed ? (
            <p className="text-sm text-block">
              Could not read the chain. Retrying every few seconds.
            </p>
          ) : (
            <p className="waiting text-sm text-muted">Reading the chain…</p>
          )}
        </div>
      ) : rows.length === 0 ? (
        <div className="panel-flat mt-4 p-6">
          <p className="text-sm text-muted">{empty}</p>
        </div>
      ) : (
        <div className="mt-4 space-y-4">{rows.map(children)}</div>
      )}
    </section>
  );
}

function Card({
  row,
  side,
  children,
}: {
  row: Row;
  side: "issuer" | "recipient";
  children: React.ReactNode;
}) {
  if (row.unreadable) {
    return (
      <div className="panel border-block p-5">
        <p className="val text-sm font-semibold break-all">{row.name}</p>
        <p className="mt-1 text-xs text-block">
          Could not read this on chain. It has not been deleted — try again.
        </p>
      </div>
    );
  }

  const spent = Number(row.spent ?? 0);
  const cap = Number(row.totalCap ?? 0);
  const ended = row.phase === "ended";

  return (
    <article className={`panel overflow-hidden ${ended ? "opacity-70" : ""}`}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-ink bg-sky px-5 py-3">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <a
            href={`/i/${row.label}`}
            className="val truncate text-sm font-semibold hover:text-sui-deep"
          >
            {row.name}
          </a>
          <Copy value={row.name} label="name" />
        </span>
        <Badge tone={phaseTone(row.phase)}>{row.endedBecause ?? row.phase ?? "—"}</Badge>
      </header>

      <div className="p-5">
        <p className="text-sm">{row.goal}</p>

        <p className="mt-1.5 text-xs text-muted">
          {side === "issuer"
            ? row.boundTo
              ? `To ${row.boundTo}`
              : "Bearer — the first verified human claims it"
            : "From the sender below"}
        </p>

        <div className="mt-4">
          <Meter value={spent} max={cap} tone={ended ? "block" : "pass"} />
          <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs">
            <span className="val text-muted">
              <b className="text-ink">{sui(row.spent)}</b> / {sui(row.totalCap)} SUI spent
            </span>
            <span className="val text-muted">
              <b className="text-ink">{sui(row.vaultBalance)}</b> left ·{" "}
              {sui(row.windowRemaining)} today
            </span>
          </div>
        </div>

        {/* The ids someone actually needs to paste into an explorer. */}
        <details className="group mt-4">
          <summary className="val cursor-pointer list-none text-xs text-muted hover:text-sui-deep">
            ▸ ids &amp; addresses
          </summary>
          <div className="panel-flat mt-2 divide-y divide-line px-3 py-1">
            <Field k="capsule" value={row.capsuleId} chars={8} />
            <Field k="vault" value={row.vaultId} chars={8} />
            <Field k={side === "issuer" ? "your address" : "sender"} value={row.issuerAddress} chars={8} />
            {row.principal && <Field k="principal" value={row.principal} chars={8} />}
            {row.holder && <Field k="agent" value={row.holder} chars={8} />}
            <Field
              k="link"
              value={`${typeof window !== "undefined" ? window.location.origin : ""}/i/${row.label}`}
              chars={14}
            />
          </div>
        </details>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {children}
          <a
            href={`/i/${row.label}/console`}
            className="ml-auto text-xs font-semibold text-muted hover:text-sui-deep"
          >
            console →
          </a>
        </div>
      </div>
    </article>
  );
}
