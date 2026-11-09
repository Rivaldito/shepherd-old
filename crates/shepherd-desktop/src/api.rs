//! Client for the Shepherd server's JSON socket API (newline-delimited JSON, one request per
//! connection; `events.subscribe` keeps its connection open). The desktop app is only a client:
//! the server owns workspaces, terminals and agents. Unix sockets only for now.

use serde_json::{json, Value};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(unix)]
use std::time::Duration;

/// Lifecycle events the UI cares about. They only say "something changed": the UI re-reads
/// `session.snapshot` instead of replaying payloads (the server documents it that way).
pub const EVENT_TYPES: &[&str] = &[
    "workspace.created",
    "workspace.updated",
    "workspace.renamed",
    "workspace.moved",
    "workspace.reordered",
    "workspace.closed",
    "workspace.focused",
    "tab.created",
    "tab.closed",
    "tab.focused",
    "tab.renamed",
    "tab.moved",
    "pane.created",
    "pane.updated",
    "pane.closed",
    "pane.focused",
    "pane.moved",
    "pane.exited",
    "pane.agent_detected",
    "layout.updated",
    "worktree.created",
    "worktree.opened",
    "worktree.removed",
];

/// Method families the webview may call. Server control (`server.*`), plugins, integrations and
/// the raw agent-reporting methods stay out of reach of the UI.
pub fn allowed_method(method: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "workspace.",
        "tab.",
        "pane.",
        "agent.",
        "worktree.",
        "layout.",
        "shepherd.",
    ];
    const DENIED: &[&str] = &[
        "pane.report_agent",
        "pane.report_agent_session",
        "pane.report_metadata",
        "pane.clear_agent_authority",
        "pane.release_agent",
    ];
    if DENIED.contains(&method) {
        return false;
    }
    matches!(method, "ping" | "session.snapshot") || PREFIXES.iter().any(|p| method.starts_with(p))
}

/// Same resolution as the CLI: `SHEPHERD_SOCKET_PATH`, then `SHEPHERD_SESSION`, then the default.
pub fn socket_path_from(
    socket_env: Option<&str>,
    session_env: Option<&str>,
    config_dir: &Path,
) -> PathBuf {
    if let Some(path) = socket_env.filter(|s| !s.is_empty()) {
        return PathBuf::from(path);
    }
    match session_env.filter(|s| !s.is_empty()) {
        Some(name) => config_dir.join("sessions").join(name).join("shepherd.sock"),
        None => config_dir.join("shepherd.sock"),
    }
}

/// The `socket:` line of `shepherd status server`, which prints it even when no server is running.
pub fn socket_from_status(text: &str) -> Option<PathBuf> {
    text.lines()
        .find_map(|l| l.strip_prefix("socket:"))
        .map(|p| PathBuf::from(p.trim()))
        .filter(|p| !p.as_os_str().is_empty())
}

/// Where this `shepherd` binary listens: a debug build uses `shepherd-dev`, a release build `shepherd`,
/// so the binary is the only reliable source.
pub fn socket_of_bin(bin: &Path) -> Option<PathBuf> {
    let out = std::process::Command::new(bin)
        .args(["status", "server"])
        .output()
        .ok()?;
    socket_from_status(&String::from_utf8_lossy(&out.stdout))
}

pub fn default_socket_path() -> PathBuf {
    static FROM_BIN: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    let env = std::env::var("SHEPHERD_SOCKET_PATH").ok();
    if env.as_deref().is_some_and(|s| !s.is_empty()) {
        return PathBuf::from(env.unwrap_or_default());
    }
    if let Some(path) = FROM_BIN.get() {
        return path.clone();
    }
    if let Some(path) = default_server_bin().and_then(|bin| socket_of_bin(&bin)) {
        return FROM_BIN.get_or_init(|| path).clone();
    }
    let config_dir = shepherd_core::config::global_config_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let session = std::env::var("SHEPHERD_SESSION").ok();
    let path = socket_path_from(None, session.as_deref(), &config_dir);
    // No binary to ask: a running debug server lives next to the release config dir.
    let dev = config_dir
        .parent()
        .map(|p| p.join("shepherd-dev").join("shepherd.sock"));
    match dev {
        Some(dev) if !path.exists() && dev.exists() => dev,
        _ => path,
    }
}

