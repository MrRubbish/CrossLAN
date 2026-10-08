use network_interface::{Addr, NetworkInterface, NetworkInterfaceConfig};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    net::{IpAddr, SocketAddr, TcpStream, UdpSocket},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, MenuEvent, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, State, WindowEvent,
};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;

const DEFAULT_PORT: u16 = 6100;
const READY_MARKER: &str = "CrossLAN listening on";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(12);
const SERVICE_RELOCATION_GRACE: Duration = Duration::from_millis(1500);
const TRAY_ID: &str = "main";
const TRAY_OPEN_FRONTEND: &str = "open-frontend";
const TRAY_CONFIG: &str = "config";
const TRAY_OPEN_LOGS: &str = "open-logs";
const TRAY_TOGGLE_SERVICE: &str = "toggle-service";
const TRAY_AUTOSTART: &str = "autostart";
const TRAY_QUIT: &str = "quit";
const DESKTOP_SESSION_CLOSED_MARKER: &str = "CrossLAN desktop session closed";
const DESKTOP_PAGE_CLOSED_MARKER: &str = "CrossLAN desktop page closed";
const DESKTOP_PAGE_CLAIMED_MARKER: &str = "CrossLAN desktop page claimed";
const DESKTOP_CONFIG_FILE: &str = "desktop.json";

