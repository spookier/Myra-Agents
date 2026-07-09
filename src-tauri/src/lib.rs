mod github;
mod tray;

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command as StdCommand;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

use tray::{hide_tray_popover, open_main, quit_app, TrayNavigate, TrayState};

/// Buffer for a `myra://auth/callback?code=…` that arrives before the webview's
/// listener is ready (the deep link can launch/focus the app first). The
/// frontend drains it via `take_pending_auth_code` on mount.
#[derive(Default)]
struct PendingAuth(Mutex<Option<String>>);

/// Where the hosted web app's desktop login bridge page lives. The desktop
/// opens `<base>/auth/desktop/` in the system browser; the bridge runs Clerk,
/// then deep-links back with a one-time handoff code.
///
/// In `tauri:dev` the bridge is served by the local Next dev server (port 1420),
/// not the production host — so default there unless `MYRA_WEB_APP_URL` overrides.
/// Note: this is the **web app** origin, not the hub Worker (the Worker has no
/// `/auth/desktop/` page).
fn web_app_url() -> String {
    std::env::var("MYRA_WEB_APP_URL").unwrap_or_else(|_| {
        if cfg!(debug_assertions) {
            "http://localhost:1420".to_string()
        } else {
            "https://app.myra-agents.ai".to_string()
        }
    })
}

/// Payload emitted to the frontend when a `myra://auth/callback` deep link arrives.
#[derive(Clone, Serialize)]
struct AuthCallback {
    code: String,
}

/// Extract the `code` query param from a `myra://auth/callback?code=…` URL.
fn parse_auth_code(url: &url::Url) -> Option<String> {
    if url.scheme() != "myra" {
        return None;
    }
    url.query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .filter(|c| !c.is_empty())
}

/// The stable port the persistent local service listens on. When a service is
/// running here we *adopt* it instead of spawning a duplicate writer on
/// `~/.myra-agents`.
const SERVICE_PORT: u16 = 4319;

/// The server version this app build ships embedded (pinned in
/// `../server-version.json`, baked by `build.rs`). The runtime stamps it beside
/// the installed copy and re-installs when an app update carries a newer server.
const EMBEDDED_SERVER_VERSION: &str = env!("MYRA_EMBEDDED_SERVER_VERSION");

/// Backs the desktop's "local" connection. Either an ephemeral child sidecar we
/// spawned on a free port (killed on exit) or an *adopted* persistent service on
/// `SERVICE_PORT` (left running — it's meant to outlive the app). `port` and
/// `adopted` change at runtime via `refresh_local_backend`.
struct SidecarState {
    port: Mutex<u16>,
    child: Mutex<Option<CommandChild>>,
    adopted: Mutex<bool>,
}

/// Reserve a free localhost port by binding `:0` and reading the assigned port.
/// The listener is dropped immediately; the small TOCTOU window is fine for a
/// single local sidecar.
fn pick_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(SERVICE_PORT)
}

/// Best-effort `GET /healthz` against a localhost port, hand-rolled over TCP to
/// avoid pulling an HTTP client into the backend. True only when a server
/// answers with a 200 — so we adopt a real myra-server, not any random listener.
fn health_ok(port: u16) -> bool {
    let Ok(addr) = format!("127.0.0.1:{port}").parse::<SocketAddr>() else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let req =
        format!("GET /healthz HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = String::new();
    let _ = stream.read_to_string(&mut buf);
    buf.lines()
        .next()
        .map(|l| l.contains("200"))
        .unwrap_or(false)
}

/// The stable path the self-installed copy of the sidecar lives at, so the OS
/// service points somewhere that survives app moves/updates.
fn stable_bin_path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let name = if cfg!(windows) {
        "myra-server.exe"
    } else {
        "myra-server"
    };
    Ok(home.join(".myra-agents").join("bin").join(name))
}

/// Version stamp written next to the installed binary, so we can tell a stale
/// install (older server than this app embeds) without running the binary.
fn version_stamp_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(stable_bin_path(app)?.with_file_name(".version"))
}