/// Where the server binary comes from: `SHEPHERD_BIN`, then `shepherd` on `PATH`, then next to this app.
pub fn find_server_bin(
    env_bin: Option<&str>,
    path_env: Option<&OsStr>,
    exe_dir: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(bin) = env_bin.filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(bin));
    }
    let on_path = path_env
        .into_iter()
        .flat_map(std::env::split_paths)
        .map(|d| d.join("shepherd"));
    on_path
        .chain(exe_dir.map(|d| d.join("shepherd")))
        .find(|p| p.is_file())
}

pub fn default_server_bin() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok();
    find_server_bin(
        std::env::var("SHEPHERD_BIN").ok().as_deref(),
        std::env::var_os("PATH").as_deref(),
        exe.as_deref().and_then(Path::parent),
    )
}

fn format_error(err: &Value) -> String {
    let code = err.get("code").and_then(Value::as_str).unwrap_or("error");
    match err.get("message").and_then(Value::as_str) {
        Some(message) => format!("{code}: {message}"),
        None => code.to_string(),
    }
}

/// Methods that wait for an agent (to be ready, to answer, to be spawned) get longer than a plain read.
pub fn timeout_for(method: &str) -> std::time::Duration {
    match method {
        "agent.start" | "agent.wait" | "agent.prompt" | "shepherd.agent.spawn" => {
            std::time::Duration::from_secs(45)
        }
        _ => std::time::Duration::from_secs(10),
    }
}

