"use client";

import { useEffect, useState } from "react";
import { Badge, Copy } from "@/components/ui";

/**
 * The pitch, as a page.
 *
 * Built as scroll-snapped full-height slides rather than a carousel: a
 * judge scrolls, and a scroll bar is a progress bar everyone already
 * knows how to read. Every claim here is one the repository can back —
 * the assert count, the abort codes and the sponsor descriptions are the
 * real ones, because the fastest way to lose a technical judge is a deck
 * that is slightly better than the code.
 */

const SLIDES = [
  "intentlink",
  "the idea",
  "the problem",
  "the refusal",
  "use cases",
  "your agent",
  "world",
  "sponsors",
  "close",
];

export default function Deck() {
  const [active, setActive] = useState(0);

  // Which slide is in view, for the rail. Observed rather than tracked on
  // scroll position, so it stays right if someone jumps with a keyboard.
  useEffect(() => {
    const els = document.querySelectorAll("[data-slide]");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.slide));
        }
      },
      { threshold: 0.55 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <main className="relative h-dvh snap-y snap-mandatory overflow-y-auto">
      <div className="glow pointer-events-none fixed inset-0 -z-10" />
      <div className="grid-bg pointer-events-none fixed inset-0 -z-10 opacity-60" />

      {/* Where you are, and how much is left. */}
      <nav className="fixed top-1/2 right-4 z-20 hidden -translate-y-1/2 flex-col gap-2 sm:flex">
        {SLIDES.map((s, i) => (
          <a
            key={s}
            href={`#s${i}`}
            title={s}
            className={`h-2.5 rounded-full border-2 border-ink transition-all ${
              i === active ? "h-7 bg-sui" : "w-2.5 bg-panel hover:bg-sky"
            } w-2.5`}
          />
        ))}
      </nav>

      <Slide i={0}>
        <span className="badge bg-sun">ETHGlobal Tokyo 2026</span>
        <h1 className="mt-6 text-6xl leading-[0.88] font-bold tracking-tight sm:text-8xl">
          A link
          <br />
          that carries a
          <br />
          <span className="marker text-sui-deep">permission.</span>
        </h1>
        <p className="mt-8 max-w-xl text-xl leading-relaxed text-muted">
          Bounded, revocable spending authority for AI agents —{" "}
          <b className="text-ink">enforced by the chain, not by the agent&rsquo;s good behaviour.</b>
        </p>
        <p className="val mt-10 text-xs tracking-widest text-muted uppercase">
          Sui · ENS · World ID ↓
        </p>
      </Slide>

      <Slide i={1} title="The idea">
        <p className="max-w-2xl text-2xl leading-snug font-semibold sm:text-3xl">
          You write what an agent may do in plain English. You send a link. Whoever
          opens it proves they&rsquo;re a human and plugs in whatever agent they like.
        </p>
        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          <Step n="1" k="Write" v="“Sell 0.02 SUI a day for 30 days, max 1% slippage, send the proceeds to Bob.”" />
          <Step n="2" k="Send" v="A link, and a QR beside it. No wallet, no seed phrase, no gas for anyone." />
          <Step n="3" k="Enforce" v="The limits aren’t in our code. They’re Move asserts on Sui." />
        </div>
        <p className="panel-ink mt-8 inline-block px-5 py-3 text-lg font-bold">
          19 asserts. Every single spend.
        </p>
      </Slide>

      <Slide i={2} title="The problem">
        <p className="max-w-2xl text-xl leading-relaxed text-muted">
          Handing an agent money today is handing over the keys and hoping. You get a
          valet who can drive anywhere — and a note on the dashboard asking nicely.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <div className="panel border-block p-6">
            <Badge tone="block">today</Badge>
            <p className="mt-3 text-lg font-bold">Instructions</p>
            <ul className="mt-3 space-y-2 text-sm text-muted">
              <li>“Only spend $50 a day” — in a prompt</li>
              <li>An API key that does everything</li>
              <li>You find out afterwards</li>
              <li>Stopping it means rotating keys</li>
            </ul>
          </div>
          <div className="panel-tint p-6">
            <Badge tone="pass">IntentLink</Badge>
            <p className="mt-3 text-lg font-bold">A key that only fits one lock</p>
            <ul className="mt-3 space-y-2 text-sm text-muted">
              <li>$50/day is a number in a Move object</li>
              <li>One pool, one destination, one month</li>
              <li>The 51st dollar never leaves</li>
              <li>Revoke in one transaction</li>
            </ul>
          </div>
        </div>

        <p className="mt-7 max-w-2xl text-lg">
          A valet key. The car starts, the boot stays shut, and it isn&rsquo;t a promise —
          it&rsquo;s the shape of the key.
        </p>
      </Slide>

      <Slide i={3} title="The moment">
        <p className="max-w-xl text-lg text-muted">
          Anyone can demo an agent that spends. Here is one being refused.
        </p>

        <div className="panel mt-6 w-full max-w-2xl overflow-hidden">
          <div className="border-b-2 border-ink bg-sky px-5 py-2.5">
            <span className="val text-xs font-semibold">Claude Desktop → IntentLink (MCP)</span>
          </div>
          <Line tone="pass" a="sell 0.01 SUI" b="settled to the recipient" tag="EXECUTED" />
          <Line tone="block" a="sell 5 SUI" b="nothing moved" tag="E_OVER_ACTION_CAP" />
          <Line tone="block" a="route through another pool" b="nothing moved" tag="E_POOL_NOT_SCOPED" />
          <Line tone="block" a="keep the proceeds" b="refused before any coin moved" tag="E_WRONG_BENEFICIARY" />
          <Line tone="pending" a="ask to exceed the limit" b="the agent can ask, it cannot approve" tag="WORLD ID" />
        </div>

        <p className="mt-6 max-w-2xl text-lg font-semibold">
          That&rsquo;s a general-purpose AI we didn&rsquo;t write, on someone else&rsquo;s laptop.
          It tried. Sui said no.
        </p>
      </Slide>

      <Slide i={4} title="Who it&rsquo;s for">
        <div className="grid gap-4 sm:grid-cols-2">
          <Case
            k="Set it up for Mum"
            v="She gets a link, not a wallet. Signs in with Google, an agent handles her savings, and she can hand it back any time. You funded it and can revoke it — she never touches a seed phrase."
          />
          <Case
            k="A strategy you don’t babysit"
            v="Give your own agent 30 days and a daily budget. It trades while you sleep, inside limits you set once, while awake."
          />
          <Case
            k="Any agent platform"
            v="Bring the permission to the agent instead of the agent to the money. It plugs into what you already use."
          />
          <Case
            k="Teams, allowances, payroll, subscriptions"
            v="Anywhere one party funds and another spends — with a ceiling, a clock, and a revoke button."
          />
        </div>
        <p className="mt-8 text-lg">
          The primitive is <b>delegated, bounded, revocable authority.</b> Trading is
          just the demo.
        </p>
      </Slide>

      <Slide i={5} title="Bring your own agent">
        <p className="max-w-2xl text-xl leading-relaxed text-muted">
          Every permission is also an <b className="text-ink">MCP server</b>. Paste one
          line into Claude Desktop or Cursor, restart, and that assistant holds a
          spending authority it cannot exceed.
        </p>

        <div className="panel mt-6 w-full max-w-2xl p-4">
          <div className="flex items-start gap-2">
            <pre className="min-w-0 flex-1 overflow-x-auto text-[11px] leading-relaxed">
              <code className="val">{CONFIG}</code>
            </pre>
            <Copy value={CONFIG} label="config" />
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <div className="panel-flat p-4">
            <p className="text-sm font-bold">Tools built from the capsule</p>
            <p className="val mt-2 text-xs text-muted">
              get_permission · quote · execute · request_escalation · get_history
            </p>
            <p className="mt-2 text-xs text-muted">
              It cannot see an action outside its scope. That part is convenience.
            </p>
          </div>
          <div className="panel-flat p-4">
            <p className="text-sm font-bold">The chain doesn&rsquo;t care what it read</p>
            <p className="mt-2 text-xs text-muted">
              Ignore every description, ask for ten times the cap, and you get an abort
              code. That part is the guarantee.
            </p>
          </div>
        </div>
      </Slide>

      <Slide i={6} title="Backed by a human">
        <p className="max-w-2xl text-xl leading-relaxed text-muted">
          An agent can <b className="text-ink">ask</b> to exceed its limit. It can never
          approve.
        </p>
        <div className="panel mt-6 w-full max-w-2xl p-6">
          <p className="val text-sm">
            approve_escalation <span className="text-muted">asserts</span>{" "}
            <b className="text-sui-deep">ctx.sender() == capsule.issuer</b>
          </p>
          <p className="mt-4 text-base leading-relaxed">
            Plus a fresh World ID proof, signal-bound to{" "}
            <span className="val text-sm">hash(capsule, amount, nonce)</span> — so a
            stored credential can&rsquo;t be replayed, and a yes to 26 can&rsquo;t be
            stretched into a yes to 260.
          </p>
          <p className="mt-4 border-t-2 border-line pt-4 text-base font-semibold">
            Every other approval mechanism is a bearer token. A bearer token can be handed
            to the agent you&rsquo;re trying to constrain. A live human cannot.
          </p>
        </div>
        <p className="mt-5 text-sm text-muted">
          Our own backend used to be able to mint that approval. We deleted the path.
        </p>
      </Slide>

      <Slide i={7} title="Three chains, three jobs">
        <div className="grid gap-4 sm:grid-cols-3">
          <Sponsor
            k="Sui"
            head="Enforces it"
            v="19 asserts between any agent and the funds, on every spend. An ExecTicket hot potato with no abilities at all — the transaction is structurally incapable of finishing unless the proceeds land on the right address."
            note="Not checked afterwards. Unrepresentable."
          />
          <Sponsor
            k="ENS"
            head="Publishes it"
            v="A subname per capability under intentlink.eth, issued through an ENSv2 PermissionedRegistry. Its records carry a hash of the terms — the same hash that sits inside the Sui object."
            note="The agent halts if the two chains disagree."
          />
          <Sponsor
            k="World"
            head="Vouches for it"
            v="A live human redeems the link. And the agent cannot approve its own escalation, because it cannot be a person."
            note="The one thing no credential can substitute for."
          />
        </div>
        <p className="mt-8 max-w-3xl text-lg">
          Ethereum names the permission. Sui refuses to break it. World proves a person is
          behind it.
        </p>
      </Slide>

      <Slide i={8}>
        <h2 className="text-5xl leading-[0.95] font-bold tracking-tight sm:text-7xl">
          Anyone can build
          <br />
          an agent that spends.
          <br />
          <span className="marker text-sui-deep">We built the part that says no.</span>
        </h2>
        <div className="mt-10 flex flex-wrap gap-3">
          <a href="/create" className="btn btn-primary">
            Create an intent
          </a>
          <a href="/" className="btn">
            Home
          </a>
        </div>
        <p className="val mt-10 text-xs text-muted">
          intentlink.eth · Sui testnet · World ID v4
        </p>
      </Slide>
    </main>
  );
}