fn installed_version(app: &AppHandle) -> Option<String> {
    let p = version_stamp_path(app).ok()?;
    std::fs::read_to_string(p)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn write_version_stamp(app: &AppHandle) {
    if let Ok(p) = version_stamp_path(app) {
        let _ = std::fs::write(p, format!("{EMBEDDED_SERVER_VERSION}\n"));
    }
}

/// True when the installed copy is older than what this app embeds (or has no
/// stamp). `"unknown"` embedded version (build couldn't read the pin) disables
/// forced upgrades — we only install-if-absent then.
fn install_is_stale(app: &AppHandle) -> bool {
    if EMBEDDED_SERVER_VERSION == "unknown" {
        return false;
    }
    match installed_version(app) {
        Some(v) => v != EMBEDDED_SERVER_VERSION,
        None => true,
    }
}

fn is_demo() -> bool {
    std::env::var("DEMO")
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false)
}

/// Copy the bundled sidecar to the stable path (overwrite = upgrade), stamp the
/// version, and (re)install the per-user OS service on `SERVICE_PORT`. Idempotent
/// — reused by first-time setup, the upgrade check, and remote-access enroll.
async fn ensure_local_service(app: &AppHandle) -> Result<(), String> {
    let dest = stable_bin_path(app)?;
    run_sidecar(
        app,
        vec!["install-self".into(), dest.to_string_lossy().to_string()],
        vec![],
    )
    .await?;
    write_version_stamp(app);
    let port = SERVICE_PORT.to_string();
    let myra_dir = std::env::var("MYRA_DIR").ok();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut envs: Vec<(&str, &str)> = vec![("PORT", port.as_str())];
        if let Some(d) = myra_dir.as_deref() {
            envs.push(("MYRA_DIR", d));
        }
        run_binary(&dest, &["install-service"], &envs)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// (Re)start the already-installed service via its own idempotent
/// `install-service` (reloads the launchd/systemd/schtasks definition and starts
/// it), then wait for it to answer on the stable port. Returns whether it came up.
fn start_installed_service(dest: &std::path::Path) -> bool {
    let port = SERVICE_PORT.to_string();
    let myra_dir = std::env::var("MYRA_DIR").ok();
    let mut envs: Vec<(&str, &str)> = vec![("PORT", port.as_str())];
    if let Some(d) = myra_dir.as_deref() {
        envs.push(("MYRA_DIR", d));
    }
    if run_binary(dest, &["install-service"], &envs).is_err() {
        return false;
    }
    for _ in 0..100 {
        if health_ok(SERVICE_PORT) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    health_ok(SERVICE_PORT)
}

/// Best-effort background upgrade: when this app embeds a newer server than the
/// installed copy, overwrite the stable binary and reload the service.
fn spawn_upgrade_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if !install_is_stale(&app) {
            return;
        }
        let Ok(dest) = stable_bin_path(&app) else {
            return;
        };
        if !dest.exists() {
            return;
        }
        match ensure_local_service(&app).await {
            Ok(()) => println!("[myra-server] upgraded local service to {EMBEDDED_SERVER_VERSION}"),
            Err(e) => eprintln!("[myra-server] upgrade skipped: {e}"),
        }
    });
}

/// Update the managed `SidecarState`, or manage it on first call.
fn set_sidecar_state(app: &AppHandle, port: u16, child: Option<CommandChild>, adopted: bool) {
    if let Some(state) = app.try_state::<SidecarState>() {
        *state.port.lock().unwrap() = port;
        *state.child.lock().unwrap() = child;
        *state.adopted.lock().unwrap() = adopted;
    } else {
        app.manage(SidecarState {
            port: Mutex::new(port),
            child: Mutex::new(child),
            adopted: Mutex::new(adopted),
        });
    }
}

