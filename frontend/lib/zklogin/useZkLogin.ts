"use client";

import { useCallback, useEffect, useState } from "react";
import {
  beginLogin,
  clearSession,
  loadSession,
  type ActiveSession,
} from "./client";

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID!;
const REDIRECT_URI =
  process.env.NEXT_PUBLIC_ZKLOGIN_REDIRECT_URI ?? "http://localhost:3000/auth/callback";

export interface ZkLoginState {
  session: ActiveSession | null;
  loading: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => void;
}

/**
 * Google sign-in that yields a real Sui address.
 *
 * No wallet, no seed phrase, no extension, and — because every transaction
 * is sponsored — no gas either.
 */
export function useZkLogin(): ZkLoginState {
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSession(loadSession());
  }, []);

  const signIn = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/epoch");
      if (!res.ok) throw new Error("could not reach the network");
      const { epoch } = (await res.json()) as { epoch: number };

      const { url } = beginLogin({
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        currentEpoch: epoch,
      });
      window.location.href = url;
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  return { session, loading, error, signIn, signOut };
}
