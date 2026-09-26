"use client";

import { useEffect, useState } from "react";
import {
  IDKitRequestWidget,
  deviceLegacy,
  orbLegacy,
  proofOfHuman,
  type IDKitResult,
  type RpContext,
} from "@worldcoin/idkit";
import { useZkLogin } from "@/lib/zklogin/useZkLogin";
import { createdOfType, sendAction } from "@/lib/tx-client";
import { StaleSessionError } from "@/lib/zklogin/client";

const SUI = 1_000_000_000;
const DAY_MS = 86_400_000;
const POOL = process.env.NEXT_PUBLIC_DEMO_POOL_ID ?? "";

const APP_ID = process.env.NEXT_PUBLIC_WORLD_APP_ID as `app_${string}`;
// A separate action from redemption. Nullifiers are per-action, and one
// person playing both issuer and recipient in a demo would otherwise be told
// they have already verified.
const ACTION =
  process.env.NEXT_PUBLIC_WORLD_ACTION_ISSUE ??
  process.env.NEXT_PUBLIC_WORLD_ACTION_IDENTITY ??
  "intentlink-issue";
const CREDENTIAL =
  ({ device: deviceLegacy, orb: orbLegacy, human: proofOfHuman } as const)[
    process.env.NEXT_PUBLIC_WORLD_CREDENTIAL ?? "human"
  ] ?? proofOfHuman;

const EXAMPLES = [
  "Sell 0.02 SUI a day for 30 days, max 1% slippage, send the DUSD to bob@gmail.com",
  "Give my agent 0.5 SUI total, at most 0.05 a day for 10 days, keep the proceeds",
  "Trade up to 0.02 SUI daily for a month. Buy the dip when the market looks good.",
];

type Phase = "compose" | "review" | "minting" | "done";

interface Clause {
  text: string;
  why: string;
}

interface Compiled {
  goal: string;
  perDay: number;
  days: number;
  maxSlippagePct: number;
  beneficiary: "recipient" | "vault";
  recipientEmail: string | null;
  advisory: Clause[];
  rejected: Clause[];
}