const CONFIG = `{
  "mcpServers": {
    "intentlink": { "type": "http", "url": "https://…/api/mcp/ilk_…" }
  }
}`;

function Slide({
  i,
  title,
  children,
}: {
  i: number;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={`s${i}`}
      data-slide={i}
      className="flex min-h-dvh snap-start flex-col justify-center px-6 py-16 sm:px-14"
    >
      <div className="mx-auto w-full max-w-4xl">
        {title && (
          <p className="val mb-5 text-xs tracking-[0.2em] text-sui-deep uppercase">
            {title}
          </p>
        )}
        {children}
      </div>
    </section>
  );
}

function Step({ n, k, v }: { n: string; k: string; v: string }) {
  return (
    <div className="panel p-5">
      <span className="val inline-grid h-7 w-7 place-items-center rounded-lg border-2 border-ink bg-sui text-sm font-bold">
        {n}
      </span>
      <p className="mt-3 text-lg font-bold">{k}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">{v}</p>
    </div>
  );
}

function Case({ k, v }: { k: string; v: string }) {
  return (
    <div className="panel p-5 transition-transform hover:-translate-y-0.5">
      <p className="text-lg font-bold">{k}</p>
      <p className="mt-2 text-sm leading-relaxed text-muted">{v}</p>
    </div>
  );
}

