use serde::Serialize;
use std::{
    fs,
    net::{IpAddr, UdpSocket},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const PORT: u16 = 6100;
const READY_MARKER: &str = "CrossLAN listening on";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchState {
    ready: bool,
    url: String,
    error: Option<String>,
}

struct RuntimeState {
    child: Option<CommandChild>,
    ready: bool,
    last_error: Option<String>,
    stdout_buffer: String,
    generation: u64,
    browser_opened: bool,
    service_host: String,
}

struct AppState {
    runtime: Mutex<RuntimeState>,
    exiting: AtomicBool,
}

impl AppState {
    fn new() -> Self {
        Self {
            runtime: Mutex::new(RuntimeState {
                child: None,
                ready: false,
                last_error: None,
                stdout_buffer: String::new(),
                generation: 0,
                browser_opened: false,
                service_host: "127.0.0.1".to_string(),
            }),
            exiting: AtomicBool::new(false),
        }
    }
}

#[tauri::command]
fn get_launch_state(state: State<'_, AppState>) -> Result<LaunchState, String> {
    launch_state(state.inner())
}

#[tauri::command]
fn restart_service(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<LaunchState, String> {
    stop_service(state.inner())?;
    start_service(&app, state.inner())?;
    launch_state(state.inner())
}

fn launch_state(state: &AppState) -> Result<LaunchState, String> {
    let runtime = state
        .runtime
        .lock()
        .map_err(|_| "CrossLAN service state is unavailable.".to_string())?;
    Ok(LaunchState {
        ready: runtime.ready,
        url: format!("http://{}:{PORT}", runtime.service_host),
        error: runtime.last_error.clone(),
    })
}

fn emit_launch_state(app: &AppHandle, state: &AppState) {
    if let Ok(snapshot) = launch_state(state) {
        let _ = app.emit("crosslan://launch-state", snapshot);
    }
}

fn set_launch_error(app: &AppHandle, state: &AppState, message: String) {
    if let Ok(mut runtime) = state.runtime.lock() {
        runtime.ready = false;
        runtime.last_error = Some(message);
    }
    emit_launch_state(app, state);
}

fn start_service(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let advertised_ip = std::env::var("CROSSLAN_ADVERTISED_IP")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(detect_lan_ip);
    let service_host = advertised_ip
        .clone()
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let generation = {
        let mut runtime = state
            .runtime
            .lock()
            .map_err(|_| "CrossLAN service state is unavailable.".to_string())?;
        if runtime.child.is_some() {
            return Ok(());
        }
        runtime.generation = runtime.generation.wrapping_add(1);
        runtime.ready = false;
        runtime.last_error = None;
        runtime.stdout_buffer.clear();
        runtime.browser_opened = false;
        runtime.service_host = service_host;
        runtime.generation
    };

    let save_dir = app
        .path()
        .download_dir()
        .map_err(error_message)?
        .join("CrossLAN");
    fs::create_dir_all(&save_dir).map_err(error_message)?;

    let client_dist = app
        .path()
        .resolve("client/dist", tauri::path::BaseDirectory::Resource)
        .map_err(error_message)?;
    let config_dir = app.path().app_config_dir().map_err(error_message)?;
    fs::create_dir_all(&config_dir).map_err(error_message)?;
    let log_dir = config_dir.join("logs");
    fs::create_dir_all(&log_dir).map_err(error_message)?;

    let sidecar = app
        .shell()
        .sidecar("crosslan-server")
        .map_err(error_message)?
        .env("PORT", PORT.to_string())
        .env("CROSSLAN_DEPLOYMENT", "node")
        .env("CROSSLAN_SAVE_DIR", save_dir)
        .env("CROSSLAN_CONFIG", config_dir.join("server-settings.json"))
        .env("CROSSLAN_CLIENT_DIST", client_dist)
        .env("CROSSLAN_LOG_FILE", log_dir.join("crosslan-server.log"))
        .env("MDNS_SERVICE_NAME", "CrossLAN");
    let sidecar = match advertised_ip {
        Some(ip) => sidecar.env("CROSSLAN_ADVERTISED_IP", ip),
        None => sidecar,
    };

    let (mut events, child) = sidecar.spawn().map_err(error_message)?;
    {
        let mut runtime = state
            .runtime
            .lock()
            .map_err(|_| "CrossLAN service state is unavailable.".to_string())?;
        runtime.child = Some(child);
    }
    emit_launch_state(app, state);

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    handle_stdout(&app_handle, generation, &bytes);
                }
                CommandEvent::Stderr(bytes) => {
                    handle_stderr(&app_handle, generation, &bytes);
                }
                CommandEvent::Error(error) => {
                    let state = app_handle.state::<AppState>();
                    set_launch_error(
                        &app_handle,
                        state.inner(),
                        format!("CrossLAN service error: {error}"),
                    );
                }
                CommandEvent::Terminated(payload) => {
                    handle_termination(&app_handle, generation, payload.code);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

fn handle_stdout(app: &AppHandle, generation: u64, bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes);
    let state = app.state::<AppState>();
    let mut became_ready = false;

    if let Ok(mut runtime) = state.runtime.lock() {
        if runtime.generation != generation {
            return;
        }
        runtime.stdout_buffer.push_str(&text);
        if runtime.stdout_buffer.len() > 16 * 1024 {
            let keep_from = runtime.stdout_buffer.len() - 8 * 1024;
            runtime.stdout_buffer.drain(..keep_from);
        }
        if !runtime.ready && runtime.stdout_buffer.contains(READY_MARKER) {
            runtime.ready = true;
            runtime.last_error = None;
            became_ready = true;
        }
    }

    if became_ready {
        let url = launch_state(state.inner())
            .map(|snapshot| snapshot.url)
            .unwrap_or_else(|_| format!("http://127.0.0.1:{PORT}"));
        if let Err(error) = open_browser(app, &url) {
            set_launch_error(app, state.inner(), format!("Unable to open browser: {error}"));
            show_main_window(app);
            return;
        }
        if let Ok(mut runtime) = state.runtime.lock() {
            if runtime.generation == generation {
                runtime.browser_opened = true;
            }
        }
        hide_main_window(app);
    }
}

fn handle_stderr(app: &AppHandle, generation: u64, bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes);
    let Some(line) = text.lines().rev().find(|line| !line.trim().is_empty()) else {
        return;
    };
    let state = app.state::<AppState>();
    if let Ok(mut runtime) = state.runtime.lock() {
        if runtime.generation == generation && !runtime.ready {
            runtime.last_error = Some(line.trim().to_string());
        }
    };
}

fn handle_termination(app: &AppHandle, generation: u64, exit_code: Option<i32>) {
    let state = app.state::<AppState>();
    let mut was_ready = false;
    let mut should_emit = false;

    if let Ok(mut runtime) = state.runtime.lock() {
        if runtime.generation != generation {
            return;
        }
        was_ready = runtime.ready;
        runtime.child = None;
        runtime.ready = false;
        if !state.exiting.load(Ordering::SeqCst) {
            if runtime.last_error.is_none() {
                runtime.last_error = Some(match exit_code {
                    Some(code) => format!("CrossLAN service exited with code {code}."),
                    None => "CrossLAN service stopped unexpectedly.".to_string(),
                });
            }
            should_emit = true;
        }
    }

    if state.exiting.load(Ordering::SeqCst) {
        return;
    }
    if was_ready {
        app.exit(exit_code.unwrap_or(1));
    } else if should_emit {
        emit_launch_state(app, state.inner());
    }
}

fn stop_service(state: &AppState) -> Result<(), String> {
    let child = {
        let mut runtime = state
            .runtime
            .lock()
            .map_err(|_| "CrossLAN service state is unavailable.".to_string())?;
        runtime.generation = runtime.generation.wrapping_add(1);
        runtime.ready = false;
        runtime.stdout_buffer.clear();
        runtime.browser_opened = false;
        runtime.child.take()
    };

    if let Some(child) = child {
        child.kill().map_err(error_message)?;
    }
    Ok(())
}

fn open_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    app.shell()
        .open(url.to_string(), None)
        .map_err(error_message)
}