#[derive(Clone, Copy)]
enum UiLocale {
    ZhCn,
    EnUs,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopConfig {
    port: u16,
    save_dir: String,
    #[serde(default = "default_network_adapter")]
    network_adapter: String,
    #[serde(default = "default_locale_preference")]
    locale: String,
    #[serde(default = "default_theme_preference")]
    theme: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkAdapter {
    id: String,
    name: String,
    ip: String,
}

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
    open_browser_on_ready: bool,
    service_host: String,
    desktop_session_token: String,
    desktop_session_closed: bool,
}

struct AppState {
    config: Mutex<DesktopConfig>,
    runtime: Mutex<RuntimeState>,
    exiting: AtomicBool,
}

impl AppState {
    fn new(config: DesktopConfig) -> Self {
        Self {
            config: Mutex::new(config),
            runtime: Mutex::new(RuntimeState {
                child: None,
                ready: false,
                last_error: None,
                stdout_buffer: String::new(),
                generation: 0,
                browser_opened: false,
                open_browser_on_ready: false,
                service_host: "127.0.0.1".to_string(),
                desktop_session_token: String::new(),
                desktop_session_closed: false,
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
    start_service(&app, state.inner(), true)?;
    launch_state(state.inner())
}

#[tauri::command]
fn get_desktop_config(state: State<'_, AppState>) -> Result<DesktopConfig, String> {
    state
        .config
        .lock()
        .map_err(|_| "CrossLAN configuration is unavailable.".to_string())
        .map(|config| config.clone())
}

#[tauri::command]
fn list_network_adapters() -> Result<Vec<NetworkAdapter>, String> {
    available_network_adapters()
}

#[tauri::command]
fn save_desktop_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: DesktopConfig,
) -> Result<LaunchState, String> {
    let config = validate_config(config)?;
    let previous = state
        .config
        .lock()
        .map_err(|_| "CrossLAN configuration is unavailable.".to_string())?
        .clone();
    if config.network_adapter != "auto" {
        selected_network_adapter_ip(
            &config.network_adapter,
            locale_from_preference(&config.locale),
        )?;
    }
    let next_service_host = configured_service_host(&config)?;
    let configured_service_changed = previous.port != config.port
        || previous.save_dir != config.save_dir
        || previous.network_adapter != config.network_adapter;
    persist_desktop_config(&app, &config)?;

    let (was_running, browser_was_open, current_service_host, session_token) = state
        .runtime
        .lock()
        .map_err(|_| "CrossLAN service state is unavailable.".to_string())
        .map(|runtime| {
            (
                runtime.child.is_some(),
                runtime.browser_opened,
                runtime.service_host.clone(),
                runtime.desktop_session_token.clone(),
            )
        })?;
    let endpoint_changed = previous.port != config.port
        || current_service_host != next_service_host;
    let service_config_changed = configured_service_changed || endpoint_changed;
    let relocation_notified = was_running
        && endpoint_changed
        && !session_token.is_empty()
        && notify_service_relocation(
            &current_service_host,
            previous.port,
            &session_token,
            &format_frontend_url(&next_service_host, config.port, ""),
            SERVICE_RELOCATION_GRACE,
        );
    if relocation_notified {
        std::thread::sleep(SERVICE_RELOCATION_GRACE);
    }
    if was_running && service_config_changed {
        stop_service(state.inner())?;
    }
    {
        let mut current = state
            .config
            .lock()
            .map_err(|_| "CrossLAN configuration is unavailable.".to_string())?;
        *current = config;
    }

    if was_running {
        if service_config_changed {
            start_service(
                &app,
                state.inner(),
                !(relocation_notified && browser_was_open),
            )?;
        } else {
            open_frontend(&app)?;
        }
    } else {
        hide_main_window(&app);
    }
    emit_launch_state(&app, state.inner());
    launch_state(state.inner())
}

#[tauri::command]
fn quit_app(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.exiting.store(true, Ordering::SeqCst);
    let _ = stop_service(state.inner());
    app.exit(0);
    Ok(())
}

fn launch_state(state: &AppState) -> Result<LaunchState, String> {
    let port = state
        .config
        .lock()
        .map_err(|_| "CrossLAN configuration is unavailable.".to_string())?
        .port;
    let runtime = state
        .runtime
        .lock()
        .map_err(|_| "CrossLAN service state is unavailable.".to_string())?;
    Ok(LaunchState {
        ready: runtime.ready,
        url: format_frontend_url(
            runtime.service_host.as_str(),
            port,
            runtime.desktop_session_token.as_str(),
        ),
        error: runtime.last_error.clone(),
    })
}

fn emit_launch_state(app: &AppHandle, state: &AppState) {
    if let Ok(snapshot) = launch_state(state) {
        let _ = app.emit("crosslan://launch-state", snapshot);
    }
    refresh_tray(app);
}

fn default_locale_preference() -> String {
    "system".to_string()
}

fn default_theme_preference() -> String {
    "system".to_string()
}

fn default_network_adapter() -> String {
    "auto".to_string()
}

fn current_ui_locale(app: &AppHandle) -> UiLocale {
    app.state::<AppState>()
        .config
        .lock()
        .map(|config| locale_from_preference(&config.locale))
        .unwrap_or_else(|_| system_ui_locale())
}

fn locale_from_preference(preference: &str) -> UiLocale {
    match preference {
        "zh-CN" => UiLocale::ZhCn,
        "en-US" => UiLocale::EnUs,
        _ => system_ui_locale(),
    }
}

fn normalize_locale_preference(preference: String) -> String {
    match preference.as_str() {
        "zh-CN" | "en-US" | "system" => preference,
        _ => default_locale_preference(),
    }
}

#[cfg(target_os = "windows")]
fn system_ui_locale() -> UiLocale {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetUserDefaultUILanguage() -> u16;
    }

    const PRIMARY_LANGUAGE_MASK: u16 = 0x03ff;
    const PRIMARY_LANGUAGE_CHINESE: u16 = 0x0004;
    let language = unsafe { GetUserDefaultUILanguage() };
    if language & PRIMARY_LANGUAGE_MASK == PRIMARY_LANGUAGE_CHINESE {
        UiLocale::ZhCn
    } else {
        UiLocale::EnUs
    }
}

#[cfg(not(target_os = "windows"))]
fn system_ui_locale() -> UiLocale {
    let locale = std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_default()
        .to_ascii_lowercase();
    if locale.starts_with("zh") {
        UiLocale::ZhCn
    } else {
        UiLocale::EnUs
    }
}

fn tr(locale: UiLocale, key: &str) -> &'static str {
    match (locale, key) {
        (UiLocale::ZhCn, "service_running") => "服务运行中",
        (UiLocale::EnUs, "service_running") => "Service running",
        (UiLocale::ZhCn, "service_starting") => "服务启动中...",
        (UiLocale::EnUs, "service_starting") => "Starting service...",
        (UiLocale::ZhCn, "service_error") => "服务错误",
        (UiLocale::EnUs, "service_error") => "Service error",
        (UiLocale::ZhCn, "service_stopped") => "服务已停止",
        (UiLocale::EnUs, "service_stopped") => "Service stopped",
        (UiLocale::ZhCn, "open_frontend") => "打开前端",
        (UiLocale::EnUs, "open_frontend") => "Open Web UI",
        (UiLocale::ZhCn, "settings") => "修改配置",
        (UiLocale::EnUs, "settings") => "Settings",
        (UiLocale::ZhCn, "open_logs") => "打开日志文件夹",
        (UiLocale::EnUs, "open_logs") => "Open Log Folder",
        (UiLocale::ZhCn, "start_service") => "启动服务",
        (UiLocale::EnUs, "start_service") => "Start service",
        (UiLocale::ZhCn, "stop_service") => "停止服务",
        (UiLocale::EnUs, "stop_service") => "Stop service",
        (UiLocale::ZhCn, "autostart") => "开机启动",
        (UiLocale::EnUs, "autostart") => "Start with Windows",
        (UiLocale::ZhCn, "quit") => "退出",
        (UiLocale::EnUs, "quit") => "Quit",
        (UiLocale::ZhCn, "autostart_failed") => "开机启动设置失败",
        (UiLocale::EnUs, "autostart_failed") => "Failed to update startup setting",
        (UiLocale::ZhCn, "port_invalid") => "端口必须在 1024 到 65535 之间。",
        (UiLocale::EnUs, "port_invalid") => "The port must be between 1024 and 65535.",
        (UiLocale::ZhCn, "unsafe_port") => "Chromium 浏览器会阻止 6000 端口，请使用其他端口。",
        (UiLocale::EnUs, "unsafe_port") => {
            "Chromium-based browsers block port 6000. Please choose another port."
        }
        (UiLocale::ZhCn, "save_dir_empty") => "默认保存目录不能为空。",
        (UiLocale::EnUs, "save_dir_empty") => "The default save directory cannot be empty.",
        (UiLocale::ZhCn, "adapter_unavailable") => "所选网卡当前不可用",
        (UiLocale::EnUs, "adapter_unavailable") => {
            "The selected network adapter is unavailable"
        }
        (UiLocale::ZhCn, "startup_timeout") => "CrossLAN 服务启动超时，请重试或查看错误日志。",
        (UiLocale::EnUs, "startup_timeout") => {
            "CrossLAN service startup timed out. Retry or check the error log."
        }
        _ => "",
    }
}

fn set_launch_error(app: &AppHandle, state: &AppState, message: String) {
    append_desktop_error(app, &message);
    if let Ok(mut runtime) = state.runtime.lock() {
        runtime.ready = false;
        runtime.last_error = Some(message);
    }
    emit_launch_state(app, state);
}

fn set_runtime_error(app: &AppHandle, state: &AppState, message: String) {
    append_desktop_error(app, &message);
    if let Ok(mut runtime) = state.runtime.lock() {
        runtime.last_error = Some(message);
    }
    emit_launch_state(app, state);
}

fn start_service(
    app: &AppHandle,
    state: &AppState,
    open_browser_on_ready: bool,
) -> Result<(), String> {
    let config = state
        .config
        .lock()
        .map_err(|_| "CrossLAN configuration is unavailable.".to_string())?
        .clone();
    let port = config.port;
    let advertised_ip = match std::env::var("CROSSLAN_ADVERTISED_IP")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        Some(ip) => Some(ip),
        None => selected_network_adapter_ip(
            &config.network_adapter,
            locale_from_preference(&config.locale),
        )?,
    };
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
        runtime.open_browser_on_ready = open_browser_on_ready;
        if runtime.desktop_session_token.is_empty() {
            runtime.desktop_session_token = create_session_token(runtime.generation);
        }
        runtime.desktop_session_closed = false;
        runtime.service_host = service_host.clone();
        runtime.generation
    };

