"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import { History } from "@/components/History";
import { Badge, Copy, Meter, Shell, Stat, phaseTone } from "@/components/ui";
import { sendAction } from "@/lib/tx-client";
import { useZkLogin } from "@/lib/zklogin/useZkLogin";

const SUI = 1_000_000_000;
const sui = (raw?: string) =>
  raw === undefined ? "—" : (Number(raw) / SUI).toLocaleString(undefined, { maximumFractionDigits: 4 });

interface Live {
  capsuleId: string;
  chain: {
    holder: string | null;
    principal: string | null;
    spent: string;
    totalCap: string;
    vaultBalance: string;
    principalPaused: boolean;
  };
  status: { phase: string; endedBecause: string | null; windowRemaining: string };
}

interface Event {
  kind: "propose" | "engine" | "executed" | "blocked" | "skipped" | "info";
  text?: string;
  amount?: string;
  meta?: string;
  ok?: boolean;
  reason?: string;
  code?: string;
  message?: string;
  digest?: string;
  amountIn?: string;
}

/**
 * The execution console.
 *
 * Every proposal the agent makes, what the engine predicted, and what the
 * chain actually did. The refusals are the point, so they are the loudest
 * thing on the page.
 */
export default function Console({ params }: { params: Promise<{ label: string }> }) {
  const { label } = use(params);
  const { session } = useZkLogin();
  const [events, setEvents] = useState<Event[]>([]);
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<Live | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const loadLive = useCallback(() => {
    fetch(`/api/intents/${label}`)
      .then((r) => r.json())
      .then((d) => (d.error ? null : setLive(d)))
      .catch(() => {});
  }, [label]);

  useEffect(() => {
    loadLive();
    const t = setInterval(loadLive, 8000);
    return () => clearInterval(t);
  }, [loadLive]);

  /**
   * The recipient's own controls, signed by them.
   *
   * They are not "revoke" — the funds were never theirs to reclaim. Pause
   * stops the agent now and is reversible; handing back ends their
   * authority for good and returns the remainder to the sender. Both
   * assert the sender is the principal, so this is their power and not
   * ours to grant.
   */
  async function control(action: unknown, verb: string) {
    if (!session) return;
    setBusy(true);
    setNote(null);
    try {
      const out = await sendAction(action, session);
      if (out.abort) throw new Error(out.abort.message);
      if (!out.success) throw new Error(out.error ?? `could not ${verb}`);
      setNote(verb);
      loadLive();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const run = useCallback(() => {
    setEvents([]);
    setRunning(true);

    const es = new EventSource(`/api/agent/${label}/run`);
    es.onmessage = (m) => {
      setEvents((prev) => [...prev, JSON.parse(m.data) as Event]);
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth" }));
    };
    es.onerror = () => {
      es.close();
      setRunning(false);
    };
  }, [label]);

  const step = useCallback(
    async (action: string) => {
      setRunning(true);
      try {
        const res = await fetch(`/api/agent/${label}/step`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const out = await res.json();
        if (out.error) {
          setEvents((p) => [...p, { kind: "info", text: out.error }]);
        } else {
          setEvents((p) => [...p, ...(out.events as Event[])]);
        }
        requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth" }));
      } finally {
        setRunning(false);
      }
    },
    [label],
  );

  const blocked = events.filter((e) => e.kind === "blocked").length;
  const executed = events.filter((e) => e.kind === "executed").length;

  return (
    <Shell
      width="max-w-2xl"
      nav={
        <a href={`/i/${label}`} className="btn btn-sm">
          ← Intent
        </a>
      }
    >
      {(() => {
        const phase = live?.status.phase;
        const ended = phase === "ended";
        const paused = phase === "paused";
        // The controls belong to whoever the chain says the principal is.
        const mine = Boolean(
          session?.address &&
            live?.chain.principal &&
            live.chain.principal.toLowerCase() === session.address.toLowerCase(),
        );

        return (
          <>
            <Badge tone={phaseTone(phase)}>
              {ended ? live?.status.endedBecause : paused ? "paused" : phase === "active" ? "agent running" : "not yet claimed"}
            </Badge>

            <h1 className="mt-4 text-4xl leading-[0.95] font-bold tracking-tight sm:text-5xl">
              {ended ? (
                <>
                  It has
                  <br />
                  <span className="marker text-block">stopped.</span>
                </>
              ) : (
                <>
                  Your agent is
                  <br />
                  <span className="marker text-sui-deep">working.</span>
                </>
              )}
            </h1>

            <p className="mt-5 max-w-md leading-relaxed text-muted">
              It acts on its own schedule, whether or not this page is open. The
              agent proposes; the chain decides — nothing below depends on it
              behaving itself.
            </p>

            {/* The numbers this person actually bears the consequence of. */}
            {live && (
              <div className="panel mt-6 p-5">
                <div className="grid grid-cols-3 gap-4">
                  <Stat k="Left in the vault" v={sui(live.chain.vaultBalance)} unit="SUI" />
                  <Stat k="Spent so far" v={sui(live.chain.spent)} unit="SUI" />
                  <Stat k="Available today" v={sui(live.status.windowRemaining)} unit="SUI" tone="sui" />
                </div>
                <div className="mt-4">
                  <Meter
                    value={Number(live.chain.spent)}
                    max={Number(live.chain.totalCap)}
                    tone={ended ? "block" : "pass"}
                  />
                </div>

                {/* Stopping it is the recipient's power, not a demo button. */}
                <div className="mt-5 flex flex-wrap items-center gap-2">
                  {!session ? (
                    <p className="text-xs text-muted">Sign in to pause or hand this back.</p>
                  ) : !mine ? (
                    <p className="text-xs text-muted">
                      Claimed by{" "}
                      <span className="val">{live.chain.principal?.slice(0, 12)}…</span> — only
                      that address can pause or hand it back.
                    </p>
                  ) : (
                    <>
                      <button
                        className="btn btn-sm"
                        disabled={busy || ended}
                        onClick={() =>
                          control(
                            {
                              kind: "principalPause",
                              capsuleId: live.capsuleId,
                              paused: !live.chain.principalPaused,
                            },
                            live.chain.principalPaused ? "resumed" : "paused",
                          )
                        }
                      >
                        {live.chain.principalPaused ? "Resume" : "Pause the agent"}
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={busy || ended}
                        onClick={() =>
                          control({ kind: "surrender", capsuleId: live.capsuleId }, "handed back")
                        }
                      >
                        Hand it back
                      </button>
                    </>
                  )}
                  <a href="/mine" className="ml-auto text-xs font-semibold text-muted hover:text-sui-deep">
                    all your intents →
                  </a>
                </div>

                {note && <p className="mt-3 text-xs font-semibold text-sui-deep">{note}</p>}
              </div>
            )}
          </>
        );
      })()}

      {/*
        Demo instruments, not the product. Driving the agent by hand is for
        answering "what if it tries X" in two seconds instead of waiting for
        a budget window — which is why it is folded away rather than being
        the first thing a recipient sees on a page about their own money.
      */}
      <details className="mt-8">
        <summary className="val cursor-pointer list-none text-xs tracking-widest text-muted uppercase hover:text-sui-deep">
          ▸ drive it by hand
        </summary>

        <button onClick={run} disabled={running} className="btn btn-primary mt-4 w-full py-3.5">
          {running ? "Running…" : events.length ? "Replay the scripted run ↻" : "Play a scripted run →"}
        </button>

        <p className="mt-4 text-xs tracking-widest text-muted uppercase">Or trigger one</p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {(
          [
            ["within", "Within the limit", "pass"],
            ["over", "Past the daily limit", "block"],
            ["wrongPool", "Unapproved pool", "block"],
            ["keepProceeds", "Keep the proceeds", "block"],
            ["decline", "Decline to trade", "pending"],
            ["escalate", "Ask permission", "pending"],
            ["usePermit", "Spend the permit", "pass"],
          ] as const
        ).map(([k, labelText, tone]) => (
          <button
            key={k}
            onClick={() => step(k)}
            disabled={running}
            className="btn btn-sm justify-start gap-2 py-2.5 text-left"
          >
            <span
              aria-hidden
              className={`inline-block h-2 w-2 shrink-0 rounded-full border border-ink ${
                tone === "pass" ? "bg-pass" : tone === "block" ? "bg-block" : "bg-pending"
              }`}
            />
            {labelText}
          </button>
        ))}
        </div>
      </details>

      {/*
        The live feed is this run and nothing else — it lives in component
        state, so leaving the page and coming back used to show an empty
        console and a "Run the agent" button, as though the agent had never
        done anything. It had; the record was just somewhere this page was
        not looking. What happened before now comes from the chain.
      */}
      {events.length === 0 && (
        <div className="panel mt-8 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-ink bg-sky px-5 py-3">
            <span className="inline-flex items-center gap-1.5">
              <span className="val text-xs font-semibold">{label}</span>
              <Copy value={label} label="label" />
            </span>
            <Badge tone="idle">what has happened so far</Badge>
          </div>
          <div className="px-5 py-2">
            <History label={label} />
          </div>
          <p className="border-t-2 border-ink bg-paper px-5 py-3 text-xs text-muted">
            Read from Sui, so it survives a refresh, this laptop, and us. Run the
            agent above to watch the next decisions happen live.
          </p>
        </div>
      )}

      {events.length > 0 && (
        <div className="panel mt-8 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-ink bg-sky px-5 py-3">
            <span className="inline-flex items-center gap-1.5">
              <span className="val text-xs font-semibold">{label}</span>
              <Copy value={label} label="label" />
            </span>
            <span className="flex gap-2">
              <Badge tone="pass">{executed} executed</Badge>
              <Badge tone="block">{blocked} refused</Badge>
            </span>
          </div>

          <div className="divide-y-2 divide-line">
            {events.map((e, i) => (
              <Line key={i} e={e} />
            ))}
          </div>
        </div>
      )}

      <div ref={endRef} />

      {events.length > 0 && !running && (
        <p className="mt-6 text-xs leading-relaxed text-muted">
          Every refusal above is a Move <span className="val font-semibold">assert!</span>{" "}
          aborting the transaction. The agent could not have proceeded regardless of what it
          intended, what our backend told it, or what it had been convinced of.
        </p>
      )}
    </Shell>
  );
}

function Line({ e }: { e: Event }) {
  if (e.kind === "info") {
    return (
      <div className="row-in bg-paper px-5 py-3">
        <p className="text-xs leading-relaxed text-muted">{e.text}</p>
      </div>
    );
  }

  if (e.kind === "propose") {
    return (
      <div className="row-in px-5 py-3">
        <p className="text-sm">
          <span className="text-muted">proposes </span>
          <span className="val font-semibold">{e.text}</span>
          <span className="val text-muted"> · {e.amount}</span>
        </p>
        {e.meta && <p className="val mt-0.5 text-xs text-muted">{e.meta}</p>}
      </div>
    );
  }

  if (e.kind === "engine") {
    return (
      <div className="row-in px-5 py-2.5 pl-10">
        <p className={`text-xs ${e.ok ? "text-muted" : "text-pending"}`}>
          engine · {e.reason}
        </p>
      </div>
    );
  }

  const tone =
    e.kind === "executed" ? "text-pass" : e.kind === "blocked" ? "text-block" : "text-pending";
  const mark = e.kind === "executed" ? "✓" : e.kind === "blocked" ? "✕" : "◇";

  return (
    <div className={`row-in stripe flex items-baseline gap-3 px-5 py-3.5 ${tone}`}>
      <span className="val text-sm font-bold" aria-hidden>
        {mark}
      </span>
      <div className="min-w-0 flex-1">
        <p className="val text-sm font-semibold text-ink">
          {e.kind === "executed" && `settled · ${e.amountIn}`}
          {e.kind === "blocked" && "nothing moved"}
          {e.kind === "skipped" && e.reason}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
          {e.kind === "executed" && e.digest && (
            <>
              <span className="val truncate">{e.digest.slice(0, 20)}…</span>
              <Copy value={e.digest} label="digest" />
            </>
          )}
          {e.kind === "blocked" && e.message}
          {e.kind === "skipped" && "agent-attested · not enforced"}
        </p>
      </div>
      <span className="val shrink-0 text-[10px] font-bold tracking-wide">
        {e.kind === "executed" ? "EXECUTED" : e.kind === "blocked" ? e.code : "SKIPPED"}
      </span>
    </div>
  );
}
