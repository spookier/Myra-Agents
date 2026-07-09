//! GitHub integration — delegates to the user's installed **`gh` CLI** for auth
//! and a manual "push agent results to GitHub" action (commit, push a branch,
//! open a PR, comment).
//!
//! This lives in the Tauri shell (not the `myra-server` sidecar) because the
//! sidecar is consumed as a pre-built binary. The shell can reach the card's
//! **local** working directory and run `gh`/`git` directly. The frontend calls
//! these commands through Tauri core (see `src/lib/github.ts`), bypassing the
//! HTTP/sidecar transport that serves board data.
//!
//! Auth reuses whatever `gh auth login` already established — no OAuth App
//! registration or token handling of our own. If the user isn't signed in, the
//! connect action launches `gh auth login --web`, which opens the GitHub login
//! page in their browser. v1 is scoped to local working directories.

use std::process::Command as StdCommand;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

fn command_with_cli_path(program: &str) -> StdCommand {
    let mut cmd = StdCommand::new(program);
    augment_cli_path(&mut cmd);
    cmd
}

#[cfg(target_os = "windows")]
fn augment_cli_path(cmd: &mut StdCommand) {
    let mut entries = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        entries.push(path.to_string_lossy().to_string());
    }

    let program_files =
        std::env::var("ProgramFiles").unwrap_or_else(|_| String::from(r"C:\Program Files"));
    let program_files_x86 = std::env::var("ProgramFiles(x86)")
        .unwrap_or_else(|_| String::from(r"C:\Program Files (x86)"));
    let local_app_data = std::env::var("LOCALAPPDATA").ok();

    let mut candidates = vec![
        format!(r"{program_files}\Git\cmd"),
        format!(r"{program_files}\Git\bin"),
        format!(r"{program_files}\GitHub CLI"),
        format!(r"{program_files_x86}\Git\cmd"),
        format!(r"{program_files_x86}\Git\bin"),
        format!(r"{program_files_x86}\GitHub CLI"),
    ];
    if let Some(local_app_data) = local_app_data {
        candidates.push(format!(r"{local_app_data}\Programs\Git\cmd"));
        candidates.push(format!(r"{local_app_data}\Programs\Git\bin"));
        candidates.push(format!(r"{local_app_data}\Programs\GitHub CLI"));
        candidates.push(format!(r"{local_app_data}\GitHub CLI"));
    }

    for candidate in candidates {
        if std::path::Path::new(&candidate).exists() {
            entries.push(candidate);
        }
    }

    cmd.env("PATH", entries.join(";"));
}

#[cfg(not(target_os = "windows"))]
fn augment_cli_path(_cmd: &mut StdCommand) {}

