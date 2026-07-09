"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  type AuthStatus,
  githubAuthLogin,
  githubAuthLogout,
  githubAuthStatus,
  githubPushCard,
  type LoginResult,
  type PushInput,
  type PushResult,
} from "@/lib/github";
import { isDevModeError } from "@/lib/tauri";

/** Phase of the connect flow. */
export type ConnectPhase = "idle" | "starting" | "awaiting" | "error";

export interface ConnectState {
  phase: ConnectPhase;
  /** Set when the sign-in couldn't start because `gh` isn't installed. */
  needsGh?: boolean;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * GitHub auth + push state. Delegates auth to the `gh` CLI: `startConnect`
 * either finds an existing `gh` session or launches the browser login and then
 * polls {@link githubAuthStatus} until it flips to connected. Also exposes
 * `pushCard` for the card action.
 */
export function useGithub() {
  const [status, setStatus] = useState<AuthStatus>({ connected: false, ghInstalled: true });
  const [loading, setLoading] = useState(true);
  const [connect, setConnect] = useState<ConnectState>({ phase: "idle" });
  const cancelled = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const s = await githubAuthStatus();
      setStatus(s);
    } catch (e) {
      if (!isDevModeError(e)) console.error("github status failed:", e);
      setStatus({ connected: false, ghInstalled: true });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Connect via `gh`. Resolves true once signed in. When a browser login is
   * launched, polls status for up to ~3 minutes waiting for the user to finish.
   */
  const startConnect = useCallback(async (): Promise<boolean> => {
    cancelled.current = false;
    setConnect({ phase: "starting" });
    let res: LoginResult;
    try {
      res = await githubAuthLogin();
    } catch (e) {
      setConnect({ phase: "error", error: e instanceof Error ? e.message : String(e) });
      return false;
    }

    if (res.status === "no_gh") {
      setConnect({ phase: "error", needsGh: true });
      setStatus((s) => ({ ...s, ghInstalled: false }));
      return false;
    }

    if (res.status === "already") {
      setStatus({ connected: true, login: res.login, ghInstalled: true });
      setConnect({ phase: "idle" });
      return true;
    }

    // "started" — a browser login is in progress. Poll until it lands.
    setConnect({ phase: "awaiting" });
    const deadline = Date.now() + 3 * 60 * 1000;
    while (!cancelled.current && Date.now() < deadline) {
      await sleep(2500);
      if (cancelled.current) break;
      try {
        const s = await githubAuthStatus();
        if (s.connected) {
          setStatus(s);
          setConnect({ phase: "idle" });
          return true;
        }
      } catch (e) {
        if (!isDevModeError(e)) console.error("github status poll failed:", e);
      }
    }
    if (!cancelled.current) {
      setConnect({ phase: "error", error: "timed_out" });
    }
    return false;
  }, []);

  const cancelConnect = useCallback(() => {
    cancelled.current = true;
    setConnect({ phase: "idle" });
  }, []);

  const logout = useCallback(async () => {
    await githubAuthLogout();
    setStatus((s) => ({ connected: false, ghInstalled: s.ghInstalled }));
  }, []);

  const pushCard = useCallback((input: PushInput): Promise<PushResult> => githubPushCard(input), []);

  return { status, loading, connect, refresh, startConnect, cancelConnect, logout, pushCard };
}
