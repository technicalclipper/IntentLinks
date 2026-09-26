"use client";

import { Badge, Copy, Mono, Nav } from "@/components/ui";
import { useZkLogin } from "@/lib/zklogin/useZkLogin";

/**
 * The home page shows the product's best moment rather than describing it.
 *
 * Anyone can demo a transaction succeeding. The interesting screen is the
 * one where the chain refuses — so that is what goes above the fold, with
 * the abort code visible and no explanation offered for it.
 */
export default function Home() {
  const { session, loading, error, signIn, signOut } = useZkLogin();

  return (
    <main className="relative min-h-dvh overflow-hidden">
      <div className="glow pointer-events-none absolute inset-0 -z-10" />
      <div className="grid-bg grid-fade pointer-events-none absolute inset-0 -z-10" />

      <Nav
        right={
          session ? (
            <>
              <a href="/mine" className="btn btn-sm">
                Your intents
              </a>
              <a href="/create" className="btn btn-sm btn-primary">
                Create
              </a>
            </>
          ) : (
            <button onClick={signIn} disabled={loading} className="btn btn-sm btn-primary">
              {loading ? "Redirecting…" : "Sign in"}
            </button>
          )
        }
      />

      <div className="relative mx-auto max-w-3xl px-5 pt-10 pb-24 sm:px-8">
        <span className="badge bg-sun">⇥ built on Sui · ENS · World ID</span>

        <h1 className="mt-6 text-5xl leading-[0.92] font-bold tracking-tight sm:text-7xl">
          A link that
          <br />
          carries a
          <br />
          <span className="marker text-sui-deep">permission.</span>
        </h1>

        <p className="mt-7 max-w-lg text-lg leading-relaxed text-muted">
          Give an AI agent a bounded, revocable authority — how much, how often,
          where, for how long. The limits are Move asserts on Sui, so{" "}
          <b className="text-ink">the chain refuses. Not the agent.</b>
        </p>

        {/* The product, not a description of it. */}
        <div className="panel mt-12 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-ink bg-sky px-5 py-3">
            <span className="inline-flex items-center gap-1.5">
              <span className="val text-xs font-semibold">dca.alice.intentlink.eth</span>
              <Copy value="dca.alice.intentlink.eth" label="name" />
            </span>
            <span className="val text-xs">day 8 of 30</span>
          </div>

          <div className="divide-y-2 divide-line">
            <Row tone="pass" delay={0} label="swap 12 SUI · Cetus" detail="settled to Alice" tag="EXECUTED" />
            <Row tone="block" delay={90} label="swap 26 SUI" detail="nothing moved" tag="E_OVER_WINDOW_CAP" />
            <Row
              tone="pending"
              delay={180}
              label="escalation requested · 26 SUI"
              detail="the agent can ask, it cannot approve"
              tag="WORLD ID"
            />
            <Row
              tone="block"
              delay={270}
              label="proceeds → agent's own address"
              detail="refused before any coin moved"
              tag="E_WRONG_BENEFICIARY"
            />
          </div>

          <p className="border-t-2 border-ink bg-paper px-5 py-3 text-xs text-muted">
            The refusals are the product. Anyone can build an agent that spends.
          </p>
        </div>

        {/* --- sign in ------------------------------------------- */}
        <div className="panel mt-8 p-6">
          {session ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="pass">signed in</Badge>
                <span className="text-sm">{session.email}</span>
              </div>

              <p className="mt-5 text-xs tracking-widest text-muted uppercase">
                Your Sui address
              </p>
              <div className="mt-1.5">
                <Mono value={session.address} chars={10} label="address" />
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <a href="/create" className="btn btn-primary">
                  Create an intent
                </a>
                <a href="/mine" className="btn">
                  Your intents
                </a>
                <button onClick={signOut} className="btn">
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-lg font-bold">Start in one click</h2>
              <p className="mt-1 text-sm text-muted">
                No wallet. No seed phrase. No gas. Your address is derived from
                your Google account and the transactions are sponsored.
              </p>
              <button
                onClick={signIn}
                disabled={loading}
                className="btn btn-primary mt-5"
              >
                {loading ? "Redirecting…" : "Continue with Google"}
              </button>
              {error && <p className="mt-4 text-sm text-block">{error}</p>}
            </>
          )}
        </div>

        {/* --- the three chains ---------------------------------- */}
        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          <Pillar
            k="Sui"
            v="Fifteen asserts stand between the agent and the funds. A hot potato makes settling to the right address structurally unavoidable."
          />
          <Pillar
            k="ENS"
            v="Each capability is a subname. The agent resolves it to learn its own bounds — and halts if ENS and Sui disagree."
          />
          <Pillar
            k="World"
            v="A live human redeems the link — and, the part nothing else can do, the agent cannot approve its own escalation, because it cannot be a person."
          />
        </div>
      </div>
    </main>
  );
}

function Row({
  tone,
  label,
  detail,
  tag,
  delay,
}: {
  tone: "pass" | "block" | "pending";
  label: string;
  detail: string;
  tag: string;
  delay: number;
}) {
  const colour =
    tone === "pass" ? "text-pass" : tone === "block" ? "text-block" : "text-pending";
  const glyph = tone === "pass" ? "✓" : tone === "block" ? "✕" : "◴";

  return (
    <div
      className={`row-in stripe flex items-baseline gap-3 px-5 py-3.5 ${colour}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <span className="val text-sm font-bold" aria-hidden>
        {glyph}
      </span>
      <div className="min-w-0 flex-1">
        <p className="val truncate text-sm font-semibold text-ink">{label}</p>
        <p className="mt-0.5 text-xs text-muted">{detail}</p>
      </div>
      <span className="val shrink-0 text-[10px] font-bold tracking-wide">{tag}</span>
    </div>
  );
}

function Pillar({ k, v }: { k: string; v: string }) {
  return (
    <div className="panel-flat p-5 transition-transform hover:-translate-y-0.5">
      <span className="badge bg-sui">{k}</span>
      <p className="mt-3 text-sm leading-relaxed text-muted">{v}</p>
    </div>
  );
}