    let save_dir = PathBuf::from(config.save_dir);
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
        .env("PORT", port.to_string())
        .env("CROSSLAN_DEPLOYMENT", "node")
        .env("CROSSLAN_DESKTOP_MANAGED", "1")
        .env("CROSSLAN_SAVE_DIR", save_dir)
        .env("CROSSLAN_CONFIG", config_dir.join("server-settings.json"))
        .env("CROSSLAN_CLIENT_DIST", client_dist)
        .env("CROSSLAN_DESKTOP_SESSION_TOKEN", {
            let runtime = state
                .runtime
                .lock()
                .map_err(|_| "CrossLAN service state is unavailable.".to_string())?;
            runtime.desktop_session_token.clone()
        })
        .env("CROSSLAN_LOG_FILE", log_dir.join("crosslan-server.log"))
        .env("MDNS_SERVICE_NAME", "CrossLAN");
    let sidecar = match advertised_ip {
        Some(ip) => sidecar
            .env("CROSSLAN_ADVERTISED_IP", ip.clone())
            .env("CROSSLAN_BIND_HOST", ip),
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

    let watchdog_app = app.clone();
    let watchdog_host = service_host;
    std::thread::spawn(move || {
        monitor_service_startup(watchdog_app, generation, watchdog_host, port)
    });

    Ok(())
}

fn monitor_service_startup(app: AppHandle, generation: u64, host: String, port: u16) {
    let deadline = std::time::Instant::now() + STARTUP_TIMEOUT;
    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(150));
        let state = app.state::<AppState>();
        let pending = state
            .runtime
            .lock()
            .map(|runtime| {
                runtime.generation == generation && runtime.child.is_some() && !runtime.ready
            })
            .unwrap_or(false);
        if !pending {
            return;
        }
        if probe_crosslan_health(&host, port) {
            handle_stdout(&app, generation, READY_MARKER.as_bytes());
            return;
        }
    }

    let state = app.state::<AppState>();
    let (should_timeout, child) = state
        .runtime
        .lock()
        .map(|mut runtime| {
            if runtime.generation != generation || runtime.ready || runtime.child.is_none() {
                return (false, None);
            }
            (true, runtime.child.take())
        })
        .unwrap_or((false, None));
    if !should_timeout {
        return;
    }
    if let Some(child) = child {
        let _ = child.kill();
    }
    let locale = current_ui_locale(&app);
    set_launch_error(
        &app,
        state.inner(),
        tr(locale, "startup_timeout").to_string(),
    );
    show_main_window(&app);
}

