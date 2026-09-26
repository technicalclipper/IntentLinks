"use client";

import { Badge, Mono } from "@/components/ui";

import { useEffect, useRef, useState } from "react";
import {
  extendedPublicKey,
  extendedPublicKeyDecimal,
  loadEphemeral,
  saveSession,
} from "@/lib/zklogin/client";

type Phase = "working" | "done" | "failed";

/**
 * Google returns the id_token in the URL *fragment*, which never reaches the
 * server — so this has to run in the browser. It hands the token to our
 * backend for proving (the salt lives there) and keeps the ephemeral key
 * here, which is what makes the address genuinely the user's.
 */
export default function AuthCallback() {
  const [phase, setPhase] = useState<Phase>("working");
  const [detail, setDetail] = useState("verifying with Google");
  const [address, setAddress] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    (async () => {
      try {
        const params = new URLSearchParams(window.location.hash.slice(1));
        const idToken = params.get("id_token");
        if (!idToken) throw new Error("Google did not return a token");

        const ephemeral = loadEphemeral();
        if (!ephemeral) throw new Error("this sign-in was started in another tab");

        setDetail("generating your proof");
        const provedFor = extendedPublicKey(ephemeral);
        const res = await fetch("/api/zklogin/prove", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            idToken,
            // decimal, not the base64 the SDK hands back
            extendedEphemeralPublicKey: extendedPublicKeyDecimal(ephemeral),
            maxEpoch: ephemeral.maxEpoch,
            jwtRandomness: ephemeral.randomness,
          }),
        });

        const data = (await res.json()) as {
          address?: string;
          proof?: unknown;
          email?: string;
          mode?: "demo" | "zklogin";
          error?: string;
        };
        if (!res.ok || !data.address) throw new Error(data.error ?? "proving failed");

        saveSession({
          ...ephemeral,
          provedFor,
          mode: data.mode ?? "zklogin",
          address: data.address,
          email: data.email ?? "",
          proof: data.proof,
          idToken,
        });

        setAddress(data.address);
        setPhase("done");

        // Drop the token out of the address bar before going anywhere.
        window.history.replaceState({}, "", "/auth/callback");
        const next = sessionStorage.getItem("intentlink.next") ?? "/";
        sessionStorage.removeItem("intentlink.next");
        setTimeout(() => (window.location.href = next), 900);
      } catch (e) {
        setDetail((e as Error).message);
        setPhase("failed");
      }
    })();
  }, []);

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden p-6">
      <div className="glow pointer-events-none absolute inset-0 -z-10" />
      <div className="grid-bg grid-fade pointer-events-none absolute inset-0 -z-10" />
      <div className="panel w-full max-w-md p-8">
        {phase === "working" && (
          <>
            <Badge tone="pending">signing you in</Badge>
            <p className="waiting mt-3 text-2xl font-bold tracking-tight">{detail}…</p>
            <p className="mt-6 text-xs text-muted">
              Proof generation takes a few seconds the first time.
            </p>
          </>
        )}

        {phase === "done" && (
          <>
            <Badge tone="pass">signed in</Badge>
            <p className="mt-3 text-xs tracking-widest text-muted uppercase">
              Your Sui address
            </p>
            <div className="mt-1.5">
              <Mono value={address ?? ""} chars={10} label="address" />
            </div>
            <p className="mt-6 text-xs text-muted">
              No wallet, no seed phrase, no gas.
            </p>
          </>
        )}

        {phase === "failed" && (
          <>
            <Badge tone="block">sign-in failed</Badge>
            <p className="mt-2 text-sm">{detail}</p>
            <a href="/" className="btn mt-6">
              Start again
            </a>
          </>
        )}
      </div>
    </main>
  );
}
