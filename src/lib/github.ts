import { invoke as coreInvoke, isTauri } from "@tauri-apps/api/core";

/**
 * GitHub integration client seam. These commands are served by the **Tauri Rust
 * shell** (not the sidecar), so — like the OS helpers in `@/lib/tauri` — they
 * call Tauri core directly instead of routing through the connection manager.
 * Auth is delegated to the user's installed `gh` CLI. In a plain browser (no
 * Tauri) every call rejects with a dev-mode error.
 */

function notInTauri(cmd: string): Promise<never> {
  return Promise.reject(new Error(`[Dev Mode] GitHub command "${cmd}" requires the desktop app`));
}

export interface AuthStatus {
  connected: boolean;
  login?: string;
  /** False when the `gh` CLI itself is missing. */
  ghInstalled: boolean;
}

export type LoginStatus = "already" | "started" | "no_gh";

export interface LoginResult {
  status: LoginStatus;
  login?: string;
}

export interface PushInput {
  workingDir: string;
  title: string;
  body?: string;
  branch?: string;
  baseBranch?: string;
  draft?: boolean;
  /** Stage + commit pending changes before pushing. Defaults to true. */
  commit?: boolean;
}

export interface PushResult {
  prNumber: number;
  prUrl: string;
  branch: string;
  reused: boolean;
  committed: boolean;
}

/** Whether `gh` is installed and signed in, and to which account. */
export function githubAuthStatus(): Promise<AuthStatus> {
  if (!isTauri()) return notInTauri("github_auth_status");
  return coreInvoke<AuthStatus>("github_auth_status");
}

/**
 * Start sign-in via `gh`. If already authenticated this is a no-op reporting the
 * current login; otherwise it launches `gh auth login --web` (opens the GitHub
 * login page in the browser) and the caller polls {@link githubAuthStatus}.
 */
export function githubAuthLogin(): Promise<LoginResult> {
  if (!isTauri()) return notInTauri("github_auth_login");
  return coreInvoke<LoginResult>("github_auth_login");
}

/** Sign out via `gh auth logout`. */
export function githubAuthLogout(): Promise<void> {
  if (!isTauri()) return notInTauri("github_auth_logout");
  return coreInvoke<void>("github_auth_logout");
}

/** Commit (optionally), push a branch, and open/reuse a PR for a card. */
export function githubPushCard(input: PushInput): Promise<PushResult> {
  if (!isTauri()) return notInTauri("github_push_card");
  return coreInvoke<PushResult>("github_push_card", { input });
}
