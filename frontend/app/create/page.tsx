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
const ACTION = process.env.NEXT_PUBLIC_WORLD_ACTION_IDENTITY ?? "intentlink-identity";
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
  const [worldOpen, setWorldOpen] = useState(false);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    fetch("/api/world/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: ACTION }),
    })
      .then((r) => r.json())
      .then((d) => d.rp_context && setRp(d.rp_context))
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
        body: JSON.stringify({ proof, action: ACTION }),
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
        <p className="text-sm">Sign in to create an intent.</p>
        <button onClick={signIn} className="mt-4 border border-ink bg-ink px-4 py-2 text-sm text-paper">
          Continue with Google
        </button>
      </Shell>
    );
  }

  if (phase === "done" && link) {
    return (
      <Shell>
        <p className="text-sm text-pass">Intent created</p>
        <p className="val mt-3 text-2xl break-all">{link.name}</p>
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
        <p className="text-sm text-muted">Creating</p>
        <p className="mt-2 text-2xl">{step}…</p>
        <p className="mt-6 text-xs text-muted">
          Two transactions on Sui, then the name on Ethereum.
        </p>
      </Shell>
    );
  }

  if (phase === "review" && c) {
    return (
      <Shell>
        <button onClick={() => setPhase("compose")} className="text-sm text-muted">
          ← edit
        </button>

        <p className="mt-6 text-xs tracking-wide text-muted uppercase">Enforced on-chain</p>
        <div className="panel mt-3 p-5">
          <dl className="space-y-1.5 text-sm">
            <Row k="Action" v={c.goal} />
            <Row k="Per day" v={`${c.perDay} SUI`} />
            <Row k="Periods" v={`${c.days} × 24h`} />
            <Row k="Total" v={`${(c.perDay * c.days).toFixed(4)} SUI`} />
            <Row k="Max slippage" v={`${c.maxSlippagePct}%`} />
            <Row k="Pool" v="one approved pool" />
            <Row
              k="Proceeds"
              v={c.beneficiary === "recipient" ? "to the recipient" : "back to you"}
            />
            {c.recipientEmail && <Row k="Only for" v={c.recipientEmail} />}
            <Row k="Hard ceiling" v={`${(c.perDay * 5).toFixed(4)} SUI`} note="never exceeded" />
          </dl>
          <p className="mt-4 text-xs text-muted">
            Every line becomes an <span className="val">assert</span>. The chain refuses
            anything outside them.
          </p>
        </div>

        {c.advisory.length > 0 && (
          <>
            <p className="mt-6 text-xs tracking-wide text-pending uppercase">
              ◇ The agent decides these
            </p>
            <div className="panel mt-3 p-5">
              {c.advisory.map((a, i) => (
                <div key={i} className={i ? "mt-3" : ""}>
                  <p className="text-sm">&ldquo;{a.text}&rdquo;</p>
                  <p className="mt-1 text-xs text-muted">{a.why}</p>
                </div>
              ))}
              <p className="mt-4 text-xs text-muted">
                Not enforceable on-chain. Your limits above still apply regardless.
              </p>
            </div>
          </>
        )}

        {c.rejected.length > 0 && (
          <>
            <p className="mt-6 text-xs tracking-wide text-block uppercase">✗ Not possible</p>
            <div className="panel mt-3 p-5">
              {c.rejected.map((a, i) => (
                <div key={i} className={i ? "mt-3" : ""}>
                  <p className="text-sm">&ldquo;{a.text}&rdquo;</p>
                  <p className="mt-1 text-xs text-muted">{a.why}</p>
                </div>
              ))}
              <p className="mt-4 text-xs text-muted">
                Left out of the capability rather than quietly ignored.
              </p>
            </div>
          </>
        )}

        {error && <p className="mt-4 text-sm text-block">{error}</p>}

        {issuerNullifier ? (
          <>
            <p className="mt-6 text-sm text-pass">
              ⛓ Verified — recorded on the capsule, so only you can approve the agent going
              past these limits.
            </p>
            <button
              onClick={mint}
              className="mt-4 border border-ink bg-ink px-5 py-2.5 text-sm text-paper"
            >
              Create intent
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setWorldOpen(true)}
              disabled={!rp || verifying}
              className="mt-6 border border-ink bg-ink px-5 py-2.5 text-sm text-paper disabled:opacity-40"
            >
              {verifying ? "Verifying…" : !rp ? "Preparing…" : "Verify with World & create"}
            </button>
            <p className="mt-3 text-xs text-muted">
              Your proof is recorded on the capsule. It is what lets the agent ask you — and
              only you — to exceed a limit.
            </p>
            {rp && (
              <IDKitRequestWidget
                open={worldOpen}
                onOpenChange={setWorldOpen}
                app_id={APP_ID}
                action={ACTION}
                rp_context={rp}
                allow_legacy_proofs
                action_description="Create an IntentLink permission"
                preset={CREDENTIAL()}
                onSuccess={onVerified}
              />
            )}
          </>
        )}
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-3xl tracking-tight">New intent</h1>
      <p className="mt-2 text-muted">Say what the agent may do.</p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="Sell 0.02 SUI a day for 30 days, max 1% slippage, send the DUSD to bob@gmail.com"
        className="mt-6 w-full resize-none border border-line bg-panel px-4 py-3 text-sm leading-relaxed"
      />

      <div className="mt-3 space-y-1.5">
        {EXAMPLES.map((e) => (
          <button
            key={e}
            onClick={() => setText(e)}
            className="block text-left text-xs text-muted hover:text-ink"
          >
            → {e}
          </button>
        ))}
      </div>

      {error && <p className="mt-4 text-sm text-block">{error}</p>}

      <button
        onClick={compile}
        disabled={!text.trim() || compiling}
        className="mt-6 border border-ink bg-ink px-5 py-2.5 text-sm text-paper disabled:opacity-40"
      >
        {compiling ? "Reading…" : "Compile"}
      </button>
      <p className="mt-3 text-xs text-muted">
        You will see exactly which parts become on-chain limits before anything is created.
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh p-6">
      <div className="mx-auto max-w-xl pt-10">
        <a href="/" className="val text-sm text-accent">
          [→]
        </a>
        <div className="mt-6">{children}</div>
      </div>
    </main>
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
