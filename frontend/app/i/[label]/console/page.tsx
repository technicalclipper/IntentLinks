"use client";

import { use, useCallback, useRef, useState } from "react";

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
  const [events, setEvents] = useState<Event[]>([]);
  const [running, setRunning] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

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

  const blocked = events.filter((e) => e.kind === "blocked").length;
  const executed = events.filter((e) => e.kind === "executed").length;

  return (
    <main className="relative min-h-dvh overflow-hidden p-6">
      <div className="grid-bg grid-fade pointer-events-none absolute inset-0" />

      <div className="relative mx-auto max-w-2xl pt-14 pb-24">
        <a href={`/i/${label}`} className="val text-sm text-accent">
          [→]
        </a>

        <h1 className="mt-8 text-5xl leading-[0.95] tracking-tight">
          Watch it
          <br />
          <span className="text-accent">get refused.</span>
        </h1>
        <p className="mt-6 max-w-md leading-relaxed text-muted">
          The agent proposes; the chain decides. Nothing below depends on the
          agent behaving itself.
        </p>

        <button
          onClick={run}
          disabled={running}
          className="mt-8 w-full border border-ink bg-ink px-5 py-3.5 text-paper disabled:opacity-30"
        >
          {running ? "Running…" : events.length ? "Run again" : "Run the agent →"}
        </button>

        {events.length > 0 && (
          <div className="panel mt-8">
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <p className="val text-xs text-muted">{label}</p>
              <p className="val text-xs">
                <span className="text-pass">{executed} executed</span>
                <span className="text-muted"> · </span>
                <span className="text-block">{blocked} refused</span>
              </p>
            </div>

            <div className="divide-y divide-line">
              {events.map((e, i) => (
                <Line key={i} e={e} />
              ))}
            </div>
          </div>
        )}

        <div ref={endRef} />

        {events.length > 0 && !running && (
          <p className="mt-6 text-xs leading-relaxed text-muted">
            Every refusal above is a Move <span className="val">assert!</span> aborting the
            transaction. The agent could not have proceeded regardless of what it
            intended, what our backend told it, or what it had been convinced of.
          </p>
        )}
      </div>
    </main>
  );
}

function Line({ e }: { e: Event }) {
  if (e.kind === "info") {
    return (
      <div className="row-in px-5 py-3">
        <p className="text-xs leading-relaxed text-muted">{e.text}</p>
      </div>
    );
  }

  if (e.kind === "propose") {
    return (
      <div className="row-in px-5 py-3">
        <p className="text-sm">
          <span className="text-muted">proposes </span>
          <span className="val">{e.text}</span>
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
  const mark = e.kind === "executed" ? "⛓" : e.kind === "blocked" ? "⨯" : "◇";

  return (
    <div className={`row-in stripe flex items-baseline gap-4 px-5 py-3.5 ${tone}`}>
      <span className="val text-xs">{mark}</span>
      <div className="min-w-0 flex-1">
        <p className="val text-sm text-ink">
          {e.kind === "executed" && `settled · ${e.amountIn}`}
          {e.kind === "blocked" && "nothing moved"}
          {e.kind === "skipped" && e.reason}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {e.kind === "executed" && e.digest?.slice(0, 16)}
          {e.kind === "blocked" && e.message}
          {e.kind === "skipped" && "agent-attested · not enforced"}
        </p>
      </div>
      <span className="val shrink-0 text-[10px] tracking-wide">
        {e.kind === "executed" ? "EXECUTED" : e.kind === "blocked" ? e.code : "SKIPPED"}
      </span>
    </div>
  );
}
