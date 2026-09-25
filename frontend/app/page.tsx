"use client";

import { useZkLogin } from "@/lib/zklogin/useZkLogin";

export default function Home() {
  const { session, loading, error, signIn, signOut } = useZkLogin();

  return (
    <main className="min-h-dvh flex items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <p className="val text-sm text-accent">[→]</p>
        <h1 className="mt-3 text-4xl tracking-tight">IntentLink</h1>
        <p className="mt-2 text-muted">A link that carries a permission.</p>

        <div className="panel mt-8 p-6">
          {session ? (
            <>
              <p className="text-sm text-muted">Signed in as</p>
              <p className="mt-1">{session.email}</p>

              <p className="mt-4 text-sm text-muted">Your Sui address</p>
              <p className="val mt-1 text-sm break-all">{session.address}</p>

              <div className="mt-6 flex gap-3">
                <a
                  href="/create"
                  className="border border-ink bg-ink px-4 py-2 text-sm text-paper"
                >
                  Create an intent
                </a>
                <button
                  onClick={signOut}
                  className="border border-line px-4 py-2 text-sm"
                >
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm">
                Give an AI agent a bounded, revocable permission — enforced on
                Sui, not by the agent behaving.
              </p>
              <button
                onClick={signIn}
                disabled={loading}
                className="mt-6 border border-ink bg-ink px-4 py-2 text-sm text-paper disabled:opacity-50"
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
      </div>
    </main>
  );
}
