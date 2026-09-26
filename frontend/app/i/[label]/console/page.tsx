"use client";

import { use, useCallback, useRef, useState } from "react";
import { Badge, Copy, Shell } from "@/components/ui";

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
      <span className="badge bg-sun">live · agent vs chain</span>

      <h1 className="mt-4 text-4xl leading-[0.95] font-bold tracking-tight sm:text-5xl">
        Watch it
        <br />
        <span className="marker text-block">get refused.</span>
      </h1>
      <p className="mt-5 max-w-md leading-relaxed text-muted">
        The agent proposes; the chain decides. Nothing below depends on the agent
        behaving itself.
      </p>

      <button onClick={run} disabled={running} className="btn btn-primary mt-7 w-full py-3.5">
        {running ? "Running…" : events.length ? "Run again ↻" : "Run the agent →"}
      </button>

      {/* Driving it by hand, for when a judge asks "what if it tries X". */}
      <p className="mt-8 text-xs tracking-widest text-muted uppercase">Or trigger one</p>
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
