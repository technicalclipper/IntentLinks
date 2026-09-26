"use client";

import { useEffect, useState } from "react";

/**
 * The shared vocabulary.
 *
 * Every page previously grew its own Card, Btn and Row, which is how three
 * screens end up with three different ideas of what a border is. These are
 * the only ones now.
 */

/* ===== copy ======================================================= */

/**
 * Copy to clipboard, with the confirmation on the button itself.
 *
 * Addresses and object ids are the things people most need out of this app
 * and least able to retype — one transposed character in a 64-hex string is
 * a support conversation. The feedback is a state change on the control the
 * person just pressed, not a toast somewhere else on the page.
 *
 * navigator.clipboard is undefined on insecure origins, so there is a
 * fallback rather than a button that silently does nothing.
 */
export function Copy({
  value,
  label,
  className = "",
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const el = document.createElement("textarea");
        el.value = value;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        el.remove();
      }
      setDone(true);
    } catch {
      /* A failed copy leaves the value on screen to select by hand. */
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={done ? "Copied" : `Copy${label ? ` ${label}` : ""}`}
      aria-label={done ? "Copied" : `Copy${label ? ` ${label}` : ""}`}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md border-2 px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
        done
          ? "border-pass bg-pass text-white"
          : "border-ink bg-panel hover:bg-sky"
      } ${className}`}
    >
      {done ? <TickIcon /> : <CopyIcon />}
      <span className="val">{done ? "copied" : "copy"}</span>
    </button>
  );
}

/**
 * A value you are meant to copy: truncated in the middle, never wrapped,
 * with the control attached.
 *
 * Truncation is in the middle because the ends of an address are what a
 * person checks against another screen — the middle is the part nobody
 * reads.
 */
export function Mono({
  value,
  href,
  chars = 6,
  label,
  full = false,
}: {
  value: string;
  href?: string;
  chars?: number;
  label?: string;
  full?: boolean;
}) {
  const short =
    full || value.length <= chars * 2 + 3
      ? value
      : `${value.slice(0, chars)}…${value.slice(-chars)}`;

  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title={value}
          className="val truncate text-sm underline decoration-sui decoration-2 underline-offset-2 hover:text-sui-deep"
        >
          {short}
        </a>
      ) : (
        <span className="val truncate text-sm" title={value}>
          {short}
        </span>
      )}
      <Copy value={value} label={label} />
    </span>
  );
}

/** A labelled row of exactly that. */
export function Field({
  k,
  value,
  href,
  chars,
  full,
}: {
  k: string;
  value: string;
  href?: string;
  chars?: number;
  full?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <span className="text-xs text-muted">{k}</span>
      <Mono value={value} href={href} chars={chars} full={full} label={k} />
    </div>
  );
}

/* ===== state ====================================================== */

export type Tone = "pass" | "block" | "pending" | "idle";

const TONE: Record<Tone, { bg: string; icon: string }> = {
  pass: { bg: "bg-pass text-white", icon: "✓" },
  block: { bg: "bg-block text-white", icon: "✕" },
  pending: { bg: "bg-pending text-ink", icon: "◴" },
  idle: { bg: "bg-sky text-ink", icon: "·" },
};

/**
 * Colour is never the only signal. Every badge carries a glyph and a word,
 * so it survives being printed, screenshotted, or read by someone who does
 * not see red and green as different.
 */
export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const t = TONE[tone];
  return (
    <span className={`badge ${t.bg}`}>
      <span aria-hidden>{t.icon}</span>
      {children}
    </span>
  );
}

/** Phase strings from the chain, mapped to a tone once, here. */
export function phaseTone(phase?: string): Tone {
  if (phase === "active") return "pass";
  if (phase === "ended") return "block";
  if (phase === "paused") return "pending";
  return "idle";
}

/* ===== numbers ==================================================== */

export function Stat({
  k,
  v,
  unit,
  tone,
}: {
  k: string;
  v: string;
  unit?: string;
  tone?: "sui" | "pass" | "block";
}) {
  const colour =
    tone === "sui" ? "text-sui-deep" : tone === "pass" ? "text-pass" : tone === "block" ? "text-block" : "";
  return (
    <div>
      <p className="text-xs text-muted">{k}</p>
      <p className={`figure mt-0.5 text-xl sm:text-2xl ${colour}`}>{v}</p>
      {unit && <p className="val text-[10px] tracking-wide text-muted uppercase">{unit}</p>}
    </div>
  );
}

/** Spend against a ceiling. The ceiling is the point, so it is labelled. */
export function Meter({ value, max, tone = "pass" }: { value: number; max: number; tone?: Tone }) {
  const pct = Math.min(100, max > 0 ? (value / max) * 100 : 0);
  const bar = tone === "block" ? "bg-block" : tone === "pending" ? "bg-pending" : "bg-pass";
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full border-2 border-ink bg-panel">
      <div
        className={`h-full ${bar} transition-[width] duration-500`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* ===== page furniture ============================================= */

export function Nav({ right }: { right?: React.ReactNode }) {
  return (
    <nav className="relative z-10 flex items-center justify-between gap-4 px-5 py-4 sm:px-8">
      <a href="/" className="group inline-flex items-center gap-2">
        <span className="inline-grid h-8 w-8 place-items-center rounded-lg border-2 border-ink bg-sui text-sm font-bold shadow-[2px_2px_0_0_var(--color-ink)] transition-transform group-hover:-translate-y-0.5">
          ⇥
        </span>
        <span className="text-[15px] font-bold tracking-tight">IntentLink</span>
      </a>
      <div className="flex items-center gap-2">{right}</div>
    </nav>
  );
}

export function Shell({
  children,
  width = "max-w-3xl",
  nav,
}: {
  children: React.ReactNode;
  width?: string;
  nav?: React.ReactNode;
}) {
  return (
    <main className="relative min-h-dvh overflow-hidden">
      <div className="glow pointer-events-none absolute inset-0 -z-10" />
      <div className="grid-bg grid-fade pointer-events-none absolute inset-0 -z-10" />
      <Nav right={nav} />
      <div className={`relative mx-auto ${width} px-5 pt-6 pb-24 sm:px-8`}>{children}</div>
    </main>
  );
}

/* ===== icons ====================================================== */

function CopyIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="5.2" y="5.2" width="8.6" height="8.6" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M10.8 2.2H4.2a2 2 0 0 0-2 2v6.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function TickIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
