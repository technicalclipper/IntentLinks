"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Copy } from "@/components/ui";

interface Entry {
  kind: string;
  atMs: number | null;
  digest: string;
  actor: string | null;
  amount: string | null;
  detail: string | null;
  elevated: boolean;
}

/**
 * What happened, read from Sui.
 *
 * Reconstructed from Move events rather than from anything we store, which
 * is the whole point of showing it: a log our server writes is a claim
 * about what happened, and this is what happened. Both parties see the
 * identical list — the recipient is accountable for what the agent did
 * with their authority and the issuer is paying for it, so a history only
 * one of them can audit is no use to either.
 */

/** Colour never carries the meaning alone; each row has a word and a mark. */
const LOOK: Record<string, { mark: string; tone: string; label: string }> = {
  minted: { mark: "✦", tone: "text-muted", label: "created" },
  redeemed: { mark: "✓", tone: "text-pass", label: "redeemed" },
  executed: { mark: "✓", tone: "text-pass", label: "executed" },
  swapped: { mark: "✓", tone: "text-pass", label: "traded" },
  escalation_requested: { mark: "◴", tone: "text-pending", label: "asked to exceed" },
  permit_minted: { mark: "◴", tone: "text-pending", label: "approved, once" },
  permit_consumed: { mark: "✓", tone: "text-pass", label: "permit spent" },
  window_rolled: { mark: "·", tone: "text-muted", label: "new period" },
  skipped: { mark: "◇", tone: "text-pending", label: "declined" },
  revoked: { mark: "✕", tone: "text-block", label: "revoked" },
  vault_revoked: { mark: "✕", tone: "text-block", label: "swept" },
  paused: { mark: "◴", tone: "text-pending", label: "paused" },
  surrendered: { mark: "✕", tone: "text-block", label: "handed back" },
  caps_reduced: { mark: "↓", tone: "text-muted", label: "limits tightened" },
  funded: { mark: "+", tone: "text-muted", label: "topped up" },
  withdrawn: { mark: "−", tone: "text-muted", label: "withdrawn" },
};

export function History({ label, compact }: { label: string; compact?: boolean }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/intents/${label}/history`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setEntries(d.entries ?? [])))
      .catch((e) => setError(String(e)));
  }, [label]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (error) {
    return <p className="text-xs text-block">Could not read the history: {error}</p>;
  }
  if (!entries) {
    return <p className="waiting text-xs text-muted">Reading the chain…</p>;
  }
  if (entries.length === 0) {
    return <p className="text-xs text-muted">Nothing has happened yet.</p>;
  }

  const shown = compact ? entries.slice(-6) : entries;

  return (
    <div>
      {compact && entries.length > shown.length && (
        <p className="mb-2 text-xs text-muted">
          Showing the last {shown.length} of {entries.length}.
        </p>
      )}

      <ol className="space-y-0">
        {shown.map((e, i) => {
          const look = LOOK[e.kind] ?? { mark: "·", tone: "text-muted", label: e.kind };
          return (
            <li
              key={`${e.digest}-${i}`}
              className={`stripe flex items-baseline gap-3 border-b-2 border-line py-2.5 pl-3 last:border-b-0 ${look.tone}`}
            >
              <span className="val w-4 shrink-0 text-sm font-bold" aria-hidden>
                {look.mark}
              </span>

              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">
                  {look.label}
                  {e.elevated && (
                    <span className="val ml-2 text-[10px] text-pending">ESCALATED</span>
                  )}
                </p>
                {e.detail && <p className="mt-0.5 text-xs text-muted">{e.detail}</p>}
              </div>

              <div className="shrink-0 text-right">
                <p className="val text-[11px] text-muted">
                  {e.atMs ? new Date(e.atMs).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }) : "—"}
                </p>
                {e.digest && !compact && (
                  <span className="mt-0.5 inline-flex items-center gap-1">
                    <span className="val text-[10px] text-muted">{e.digest.slice(0, 8)}…</span>
                    <Copy value={e.digest} label="digest" />
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The framed version, for a page that is mostly this. */
export function HistoryPanel({ label }: { label: string }) {
  return (
    <div className="panel mt-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-ink bg-sky px-5 py-3">
        <p className="text-xs font-bold tracking-widest uppercase">History</p>
        <Badge tone="idle">from Move events</Badge>
      </div>
      <div className="px-5 py-2">
        <History label={label} />
      </div>
      <p className="border-t-2 border-ink bg-paper px-5 py-3 text-xs text-muted">
        Read from Sui, not from us. Every row is an event the contract emitted;
        delete our database and this survives unchanged.
      </p>
    </div>
  );
}