fn handle_stdout(app: &AppHandle, generation: u64, bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes);
    let state = app.state::<AppState>();
    let mut became_ready = false;
    let mut should_open_browser = false;

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
            should_open_browser = runtime.open_browser_on_ready;
        }
        if text.contains(DESKTOP_SESSION_CLOSED_MARKER) {
            runtime.desktop_session_closed = true;
        }
        if text.contains(DESKTOP_PAGE_CLOSED_MARKER) {
            runtime.browser_opened = false;
        }
        if text.contains(DESKTOP_PAGE_CLAIMED_MARKER) {
            runtime.browser_opened = true;
        }
    }

    if became_ready {
        emit_launch_state(app, state.inner());
        if should_open_browser {
            let url = launch_state(state.inner())
                .map(|snapshot| snapshot.url)
                .unwrap_or_else(|_| {
                    let port = state
                        .config
                        .lock()
                        .map(|config| config.port)
                        .unwrap_or(DEFAULT_PORT);
                    format!("http://127.0.0.1:{port}")
                });
            if let Err(error) = open_browser(app, &url) {
                set_launch_error(app, state.inner(), format!("Unable to open browser: {error}"));
                show_main_window(app);
                return;
            }
            if let Ok(mut runtime) = state.runtime.lock() {
                if runtime.generation == generation {
                    runtime.browser_opened = true;
                    runtime.open_browser_on_ready = false;
                }
            }
        }
        // A settings-triggered restart reuses and redirects the existing browser
        // page, so it deliberately does not open another tab. The launcher must
        // still close once the replacement service is healthy.
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
    let mut should_emit = false;
    let mut desktop_session_closed = false;
    let mut error_to_log = None;

    if let Ok(mut runtime) = state.runtime.lock() {
        if runtime.generation != generation {
            return;
        }
        desktop_session_closed = runtime.desktop_session_closed;
        runtime.child = None;
        runtime.ready = false;
        runtime.open_browser_on_ready = false;
        runtime.desktop_session_closed = false;
        if !state.exiting.load(Ordering::SeqCst) {
            if runtime.last_error.is_none() {
                let message = match exit_code {
                    Some(code) => format!("CrossLAN service exited with code {code}."),
                    None => "CrossLAN service stopped unexpectedly.".to_string(),
                };
                runtime.last_error = Some(message.clone());
                error_to_log = Some(message);
            }
            should_emit = true;
        }
    }

    if state.exiting.load(Ordering::SeqCst) {
        return;
    }
    if desktop_session_closed {
        state.exiting.store(true, Ordering::SeqCst);
        app.exit(0);
        return;
    }
    if should_emit {
        if let Some(error) = error_to_log {
            append_desktop_error(app, &error);
        }
        emit_launch_state(app, state.inner());
    }
}

