"use client";

import { useState } from "react";
import { useZkLogin } from "@/lib/zklogin/useZkLogin";
import { createdOfType, sendAction } from "@/lib/tx-client";
import { StaleSessionError } from "@/lib/zklogin/client";

const SUI = 1_000_000_000;
const DAY_MS = 86_400_000;

/** A stand-in pool id until a real DEX is wired in. Scope is what matters. */
const POOL = "0x00000000000000000000000000000000000000000000000000000000000900d1";

type Phase = "compose" | "review" | "minting" | "done";

interface Draft {
  recipient: string;
  goal: string;
  perDay: string;
  days: string;
  slippagePct: string;
  beneficiary: "recipient" | "vault";
}

export default function Create() {
  const { session, signIn } = useZkLogin();
  const [phase, setPhase] = useState<Phase>("compose");
  const [step, setStep] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);

  const [d, setD] = useState<Draft>({
    recipient: "",
    goal: "Buy SUI daily",
    perDay: "0.02",
    days: "30",
    slippagePct: "1",
    beneficiary: "recipient",
  });

  const perWindow = BigInt(Math.round(Number(d.perDay || 0) * SUI));
  const windows = BigInt(d.days || 0);
  const total = perWindow * windows;
  // The ceiling nothing can lift — generous enough for escalation to be
  // useful, tight enough to still be a ceiling.
  const hardCap = perWindow * 5n;

  async function mint() {
    if (!session) return;
    setError(null);
    setPhase("minting");

    try {
      const now = Date.now();
      const policy = {
        version: 1 as const,
        goal: d.goal,
        asset: "SUI",
        perActionCap: perWindow.toString(),
        perWindowCap: perWindow.toString(),
        totalCap: total.toString(),
        hardCap: hardCap.toString(),
        windowMs: String(DAY_MS),
        maxWindows: d.days,
        allowedPools: [POOL],
        maxSlippageBps: String(Math.round(Number(d.slippagePct) * 100)),
        beneficiary: d.beneficiary === "recipient" ? "recipient" : "vault",
        notBefore: "0",
        expiresAt: String(now + Number(d.days) * DAY_MS),
        boundTo: d.recipient ? maskEmail(d.recipient) : null,
      };

      setStep("hashing the policy");
      const res = await fetch("/api/intents/policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy, recipientEmail: d.recipient || null }),
      });
      const { policyHash, salt, boundRecipient, error: pErr } = await res.json();
      if (!res.ok) throw new Error(pErr ?? "could not prepare the policy");

      // The issuer genuinely needs coins — they are funding a vault. On
      // mainnet they would already hold SUI; on testnet a fresh zkLogin
      // address has none, so top it up. The recipient never needs this.
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
      const vaultRes = await sendAction(
        { kind: "createVault", amount: total.toString() },
        session,
      );
      if (!vaultRes.success) throw new Error(vaultRes.abort?.message ?? vaultRes.error ?? "vault failed");
      const vaultId = createdOfType(vaultRes, "::Vault<");
      if (!vaultId) throw new Error("vault was not created");

      setStep("writing the limits on-chain");
      const capRes = await sendAction(
        {
          kind: "mintCapsule",
          args: {
            vaultId,
            boundRecipient,
            issuerNullifier: "0x00",
            perActionCap: policy.perActionCap,
            totalCap: policy.totalCap,
            hardCap: policy.hardCap,
            windowMs: policy.windowMs,
            perWindowCap: policy.perWindowCap,
            maxWindows: policy.maxWindows,
            allowedPools: policy.allowedPools,
            maxSlippageBps: policy.maxSlippageBps,
            beneficiaryMode: d.beneficiary === "recipient" ? 1 : 0,
            beneficiaryAddr: null,
            notBefore: policy.notBefore,
            expiresAt: policy.expiresAt,
            ensNode: "0x00",
            policyHash,
          },
        },
        session,
      );
      if (!capRes.success) throw new Error(capRes.abort?.message ?? capRes.error ?? "capsule failed");
      const capsuleId = createdOfType(capRes, "::Capsule");
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
          recipientEmail: d.recipient || null,
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
          Send this to {d.recipient || "anyone"}. They need no wallet and pay no gas.
        </p>
        <div className="panel mt-6 p-4">
          <p className="val text-sm break-all">
            {typeof window !== "undefined" ? window.location.origin : ""}{link.url}
          </p>
        </div>
        <div className="mt-6 flex gap-3">
          <a href={link.url} className="border border-ink bg-ink px-4 py-2 text-sm text-paper">
            Open as the recipient
          </a>
          <a href="/" className="border border-line px-4 py-2 text-sm">Done</a>
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

  return (
    <Shell>
      <h1 className="text-3xl tracking-tight">New intent</h1>

      <section className="mt-8">
        <p className="text-sm text-muted">Who is this for?</p>
        <input
          value={d.recipient}
          onChange={(e) => setD({ ...d, recipient: e.target.value })}
          placeholder="bob@gmail.com"
          className="val mt-2 w-full border border-line bg-panel px-3 py-2 text-sm"
        />
        <p className="mt-1 text-xs text-muted">
          {d.recipient
            ? "Only this Google account can open it."
            : "Leave empty and the first verified human to open it claims it."}
        </p>
      </section>

      <section className="mt-6">
        <p className="text-sm text-muted">What may the agent do?</p>
        <input
          value={d.goal}
          onChange={(e) => setD({ ...d, goal: e.target.value })}
          className="mt-2 w-full border border-line bg-panel px-3 py-2 text-sm"
        />
      </section>

      <section className="mt-6 grid grid-cols-3 gap-3">
        <Field label="SUI per day" value={d.perDay} onChange={(v) => setD({ ...d, perDay: v })} />
        <Field label="Days" value={d.days} onChange={(v) => setD({ ...d, days: v })} />
        <Field label="Max slippage %" value={d.slippagePct} onChange={(v) => setD({ ...d, slippagePct: v })} />
      </section>

      <section className="mt-6">
        <p className="text-sm text-muted">Where do the proceeds go?</p>
        <div className="mt-2 flex gap-3">
          {(["recipient", "vault"] as const).map((b) => (
            <button
              key={b}
              onClick={() => setD({ ...d, beneficiary: b })}
              className={`border px-3 py-2 text-sm ${
                d.beneficiary === b ? "border-ink bg-ink text-paper" : "border-line"
              }`}
            >
              {b === "recipient" ? "To the recipient" : "Back to me"}
            </button>
          ))}
        </div>
      </section>

      <div className="panel mt-8 p-5">
        <p className="text-xs tracking-wide text-muted uppercase">
          Enforced on-chain
        </p>
        <dl className="mt-3 space-y-1.5 text-sm">
          <Row k="Per day" v={`${d.perDay} SUI`} />
          <Row k="Total" v={`${(Number(d.perDay) * Number(d.days)).toFixed(4)} SUI`} />
          <Row k="Periods" v={`${d.days} × 24h`} />
          <Row k="Pool" v="Cetus only" />
          <Row k="Slippage" v={`${d.slippagePct}%`} />
          <Row k="Hard ceiling" v={`${(Number(d.perDay) * 5).toFixed(4)} SUI`} note="never exceeded" />
        </dl>
        <p className="mt-3 text-xs text-muted">
          Each line becomes an assert. The chain refuses anything outside them.
        </p>
      </div>

      {error && <p className="mt-4 text-sm text-block">{error}</p>}

      <button
        onClick={mint}
        disabled={!Number(d.perDay) || !Number(d.days)}
        className="mt-6 border border-ink bg-ink px-5 py-2.5 text-sm text-paper disabled:opacity-40"
      >
        Create intent
      </button>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh p-6">
      <div className="mx-auto max-w-xl pt-10">
        <a href="/" className="val text-sm text-accent">[→]</a>
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-xs text-muted">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        className="val mt-1 w-full border border-line bg-panel px-3 py-2 text-sm"
      />
    </label>
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