/// Resolve the local backend in three steps, guaranteeing a single writer on
/// `~/.myra-agents`:
///   1. Adopt a persistent service already listening on `SERVICE_PORT`.
///   2. Else, if one was set up before but is down, (re)start and adopt it.
///   3. Else, spawn an ephemeral sidecar on a free port for this session.
/// The local HTTP interface runs ungated (loopback only). The persistent service
/// is never installed silently here — that's an explicit user action
/// (`install_local_server`); steps 2–3 only adopt/restart an existing install or
/// run the ephemeral fallback. Returns the resolved port.
fn start_local_backend(app: &AppHandle) -> u16 {
    // 1. Adopt a running persistent service.
    if health_ok(SERVICE_PORT) {
        set_sidecar_state(app, SERVICE_PORT, None, true);
        spawn_upgrade_check(app.clone());
        return SERVICE_PORT;
    }

    // 2. A service was set up before but isn't up (login service disabled,
    //    crashed, just installed): start it and adopt. Skipped in demo, which
    //    runs an isolated data dir and never installs a service.
    if !is_demo() {
        if let Ok(dest) = stable_bin_path(app) {
            if dest.exists() && start_installed_service(&dest) {
                set_sidecar_state(app, SERVICE_PORT, None, true);
                spawn_upgrade_check(app.clone());
                return SERVICE_PORT;
            }
        }
    }

    // 3. Ephemeral fallback: spawn the bundled sidecar on a free port. Keeps the
    //    board working before the user opts into the persistent local server, and
    //    on boxes that can't host a login service.
    //    Dev override: `MYRA_DEV_PORT` pins this to a known port so a plain
    //    browser (./dev.sh app bakes NEXT_PUBLIC_MYRA_SERVER_URL at it) reaches
    //    the very sidecar the webview uses — no second server. Unset → free port.
    let port = std::env::var("MYRA_DEV_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or_else(pick_free_port);
    let mut command = app
        .shell()
        // The shell plugin resolves a sidecar relative to the executable's own
        // directory by joining this arg verbatim — and Tauri bundles externalBin
        // flat next to the exe (Contents/MacOS/myra-server, target/<profile>/
        // myra-server), with no `binaries/` subdir. So pass the basename, not the
        // configured externalBin path, or spawn fails with ENOENT on launch.
        .sidecar("myra-server")
        .expect("sidecar myra-server should resolve")
        .env("PORT", port.to_string())
        // Tie the ephemeral sidecar's lifetime to ours: it watches this PID and
        // self-exits when we die. `RunEvent::Exit` only fires on a clean Quit —
        // a SIGKILL/Ctrl-C (esp. a `tauri:dev` restart) would otherwise orphan it
        // (reparented to init), leaking a sidecar per restart. The persistent
        // service is started without this var, so it's never touched.
        .env("MYRA_PARENT_PID", std::process::id().to_string());
    if let Ok(demo) = std::env::var("DEMO") {
        command = command.env("DEMO", demo);
    }

    match command.spawn() {
        Ok((mut rx, child)) => {
            // Drain the sidecar's stdout/stderr so it never blocks on a full pipe,
            // and surface its logs in the desktop console for debugging.
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                            log::info!(target: "myra-server", "{}", String::from_utf8_lossy(&bytes).trim_end());
                        }
                        CommandEvent::Terminated(payload) => {
                            log::warn!(target: "myra-server", "terminated: {:?}", payload.code);
                        }
                        _ => {}
                    }
                }
            });
            set_sidecar_state(app, port, Some(child), false);
        }
        Err(e) => {
            log::error!(target: "myra-server", "spawn failed: {e}");
            set_sidecar_state(app, port, None, false);
        }
    }

    // Wait until the server is actually listening before the UI fans out reads.
    for _ in 0..100 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    port
}