fn stop_service(state: &AppState) -> Result<(), String> {
    let port = state
        .config
        .lock()
        .map_err(|_| "CrossLAN configuration is unavailable.".to_string())?
        .port;
    let (child, token, service_host) = {
        let mut runtime = state
            .runtime
            .lock()
            .map_err(|_| "CrossLAN service state is unavailable.".to_string())?;
        runtime.generation = runtime.generation.wrapping_add(1);
        runtime.ready = false;
        runtime.last_error = None;
        runtime.stdout_buffer.clear();
        runtime.browser_opened = false;
        runtime.open_browser_on_ready = false;
        runtime.desktop_session_closed = false;
        (
            runtime.child.take(),
            runtime.desktop_session_token.clone(),
            runtime.service_host.clone(),
        )
    };

    if child.is_some() && !token.is_empty() {
        notify_desktop_session_termination(&service_host, port, &token);
    }
    if let Some(child) = child {
        child.kill().map_err(error_message)?;
        wait_for_port_release(&service_host, port, Duration::from_secs(2));
    }
    Ok(())
}

fn open_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    app.shell()
        .open(url.to_string(), None)
        .map_err(error_message)
}

fn open_log_folder(app: &AppHandle) -> Result<(), String> {
    let log_dir = app
        .path()
        .app_config_dir()
        .map_err(error_message)?
        .join("logs");
    fs::create_dir_all(&log_dir).map_err(error_message)?;
    app.shell()
        .open(log_dir.to_string_lossy().into_owned(), None)
        .map_err(error_message)
}

fn append_desktop_error(app: &AppHandle, message: &str) {
    let Ok(config_dir) = app.path().app_config_dir() else {
        return;
    };
    let log_dir = config_dir.join("logs");
    if fs::create_dir_all(&log_dir).is_err() {
        return;
    }
    let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("crosslan-server.log"))
    else {
        return;
    };
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let _ = writeln!(file, "[{timestamp}] [ERROR] {message}");
}

fn create_tray_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let state = app.state::<AppState>();
    let locale = current_ui_locale(app);
    let (ready, running, service_host, last_error) = {
        let runtime = state
            .runtime
            .lock()
            .map_err(|_| "CrossLAN service state is unavailable.".to_string())?;
        (
            runtime.ready,
            runtime.child.is_some(),
            runtime.service_host.clone(),
            runtime.last_error.clone(),
        )
    };
    let port = app
        .state::<AppState>()
        .config
        .lock()
        .map(|config| config.port)
        .unwrap_or(DEFAULT_PORT);
    let status = if ready {
        format!("{} · {service_host}:{port}", tr(locale, "service_running"))
    } else if running {
        tr(locale, "service_starting").to_string()
    } else if let Some(error) = last_error {
        format!(
            "{} · {}",
            tr(locale, "service_error"),
            truncate_menu_text(&error)
        )
    } else {
        tr(locale, "service_stopped").to_string()
    };
    let service_action = if running {
        tr(locale, "stop_service")
    } else {
        tr(locale, "start_service")
    };
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);

    let status_item = MenuItem::with_id(app, "service-status", status, false, None::<&str>)
        .map_err(error_message)?;
    let open_item = MenuItem::with_id(
        app,
        TRAY_OPEN_FRONTEND,
        tr(locale, "open_frontend"),
        true,
        None::<&str>,
    )
    .map_err(error_message)?;
    let config_item = MenuItem::with_id(
        app,
        TRAY_CONFIG,
        tr(locale, "settings"),
        true,
        None::<&str>,
    )
    .map_err(error_message)?;
    let logs_item = MenuItem::with_id(
        app,
        TRAY_OPEN_LOGS,
        tr(locale, "open_logs"),
        true,
        None::<&str>,
    )
    .map_err(error_message)?;
    let service_item =
        MenuItem::with_id(app, TRAY_TOGGLE_SERVICE, service_action, true, None::<&str>)
            .map_err(error_message)?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        TRAY_AUTOSTART,
        tr(locale, "autostart"),
        true,
        autostart_enabled,
        None::<&str>,
    )
    .map_err(error_message)?;
    let separator = PredefinedMenuItem::separator(app).map_err(error_message)?;
    let quit_item =
        MenuItem::with_id(app, TRAY_QUIT, tr(locale, "quit"), true, None::<&str>)
            .map_err(error_message)?;

    Menu::with_items(
        app,
        &[
            &status_item,
            &open_item,
            &config_item,
            &logs_item,
            &service_item,
            &autostart_item,
            &separator,
            &quit_item,
        ],
    )
    .map_err(error_message)
}