/// Run `gh` with the given args (optionally in `cwd`), returning trimmed stdout
/// or the trimmed stderr on failure.
fn run_gh(args: &[&str], cwd: Option<&str>) -> Result<String, String> {
    let mut cmd = command_with_cli_path("gh");
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("failed to run gh (is the GitHub CLI installed?): {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// True when `gh` is reachable on PATH.
fn gh_available() -> bool {
    command_with_cli_path("gh")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// The authenticated login, or `None` when `gh` isn't signed in.
fn gh_login() -> Option<String> {
    run_gh(&["api", "user", "--jq", ".login"], None)
        .ok()
        .filter(|s| !s.is_empty())
}

/// The token `gh` holds for github.com, used to authenticate the branch push.
fn gh_token() -> Result<String, String> {
    let token = run_gh(&["auth", "token"], None)?;
    if token.is_empty() {
        return Err("gh returned an empty token".into());
    }
    Ok(token)
}

// ---------------------------------------------------------------------------
// Auth — delegated to the gh CLI
// ---------------------------------------------------------------------------

/// Connection status for the Settings panel / push dialog.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    connected: bool,
    login: Option<String>,
    /// False when the `gh` CLI itself is missing — the UI nudges the user to
    /// install it rather than to sign in.
    gh_installed: bool,
}

/// Report whether `gh` is installed and signed in, and to which account.
#[tauri::command]
pub fn github_auth_status() -> Result<AuthStatus, String> {
    if !gh_available() {
        return Ok(AuthStatus {
            connected: false,
            login: None,
            gh_installed: false,
        });
    }
    match gh_login() {
        Some(login) => Ok(AuthStatus {
            connected: true,
            login: Some(login),
            gh_installed: true,
        }),
        None => Ok(AuthStatus {
            connected: false,
            login: None,
            gh_installed: true,
        }),
    }
}

/// Result of kicking off a sign-in.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    /// `already` (was signed in), `started` (browser login launched), or
    /// `no_gh` (CLI missing).
    status: String,
    login: Option<String>,
}

/// Begin sign-in. If `gh` is already authenticated this is a no-op that reports
/// the current login. Otherwise it launches `gh auth login --web`, which opens
/// the GitHub login page in the user's browser; the child runs detached and the
/// frontend polls {@link github_auth_status} until it flips to connected.
#[tauri::command]
pub fn github_auth_login() -> Result<LoginResult, String> {
    if !gh_available() {
        return Ok(LoginResult {
            status: "no_gh".into(),
            login: None,
        });
    }
    if let Some(login) = gh_login() {
        return Ok(LoginResult {
            status: "already".into(),
            login: Some(login),
        });
    }
    spawn_gh_login()?;
    Ok(LoginResult {
        status: "started".into(),
        login: None,
    })
}

/// Launch `gh auth login --web` so it can prompt the user in their browser.
/// `gh`'s interactive login needs a real terminal, so we open one; the browser
/// page is opened by `gh` itself once the user proceeds.
fn spawn_gh_login() -> Result<(), String> {
    let gh_args = "auth login --web --git-protocol https --skip-ssh-key";

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // `start` opens a new console window that hosts the interactive login.
        // Pass the whole command line verbatim with `raw_arg` so Rust's
        // per-argument quoting doesn't mangle `start`'s title parsing (an empty
        // "" title keeps the quoted `gh` command from being taken as the title).
        let mut cmd = StdCommand::new("cmd.exe");
        augment_cli_path(&mut cmd);
        cmd.raw_arg(format!("/c start \"\" cmd /k \"gh {gh_args}\""))
            .spawn()
            .map_err(|e| format!("failed to open terminal for gh login: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        // Ask Terminal.app to run the login command in a new window.
        let script = format!("tell application \"Terminal\" to do script \"gh {gh_args}\"");
        StdCommand::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("failed to open Terminal for gh login: {e}"))?;
        StdCommand::new("osascript")
            .args(["-e", "tell application \"Terminal\" to activate"])
            .spawn()
            .ok();
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Try a few common terminal emulators; fall back to a bare spawn.
        let full = format!("gh {gh_args}");
        let candidates: [(&str, Vec<&str>); 3] = [
            ("x-terminal-emulator", vec!["-e", "sh", "-c", &full]),
            ("gnome-terminal", vec!["--", "sh", "-c", &full]),
            ("xterm", vec!["-e", "sh", "-c", &full]),
        ];
        for (bin, args) in candidates {
            if StdCommand::new(bin).args(&args).spawn().is_ok() {
                return Ok(());
            }
        }
        StdCommand::new("gh")
            .args([
                "auth",
                "login",
                "--web",
                "--git-protocol",
                "https",
                "--skip-ssh-key",
            ])
            .spawn()
            .map_err(|e| format!("failed to start gh login: {e}"))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Ok(())
}

/// Sign out via `gh auth logout`. A "not logged in" outcome is treated as success.
#[tauri::command]
pub fn github_auth_logout() -> Result<(), String> {
    match run_gh(&["auth", "logout", "--hostname", "github.com"], None) {
        Ok(_) => Ok(()),
        Err(e) if e.to_lowercase().contains("not logged") => Ok(()),
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// Push flow
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushInput {
    /// Local git working directory of the card's run.
    working_dir: String,
    /// PR title (also the commit message when committing pending changes).
    title: String,
    /// PR body (typically the agent result/summary).
    body: Option<String>,
    /// Branch to push. Defaults to `myra/<slug>-<shortid>`.
    branch: Option<String>,
    /// Base branch for the PR. Defaults to the repo's default branch.
    base_branch: Option<String>,
    /// Open the PR as a draft.
    draft: Option<bool>,
    /// Stage + commit pending changes before pushing. Defaults to true.
    commit: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pr_number: u64,
    pr_url: String,
    branch: String,
    /// True when an existing open PR for this branch was reused.
    reused: bool,
    /// True when pending changes were committed as part of this push.
    committed: bool,
}

/// Run a git command in `dir`, returning trimmed stdout or stderr on failure.
fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = command_with_cli_path("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git {}: {e}", args.join(" ")))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Resolve a repo\'s default branch (e.g. `main`) via gh, for base-branch checks.
fn default_branch(repo_slug: &str, dir: &str) -> Result<String, String> {
    let name = run_gh(
        &[
            "repo",
            "view",
            repo_slug,
            "--json",
            "defaultBranchRef",
            "--jq",
            ".defaultBranchRef.name",
        ],
        Some(dir),
    )?;
    if name.is_empty() {
        return Err("gh returned an empty default branch".into());
    }
    Ok(name)
}

/// Parse `owner`/`repo` from a GitHub remote URL (https or ssh forms).
fn parse_owner_repo(remote: &str) -> Option<(String, String)> {
    let r = remote.trim();
    let rest = if let Some(idx) = r.find("github.com") {
        // Strip everything up to and including "github.com", then a ':' or '/'.
        let after = &r[idx + "github.com".len()..];
        after.trim_start_matches([':', '/']).to_string()
    } else {
        return None;
    };
    let rest = rest.strip_suffix(".git").unwrap_or(&rest);
    let mut parts = rest.split('/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

/// Slugify a title into a branch-safe segment.
fn slugify(title: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in title.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
    }
    let slug = slug.trim_matches('-');
    let truncated: String = slug.chars().take(40).collect();
    let truncated = truncated.trim_matches('-').to_string();
    if truncated.is_empty() {
        "task".to_string()
    } else {
        truncated
    }
}

/// Short, mostly-unique suffix derived from the clock (base-36 of epoch millis).
fn short_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut n = millis as u64;
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    if n == 0 {
        out.push(b'0');
    }
    while n > 0 {
        out.push(digits[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    // Keep it short — the low-order digits change fastest.
    let s = String::from_utf8(out).unwrap_or_default();
    s.chars()
        .rev()
        .take(6)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

/// PR identity parsed from `gh pr view --json`.
#[derive(Deserialize)]
struct GhPr {
    number: u64,
    url: String,
}

/// Extract the trailing PR number from a `…/pull/<n>` URL.
fn pr_number_from_url(url: &str) -> u64 {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// Commit (optionally), push a branch, and open or reuse a PR — all via `gh` and
/// `git`. Requires `gh` to be signed in and a working directory whose `origin`
/// points at GitHub.
#[tauri::command]
pub fn github_push_card(input: PushInput) -> Result<PushResult, String> {
    if gh_login().is_none() {
        return Err("Not signed in to GitHub (run gh auth login)".into());
    }
    let token = gh_token()?;
    let dir = input.working_dir.clone();

    // 1. Validate it's a git repo and resolve the GitHub origin.
    git(&dir, &["rev-parse", "--is-inside-work-tree"])
        .map_err(|_| format!("{dir} is not a git repository"))?;
    let origin = git(&dir, &["remote", "get-url", "origin"])
        .map_err(|_| "No 'origin' remote found".to_string())?;
    let (owner, repo) = parse_owner_repo(&origin)
        .ok_or_else(|| format!("origin is not a GitHub remote: {origin}"))?;
    let repo_slug = format!("{owner}/{repo}");

    // 2. Resolve / create the branch.
    let branch = match input
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
    {
        Some(b) => b.to_string(),
        None => format!("myra/{}-{}", slugify(&input.title), short_id()),
    };
    if git(&dir, &["rev-parse", "--verify", &branch]).is_ok() {
        git(&dir, &["checkout", &branch])?;
    } else {
        git(&dir, &["checkout", "-b", &branch])?;
    }

    // 3. Optionally commit pending changes.
    let mut committed = false;
    if input.commit.unwrap_or(true) {
        git(&dir, &["add", "-A"])?;
        let dirty = !git(&dir, &["status", "--porcelain"])?.is_empty();
        if dirty {
            git(&dir, &["commit", "-m", &input.title])?;
            committed = true;
        }
    }

    // 3.5 Guard against an empty PR. When the run produced no file changes,
    // nothing is committed and the fresh branch matches its base, so
    // `gh pr create` fails with a confusing "No commits between …" error.
    // Detect that here and explain what to do instead.
    let base = match input
        .base_branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
    {
        Some(b) => b.to_string(),
        None => default_branch(&repo_slug, &dir).unwrap_or_else(|_| "main".to_string()),
    };
    if branch != base {
        for base_ref in [format!("origin/{base}"), base.clone()] {
            match git(&dir, &["rev-list", "--count", &format!("{base_ref}..HEAD")]) {
                Ok(count) if count.trim() == "0" => {
                    return Err(format!(
                        "Nothing to push: the run made no new commits in {dir}, so branch \"{branch}\" \
                         matches \"{base}\". Make sure the agent produced file changes before pushing to GitHub."
                    ));
                }
                // Found a usable base ref (and it has diverged) — stop probing.
                Ok(_) => break,
                // Base ref not present locally; try the next candidate.
                Err(_) => continue,
            }
        }
    }

    // 4. Push using an authenticated https URL (token not persisted in config).
    let push_url = format!("https://x-access-token:{token}@github.com/{owner}/{repo}.git");
    let refspec = format!("HEAD:refs/heads/{branch}");
    git(&dir, &["push", "--force-with-lease", &push_url, &refspec])
        .map_err(|e| sanitize_token(&e, &token))?;

    // 5. Create or reuse the PR via gh.
    let body = input.body.unwrap_or_default();
    let mut create_args: Vec<String> = vec![
        "pr".into(),
        "create".into(),
        "--repo".into(),
        repo_slug.clone(),
        "--head".into(),
        branch.clone(),
        "--title".into(),
        input.title.clone(),
        "--body".into(),
        body.clone(),
    ];
    if let Some(base) = input
        .base_branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
    {
        create_args.push("--base".into());
        create_args.push(base.to_string());
    }
    if input.draft.unwrap_or(false) {
        create_args.push("--draft".into());
    }
    let create_refs: Vec<&str> = create_args.iter().map(String::as_str).collect();

    match run_gh(&create_refs, Some(&dir)) {
        Ok(url) => {
            let pr_url = url
                .lines()
                .rev()
                .find(|l| l.contains("/pull/"))
                .unwrap_or(&url)
                .trim()
                .to_string();
            Ok(PushResult {
                pr_number: pr_number_from_url(&pr_url),
                pr_url,
                branch,
                reused: false,
                committed,
            })
        }
        Err(e) if e.to_lowercase().contains("already exists") => {
            // Reuse the existing PR: fetch its identity and add the result as a comment.
            let json = run_gh(
                &[
                    "pr",
                    "view",
                    &branch,
                    "--repo",
                    &repo_slug,
                    "--json",
                    "number,url",
                ],
                Some(&dir),
            )?;
            let pr: GhPr =
                serde_json::from_str(&json).map_err(|err| format!("parse pr view: {err}"))?;
            if !body.is_empty() {
                let _ = run_gh(
                    &[
                        "pr", "comment", &branch, "--repo", &repo_slug, "--body", &body,
                    ],
                    Some(&dir),
                );
            }
            Ok(PushResult {
                pr_number: pr.number,
                pr_url: pr.url,
                branch,
                reused: true,
                committed,
            })
        }
        Err(e) => {
            let sanitized = sanitize_token(&e, &token);
            if sanitized.to_lowercase().contains("no commits between") {
                return Err(format!(
                    "Nothing to push: branch \"{branch}\" has no commits that \"{base}\" doesn\'t \
                     already have. Make sure the agent produced file changes before pushing to GitHub."
                ));
            }
            Err(sanitized)
        }
    }
}

/// Strip the token from any error text before it reaches the UI/logs.
fn sanitize_token(msg: &str, token: &str) -> String {
    if token.is_empty() {
        msg.to_string()
    } else {
        msg.replace(token, "***")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_owner_repo_https() {
        assert_eq!(
            parse_owner_repo("https://github.com/Myra-Agents/Myra-Agents.git"),
            Some(("Myra-Agents".into(), "Myra-Agents".into()))
        );
    }

    #[test]
    fn parse_owner_repo_https_no_suffix() {
        assert_eq!(
            parse_owner_repo("https://github.com/octo/api"),
            Some(("octo".into(), "api".into()))
        );
    }

    #[test]
    fn parse_owner_repo_ssh_scp() {
        assert_eq!(
            parse_owner_repo("git@github.com:octo/api.git"),
            Some(("octo".into(), "api".into()))
        );
    }

    #[test]
    fn parse_owner_repo_ssh_url() {
        assert_eq!(
            parse_owner_repo("ssh://git@github.com/octo/api.git"),
            Some(("octo".into(), "api".into()))
        );
    }

    #[test]
    fn parse_owner_repo_rejects_non_github() {
        assert_eq!(parse_owner_repo("https://gitlab.com/octo/api.git"), None);
        assert_eq!(parse_owner_repo("not a url"), None);
    }

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Fix the login bug!"), "fix-the-login-bug");
    }

    #[test]
    fn slugify_trims_and_collapses() {
        assert_eq!(slugify("  ***Hello,   World*** "), "hello-world");
    }

    #[test]
    fn slugify_empty_falls_back() {
        assert_eq!(slugify("!!!"), "task");
        assert_eq!(slugify(""), "task");
    }

    #[test]
    fn slugify_truncates_to_40() {
        let long = "a".repeat(80);
        assert!(slugify(&long).len() <= 40);
    }

    #[test]
    fn short_id_is_short_and_alnum() {
        let id = short_id();
        assert!(!id.is_empty());
        assert!(id.len() <= 6);
        assert!(id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn pr_number_parses_tail() {
        assert_eq!(pr_number_from_url("https://github.com/o/r/pull/42"), 42);
        assert_eq!(pr_number_from_url("https://github.com/o/r/pull/7/"), 7);
        assert_eq!(pr_number_from_url("no-number-here"), 0);
    }

    #[test]
    fn sanitize_token_redacts() {
        let msg = "fatal: cannot push to https://x-access-token:ghp_secret@github.com/o/r.git";
        let out = sanitize_token(msg, "ghp_secret");
        assert!(!out.contains("ghp_secret"));
        assert!(out.contains("***"));
    }

    #[test]
    fn sanitize_token_empty_is_noop() {
        assert_eq!(sanitize_token("hello", ""), "hello");
    }
}