/// Run the bundled sidecar binary to completion, returning its stdout. Used for
/// short subcommands (`status`, `install-self`) where we want the output, not a
/// long-lived child.
async fn run_sidecar(
    app: &AppHandle,
    args: Vec<String>,
    envs: Vec<(String, String)>,
) -> Result<String, String> {
    let mut command = app
        .shell()
        .sidecar("myra-server")
        .map_err(|e| e.to_string())?
        .args(args);
    for (k, v) in envs {
        command = command.env(k, v);
    }
    let output = command.output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Run the stable self-installed copy of the sidecar to completion (blocking).
/// Used for enroll/install-service/unenroll/uninstall-service so the service
/// definition bakes in the stable binary path.
fn run_binary(
    path: &std::path::Path,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    let mut cmd = StdCommand::new(path);
    cmd.args(args);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Return the port the local sidecar is listening on, so the frontend can point
/// its "local" connection at `http://127.0.0.1:<port>`.
#[tauri::command]
fn get_sidecar_port(state: tauri::State<'_, SidecarState>) -> u16 {
    *state.port.lock().unwrap()
}

/// Git branches of a working directory: the checked-out branch plus all local
/// and remote-tracking refs. Used by the schedule editor's branch picker.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitBranches {
    /// True when `path` is inside a git work tree (false → fall back gracefully).
    is_git: bool,
    /// Currently checked-out branch (None when detached HEAD / not git).
    current: Option<String>,
    /// Local branches (`refs/heads`).
    local: Vec<String>,
    /// Remote-tracking branches (`refs/remotes`, e.g. `origin/main`).
    remote: Vec<String>,
}

/// Inspect a folder's git branches. Returns `is_git: false` rather than erroring
/// when the path is not a git work tree, so the UI degrades cleanly.
///
/// `async` + `spawn_blocking` on purpose: a sync Tauri command runs on the main
/// thread, and `git` can stall (huge repo, cold disk, network mount) — that
/// froze the whole window when opening a schedule. The git calls stay blocking
/// `std::process` but execute on a blocking-pool thread instead.
#[tauri::command]
async fn git_branches(path: String) -> Result<GitBranches, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let run = |args: &[&str]| -> Result<String, String> {
            let out = StdCommand::new("git")
                .arg("-C")
                .arg(&path)
                .args(args)
                .output()
                .map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        };

        // Not a git work tree → graceful empty result.
        let inside = run(&["rev-parse", "--is-inside-work-tree"]).map(|s| s == "true").unwrap_or(false);
        if !inside {
            return Ok(GitBranches { is_git: false, current: None, local: vec![], remote: vec![] });
        }

        let split = |s: String| {
            s.lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
        };
        let current = run(&["rev-parse", "--abbrev-ref", "HEAD"]).ok().filter(|s| !s.is_empty() && s != "HEAD");
        let local = run(&["for-each-ref", "--format=%(refname:short)", "refs/heads"]).map(split).unwrap_or_default();
        let mut remote = run(&["for-each-ref", "--format=%(refname:short)", "refs/remotes"]).map(split).unwrap_or_default();
        // Keep real remote branches (`origin/main`); drop the symbolic remote HEAD,
        // which `%(refname:short)` collapses to the bare remote name (e.g. `origin`).
        remote.retain(|r| r.contains('/') && !r.ends_with("/HEAD"));

        Ok(GitBranches { is_git: true, current, local, remote })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The OS user home directory — the schedule folder picker's default base when
/// no custom "home folder" is configured.
#[tauri::command]
fn home_dir(app: AppHandle) -> Result<String, String> {
    app.path()
        .home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/// Immediate subdirectories of `path` (absolute paths, dotfiles skipped, sorted).
/// Powers the folder picker's list of working folders under the home folder.
#[tauri::command]
fn list_subfolders(path: String) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let name = entry.file_name().to_string_lossy().to_string();
        if is_dir && !name.starts_with('.') {
            out.push(entry.path().to_string_lossy().to_string());
        }
    }
    out.sort();
    Ok(out)
}