function Sponsor({ k, head, v, note }: { k: string; head: string; v: string; note: string }) {
  return (
    <div className="panel flex h-full flex-col p-5">
      <span className="badge self-start bg-sui">{k}</span>
      <p className="mt-3 text-lg font-bold">{head}</p>
      <p className="mt-2 flex-1 text-sm leading-relaxed text-muted">{v}</p>
      <p className="val mt-3 border-t-2 border-line pt-3 text-xs text-sui-deep">{note}</p>
    </div>
  );
}

function Line({
  tone,
  a,
  b,
  tag,
}: {
  tone: "pass" | "block" | "pending";
  a: string;
  b: string;
  tag: string;
}) {
  const colour =
    tone === "pass" ? "text-pass" : tone === "block" ? "text-block" : "text-pending";
  const glyph = tone === "pass" ? "✓" : tone === "block" ? "✕" : "◴";
  return (
    <div
      className={`stripe flex items-baseline gap-3 border-b-2 border-line px-5 py-3 last:border-b-0 ${colour}`}
    >
      <span className="val text-sm font-bold" aria-hidden>
        {glyph}
      </span>
      <div className="min-w-0 flex-1">
        <p className="val truncate text-sm font-semibold text-ink">{a}</p>
        <p className="mt-0.5 text-xs text-muted">{b}</p>
      </div>
      <span className="val shrink-0 text-[10px] font-bold tracking-wide">{tag}</span>
    </div>
  );
}