fn truncate_menu_text(value: &str) -> String {
    const MAX_CHARS: usize = 42;
    let mut chars = value.chars();
    let text: String = chars.by_ref().take(MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{text}...")
    } else {
        text
    }
}

fn refresh_tray(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if let Ok(menu) = create_tray_menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn setup_tray(app: &AppHandle) -> Result<(), String> {
    let menu = create_tray_menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("CrossLAN")
        .show_menu_on_left_click(false)
        .on_menu_event(handle_tray_menu)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = open_frontend(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app).map_err(error_message)?;
    Ok(())
}

fn handle_tray_menu(app: &AppHandle, event: MenuEvent) {
    let id = event.id();
    if id == TRAY_OPEN_FRONTEND {
        if let Err(error) = open_frontend(app) {
            let state = app.state::<AppState>();
            set_runtime_error(app, state.inner(), format!("Unable to open browser: {error}"));
            show_main_window(app);
        }
        return;
    }

    if id == TRAY_CONFIG {
        let _ = app.emit("crosslan://open-config", ());
        show_main_window(app);
        return;
    }


    if id == TRAY_OPEN_LOGS {
        if let Err(error) = open_log_folder(app) {
            let state = app.state::<AppState>();
            set_runtime_error(app, state.inner(), error);
            show_main_window(app);
        }
        return;
    }

    if id == TRAY_TOGGLE_SERVICE {
        let state = app.state::<AppState>();
        let running = state
            .runtime
            .lock()
            .map(|runtime| runtime.child.is_some())
            .unwrap_or(false);
        let result = if running {
            stop_service(state.inner())
        } else {
            start_service(app, state.inner(), false)
        };
        if let Err(error) = result {
            set_launch_error(app, state.inner(), error);
            show_main_window(app);
        } else {
            emit_launch_state(app, state.inner());
        }
        return;
    }

    if id == TRAY_AUTOSTART {
        let result = match app.autolaunch().is_enabled() {
            Ok(true) => app.autolaunch().disable(),
            Ok(false) => app.autolaunch().enable(),
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            let state = app.state::<AppState>();
            let locale = current_ui_locale(app);
            set_runtime_error(
                app,
                state.inner(),
                format!("{}: {error}", tr(locale, "autostart_failed")),
            );
            show_main_window(app);
        } else {
            refresh_tray(app);
        }
        return;
    }

    if id == TRAY_QUIT {
        let _ = quit_app(app.clone(), app.state::<AppState>());
    }
}

fn open_frontend(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let port = state
        .config
        .lock()
        .map_err(|_| "CrossLAN configuration is unavailable.".to_string())?
        .port;
    let (ready, running, browser_opened, url) = {
        let runtime = state
            .runtime
            .lock()
            .map_err(|_| "CrossLAN service state is unavailable.".to_string())?;
        (
            runtime.ready,
            runtime.child.is_some(),
            runtime.browser_opened,
            format_frontend_url(
                runtime.service_host.as_str(),
                port,
                runtime.desktop_session_token.as_str(),
            ),
        )
    };

    if ready {
        if browser_opened {
            hide_main_window(app);
            return Ok(());
        }
        open_browser(app, &url)?;
        if let Ok(mut runtime) = state.runtime.lock() {
            runtime.browser_opened = true;
            runtime.open_browser_on_ready = false;
        }
        hide_main_window(app);
        return Ok(());
    }

    if running {
        if let Ok(mut runtime) = state.runtime.lock() {
            runtime.open_browser_on_ready = true;
        }
        return Ok(());
    }

    start_service(app, state.inner(), true)
}

fn launched_from_autostart() -> bool {
    std::env::args().any(|argument| argument == "--autostart")
}

fn format_frontend_url(host: &str, port: u16, token: &str) -> String {
    let base = format!("http://{host}:{port}/");
    if token.is_empty() {
        base
    } else {
        format!("{base}?crosslanDesktopToken={token}")
    }
}

fn create_session_token(generation: u64) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{nanos:x}-{:x}-{generation:x}", std::process::id())
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


fn available_network_adapters() -> Result<Vec<NetworkAdapter>, String> {
    let interfaces = NetworkInterface::show().map_err(error_message)?;
    let mut adapters = Vec::new();
    for interface in interfaces {
        let Some(ip) = interface.addr.iter().find_map(|address| match address {
            Addr::V4(value) if is_usable_lan_ipv4(value.ip) => Some(value.ip),
            _ => None,
        }) else {
            continue;
        };
        let id = interface
            .mac_addr
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or(&interface.name)
            .to_string();
        adapters.push(NetworkAdapter {
            id,
            name: interface.name,
            ip: ip.to_string(),
        });
    }
    adapters.sort_by(|left, right| left.name.cmp(&right.name).then(left.ip.cmp(&right.ip)));
    adapters.dedup_by(|left, right| left.id == right.id);
    Ok(adapters)
}

fn selected_network_adapter_ip(
    selection: &str,
    locale: UiLocale,
) -> Result<Option<String>, String> {
    if selection == "auto" || selection.is_empty() {
        return Ok(detect_lan_ip());
    }
    available_network_adapters()?
        .into_iter()
        .find(|adapter| adapter.id == selection)
        .map(|adapter| Some(adapter.ip))
        .ok_or_else(|| format!("{}: {selection}", tr(locale, "adapter_unavailable")))
}

fn configured_service_host(config: &DesktopConfig) -> Result<String, String> {
    if let Some(ip) = std::env::var("CROSSLAN_ADVERTISED_IP")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(ip);
    }
    Ok(selected_network_adapter_ip(
        &config.network_adapter,
        locale_from_preference(&config.locale),
    )?
    .unwrap_or_else(|| "127.0.0.1".to_string()))
}

