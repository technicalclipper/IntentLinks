"use client";

import { useCallback, useEffect, useState } from "react";
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
      if (!res.ok) throw new Error(out.error ?? "could not load");
      setData(out);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [session]);

  useEffect(() => {
    load();
    // The agent spends while this is open. A revoke button next to a stale
    // number is worse than no number.
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

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
        <h1 className="text-xl">Your intents</h1>
        <p className="mt-2 text-sm text-muted">
          Sign in to see what you have issued and what you hold.
        </p>
        <button
          onClick={signIn}
          className="mt-6 border border-ink bg-ink px-4 py-2 text-sm text-paper"
        >
          Continue with Google
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-xl">Your intents</h1>
        <a href="/create" className="val text-sm text-accent">
          new +
        </a>
      </div>
      <p className="val mt-2 text-xs break-all text-muted">
        {data?.email ?? session.email} · {(data?.address ?? session.address).slice(0, 18)}…
      </p>

      {note && <p className="mt-4 text-sm text-pass">{note}</p>}
      {error && <p className="mt-4 text-sm text-block">{error}</p>}

      <Section
        title="Issued by you"
        empty="You have not created any intents yet."
        rows={data?.issued}
      >
        {(r) => (
          <Card key={r.label} row={r} side="issuer">
            {/* Pausing is reversible and revocation is not, so they are not
                given the same weight. */}
            <Btn
              busy={busy === r.label}
              disabled={r.phase === "ended"}
              onClick={() =>
                act(
                  r,
                  { kind: "issuerPause", capsuleId: r.capsuleId, paused: !r.issuerPaused },
                  r.issuerPaused ? "resumed" : "paused",
                )
              }
            >
              {r.issuerPaused ? "Resume" : "Pause"}
            </Btn>
            <Btn
              danger
              busy={busy === r.label}
              disabled={r.phase === "ended"}
              onClick={() =>
                act(r, { kind: "revokeCapsule", capsuleId: r.capsuleId }, "revoked")
              }
            >
              Revoke
            </Btn>
            <Btn
              danger
              busy={busy === r.label}
              onClick={() =>
                act(r, { kind: "revokeVault", vaultId: r.vaultId }, "swept")
              }
            >
              Revoke &amp; sweep
            </Btn>
          </Card>
        )}
      </Section>

      <Section
        title="Held by you"
        empty="No intents have been issued to you."
        rows={data?.received}
      >
        {(r) => (
          <Card key={r.label} row={r} side="recipient">
            {!r.holder ? (
              <a
                href={`/i/${r.label}`}
                className="border border-ink px-3 py-1.5 text-xs hover:bg-ink hover:text-paper"
              >
                Verify &amp; claim
              </a>
            ) : !samePrincipal(r, data) ? (
              /* Addressed to this person's email, but claimed by a different
                 Sui address — so the chain will refuse them, and offering the
                 button anyway would just produce an abort they cannot act on.
                 Happens to links claimed before the issuer-derivation fix. */
              <p className="text-xs text-muted">
                Claimed by <span className="val">{r.principal?.slice(0, 12)}…</span>, not
                your current address. Only that address can pause or hand it back.
              </p>
            ) : (
              <>
                <Btn
                  busy={busy === r.label}
                  disabled={r.phase === "ended"}
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
                </Btn>
                {/* Not "revoke" — the funds are not theirs to reclaim. This
                    ends their authority and returns the rest to the sender. */}
                <Btn
                  danger
                  busy={busy === r.label}
                  disabled={r.phase === "ended"}
                  onClick={() =>
                    act(r, { kind: "surrender", capsuleId: r.capsuleId }, "handed back")
                  }
                >
                  Hand back
                </Btn>
              </>
            )}
          </Card>
        )}
      </Section>

      {data?.truncated && (
        <p className="mt-6 text-xs text-muted">
          Showing the most recent 60. Older intents are still live on chain.
        </p>
      )}
    </Shell>
  );
}

/** Can this viewer actually exercise the principal's controls? */
function samePrincipal(r: Row, data: Mine | null): boolean {
  return Boolean(
    data?.address && r.principal &&
    r.principal.toLowerCase() === data.address.toLowerCase(),
  );
}

function Section({
  title,
  empty,
  rows,
  children,
}: {
  title: string;
  empty: string;
  rows?: Row[];
  children: (r: Row) => React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <p className="text-xs tracking-widest text-muted uppercase">
        {title} {rows && <span className="val">({rows.length})</span>}
      </p>
      {!rows ? (
        <p className="mt-3 text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{empty}</p>
      ) : (
        <div className="mt-3 space-y-3">{rows.map(children)}</div>
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
      <div className="panel p-4">
        <p className="val text-sm break-all">{row.name}</p>
        <p className="mt-1 text-xs text-block">
          Could not read this capability on chain. It has not been deleted — try again.
        </p>
      </div>
    );
  }

  const spent = Number(row.spent ?? 0);
  const cap = Math.max(1, Number(row.totalCap ?? 1));

  return (
    <div className="panel p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <a href={`/i/${row.label}`} className="val text-sm break-all hover:text-accent">
          {row.name}
        </a>
        <Status row={row} />
      </div>

      <p className="mt-1 text-xs text-muted">{row.goal}</p>

      <p className="mt-2 text-xs text-muted">
        {side === "issuer"
          ? row.boundTo
            ? `To ${row.boundTo}`
            : "Bearer — first verified human claims it"
          : `From ${row.issuerAddress.slice(0, 10)}…`}
      </p>

      <div className="mt-3 h-1 w-full bg-line">
        <div
          className="h-full bg-pass transition-[width] duration-500"
          style={{ width: `${Math.min(100, (spent / cap) * 100)}%` }}
        />
      </div>
      <div className="mt-1.5 flex flex-wrap justify-between gap-2 text-xs text-muted">
        <span className="val">
          {sui(row.spent)} / {sui(row.totalCap)} SUI spent
        </span>
        <span className="val">
          {sui(row.vaultBalance)} left · {sui(row.windowRemaining)} today
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {children}
        <a
          href={`/i/${row.label}/console`}
          className="ml-auto text-xs text-muted hover:text-accent"
        >
          console →
        </a>
      </div>
    </div>
  );
}

/** Colour is never the only signal — the word is always there too. */
function Status({ row }: { row: Row }) {
  const label = row.endedBecause ?? row.phase ?? "unknown";
  const tone =
    row.phase === "active"
      ? "text-pass"
      : row.phase === "ended"
        ? "text-block"
        : "text-muted";
  return <span className={`val text-xs ${tone}`}>{label}</span>;
}

function Btn({
  children,
  onClick,
  danger,
  busy,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      className={`border px-3 py-1.5 text-xs disabled:opacity-30 ${
        danger
          ? "border-block text-block hover:bg-block hover:text-paper"
          : "border-ink hover:bg-ink hover:text-paper"
      }`}
    >
      {busy ? "…" : children}
    </button>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh p-6">
      <div className="mx-auto max-w-2xl pt-10">
        <a href="/" className="val text-sm text-accent">
          [→]
        </a>
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}