export default function Create() {
  const { session, signIn } = useZkLogin();
  const [phase, setPhase] = useState<Phase>("compose");
  const [text, setText] = useState("");
  const [c, setC] = useState<Compiled | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [step, setStep] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);

  // Recorded on the capsule so escalation can prove it is the *same* human
  // who set the limit, not merely a human.
  const [issuerNullifier, setIssuerNullifier] = useState<string | null>(null);
  const [rp, setRp] = useState<RpContext | null>(null);
  // The server mints a fresh action per request, so a second
  // verification is never treated as a repeat of the first.
  const [action, setAction] = useState<string | null>(null);
  const [worldOpen, setWorldOpen] = useState(false);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    fetch("/api/world/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        purpose: "issue",
        description: "Create an IntentLink permission",
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.rp_context) return;
        setRp(d.rp_context);
        setAction(d.action);
      })
      .catch(() => {});
  }, []);

  async function compile() {
    setCompiling(true);
    setError(null);
    try {
      const res = await fetch("/api/intents/compile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? "could not read that");
      setC(out as Compiled);
      setPhase("review");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCompiling(false);
    }
  }

  async function onVerified(proof: IDKitResult) {
    setVerifying(true);
    setError(null);
    try {
      const res = await fetch("/api/world/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proof, action }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? "verification failed");
      setIssuerNullifier(out.nullifier);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setVerifying(false);
    }
  }

  async function mint() {
    if (!session || !c) return;
    setError(null);
    setPhase("minting");

    const perWindow = BigInt(Math.round(c.perDay * SUI));
    const total = perWindow * BigInt(c.days);
    const hardCap = perWindow * 5n;

    try {
      const now = Date.now();
      const policy = {
        version: 1 as const,
        goal: c.goal,
        asset: "SUI",
        perActionCap: perWindow.toString(),
        perWindowCap: perWindow.toString(),
        totalCap: total.toString(),
        hardCap: hardCap.toString(),
        windowMs: String(DAY_MS),
        maxWindows: String(c.days),
        allowedPools: [POOL],
        maxSlippageBps: String(Math.round(c.maxSlippagePct * 100)),
        beneficiary: c.beneficiary,
        notBefore: "0",
        expiresAt: String(now + c.days * DAY_MS),
        boundTo: c.recipientEmail ? maskEmail(c.recipientEmail) : null,
      };

      // A capsule scoped to a pool that does not exist is a capability the
      // agent can never use — every action refuses with POOL_NOT_SCOPED and
      // it looks like the product is broken rather than misconfigured.
      if (!POOL || !POOL.startsWith("0x") || POOL.length < 40) {
        throw new Error(
          "No trading pool is configured. Set NEXT_PUBLIC_DEMO_POOL_ID and restart.",
        );
      }

      setStep("hashing the policy");
      const pres = await fetch("/api/intents/policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy, recipientEmail: c.recipientEmail }),
      });
      const { policyHash, salt, boundRecipient, error: pErr } = await pres.json();
      if (!pres.ok) throw new Error(pErr ?? "could not prepare the policy");

      setStep("checking your balance");
      const bal = await fetch(`/api/balance?address=${session.address}`).then((r) => r.json());
      if (BigInt(bal.balance ?? 0) < total + BigInt(50_000_000)) {
        setStep("topping up your testnet balance");
        await fetch("/api/dev/fund", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            address: session.address,
            amount: (total + BigInt(100_000_000)).toString(),
          }),
        });
      }

      setStep("funding the vault");
      const v = await sendAction({ kind: "createVault", amount: total.toString() }, session);
      if (!v.success) throw new Error(v.abort?.message ?? v.error ?? "vault failed");
      const vaultId = createdOfType(v, "::Vault<");
      if (!vaultId) throw new Error("vault was not created");

      setStep("writing the limits on-chain");
      const cap = await sendAction(
        {
          kind: "mintCapsule",
          args: {
            vaultId,
            boundRecipient,
            issuerNullifier: issuerNullifier ?? "0x00",
            perActionCap: policy.perActionCap,
            totalCap: policy.totalCap,
            hardCap: policy.hardCap,
            windowMs: policy.windowMs,
            perWindowCap: policy.perWindowCap,
            maxWindows: policy.maxWindows,
            allowedPools: policy.allowedPools,
            maxSlippageBps: policy.maxSlippageBps,
            beneficiaryMode: c.beneficiary === "recipient" ? 1 : 0,
            beneficiaryAddr: null,
            notBefore: policy.notBefore,
            expiresAt: policy.expiresAt,
            ensNode: "0x00",
            policyHash,
          },
        },
        session,
      );
      if (!cap.success) throw new Error(cap.abort?.message ?? cap.error ?? "capsule failed");
      const capsuleId = createdOfType(cap, "::Capsule");
      if (!capsuleId) throw new Error("capsule was not created");

      setStep("publishing the name");
      const fin = await fetch("/api/intents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          vaultId,
          capsuleId,
          policy,
          policyHash,
          salt,
          recipientEmail: c.recipientEmail,
          issuerAddress: session.address,
        }),
      });
      const out = await fin.json();
      if (!fin.ok) throw new Error(out.error ?? "could not publish the name");

      setLink({ name: out.name, url: out.url });
      setPhase("done");
    } catch (e) {
      if (e instanceof StaleSessionError) {
        setError("Your sign-in expired. Sign in again and retry.");
        setPhase("compose");
        return;
      }
      setError((e as Error).message);
      setPhase("review");
    }
  }

  if (!session) {
    return (
      <Shell>
        <h1 className="text-5xl leading-[0.95] tracking-tight">
          Say what the
          <br />
          agent <span className="text-accent">may do.</span>
        </h1>
        <p className="mt-6 max-w-md leading-relaxed text-muted">
          Write it in plain English. You will see exactly which parts become
          on-chain limits — and which parts we refuse — before anything is created.
        </p>

        <div className="panel mt-10 p-6">
          <p className="text-xs tracking-widest text-muted uppercase">For example</p>
          <p className="mt-3 leading-relaxed">
            &ldquo;Sell 0.02 SUI a day for 30 days, max 1% slippage, send the DUSD
            to bob@gmail.com.&rdquo;
          </p>
          <div className="mt-5 space-y-1.5 border-t border-line pt-5 text-sm">
            <p className="text-pass">⛓ 0.02 SUI per day · 30 periods · 1% slippage</p>
            <p className="text-block">⨯ anything above that — refused by the chain</p>
          </div>
        </div>

        <button
          onClick={signIn}
          className="mt-8 w-full border border-ink bg-ink px-5 py-3.5 text-paper"
        >
          Continue with Google →
        </button>
        <p className="mt-3 text-xs text-muted">No wallet. No seed phrase. No gas.</p>
      </Shell>
    );
  }

  if (phase === "done" && link) {
    return (
      <Shell>
        <p className="text-xs tracking-widest text-pass uppercase">Intent created</p>
        <p className="val mt-4 text-3xl leading-tight break-all">{link.name}</p>
        <p className="mt-2 text-sm text-muted">
          Send this to {c?.recipientEmail ?? "anyone"}. They need no wallet and pay no gas.
        </p>
        <div className="panel mt-6 p-4">
          <p className="val text-sm break-all">
            {typeof window !== "undefined" ? window.location.origin : ""}
            {link.url}
          </p>
        </div>
        <div className="mt-6 flex gap-3">
          <a href={link.url} className="border border-ink bg-ink px-4 py-2 text-sm text-paper">
            Open as the recipient
          </a>
          <a href="/" className="border border-line px-4 py-2 text-sm">
            Done
          </a>
        </div>
      </Shell>
    );
  }

  if (phase === "minting") {
    return (
      <Shell>
        <p className="text-xs tracking-widest text-muted uppercase">Creating</p>
        <p className="mt-4 text-4xl leading-tight tracking-tight">{step}…</p>
        <p className="mt-8 text-sm text-muted">
          Two transactions on Sui, then the name on Ethereum.
        </p>
      </Shell>
    );
  }

  if (phase === "review" && c) {
    return (
      <Shell wide>
        <button onClick={() => setPhase("compose")} className="text-sm text-muted hover:text-ink">
          ← edit
        </button>

        <p className="mt-8 text-lg leading-relaxed">
          &ldquo;<span className="text-muted">{text}</span>&rdquo;
        </p>

        {/* Enforced ------------------------------------------------ */}
        <div className="row-in mt-10">
          <div className="flex items-baseline gap-3">
            <span className="val text-pass">⛓</span>
            <p className="text-xs tracking-widest text-muted uppercase">
              Enforced on-chain
            </p>
          </div>

          <div className="panel clause mt-3 p-6 text-pass">
            <div className="grid grid-cols-2 gap-x-8 gap-y-5 text-ink sm:grid-cols-3">
              <Figure k="Per day" v={`${c.perDay}`} unit="SUI" />
              <Figure k="Periods" v={`${c.days}`} unit="× 24h" />
              <Figure k="Total" v={(c.perDay * c.days).toFixed(3)} unit="SUI" />
              <Figure k="Max slippage" v={`${c.maxSlippagePct}`} unit="%" />
              <Figure k="Hard ceiling" v={(c.perDay * 5).toFixed(3)} unit="SUI" accent />
              <Figure k="Pool" v="1" unit="approved" />
            </div>

            <dl className="mt-6 space-y-1.5 border-t border-line pt-5 text-sm text-ink">
              <Row k="Action" v={c.goal} />
              <Row
                k="Proceeds"
                v={c.beneficiary === "recipient" ? "to the recipient" : "back to you"}
              />
              {c.recipientEmail && <Row k="Only for" v={c.recipientEmail} />}
            </dl>

            <p className="mt-5 text-xs text-muted">
              Every line becomes an <span className="val">assert!</span>. The chain
              refuses anything outside them — not the agent.
            </p>
          </div>
        </div>

        {/* Advisory ------------------------------------------------ */}
        {c.advisory.length > 0 && (
          <div className="row-in mt-8" style={{ animationDelay: "90ms" }}>
            <div className="flex items-baseline gap-3">
              <span className="val text-pending">◇</span>
              <p className="text-xs tracking-widest text-muted uppercase">
                The agent decides these
              </p>
            </div>
            <div className="panel clause mt-3 p-6 text-pending">
              {c.advisory.map((a, i) => (
                <div key={i} className={i ? "mt-4" : ""}>
                  <p className="text-ink">&ldquo;{a.text}&rdquo;</p>
                  <p className="mt-1 text-xs text-muted">{a.why}</p>
                </div>
              ))}
              <p className="mt-5 text-xs text-muted">
                Not enforceable. Your limits above still apply regardless.
              </p>
            </div>
          </div>
        )}

        {/* Rejected ------------------------------------------------ */}
        {c.rejected.length > 0 && (
          <div className="row-in mt-8" style={{ animationDelay: "180ms" }}>
            <div className="flex items-baseline gap-3">
              <span className="val text-block">⨯</span>
              <p className="text-xs tracking-widest text-muted uppercase">Refused</p>
            </div>
            <div className="panel clause mt-3 p-6 text-block">
              {c.rejected.map((a, i) => (
                <div key={i} className={i ? "mt-4" : ""}>
                  <p className="text-ink">&ldquo;{a.text}&rdquo;</p>
                  <p className="mt-1 text-xs text-muted">{a.why}</p>
                </div>
              ))}
              <p className="mt-5 text-xs text-muted">
                Left out of the capability rather than quietly ignored.
              </p>
            </div>
          </div>
        )}

        {error && <p className="mt-6 text-sm text-block">{error}</p>}

        <div className="mt-10 border-t border-line pt-8">
          {issuerNullifier ? (
            <>
              <p className="text-sm text-pass">
                ⛓ Verified — recorded on the capsule, so only you can approve the
                agent going past these limits.
              </p>
              <button
                onClick={mint}
                className="mt-5 w-full border border-ink bg-ink px-5 py-3.5 text-paper"
              >
                Create intent →
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setWorldOpen(true)}
                disabled={!rp || !action || verifying}
                className="w-full border border-ink bg-ink px-5 py-3.5 text-paper disabled:opacity-30"
              >
                {verifying ? "Verifying…" : !rp ? "Preparing…" : "Verify with World & create →"}
              </button>
              <p className="mt-4 text-xs leading-relaxed text-muted">
                Your proof is recorded on the capsule. It is what lets the agent ask
                you — and only you — to exceed a limit.
              </p>
              {rp && action && (
                <IDKitRequestWidget
                  open={worldOpen}
                  onOpenChange={setWorldOpen}
                  app_id={APP_ID}
                  action={action!}
                  rp_context={rp}
                  allow_legacy_proofs
                  action_description="Create an IntentLink permission"
                  preset={CREDENTIAL()}
                  onSuccess={onVerified}
                />
              )}
            </>
          )}
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-5xl leading-[0.95] tracking-tight">
        Say what the
        <br />
        agent <span className="text-accent">may do.</span>
      </h1>
      <p className="mt-6 max-w-md leading-relaxed text-muted">
        Write it however you like. You will see exactly which parts become
        on-chain limits — and which parts we refuse — before anything is created.
      </p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="Sell 0.02 SUI a day for 30 days, max 1% slippage, send the DUSD to bob@gmail.com"
        className="panel mt-10 w-full resize-none px-5 py-4 leading-relaxed outline-none focus:border-ink"
      />

      <p className="mt-6 text-xs tracking-wide text-muted uppercase">Try one</p>
      <div className="mt-3 space-y-2">
        {EXAMPLES.map((e) => (
          <button
            key={e}
            onClick={() => setText(e)}
            className="panel block w-full px-4 py-3 text-left text-sm text-muted transition hover:border-ink hover:text-ink"
          >
            {e}
          </button>
        ))}
      </div>

      {error && <p className="mt-6 text-sm text-block">{error}</p>}

      <button
        onClick={compile}
        disabled={!text.trim() || compiling}
        className="mt-8 w-full border border-ink bg-ink px-5 py-3.5 text-paper disabled:opacity-30"
      >
        {compiling ? "Reading…" : "Compile →"}
      </button>
    </Shell>
  );
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="relative min-h-dvh overflow-hidden p-6">
      <div className="grid-bg grid-fade pointer-events-none absolute inset-0" />
      <div className={`relative mx-auto pt-14 pb-24 ${wide ? "max-w-2xl" : "max-w-xl"}`}>
        <a href="/" className="val text-sm text-accent">
          [→]
        </a>
        <div className="mt-8">{children}</div>
      </div>
    </main>
  );
}

function Figure({
  k,
  v,
  unit,
  accent,
}: {
  k: string;
  v: string;
  unit: string;
  accent?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-muted">{k}</p>
      <p className={`figure mt-1 text-3xl ${accent ? "text-accent" : ""}`}>{v}</p>
      <p className="text-xs text-muted">{unit}</p>
    </div>
  );
}

function Row({ k, v, note }: { k: string; v: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{k}</dt>
      <dd className="val text-right">
        {v}
        {note && <span className="ml-2 text-xs text-accent">{note}</span>}
      </dd>
    </div>
  );
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return domain ? `${local.slice(0, 1)}•••@${domain}` : "•••";
}