fn is_usable_lan_ipv4(ip: std::net::Ipv4Addr) -> bool {
    !ip.is_loopback() && !ip.is_unspecified() && !ip.is_link_local() && !ip.is_multicast()
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

fn default_desktop_config(app: &AppHandle) -> DesktopConfig {
    let save_dir = app
        .path()
        .download_dir()
        .map(|path| path.join("CrossLAN"))
        .unwrap_or_else(|_| PathBuf::from("CrossLAN"));
    DesktopConfig {
        port: DEFAULT_PORT,
        save_dir: save_dir.to_string_lossy().into_owned(),
        network_adapter: default_network_adapter(),
        locale: default_locale_preference(),
        theme: default_theme_preference(),
    }
}

fn load_desktop_config(app: &AppHandle) -> DesktopConfig {
    let fallback = default_desktop_config(app);
    let Ok(config_dir) = app.path().app_config_dir() else {
        return fallback;
    };
    let Ok(text) = fs::read_to_string(config_dir.join(DESKTOP_CONFIG_FILE)) else {
        return fallback;
    };
    serde_json::from_str::<DesktopConfig>(&text)
        .ok()
        .and_then(|config| validate_config(config).ok())
        .unwrap_or(fallback)
}

fn persist_desktop_config(app: &AppHandle, config: &DesktopConfig) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(error_message)?;
    fs::create_dir_all(&config_dir).map_err(error_message)?;
    let text = serde_json::to_string_pretty(config).map_err(error_message)?;
    fs::write(config_dir.join(DESKTOP_CONFIG_FILE), text).map_err(error_message)
}

fn validate_config(mut config: DesktopConfig) -> Result<DesktopConfig, String> {
    config.locale = normalize_locale_preference(config.locale);
    config.theme = match config.theme.as_str() {
        "system" | "light" | "dark" => config.theme,
        _ => default_theme_preference(),
    };
    config.network_adapter = config.network_adapter.trim().to_string();
    if config.network_adapter.is_empty() {
        config.network_adapter = default_network_adapter();
    }
    let locale = locale_from_preference(&config.locale);
    if config.port < 1024 {
        return Err(tr(locale, "port_invalid").to_string());
    }
    if config.port == 6000 {
        return Err(tr(locale, "unsafe_port").to_string());
    }
    config.save_dir = config.save_dir.trim().to_string();
    if config.save_dir.is_empty() {
        return Err(tr(locale, "save_dir_empty").to_string());
    }
    Ok(config)
}

