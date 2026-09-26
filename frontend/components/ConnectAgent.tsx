"use client";

import { useState } from "react";
import { Badge, Copy } from "@/components/ui";

/**
 * Plugging your own agent into a permission.
 *
 * The thing being handed over is not an API key and a page of docs — it is
 * a line of configuration. Paste it into Claude Desktop, Cursor, or
 * anything else that speaks MCP, restart, and that agent now holds a
 * bounded spending authority it cannot exceed.
 *
 * Worth being exact about what the config contains: a token scoped to one
 * capsule. It is a bearer credential, and it is worth almost nothing on
 * its own — it cannot exceed a cap, reach an unapproved pool, or move
 * proceeds anywhere but the address fixed when the link was created, and
 * it dies the moment the human revokes. That is what a capability is, and
 * it is why this can be pasted into software we have never seen.
 */
export function ConnectAgent({
  token,
  label,
  name,
}: {
  token: string;
  label: string;
  name: string;
}) {
  const [tab, setTab] = useState<"claude" | "cursor" | "raw">("claude");

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const url = `${origin}/api/mcp/${token}`;

  const snippets: Record<typeof tab, { file: string; body: string }> = {
    claude: {
      file: "claude_desktop_config.json",
      body: JSON.stringify(
        { mcpServers: { intentlink: { type: "http", url } } },
        null,
        2,
      ),
    },
    cursor: {
      file: ".cursor/mcp.json",
      body: JSON.stringify({ mcpServers: { intentlink: { url } } }, null, 2),
    },
    raw: {
      file: "any MCP client",
      body: url,
    },
  };

  const snip = snippets[tab];

  return (
    <div className="panel mt-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-ink bg-sky px-5 py-3">
        <p className="text-xs font-bold tracking-widest uppercase">Connect your agent</p>
        <Badge tone="pass">ready</Badge>
      </div>

      <div className="p-5">
        <p className="text-sm">
          Paste this into your AI assistant, restart it, and it can act on{" "}
          <span className="val">{name}</span> — inside the limits, and nowhere else.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {(
            [
              ["claude", "Claude Desktop"],
              ["cursor", "Cursor"],
              ["raw", "URL only"],
            ] as const
          ).map(([k, labelText]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`btn btn-sm ${tab === k ? "btn-ink" : ""}`}
            >
              {labelText}
            </button>
          ))}
        </div>

        <p className="val mt-4 text-[11px] tracking-wide text-muted">{snip.file}</p>
        <div className="mt-1.5 flex items-start gap-2">
          <pre className="panel-flat min-w-0 flex-1 overflow-x-auto px-3 py-2.5 text-[11px] leading-relaxed">
            <code className="val">{snip.body}</code>
          </pre>
          <Copy value={snip.body} label="config" />
        </div>

        {/* What the agent will find once it connects. Named here because a
            person deciding whether to paste this deserves to know. */}
        <p className="mt-5 text-xs tracking-widest text-muted uppercase">
          Tools it will be given
        </p>
        <ul className="mt-2 space-y-1 text-xs text-muted">
          <Tool k="get_permission">its bounds and what is left of them</Tool>
          <Tool k="quote">what the pool would pay, before committing</Tool>
          <Tool k="execute">make a trade — refused by the chain if out of bounds</Tool>
          <Tool k="request_escalation">ask you for more room; it cannot grant itself any</Tool>
          <Tool k="get_history">what it has already done</Tool>
        </ul>

        <p className="mt-5 text-xs leading-relaxed text-muted">
          The tool list is built from your capability, so it cannot see an action
          outside scope. That part is convenience. The guarantee is underneath: an
          agent that ignores all of it and asks for ten times the limit gets an
          abort code from Sui and moves nothing.
        </p>

        <details className="group mt-4">
          <summary className="val cursor-pointer list-none text-xs text-muted hover:text-sui-deep">
            ▸ what this token can do if it leaks
          </summary>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Trades within your daily and total limits, in the one approved pool,
            with the proceeds going to the same address they were always going
            to. It cannot withdraw, cannot redirect, cannot exceed the hard cap,
            and stops the instant you pause or hand the capability back. Revoking
            is on your{" "}
            <a href="/mine" className="underline decoration-sui decoration-2">
              intents page
            </a>
            , and it takes effect on the next action rather than eventually.
          </p>
        </details>

        <p className="mt-4 text-xs text-muted">
          Prefer your agent to sign for itself?{" "}
          <span className="val">/i/{label}</span> can be redeemed with your own
          agent address instead — then we hold no key at all.
        </p>
      </div>
    </div>
  );
}

function Tool({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <li className="flex flex-wrap gap-x-2">
      <span className="val text-ink">{k}</span>
      <span>— {children}</span>
    </li>
  );
}