/// One request, one response. Returns the `result` value, or the server's error as text.
#[cfg(unix)]
pub fn call(path: &Path, method: &str, params: Value) -> Result<Value, String> {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let timeout = Some(timeout_for(method));
    let mut stream = UnixStream::connect(path)
        .map_err(|e| format!("no se pudo conectar a {}: {e}", path.display()))?;
    stream
        .set_read_timeout(timeout)
        .and_then(|_| stream.set_write_timeout(timeout))
        .map_err(|e| e.to_string())?;
    let id = format!("desktop-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    let mut line = serde_json::to_vec(&json!({ "id": id, "method": method, "params": params }))
        .map_err(|e| e.to_string())?;
    line.push(b'\n');
    stream.write_all(&line).map_err(|e| e.to_string())?;
    let mut reply = String::new();
    BufReader::new(stream)
        .read_line(&mut reply)
        .map_err(|e| e.to_string())?;
    if reply.trim().is_empty() {
        return Err("el servidor cerró la conexión sin responder".into());
    }
    let response: Value =
        serde_json::from_str(&reply).map_err(|e| format!("respuesta inválida: {e}"))?;
    if let Some(err) = response.get("error") {
        return Err(format_error(err));
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| "respuesta sin result".into())
}

/// Subscribes and blocks, handing every pushed event to `on_event`. Returns `Ok` when the server
/// closes the connection and `Err` for a rejected subscription or `events_lost`; the caller reconnects.
#[cfg(unix)]
#[allow(dead_code)] // the tests use it; the app subscribes through `read_subscriptions`
pub fn read_events(
    path: &Path,
    types: &[&str],
    on_ready: &mut dyn FnMut(),
    on_event: &mut dyn FnMut(Value),
) -> Result<(), String> {
    let subs: Vec<Value> = types.iter().map(|t| json!({ "type": t })).collect();
    read_subscriptions(path, subs, on_ready, &mut |event| {
        on_event(event);
        true
    })
}

/// Like `read_events` with explicit subscriptions (some need parameters, e.g. a `pane_id`). `on_event`
/// returns `false` to end the subscription so the caller can reconnect with a new list.
#[cfg(unix)]
pub fn read_subscriptions(
    path: &Path,
    subs: Vec<Value>,
    on_ready: &mut dyn FnMut(),
    on_event: &mut dyn FnMut(Value) -> bool,
) -> Result<(), String> {
    let mut stream = UnixStream::connect(path)
        .map_err(|e| format!("no se pudo conectar a {}: {e}", path.display()))?;
    let mut line = serde_json::to_vec(&json!({ "id": "desktop-events", "method": "events.subscribe", "params": { "subscriptions": subs } }))
        .map_err(|e| e.to_string())?;
    line.push(b'\n');
    stream.write_all(&line).map_err(|e| e.to_string())?;
    let mut acked = false;
    for line in BufReader::new(stream).lines() {
        let value: Value =
            serde_json::from_str(&line.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if let Some(err) = value.get("error") {
            return Err(format_error(err));
        }
        if !acked {
            acked = true;
            on_ready();
            continue;
        }
        if !on_event(value) {
            break;
        }
    }
    Ok(())
}

/// `pane.agent_status_changed` needs a `pane_id` per subscription (a global one is rejected), so the
/// UI asks for it on every pane of the snapshot, like the TUI gets status changes pushed per pane.
pub fn status_subscriptions(snapshot: &Value) -> Vec<Value> {
    snapshot["snapshot"]["panes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["pane_id"].as_str())
        .map(|id| json!({ "type": "pane.agent_status_changed", "pane_id": id }))
        .collect()
}

/// Events after which the pane set (and so the status subscriptions) is stale.
pub fn changes_panes(event: &Value) -> bool {
    matches!(
        event["event"].as_str(),
        Some("pane.created" | "pane.closed" | "pane.exited" | "pane.agent_detected" | "pane.moved")
    )
}

/// What the UI console may run: the runtime command families plus `--version`/`--help`.
/// Server control, updates, machines, config and integrations stay out of reach, as for `allowed_method`.
pub fn allowed_cli(args: &[String]) -> bool {
    const FAMILIES: &[&str] = &[
        "workspace",
        "tab",
        "pane",
        "agent",
        "worktree",
        "notification",
        "api",
        "status",
    ];
    match args.first().map(String::as_str) {
        Some("--version" | "-V" | "--help" | "-h" | "help") => true,
        Some(first) => FAMILIES.contains(&first),
        None => false,
    }
}

#[derive(serde::Serialize, Debug)]
pub struct CliOutput {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// Runs `bin args…` against `socket` (never through a shell), killing it after `timeout`.
#[cfg(unix)]
pub fn run_cli(
    bin: &Path,
    socket: &Path,
    args: &[String],
    timeout: Duration,
) -> Result<CliOutput, String> {
    let mut cmd = std::process::Command::new(bin);
    cmd.args(args)
        .env("SHEPHERD_SOCKET_PATH", socket)
        .env_remove("SHEPHERD_ENV");
    run_command(cmd, timeout)
}

/// Runs a prepared command with no stdin, killing it after `timeout`.
/// Output is capped so a chatty command cannot flood the webview.
#[cfg(unix)]
pub fn run_command(mut cmd: std::process::Command, timeout: Duration) -> Result<CliOutput, String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::Instant;
    const CAP: u64 = 256 * 1024;
    let program = cmd.get_program().to_string_lossy().into_owned();
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // ETXTBSY ("Text file busy", errno 26) is transient: another thread forked while the file was
    // still open for writing (a script just written, a binary being replaced). Give it a moment.
    let mut child = {
        let mut attempts = 0;
        loop {
            match cmd.spawn() {
                Err(e) if e.raw_os_error() == Some(26) && attempts < 40 => {
                    attempts += 1;
                    std::thread::sleep(Duration::from_millis(25));
                }
                other => break other.map_err(|e| format!("no se pudo ejecutar {program}: {e}"))?,
            }
        }
    };
    // Output is collected as it arrives: a grandchild that keeps the pipe open after we killed the
    // child must not make us wait for it (its output so far is still returned).
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        let buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let shared = buf.clone();
        let handle = std::thread::spawn(move || {
            let (mut pipe, mut chunk) = (pipe, [0u8; 4096]);
            while let Some(Ok(n)) = pipe.as_mut().map(|p| p.read(&mut chunk)) {
                let mut out = shared.lock().unwrap_or_else(|e| e.into_inner());
                let room = (CAP as usize).saturating_sub(out.len());
                if n == 0 || room == 0 {
                    break;
                }
                out.extend_from_slice(&chunk[..n.min(room)]);
            }
        });
        (buf, handle)
    };
    let (out, out_thread) = drain(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let (err, err_thread) = drain(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + timeout;
    let (mut code, mut timed_out) = (None, false);
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                code = status.code();
                break;
            }
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                timed_out = true;
                break;
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    }
    let grace = Instant::now() + Duration::from_millis(300);
    while !(out_thread.is_finished() && err_thread.is_finished()) && Instant::now() < grace {
        std::thread::sleep(Duration::from_millis(10));
    }
    let text = |buf: &std::sync::Mutex<Vec<u8>>| {
        String::from_utf8_lossy(&buf.lock().unwrap_or_else(|e| e.into_inner())).into_owned()
    };
    Ok(CliOutput {
        code,
        stdout: text(&out),
        stderr: text(&err),
        timed_out,
    })
}

#[cfg(not(unix))]
pub fn run_command(_: std::process::Command, _: std::time::Duration) -> Result<CliOutput, String> {
    Err("solo está implementado en Unix".into())
}

#[cfg(not(unix))]
pub fn run_cli(
    _: &Path,
    _: &Path,
    _: &[String],
    _: std::time::Duration,
) -> Result<CliOutput, String> {
    Err("la consola solo está implementada en Unix".into())
}

/// Starts `shepherd server` detached so it outlives this app, then waits until it answers `ping`.
#[cfg(unix)]
pub fn start_server(bin: &Path, socket: &Path) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    Command::new(bin)
        .arg("server")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("no se pudo ejecutar {}: {e}", bin.display()))?;
    for _ in 0..75 {
        std::thread::sleep(Duration::from_millis(200));
        if call(socket, "ping", json!({})).is_ok() {
            return Ok(());
        }
    }
    Err("el servidor no respondió tras arrancar".into())
}