fn notify_desktop_session_termination(host: &str, port: u16, token: &str) {
    let Some(address) = socket_address(host, port) else {
        return;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else {
        return;
    };
    let body = format!(r#"{{"token":"{token}"}}"#);
    let request = format!(
        "POST /api/desktop/session/terminate HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(700)));
    if stream.write_all(request.as_bytes()).is_err() {
        return;
    }
    let mut response = [0_u8; 256];
    let _ = stream.read(&mut response);
}

fn notify_service_relocation(
    host: &str,
    port: u16,
    token: &str,
    target_url: &str,
    grace: Duration,
) -> bool {
    let Some(address) = socket_address(host, port) else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else {
        return false;
    };
    let body = serde_json::json!({
        "token": token,
        "targetUrl": target_url,
        "delayMs": grace.as_millis() as u64
    })
    .to_string();
    let request = format!(
        "POST /api/desktop/service/relocate HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.set_read_timeout(Some(Duration::from_millis(900)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(700)));
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = [0_u8; 512];
    let Ok(bytes_read) = stream.read(&mut response) else {
        return false;
    };
    String::from_utf8_lossy(&response[..bytes_read]).starts_with("HTTP/1.1 200")
}

fn probe_crosslan_health(host: &str, port: u16) -> bool {
    let Some(address) = socket_address(host, port) else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(120)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(120)));
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = [0_u8; 1024];
    let Ok(bytes_read) = stream.read(&mut response) else {
        return false;
    };
    let response = String::from_utf8_lossy(&response[..bytes_read]);
    response.starts_with("HTTP/1.1 200") && response.contains("\"name\":\"CrossLAN\"")
}

fn wait_for_port_release(host: &str, port: u16, timeout: Duration) {
    let Some(address) = socket_address(host, port) else {
        return;
    };
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if TcpStream::connect_timeout(&address, Duration::from_millis(50)).is_err() {
            return;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

fn socket_address(host: &str, port: u16) -> Option<SocketAddr> {
    host.parse::<IpAddr>()
        .ok()
        .map(|ip| SocketAddr::new(ip, port))
}

#[cfg(test)]
mod config_tests {
    use super::{validate_config, DesktopConfig};

    fn legacy_config() -> DesktopConfig {
        serde_json::from_str(
            r#"{"port":6100,"saveDir":"Downloads/CrossLAN","networkAdapter":"auto","locale":"system"}"#,
        )
        .unwrap()
    }

    #[test]
    fn missing_theme_defaults_to_system() {
        assert_eq!(legacy_config().theme, "system");
    }

    #[test]
    fn theme_preferences_survive_config_roundtrip() {
        for theme in ["system", "light", "dark"] {
            let mut config = legacy_config();
            config.theme = theme.to_string();
            let config = validate_config(config).unwrap();
            let saved = serde_json::to_string(&config).unwrap();
            let loaded: DesktopConfig = serde_json::from_str(&saved).unwrap();
            assert_eq!(loaded.theme, theme);
        }
    }

    #[test]
    fn unknown_theme_falls_back_to_system() {
        let mut config = legacy_config();
        config.theme = "invalid".to_string();
        assert_eq!(validate_config(config).unwrap().theme, "system");
    }

}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--autostart"])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if open_frontend(app).is_err() {
                show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_launch_state,
            restart_service,
            get_desktop_config,
            list_network_adapters,
            save_desktop_config,
            quit_app
        ])
        .setup(|app| {
            let config = load_desktop_config(app.handle());
            app.manage(AppState::new(config));
            let state = app.state::<AppState>();
            setup_tray(app.handle()).map_err(std::io::Error::other)?;
            hide_main_window(app.handle());
            let open_browser_on_ready = !launched_from_autostart();
            if let Err(error) =
                start_service(app.handle(), state.inner(), open_browser_on_ready)
            {
                set_launch_error(app.handle(), state.inner(), error);
                show_main_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                hide_main_window(window.app_handle());
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