/// Create a new local branch (from the current HEAD) in a git work tree.
/// Async for the same reason as [`git_branches`]: keep git off the main thread.
#[tauri::command]
async fn git_create_branch(path: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = name.trim();
        if name.is_empty() {
            return Err("branch name is empty".into());
        }
        // `--` separates the branch name from option parsing (safety).
        let out = StdCommand::new("git")
            .arg("-C")
            .arg(&path)
            .args(["branch", "--", name])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Re-resolve the local backend (kill any ephemeral child first, then adopt the
/// service or re-spawn). Returns the new port. Called by the frontend after
/// enabling/disabling remote access.
#[tauri::command]
fn refresh_local_backend(app: AppHandle) -> u16 {
    if let Some(state) = app.try_state::<SidecarState>() {
        let adopted = *state.adopted.lock().unwrap();
        if !adopted {
            if let Some(child) = state.child.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    }
    start_local_backend(&app)
}

/// Status of this machine's remote-access enrollment. Mirrors the `status --json`
/// shape emitted by `packages/server/src/main.ts::runStatus`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteStatus {
    enrolled: bool,
    hub_url: Option<String>,
    user_id: Option<String>,
    instance_id: Option<String>,
    label: Option<String>,
    running: bool,
}

/// Make this computer reachable from the hub. Remote access *layers on top of* the
/// local server: ensure the binary is installed, enroll it with the pairing code,
/// then (re)install the service so it dials the hub on start. The frontend then
/// calls `refresh_local_backend` to adopt it. Local-direct access keeps working
/// with or without this.
#[tauri::command]
async fn enable_remote_access(
    app: AppHandle,
    hub_url: String,
    code: String,
    label: String,
) -> Result<(), String> {
    let dest = stable_bin_path(&app)?;
    run_sidecar(
        &app,
        vec!["install-self".into(), dest.to_string_lossy().to_string()],
        vec![],
    )
    .await?;
    write_version_stamp(&app);
    let port = SERVICE_PORT.to_string();
    let myra_dir = std::env::var("MYRA_DIR").ok();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        // Enroll first so the service is already paired when it starts + dials out.
        run_binary(
            &dest,
            &["enroll", &code],
            &[
                ("MYRA_HUB_URL", hub_url.as_str()),
                ("MYRA_INSTANCE_LABEL", label.as_str()),
            ],
        )?;
        let mut envs: Vec<(&str, &str)> = vec![("PORT", port.as_str())];
        if let Some(d) = myra_dir.as_deref() {
            envs.push(("MYRA_DIR", d));
        }
        run_binary(&dest, &["install-service"], &envs)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Combined health/identity of this machine's local server, for the Local Server
/// settings panel: whether the binary is installed, its stamped version vs. what
/// the app embeds, whether it's answering, and any hub enrollment layered on top.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalServerStatus {
    /// Persistent copy present at the stable path.
    installed: bool,
    /// Version stamped beside the installed copy (`None` if absent/unstamped).
    version: Option<String>,
    /// Server version this app build ships embedded.
    embedded_version: String,
    /// Answering `GET /healthz` on its port right now.
    running: bool,
    /// Port the local connection should target.
    port: u16,
    /// Hub enrollment layered on top (remote access).
    enrolled: bool,
    hub_url: Option<String>,
    label: Option<String>,
}

/// Report the local server's install + run + enrollment state.
#[tauri::command]
async fn local_server_status(app: AppHandle) -> Result<LocalServerStatus, String> {
    let installed = stable_bin_path(&app).map(|p| p.exists()).unwrap_or(false);
    let version = installed_version(&app);
    let port = app
        .try_state::<SidecarState>()
        .map(|s| *s.port.lock().unwrap())
        .unwrap_or(SERVICE_PORT);
    let running = health_ok(port) || health_ok(SERVICE_PORT);

    // Enrollment comes from the sidecar's own `status` (reads the credential file).
    let (enrolled, hub_url, label) =
        match run_sidecar(&app, vec!["status".into(), "--json".into()], vec![]).await {
            Ok(out) => {
                let line = out
                    .lines()
                    .rev()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("")
                    .trim();
                match serde_json::from_str::<RemoteStatus>(line) {
                    Ok(s) => (s.enrolled, s.hub_url, s.label),
                    Err(_) => (false, None, None),
                }
            }
            Err(_) => (false, None, None),
        };

    Ok(LocalServerStatus {
        installed,
        version,
        embedded_version: EMBEDDED_SERVER_VERSION.to_string(),
        running,
        port,
        enrolled,
        hub_url,
        label,
    })
}

/// Set up the persistent local server: install the binary to the stable path and
/// register the per-user OS service on `SERVICE_PORT`, then adopt it.
/// Explicit user action (a login service is a system change — never silent).
#[tauri::command]
async fn install_local_server(app: AppHandle) -> Result<LocalServerStatus, String> {
    ensure_local_service(&app).await?;
    let up = tauri::async_runtime::spawn_blocking(|| {
        for _ in 0..100 {
            if health_ok(SERVICE_PORT) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    })
    .await
    .unwrap_or(false);
    if up {
        set_sidecar_state(&app, SERVICE_PORT, None, true);
    }
    local_server_status(app).await
}

/// Tear down the persistent local server: remove the OS service, delete the
/// installed binary + stamp, then fall back to the ephemeral/offline backend for
/// this session.
#[tauri::command]
async fn uninstall_local_server(app: AppHandle) -> Result<LocalServerStatus, String> {
    let dest = stable_bin_path(&app)?;
    let stamp = version_stamp_path(&app).ok();
    tauri::async_runtime::spawn_blocking(move || {
        if dest.exists() {
            let _ = run_binary(&dest, &["uninstall-service"], &[]);
        }
        let _ = std::fs::remove_file(&dest);
        if let Some(s) = stamp {
            let _ = std::fs::remove_file(s);
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    refresh_local_backend(app.clone());
    local_server_status(app).await
}

/// Stop remote access: remove the OS service and drop the hub credential.
#[tauri::command]
async fn disable_remote_access(app: AppHandle) -> Result<(), String> {
    let dest = stable_bin_path(&app)?;
    if dest.exists() {
        tauri::async_runtime::spawn_blocking(move || {
            let _ = run_binary(&dest, &["uninstall-service"], &[]);
            let _ = run_binary(&dest, &["unenroll"], &[]);
        })
        .await
        .map_err(|e| e.to_string())?;
    } else {
        let _ = run_sidecar(&app, vec!["uninstall-service".into()], vec![]).await;
        let _ = run_sidecar(&app, vec!["unenroll".into()], vec![]).await;
    }
    Ok(())
}

/// Report this machine's enrollment + running state.
#[tauri::command]
async fn remote_access_status(app: AppHandle) -> Result<RemoteStatus, String> {
    let out = run_sidecar(&app, vec!["status".into(), "--json".into()], vec![]).await?;
    let line = out
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    serde_json::from_str(line).map_err(|e| format!("parse status: {e} (output: {out})"))
}

/// Open the system browser at the web app's desktop login bridge. The browser
/// runs Clerk's hosted sign-in (which the Tauri webview can't host), then deep-
/// links a one-time code back to `myra://auth/callback`.
#[tauri::command]
async fn start_login(app: AppHandle) -> Result<(), String> {
    let url = format!("{}/auth/desktop/", web_app_url().trim_end_matches('/'));
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Drain any auth code buffered before the frontend's deep-link listener mounted.
#[tauri::command]
fn take_pending_auth_code(state: tauri::State<'_, PendingAuth>) -> Option<String> {
    state.0.lock().ok().and_then(|mut c| c.take())
}

/// Open the webview's devtools, invoked by the frontend's dev-only "Inspect
/// Element" context-menu item (the native WebKit menu — and its Inspect entry —
/// are suppressed by the frontend). `open_devtools` only exists in debug builds
/// (or with the `devtools` feature), so this is a no-op in release.
#[tauri::command]
fn open_devtools(#[allow(unused_variables)] window: tauri::WebviewWindow) {
    #[cfg(debug_assertions)]
    window.open_devtools();
}

/// Wire the `myra://` deep-link handler: buffer the auth code, notify the
/// frontend, and bring the window forward.
fn setup_deep_link(handle: &AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;

    // Linux/Windows: register the scheme at runtime (macOS registers via the
    // Info.plist generated from tauri.conf.json's plugins.deep-link.schemes).
    #[cfg(any(windows, target_os = "linux"))]
    {
        let _ = handle.deep_link().register_all();
    }

    let h = handle.clone();
    handle.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            let Some(code) = parse_auth_code(&url) else {
                continue;
            };
            if let Some(state) = h.try_state::<PendingAuth>() {
                if let Ok(mut slot) = state.0.lock() {
                    *slot = Some(code.clone());
                }
            }
            let _ = h.emit("auth-callback", AuthCallback { code });
            if let Some(win) = h.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
    });
}

fn build_app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

    // Start from the OS default menu so macOS adds Fill / Center /
    // Move & Resize / Bring All to Front automatically to the Window submenu.
    let menu = Menu::default(app)?;

    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let new_schedule = MenuItemBuilder::with_id("new_schedule", "New Patrol")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;
    let sep = PredefinedMenuItem::separator(app)?;

    #[cfg(target_os = "macos")]
    {
        use tauri::menu::MenuItemKind;
        let items = menu.items()?;

        // items[0] = "Myra Agents" app submenu. macOS convention: Settings
        // goes right after the first separator (position 2 = after About + sep).
        if let Some(MenuItemKind::Submenu(app_sub)) = items.first() {
            app_sub.insert_items(&[&settings, &sep], 2)?;
        }

        // Find the existing "File" submenu from Menu::default() and prepend
        // New Schedule to it. If absent (unlikely), create one at position 1.
        let mut has_file = false;
        for item in &items {
            if let MenuItemKind::Submenu(sub) = item {
                if sub.text().unwrap_or_default().eq_ignore_ascii_case("file") {
                    let sep2 = PredefinedMenuItem::separator(app)?;
                    sub.prepend_items(&[&new_schedule, &sep2])?;
                    has_file = true;
                    break;
                }
            }
        }
        if !has_file {
            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&new_schedule)
                .separator()
                .close_window()
                .build()?;
            menu.insert(&file_menu, 1)?;
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Prepend a File submenu; Settings goes inside it alongside Quit.
        let file_menu = SubmenuBuilder::new(app, "File")
            .item(&new_schedule)
            .separator()
            .item(&settings)
            .separator()
            .quit()
            .build()?;
        menu.prepend(&file_menu)?;
    }

    Ok(menu)
}

fn navigate_main(app: &AppHandle, path: &str, new_schedule: bool) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    let _ = app.emit(
        "tray-navigate",
        TrayNavigate { path: path.to_string(), new_schedule },
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    // Console (visible when launched from a terminal).
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    // Persistent file: ~/Library/Logs/com.myra-agents.app/Myra Agents.log
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                    // Forward into the webview devtools console too.
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        // Self-update: check GitHub Releases for a newer signed build, then
        // download + verify + install + relaunch. Driven from the frontend via
        // the JS updater/process plugins (Settings → Preferences + a silent
        // launch check). Desktop only — the updater plugin is a no-op elsewhere.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Launch at login: toggled from Settings → Preferences via the JS
        // autostart plugin (enable/disable/isEnabled). macOS uses a per-user
        // LaunchAgent; Windows/Linux use the platform-native registry/desktop entry.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .menu(build_app_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "new_schedule" => navigate_main(app, "/schedules", true),
            "settings" => navigate_main(app, "/settings", false),
            _ => {}
        })
        .manage(TrayState::default())
        .manage(PendingAuth::default())
        .setup(|app| {
            tray::setup_tray(app.handle())?;
            start_local_backend(app.handle());
            setup_deep_link(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide to tray instead of closing
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_sidecar_port,
            git_branches,
            git_create_branch,
            home_dir,
            list_subfolders,
            refresh_local_backend,
            local_server_status,
            install_local_server,
            uninstall_local_server,
            enable_remote_access,
            disable_remote_access,
            remote_access_status,
            start_login,
            take_pending_auth_code,
            open_devtools,
            github::github_auth_login,
            github::github_auth_status,
            github::github_auth_logout,
            github::github_push_card,
            hide_tray_popover,
            open_main,
            quit_app
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Kill the sidecar when the app actually exits (tray "Quit" → Exit) —
        // but never an adopted persistent service; it's meant to outlive the app.
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<SidecarState>() {
                let adopted = *state.adopted.lock().unwrap();
                if !adopted {
                    if let Some(child) = state.child.lock().ok().and_then(|mut c| c.take()) {
                        let _ = child.kill();
                    }
                }
            }
        }

        // macOS: clicking the menu-bar tray icon activates the app, which AppKit
        // turns into a reopen that resurrects the hidden main window. When the
        // reopen lands right after a popover dismiss (i.e. the click that just
        // closed the popover), undo it so the tray toggle stays a toggle. A
        // genuine Dock reopen (no recent dismiss) is left alone. AppKit performs
        // its default show *after* this callback returns, so we also hide once
        // more on a short delay to win that race.
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            let recent = app_handle
                .try_state::<TrayState>()
                .map(|s| s.dismissed_within(Duration::from_millis(600)))
                .unwrap_or(false);
            if recent {
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.hide();
                }
                let handle = app_handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(120));
                    let inner = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        if let Some(win) = inner.get_webview_window("main") {
                            let _ = win.hide();
                        }
                    });
                });
            }
        }
    });
}