#[cfg(not(unix))]
pub fn call(_: &Path, _: &str, _: Value) -> Result<Value, String> {
    Err("la conexión al servidor solo está implementada en Unix".into())
}

#[cfg(not(unix))]
#[allow(dead_code)] // the tests use it; the app subscribes through `read_subscriptions`
pub fn read_events(
    _: &Path,
    _: &[&str],
    _: &mut dyn FnMut(),
    _: &mut dyn FnMut(Value),
) -> Result<(), String> {
    Err("la conexión al servidor solo está implementada en Unix".into())
}

#[cfg(not(unix))]
pub fn read_subscriptions(
    _: &Path,
    _: Vec<Value>,
    _: &mut dyn FnMut(),
    _: &mut dyn FnMut(Value) -> bool,
) -> Result<(), String> {
    Err("la conexión al servidor solo está implementada en Unix".into())
}

#[cfg(not(unix))]
pub fn start_server(_: &Path, _: &Path) -> Result<(), String> {
    Err("la conexión al servidor solo está implementada en Unix".into())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    /// A one-connection fake server: checks the request line, then writes `replies` verbatim.
    fn fake_server(
        dir: &Path,
        expect_method: &'static str,
        replies: &'static [&'static str],
    ) -> (PathBuf, std::thread::JoinHandle<()>) {
        let path = dir.join("s.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut request)
                .unwrap();
            let request: Value = serde_json::from_str(&request).unwrap();
            assert_eq!(request["method"], expect_method);
            for reply in replies {
                stream.write_all(reply.as_bytes()).unwrap();
                stream.write_all(b"\n").unwrap();
            }
        });
        (path, handle)
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shepherd-desktop-api-{name}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn socket_is_read_from_status_output() {
        let text = "status: not running\nsocket: /home/u/.config/shepherd-dev/shepherd.sock\n";
        assert_eq!(
            socket_from_status(text),
            Some(PathBuf::from("/home/u/.config/shepherd-dev/shepherd.sock"))
        );
        assert_eq!(socket_from_status("status: running\n"), None);
    }

    #[test]
    fn status_subscriptions_cover_every_pane() {
        let snapshot = json!({"snapshot": {"panes": [{"pane_id": "w1:p1"}, {"pane_id": "w1:p2"}]}});
        assert_eq!(
            status_subscriptions(&snapshot),
            vec![
                json!({"type": "pane.agent_status_changed", "pane_id": "w1:p1"}),
                json!({"type": "pane.agent_status_changed", "pane_id": "w1:p2"}),
            ]
        );
        assert!(changes_panes(&json!({"event": "pane.created"})));
        assert!(!changes_panes(
            &json!({"event": "pane.agent_status_changed"})
        ));
    }

    #[test]
    fn call_returns_result_and_surfaces_server_errors() {
        let dir = temp("call");
        let (path, server) = fake_server(
            &dir,
            "pane.read",
            &[r#"{"id":"x","result":{"type":"pane_read","read":{"text":"hola"}}}"#],
        );
        let result = call(&path, "pane.read", json!({ "pane_id": "w1:p1" })).unwrap();
        server.join().unwrap();
        assert_eq!(result["read"]["text"], "hola");

        std::fs::remove_file(&path).unwrap();
        let (path, server) = fake_server(
            &dir,
            "pane.read",
            &[r#"{"id":"x","error":{"code":"pane_not_found","message":"no such pane"}}"#],
        );
        let err = call(&path, "pane.read", json!({})).unwrap_err();
        server.join().unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(err, "pane_not_found: no such pane");
    }

    #[test]
    fn call_reports_an_unreachable_server() {
        let err = call(Path::new("/nonexistent/shepherd.sock"), "ping", json!({})).unwrap_err();
        assert!(err.contains("no se pudo conectar"), "{err}");
    }

    #[test]
    fn events_are_forwarded_after_the_ack_and_end_on_close() {
        let dir = temp("events");
        let (path, server) = fake_server(
            &dir,
            "events.subscribe",
            &[
                r#"{"id":"s","result":{"type":"subscription_started"}}"#,
                r#"{"event":"workspace.created","data":{"n":1}}"#,
                r#"{"event":"pane.closed","data":{}}"#,
            ],
        );
        let (mut ready, mut seen) = (0, Vec::new());
        read_events(&path, EVENT_TYPES, &mut || ready += 1, &mut |e| {
            seen.push(e["event"].as_str().unwrap().to_string())
        })
        .unwrap();
        server.join().unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(ready, 1);
        assert_eq!(seen, ["workspace.created", "pane.closed"]);
    }

    #[test]
    fn a_rejected_subscription_is_an_error() {
        let dir = temp("events-lost");
        let (path, server) = fake_server(
            &dir,
            "events.subscribe",
            &[r#"{"id":"s","error":{"code":"events_lost","message":"too slow"}}"#],
        );
        let err = read_events(&path, EVENT_TYPES, &mut || {}, &mut |_| {}).unwrap_err();
        server.join().unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(err, "events_lost: too slow");
    }

    #[test]
    fn only_runtime_methods_are_allowed() {
        for ok in [
            "ping",
            "session.snapshot",
            "workspace.create",
            "tab.list",
            "pane.read",
            "pane.send_keys",
            "agent.start",
            "worktree.list",
            "layout.export",
            "shepherd.agent.spawn",
        ] {
            assert!(allowed_method(ok), "{ok}");
        }
        for no in [
            "server.stop",
            "plugin.pane.open",
            "integration.install",
            "events.subscribe",
            "pane.report_agent",
            "pane.release_agent",
            "client.window_title.set",
            "workspacex.list",
            "",
        ] {
            assert!(!allowed_method(no), "{no}");
        }
    }

    #[test]
    fn socket_path_follows_the_cli_resolution_order() {
        let cfg = Path::new("/home/u/.config/shepherd");
        assert_eq!(
            socket_path_from(Some("/tmp/x.sock"), Some("work"), cfg),
            Path::new("/tmp/x.sock")
        );
        assert_eq!(
            socket_path_from(None, Some("work"), cfg),
            Path::new("/home/u/.config/shepherd/sessions/work/shepherd.sock")
        );
        assert_eq!(
            socket_path_from(Some(""), None, cfg),
            Path::new("/home/u/.config/shepherd/shepherd.sock")
        );
    }

    #[test]
    fn server_binary_lookup_prefers_the_env_override_then_path_then_the_app_dir() {
        let dir = temp("bin");
        let (a, b) = (dir.join("a"), dir.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("shepherd"), "").unwrap();
        let path_env = std::env::join_paths([&a, &b]).unwrap();
        assert_eq!(
            find_server_bin(Some("/opt/shepherd"), Some(&path_env), None),
            Some(PathBuf::from("/opt/shepherd"))
        );
        assert_eq!(
            find_server_bin(None, Some(&path_env), None),
            Some(b.join("shepherd"))
        );
        assert_eq!(
            find_server_bin(None, None, Some(&b)),
            Some(b.join("shepherd"))
        );
        assert_eq!(
            find_server_bin(None, Some(&path_env), Some(&a)),
            Some(b.join("shepherd"))
        );
        assert_eq!(find_server_bin(None, None, Some(&a)), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn script(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-shepherd");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn cli_runs_without_a_shell_against_our_socket_and_reports_the_exit_code() {
        let dir = temp("cli");
        let bin = script(
            &dir,
            r#"echo "args: $*"; echo "socket=$SHEPHERD_SOCKET_PATH env=${SHEPHERD_ENV:-unset}"; echo oops >&2; exit 3"#,
        );
        // `; touch pwned` must stay a literal argument: nothing goes through a shell
        let args = [
            "workspace".to_string(),
            "rename".into(),
            "a; touch pwned".into(),
        ];
        let out = run_cli(
            &bin,
            Path::new("/tmp/x.sock"),
            &args,
            Duration::from_secs(5),
        )
        .unwrap();
        let pwned = dir.join("pwned").exists();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!((out.code, out.timed_out, pwned), (Some(3), false, false));
        assert_eq!(
            out.stdout,
            "args: workspace rename a; touch pwned\nsocket=/tmp/x.sock env=unset\n"
        );
        assert_eq!(out.stderr, "oops\n");
    }

    #[test]
    fn cli_is_killed_when_it_exceeds_the_timeout() {
        let dir = temp("cli-slow");
        let bin = script(&dir, "sleep 10");
        let started = std::time::Instant::now();
        let out = run_cli(
            &bin,
            Path::new("/tmp/x.sock"),
            &[],
            Duration::from_millis(200),
        )
        .unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(out.timed_out && out.code.is_none());
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn waiting_methods_get_a_longer_timeout_than_plain_ones() {
        assert_eq!(timeout_for("pane.read"), std::time::Duration::from_secs(10));
        assert!(timeout_for("agent.start") > timeout_for("pane.read"));
        assert!(timeout_for("shepherd.agent.spawn") > timeout_for("ping"));
    }

    #[test]
    fn only_runtime_cli_families_are_allowed() {
        let a = |v: &[&str]| allowed_cli(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        for ok in [
            &["workspace", "list"][..],
            &["pane", "read", "w1:p1"],
            &["agent", "list"],
            &["api", "snapshot"],
            &["status"],
            &["--version"],
            &["--help"],
        ] {
            assert!(a(ok), "{ok:?}");
        }
        for no in [
            &["server", "stop"][..],
            &["update"],
            &["channel", "set", "preview"],
            &["machine", "rm", "x"],
            &["config", "reset-keys"],
            &["integration", "install", "x"],
            &["--session", "x"],
            &["completion", "zsh"],
            &[],
        ] {
            assert!(!a(no), "{no:?}");
        }
    }

    /// Live check against a real server: `SHEPHERD_SOCKET_PATH=… cargo test -- --ignored live`.
    #[test]
    #[ignore]
    fn live_ping_and_snapshot() {
        let path = default_socket_path();
        assert_eq!(call(&path, "ping", json!({})).unwrap()["type"], "pong");
        assert_eq!(
            call(&path, "session.snapshot", json!({})).unwrap()["type"],
            "session_snapshot"
        );
    }
}