fn detect_lan_ip() -> Option<String> {
    // UDP connect performs route selection without sending application data.
    // The selected local address is normally the physical LAN adapter, not a
    // Docker/WSL/VM virtual interface.
    let socket = UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    socket.connect(("8.8.8.8", 80)).ok()?;
    let address = socket.local_addr().ok()?.ip();
    match address {
        IpAddr::V4(ip) if !ip.is_loopback() && ip.octets()[0..2] != [169, 254] => {
            Some(ip.to_string())
        }
        _ => None,
    }
}

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn error_message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let state = app.state::<AppState>();
            if let Ok(runtime) = state.runtime.lock() {
                if runtime.ready {
                    let url = format!("http://{}:{PORT}", runtime.service_host);
                    let _ = open_browser(app, &url);
                    return;
                }
            }
            show_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_launch_state, restart_service])
        .setup(|app| {
            app.manage(AppState::new());
            let state = app.state::<AppState>();
            hide_main_window(app.handle());
            if let Err(error) = start_service(app.handle(), state.inner()) {
                set_launch_error(app.handle(), state.inner(), error);
                show_main_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<AppState>();
                state.exiting.store(true, Ordering::SeqCst);
                let _ = stop_service(state.inner());
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build CrossLAN desktop application");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { .. } = event {
            let state = app.state::<AppState>();
            state.exiting.store(true, Ordering::SeqCst);
            let _ = stop_service(state.inner());
        }
    });
}
