"use client";

import { useZkLogin } from "@/lib/zklogin/useZkLogin";

/**
 * The home page shows the product's best moment rather than describing it.
 *
 * Anyone can demo a transaction succeeding. The interesting screen is the one
 * where the chain refuses — so that is what goes above the fold, with the
 * abort code visible.
 */
export default function Home() {
  const { session, loading, error, signIn, signOut } = useZkLogin();

  return (
    <main className="relative min-h-dvh overflow-hidden">
      <div className="grid-bg grid-fade pointer-events-none absolute inset-0" />

      <div className="relative mx-auto max-w-3xl px-6 pt-20 pb-24">
        <p className="val text-accent">[→]</p>

        <h1 className="mt-6 text-6xl leading-[0.95] tracking-tight sm:text-7xl">
          A link that
          <br />
          carries a
          <br />
          <span className="text-accent">permission.</span>
        </h1>

        <p className="mt-8 max-w-md text-lg leading-relaxed text-muted">
          Give an AI agent a bounded, revocable authority — how much, how often,
          where, for how long. The limits are Move asserts on Sui, so the chain
          refuses. Not the agent.
        </p>

        {/* The product, not a description of it. */}
        <div className="panel mt-14">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <p className="val text-xs text-muted">dca.alice.intentlink.eth</p>
            <p className="val text-xs text-muted">day 8 of 30</p>
          </div>

          <div className="divide-y divide-line">
            <Row state="pass" delay={0} label="swap 12 SUI · Cetus" detail="0x8a2f…" tag="EXECUTED" />
            <Row
              state="block"
              delay={90}
              label="swap 26 SUI"
              detail="nothing moved"
              tag="E_OVER_WINDOW_CAP"
            />
            <Row
              state="pending"
              delay={180}
              label="escalation requested · 26 SUI"
              detail="awaiting the issuer"
              tag="WORLD ID"
            />
            <Row
              state="block"
              delay={270}
              label="proceeds → agent's own address"
              detail="refused"
              tag="E_WRONG_BENEFICIARY"
            />
          </div>

          <p className="border-t border-line px-5 py-3 text-xs text-muted">
            The refusals are the product. Anyone can build an agent that spends.
          </p>
        </div>

        <div className="panel mt-8 p-6">
          {session ? (
            <>
              <p className="text-sm text-muted">Signed in as</p>
              <p className="mt-1">{session.email}</p>
              <p className="mt-4 text-sm text-muted">Your Sui address</p>
              <p className="val mt-1 text-sm break-all">{session.address}</p>

              <div className="mt-6 flex flex-wrap gap-3">
                <a
                  href="/create"
                  className="border border-ink bg-ink px-5 py-2.5 text-sm text-paper"
                >
                  Create an intent
                </a>
                <a href="/mine" className="border border-line px-5 py-2.5 text-sm">
                  Your intents
                </a>
                <button onClick={signOut} className="border border-line px-5 py-2.5 text-sm">
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                onClick={signIn}
                disabled={loading}
                className="border border-ink bg-ink px-5 py-2.5 text-sm text-paper disabled:opacity-50"
              >
                {loading ? "Redirecting…" : "Continue with Google"}
              </button>
              <p className="mt-3 text-xs text-muted">
                No wallet. No seed phrase. No gas.
              </p>
              {error && <p className="mt-4 text-sm text-block">{error}</p>}
            </>
          )}
        </div>

        <div className="mt-14 grid gap-8 border-t border-line pt-10 sm:grid-cols-3">
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
            v="One link, one human. And the agent cannot approve its own escalation, because it cannot be a person."
          />
        </div>
      </div>
    </main>
  );
}

function Row({
  state,
  label,
  detail,
  tag,
  delay,
}: {
  state: "pass" | "block" | "pending";
  label: string;
  detail: string;
  tag: string;
  delay: number;
}) {
  const colour =
    state === "pass" ? "text-pass" : state === "block" ? "text-block" : "text-pending";

  return (
    <div
      className={`row-in stripe flex items-baseline gap-4 px-5 py-3.5 ${colour}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <span className="val text-xs">
        {state === "pass" ? "⛓" : state === "block" ? "⨯" : "⚠"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="val truncate text-sm text-ink">{label}</p>
        <p className="mt-0.5 text-xs text-muted">{detail}</p>
      </div>
      <span className="val shrink-0 text-[10px] tracking-wide">{tag}</span>
    </div>
  );
}

function Pillar({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <p className="val text-xs tracking-wide text-accent uppercase">{k}</p>
      <p className="mt-2 text-sm leading-relaxed text-muted">{v}</p>
    </div>
  );
}
