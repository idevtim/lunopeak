//! Menu-bar / system-tray icon. Shows a leading usage % in the title (macOS)
//! and — on click — toggles a frameless webview popover that surfaces per-
//! provider session/weekly windows, cost rollups, and quick actions.
//!
//! The popover replaces what used to be a native dropdown menu. Native menus
//! couldn't render progress bars or per-provider colorways, and the old
//! implementation flattened the same information across several nested
//! submenus where it was hard to glance at. The webview gives us a single
//! visual surface that mirrors the rest of the app's design system.
//!
//! The tray runs alongside the main window in the same process — closing the
//! window hides it but keeps the tray alive so usage keeps refreshing.

use crate::commands::SettingsCache;
use crate::models::{
    Settings, TrayHeadlineWindow, TrayPinnedProvider, TrayTitleStyle, UsageLimits, UsageWindow,
};
use crate::scanners;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::image::Image;
#[cfg(target_os = "linux")]
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
#[cfg(not(target_os = "macos"))]
use tauri::{LogicalSize, PhysicalPosition, WindowEvent};
/// Provider-mark PNGs embedded at compile time. Pre-rendered as black-on-
/// transparency at 44×44 so macOS can treat them as templates and re-tint
/// them for light/dark menu bars.
const LUNOPEAK_ICON: &[u8] = include_bytes!("../icons/lunopeak-template@2x.png");

const TRAY_ID: &str = "lunopeak-tray";
pub(crate) const TRAY_PANEL_LABEL: &str = "tray-panel";
pub(crate) const PANEL_WIDTH: f64 = 380.0;
/// Tall enough for three providers' plan bars plus a few "Running now" rows.
pub(crate) const PANEL_HEIGHT: f64 = 620.0;
/// Gap between the tray icon and the panel (Windows; macOS anchors an
/// NSPopover to the status item instead).
#[cfg(not(target_os = "macos"))]
const PANEL_GAP: i32 = 8;
const REFRESH_SECS: u64 = 60;

/// Cached tray handle. We need it from both the menu-event callback (rebuild
/// menu after click) and the periodic refresh task.
static TRAY_HANDLE: OnceLock<Mutex<Option<TrayIcon>>> = OnceLock::new();
/// Usage from the last refresh, so a settings change can redraw the title
/// at once instead of waiting on a fresh `usage::collect`.
static LAST_LIMITS: Mutex<Option<UsageLimits>> = Mutex::new(None);
/// Guards against spawning multiple refresh loops when the user toggles the
/// tray off and back on.
static REFRESH_RUNNING: AtomicBool = AtomicBool::new(false);
/// Whether THIS process owns the tray. Set in `install()`. On macOS only the
/// `.accessory` menu-bar agent calls `install()`; the `.regular` window process
/// never does, so this stays false there — and `refresh()` no-ops rather than
/// lazily building a *second* menu bar icon when the window's UI calls
/// `refresh_tray` after a settings change.
static TRAY_OWNER: AtomicBool = AtomicBool::new(false);
/// Whether the Linux tray menu currently carries the "Restart to Update"
/// row, so `apply` only rebuilds the menu when that changes.
#[cfg(target_os = "linux")]
static MENU_HAS_UPDATE: AtomicBool = AtomicBool::new(false);

/// Instant the menu-bar agent recorded in `install()`. Used only to stamp the
/// popover diagnostics with process uptime so a "stops overlaying fullscreen
/// after the app's been open a while" report can be correlated with how long
/// the agent has actually been running when the bad click happened.
#[cfg(target_os = "macos")]
static AGENT_START: OnceLock<std::time::Instant> = OnceLock::new();

/// Seconds since the agent started, or 0 before `install()` recorded the start.
#[cfg(target_os = "macos")]
fn agent_uptime_secs() -> u64 {
    AGENT_START.get().map_or(0, |t| t.elapsed().as_secs())
}

fn handle_slot() -> &'static Mutex<Option<TrayIcon>> {
    TRAY_HANDLE.get_or_init(|| Mutex::new(None))
}

/// Build the tray once during app setup. Subsequent updates go through
/// `refresh()`.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    // Mark this process as the tray owner even if the tray is currently
    // disabled — a later enable goes through `refresh()`, which is gated on
    // this flag.
    TRAY_OWNER.store(true, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    let _ = AGENT_START.set(std::time::Instant::now());
    // Before the enabled check: an app left running with the tray hidden
    // should still keep checking for updates.
    crate::updates::spawn_check_loop(app.clone());
    let settings = current_settings(app);
    if !settings.tray.enabled {
        return Ok(());
    }
    build_and_store(app, &settings)?;
    spawn_refresh_loop(app.clone());
    Ok(())
}

/// Re-render the tray title using the latest settings + usage. Safe to call
/// from any thread; no-ops when the tray hasn't been installed.
pub fn refresh(app: &AppHandle) {
    // Only the tray-owning process touches the tray. In the macOS window
    // process this is false, so we never lazily build a duplicate icon.
    if !TRAY_OWNER.load(Ordering::SeqCst) {
        return;
    }
    let settings = current_settings(app);
    if !settings.tray.enabled {
        // User just toggled it off. Don't drop the cached `TrayIcon` from
        // here — `refresh` runs on a tokio blocking worker, and tray-icon's
        // Drop calls `NSStatusBar::removeStatusItem` directly, which on
        // macOS must run on the main thread (the previous code did, and it
        // crashed the app). `set_visible(false)` marshals the teardown
        // through Tauri's main-thread dispatch instead.
        if let Some(tray) = handle_slot().lock().unwrap().clone() {
            let _ = tray.set_visible(false);
        }
        // No dock-flip here: the app is permanently `.accessory` on macOS
        // (see lib.rs setup) so there's no dock icon to restore. If a user
        // ever disables the tray AND has the main window hidden they can
        // still reopen via a Finder relaunch (handled by `RunEvent::Reopen`).
        return;
    }

    // Lazily create on first refresh after a settings flip from off → on.
    let slot_empty = handle_slot().lock().unwrap().is_none();
    if slot_empty {
        if let Err(err) = build_and_store(app, &settings) {
            crate::elog!(error, "tray", "build failed: {err}");
            return;
        }
        spawn_refresh_loop(app.clone());
    } else if let Some(tray) = handle_slot().lock().unwrap().clone() {
        // Re-enabled after a previous disable — bring the icon back. No-op
        // when it's already visible.
        let _ = tray.set_visible(true);
    }

    let limits = scanners::usage::collect(&settings.agents, false);
    apply(app, &settings, &limits);
    *LAST_LIMITS.lock().unwrap() = Some(limits);
    refresh_statusline_snapshot(app, &settings);
}

/// Redraw the title and tooltip from the last refresh's usage with the
/// current settings. Cheap (no scan), so `update_settings` calls it before
/// the full `refresh` — a "Show" / "Percent for" / "Which limit" change then
/// lands in the menu bar immediately rather than after a usage re-scan.
pub fn retitle(app: &AppHandle) {
    if !TRAY_OWNER.load(Ordering::SeqCst) {
        return;
    }
    let settings = current_settings(app);
    if !settings.tray.enabled {
        return;
    }
    if let Some(limits) = LAST_LIMITS.lock().unwrap().clone() {
        apply(app, &settings, &limits);
    }
}

/// Keep the terminal status line's "today" cost current while the app sits in
/// the menu bar. No-op unless the Claude status line is installed; throttled
/// inside `snapshot_due` because it re-scans session costs.
fn refresh_statusline_snapshot(app: &AppHandle, settings: &Settings) {
    if !crate::statusline::snapshot_due() {
        return;
    }
    let mut sessions = Vec::new();
    if settings.agents.claude_code {
        if let Ok(s) = scanners::sessions::scan_all(app.state::<crate::scanners::sessions::Cache>().inner()) {
            sessions.extend(s);
        }
    }
    if settings.agents.codex {
        if let Ok(s) = scanners::codex::scan_all(app.state::<crate::scanners::codex::Cache>().inner()) {
            sessions.extend(s);
        }
    }
    crate::statusline::write_snapshot(&scanners::sessions::costs(&sessions).by_day);
}

fn build_and_store(app: &AppHandle, settings: &Settings) -> tauri::Result<()> {
    let limits = scanners::usage::collect(&settings.agents, false);
    let title = title_for(settings, &limits);

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("LunoPeak")
        .on_tray_icon_event(|tray, event| handle_tray_event(tray, event));

    // Linux tray backends (libappindicator / StatusNotifierItem) never deliver
    // left-click events to the application — the only interaction model they
    // support is a context menu. The click-toggled popover used on macOS and
    // Windows therefore can't work here (no click event fires, and there's no
    // icon rect to anchor a panel against), so the icon appears dead. Attach a
    // native menu instead so clicking the icon actually does something.
    #[cfg(target_os = "linux")]
    {
        let menu = build_tray_menu(app)?;
        builder = builder
            .menu(&menu)
            .show_menu_on_left_click(true)
            .on_menu_event(|app, event| handle_tray_menu_event(app, event.id().as_ref()));
    }

    if let Some(icon) = tray_icon(update_pending()) {
        builder = builder.icon(icon);
    }
    builder = builder.icon_as_template(true);
    if let Some(t) = title.as_ref() {
        builder = builder.title(t);
    }

    let tray = builder.build(app)?;
    *handle_slot().lock().unwrap() = Some(tray);
    // Lets `retitle` redraw (e.g. badge an update) before the first refresh tick.
    *LAST_LIMITS.lock().unwrap() = Some(limits);
    Ok(())
}

fn apply(_app: &AppHandle, settings: &Settings, limits: &UsageLimits) {
    let Some(tray) = handle_slot().lock().unwrap().clone() else {
        return;
    };
    let title = title_for(settings, limits);
    // macOS NSStatusItem keeps the previous title when set_title(None) is called;
    // pass Some("") to actually clear it after the user disables all agents.
    let _ = tray.set_title(Some(title.as_deref().unwrap_or("")));
    let mut tooltip = tooltip_for(settings, limits);
    if let Some(version) = crate::updates::available_version() {
        tooltip.push_str(&format!("\nLunoPeak {version} is ready — restart to update"));
    }
    let _ = tray.set_tooltip(Some(tooltip.as_str()));
    #[cfg(target_os = "linux")]
    if update_pending() != MENU_HAS_UPDATE.load(Ordering::SeqCst) {
        if let Ok(menu) = build_tray_menu(_app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
    // Re-set every tick so Windows / Linux pick up a taskbar theme change.
    if let Some(icon) = tray_icon(update_pending()) {
        let _ = tray.set_icon(Some(icon));
        // set_icon installs a fresh NSImage whose template bit defaults to
        // false — re-assert it so macOS tints the black PNG for the menu bar.
        let _ = tray.set_icon_as_template(true);
    }
}

/// The LunoPeak owl, whichever provider leads. A Claude / Codex / Cursor
/// logo here read as that tool's own menu-bar item when it was running too.
/// Monochrome template, not the coloured app icon. `badged` adds the
/// update-available arrow (see `add_update_badge`).
fn tray_icon(badged: bool) -> Option<Image<'static>> {
    load_tray_icon(LUNOPEAK_ICON, badged)
}

fn update_pending() -> bool {
    crate::updates::available_version().is_some()
}

/// Draw a small download arrow in the icon's bottom-right corner, signalling
/// that an update is waiting. The menu bar is the only part of the app
/// visible most of the time, so this is where the news has to go.
///
/// Stays monochrome, like the plain owl, so it's still a template image that
/// adapts to the wallpaper and to Dark Mode. A ring is cut out of the owl
/// around the badge, which keeps the two shapes apart at menu bar size
/// without relying on colour; the arrow itself is cut out of a filled disc
/// (SF Symbols' `arrow.down.circle.fill`). Edges are 4×4 supersampled.
fn add_update_badge(rgba: &mut [u8], width: u32, height: u32) {
    let (w, h) = (width as f64, height as f64);
    let r = (h * 0.25).round();
    let gap = (h / 22.0 * 1.5).max(1.0); // 1.5pt at the icon's scale
    let (cx, cy) = (w - r, h - r);

    let in_arrow = |x: f64, y: f64| {
        let dx = (x - cx).abs();
        let stem = dx <= 0.16 * r && y >= cy - 0.55 * r && y <= cy + 0.2 * r;
        let (base, apex) = (cy + 0.02 * r, cy + 0.6 * r);
        let head = y >= base && y <= apex && dx <= 0.48 * r * (apex - y) / (apex - base);
        stem || head
    };

    const SS: u32 = 4;
    for py in 0..height {
        for px in 0..width {
            let (mut ring, mut badge) = (0u32, 0u32);
            for sy in 0..SS {
                for sx in 0..SS {
                    let x = px as f64 + (sx as f64 + 0.5) / SS as f64;
                    let y = py as f64 + (sy as f64 + 0.5) / SS as f64;
                    let d = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
                    if d <= r + gap {
                        ring += 1;
                    }
                    if d <= r && !in_arrow(x, y) {
                        badge += 1;
                    }
                }
            }
            if ring == 0 {
                continue;
            }
            let n = (SS * SS) as f64;
            let i = ((py * width + px) * 4) as usize;
            let kept = rgba[i + 3] as f64 * (1.0 - ring as f64 / n);
            let a = (kept + 255.0 * badge as f64 / n).min(255.0);
            // The badge takes the owl's ink (black; tinted below on Win/Linux).
            if badge > 0 {
                rgba[i..i + 3].fill(0);
            }
            rgba[i + 3] = a.round() as u8;
        }
    }
}

/// Decode an embedded template PNG and tint it for the current platform's
/// menu-bar / taskbar / panel background. macOS rides NSImage's template
/// flag (auto-tinted by the OS), so the source is left untouched. Windows
/// and Linux don't honor template images, so the black-on-transparent
/// source would be invisible on a dark taskbar — recolor it based on the
/// detected system theme. dark-light reads `SystemUsesLightTheme` on
/// Windows and the freedesktop color-scheme portal on Linux, both of
/// which track the *taskbar/panel* theme rather than the app theme.
fn load_tray_icon(bytes: &'static [u8], badged: bool) -> Option<Image<'static>> {
    let img = Image::from_bytes(bytes).ok()?;
    let tint = tray_icon_tint();
    if tint.is_none() && !badged {
        return Some(img);
    }
    let (width, height) = (img.width(), img.height());
    let mut rgba = img.rgba().to_vec();
    if badged {
        add_update_badge(&mut rgba, width, height);
    }
    let Some(rgb) = tint else {
        return Some(Image::new_owned(rgba, width, height));
    };
    for px in rgba.chunks_exact_mut(4) {
        px[0] = rgb[0];
        px[1] = rgb[1];
        px[2] = rgb[2];
    }
    Some(Image::new_owned(rgba, width, height))
}

/// Tint to apply to tray icons. None means "leave the black-on-transparent
/// source untouched" — correct for macOS (template-tinted by the OS) and
/// for any platform whose taskbar is light. Detection failures fall back
/// to white on Windows/Linux since dark taskbars are the common default.
fn tray_icon_tint() -> Option<[u8; 3]> {
    #[cfg(target_os = "macos")]
    {
        None
    }
    #[cfg(not(target_os = "macos"))]
    {
        match dark_light::detect() {
            Ok(dark_light::Mode::Light) => None,
            _ => Some([255, 255, 255]),
        }
    }
}

fn spawn_refresh_loop(app: AppHandle) {
    if REFRESH_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(REFRESH_SECS));
        ticker.tick().await; // first tick fires immediately; we already rendered
        let mut last = TickClocks::now();
        loop {
            ticker.tick().await;
            last = last.tick_and_log();
            // refresh() does blocking I/O (filesystem walks + reqwest::blocking
            // for live usage). Dropping the embedded reqwest runtime panics
            // when called on a tokio worker, so we hop to the blocking pool.
            let app = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || refresh(&app)).await;
        }
    });
}

/// Both clocks as of one refresh tick, so the next tick can report how far the
/// loop actually drifted from `REFRESH_SECS`.
///
/// The menu-bar agent is a background `.accessory` process with no visible
/// window, which makes it a candidate for App Nap — and a napped process gets
/// its timers coalesced and its network deferred, which would stretch this
/// loop and leave the usage % in the title behind reality no matter how short
/// the scanner's cache TTL is. Whether App Nap actually engages for a process
/// that owns an `NSStatusItem` is the open question these lines answer.
///
/// Reading both clocks is what separates the two ways a tick can run late,
/// because `Instant` on macOS doesn't advance while the machine is asleep:
///
/// | monotonic | wall  | meaning                                        |
/// |-----------|-------|------------------------------------------------|
/// | ~60s      | ~60s  | healthy                                        |
/// | ~60s      | hours | machine slept — benign, cache TTL handles it    |
/// | minutes   | minutes | throttled while awake — App Nap              |
struct TickClocks {
    mono: std::time::Instant,
    wall: i64,
}

/// Only log a tick that ran meaningfully late — a healthy loop should stay
/// silent rather than writing 1440 lines a day into a size-capped log.
const TICK_DRIFT_LOG_THRESHOLD_SECS: u64 = REFRESH_SECS * 3 / 2;

impl TickClocks {
    fn now() -> Self {
        Self {
            mono: std::time::Instant::now(),
            wall: chrono::Utc::now().timestamp(),
        }
    }

    /// Sample both clocks, log if this tick ran late on either one, and return
    /// the new baseline for the next tick.
    ///
    /// Either clock can trip the threshold: monotonic catches throttling,
    /// wall-clock catches a suspend the monotonic clock slept through. Logging
    /// both together is what makes the two distinguishable after the fact.
    fn tick_and_log(&self) -> Self {
        let next = Self::now();
        let mono_secs = next.mono.duration_since(self.mono).as_secs();
        let wall_secs = (next.wall - self.wall).max(0) as u64;
        if mono_secs.max(wall_secs) >= TICK_DRIFT_LOG_THRESHOLD_SECS {
            crate::elog!(
                info,
                "tray",
                "refresh tick ran late: monotonic={}s wall={}s (interval={}s)",
                mono_secs,
                wall_secs,
                REFRESH_SECS
            );
        }
        next
    }
}

// ── Click handling / panel toggle ─────────────────────────────────────

/// Tray icon click handler. We only react to *left-button-up* — firing on
/// `Down` would race the OS focus change and immediately hide the panel via
/// the window's own blur handler. We let the OS render `Down` as a press
/// state, then act on `Up`.
fn handle_tray_event(tray: &TrayIcon, event: TrayIconEvent) {
    let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        rect,
        ..
    } = event
    else {
        return;
    };
    #[cfg(target_os = "macos")]
    {
        let _ = rect;
        toggle_popover(tray);
    }
    #[cfg(not(target_os = "macos"))]
    toggle_panel(tray.app_handle(), rect);
}

/// Linux-only context menu for the tray icon. See `build_and_store` for why a
/// menu (rather than the macOS/Windows click popover) is the only thing that
/// works on Linux.
#[cfg(target_os = "linux")]
fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItemBuilder::with_id("tray:open", "Open LunoPeak").build(app)?;
    let settings = MenuItemBuilder::with_id("tray:settings", "Settings").build(app)?;
    // A plain item, not `PredefinedMenuItem::quit` — the predefined variant
    // doesn't render on Linux's libappindicator backend (it silently drops the
    // row), so the menu would show Open/Settings and no Quit. We wire the exit
    // ourselves in `handle_tray_menu_event`.
    let quit = MenuItemBuilder::with_id("tray:quit", "Quit LunoPeak").build(app)?;
    let mut menu = MenuBuilder::new(app);
    let version = crate::updates::available_version();
    MENU_HAS_UPDATE.store(version.is_some(), Ordering::SeqCst);
    if let Some(version) = version {
        let update =
            MenuItemBuilder::with_id("tray:update", format!("Restart to Update to {version}"))
                .build(app)?;
        menu = menu.item(&update).separator();
    }
    menu.item(&open)
        .item(&settings)
        .separator()
        .item(&quit)
        .build()
}

/// Dispatch a tray-menu click (Linux). Quit is handled natively by the
/// predefined item; the rest route through the same window helpers the macOS
/// app menu and tray popover use.
#[cfg(target_os = "linux")]
fn handle_tray_menu_event(app: &AppHandle, id: &str) {
    match id {
        "tray:open" => show_main_window(app),
        "tray:settings" => navigate_main(app, "settings"),
        "tray:quit" => app.exit(0),
        "tray:update" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::updates::install_and_restart(app).await;
            });
        }
        _ => {}
    }
}

/// macOS: open or close the `NSPopover` hosting the panel (see
/// `tray_popover`). Showing emits `tray-panel://show` so the React side can
/// replay its staggered entry animation; the very first show is lost while
/// the webview loads, but that's when everything animates in anyway.
#[cfg(target_os = "macos")]
fn toggle_popover(tray: &TrayIcon) {
    let app = tray.app_handle();
    if crate::tray_popover::is_shown() {
        crate::tray_popover::close(app);
        return;
    }
    let window = match app.get_webview_window(TRAY_PANEL_LABEL) {
        Some(window) => window,
        None => match build_panel_window(app) {
            Ok(window) => window,
            Err(err) => {
                crate::elog!(error, "tray-panel", "build failed: {err}");
                return;
            }
        },
    };
    crate::elog!(info, "tray-panel", "click: show popover (uptime={}s)", agent_uptime_secs());
    let theme = current_settings(app).theme;
    let app_for_show = app.clone();
    let window_for_show = window.clone();
    // We're on the main thread (tray events arrive there), so this runs inline.
    let shown = tray
        .with_inner_tray_icon(move |inner| {
            inner.ns_status_item().is_some_and(|item| {
                crate::tray_popover::show(&app_for_show, &window_for_show, &item, &theme)
            })
        })
        .unwrap_or(false);
    if shown {
        let _ = window.emit("tray-panel://show", ());
        kick_tray_refresh(app);
    }
}

/// Windows: show the panel anchored to the tray icon rect, or hide it if
/// already open. Showing emits `tray-panel://show` so the React side can
/// replay its staggered entry animation. Hiding is unconditional — the panel
/// has no exit animation, so we drop the window directly on this side.
#[cfg(not(target_os = "macos"))]
fn toggle_panel(app: &AppHandle, icon_rect: tauri::Rect) {
    if let Some(window) = app.get_webview_window(TRAY_PANEL_LABEL) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            return;
        }
        position_panel(&window, icon_rect);
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("tray-panel://show", ());
        kick_tray_refresh(app);
        return;
    }

    // First open — build, position, then show.
    match build_panel_window(app) {
        Ok(window) => {
            position_panel(&window, icon_rect);
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.emit("tray-panel://show", ());
            kick_tray_refresh(app);
        }
        Err(err) => crate::elog!(error, "tray-panel", "build failed: {err}"),
    }
}

/// Recompute the tray title/icon off the same click that opened the popover.
/// Without this the title only refreshes on the 60s loop, so when a usage
/// window resets the popover re-fetches and shows the reset immediately while
/// the menu-bar text keeps the pre-reset figure for up to a minute (longer if
/// App Nap throttles the agent's timer). `refresh` re-runs `usage::collect`,
/// which picks up the reset the same way the popover does. It does blocking
/// I/O (fs walks + reqwest::blocking) and panics if its embedded runtime is
/// dropped on a tokio worker, so hop to the blocking pool.
fn kick_tray_refresh(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || refresh(&app));
}

fn build_panel_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let url = WebviewUrl::App("index.html#/tray-panel".into());

    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, TRAY_PANEL_LABEL, url)
        .title("LunoPeak")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        // Follow the user across virtual desktops.
        .visible_on_all_workspaces(true)
        // A click on a floating window that isn't key would otherwise only
        // focus it, and with blur-to-hide every click would just dismiss it.
        .accept_first_mouse(true)
        .transparent(true);

    // macOS: this window is never shown — `tray_popover` lifts its webview
    // into an NSPopover, which supplies the material, arrow and rounding.
    // Tell the page before it renders so it drops its own panel surface.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .initialization_script("document.documentElement.dataset.trayHost = 'popover';");
    }

    let window = builder.build()?;

    // Mica under the transparent webview on Windows, so the CSS surface
    // composites against an OS-blurred backing instead of whatever is behind
    // the window.
    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::apply_mica;
        let _ = apply_mica(&window, Some(true));
    }

    // Auto-hide when the panel loses focus — that's the popover convention
    // every OS user expects from a tray dropdown. Clicking the tray icon
    // again will re-toggle it through the tray event handler. (macOS closes
    // its popover itself; see `tray_popover`.)
    #[cfg(not(target_os = "macos"))]
    {
        let win_for_event = window.clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Focused(false)) {
                let _ = win_for_event.hide();
            }
        });
    }

    Ok(window)
}

#[cfg(not(target_os = "macos"))]
/// Position the panel adjacent to the tray icon. On macOS the menu bar is at
/// the top; on Windows/Linux the system tray is typically at the bottom-right.
/// We decide above-vs-below by comparing the icon's y against the monitor
/// midpoint, then nudge horizontally so the panel stays fully on-screen.
///
/// Multi-display correctness: we resolve the target monitor by point-in-rect
/// against the icon's center, NOT via `window.current_monitor()` — the latter
/// returns the monitor the *window* lives on (usually primary), which would
/// pin the panel to the primary even when the user clicked the icon on a
/// secondary display. Everything happens in physical pixels so a mixed retina
/// + 1× setup doesn't double-apply scale factors.
fn position_panel(window: &tauri::WebviewWindow, icon_rect: tauri::Rect) {
    // Normalize to physical pixels. `to_physical` is a no-op on Physical
    // variants and scale-multiplies on Logical, so passing the window's
    // current scale is safe regardless of which variant the backend emits.
    let win_scale = window.scale_factor().unwrap_or(1.0);
    let icon_pos = icon_rect.position.to_physical::<i32>(win_scale);
    let icon_size = icon_rect.size.to_physical::<u32>(win_scale);
    let icon_x = icon_pos.x as f64;
    let icon_y = icon_pos.y as f64;
    let icon_w = icon_size.width as f64;
    let icon_h = icon_size.height as f64;
    let icon_cx = icon_x + icon_w / 2.0;
    let icon_cy = icon_y + icon_h / 2.0;

    // Find the monitor whose physical rect contains the icon's center.
    // Falls back to current/primary if no monitor reports containing it
    // (shouldn't happen in practice, but keeps us robust against odd
    // virtual-display drivers).
    let monitors = window.available_monitors().unwrap_or_default();
    let monitor = monitors
        .iter()
        .find(|m| {
            let p = m.position();
            let s = m.size();
            let mx = p.x as f64;
            let my = p.y as f64;
            icon_cx >= mx
                && icon_cx <= mx + s.width as f64
                && icon_cy >= my
                && icon_cy <= my + s.height as f64
        })
        .cloned()
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };

    let mon_scale = monitor.scale_factor();
    let mon_pos = monitor.position();
    let mon_size = monitor.size();
    let mon_x = mon_pos.x as f64;
    let mon_y = mon_pos.y as f64;
    let mon_w = mon_size.width as f64;
    let mon_h = mon_size.height as f64;

    // Scale the panel's logical footprint into the target monitor's physical
    // space — using *its* scale, not the window's. Without this, a panel
    // opened on a 1× external from a window living on a 2× retina would be
    // half-sized.
    let panel_w = PANEL_WIDTH * mon_scale;
    let panel_h = PANEL_HEIGHT * mon_scale;
    let gap = PANEL_GAP as f64 * mon_scale;
    let margin = 6.0 * mon_scale;

    let below = icon_y < mon_y + mon_h / 2.0;
    let mut x = icon_cx - panel_w / 2.0;
    let mut y = if below {
        icon_y + icon_h + gap
    } else {
        icon_y - panel_h - gap
    };

    let max_x = mon_x + mon_w - panel_w - margin;
    let min_x = mon_x + margin;
    if x > max_x {
        x = max_x;
    }
    if x < min_x {
        x = min_x;
    }
    let max_y = mon_y + mon_h - panel_h - margin;
    let min_y = mon_y + margin;
    if y > max_y {
        y = max_y;
    }
    if y < min_y {
        y = min_y;
    }

    // Re-assert size in logical pixels so the OS picks up the destination
    // monitor's scale automatically. Setting LogicalSize after moving across
    // monitors is the canonical pattern — set_position followed by set_size
    // ensures the size is interpreted in the new monitor's DPI.
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    let _ = window.set_size(LogicalSize::new(PANEL_WIDTH, PANEL_HEIGHT));
}

/// Programmatic entry point — used by commands when the frontend wants to
/// dismiss the panel after a navigation/action click.
pub fn hide_panel(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app_for_close = app.clone();
        let _ = app.run_on_main_thread(move || crate::tray_popover::close(&app_for_close));
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window(TRAY_PANEL_LABEL) {
        let _ = window.hide();
    }
}

/// Re-theme the open popover after an Appearance change (macOS). The webview
/// re-themes itself; this keeps the popover's material and arrow in step.
pub fn apply_panel_theme(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let theme = current_settings(app).theme;
        let _ = app.run_on_main_thread(move || crate::tray_popover::set_theme(&theme));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    crate::macos_agent::debug_log(&format!(
        "show_main_window: main_exists={}",
        app.get_webview_window("main").is_some()
    ));
    // Window process (macOS) / single process (Win/Linux): bring the existing
    // window forward. `set_focus()` calls `activateIgnoringOtherApps:` (tao),
    // which foregrounds the `.regular` app and activates its menu bar.
    if let Some(window) = app.get_webview_window("main") {
        // Detect a hidden→visible transition so the frontend can refresh
        // stale data. With close-to-tray the webview keeps its DOM and
        // query cache across hides, so reopening from the tray would
        // otherwise show whatever was on screen when the user closed it.
        let was_hidden = matches!(window.is_visible(), Ok(false));
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        if was_hidden {
            let _ = app.emit_to(
                tauri::EventTarget::WebviewWindow {
                    label: "main".into(),
                },
                "app://reopened",
                (),
            );
        }
        return;
    }
    // macOS menu-bar agent: there is no main window in this process. Open the
    // separate window app via LaunchServices (focuses it if already running).
    #[cfg(target_os = "macos")]
    crate::macos_agent::launch_window(app, None);
}

/// Navigate the main window to a route, bringing it forward first. Used by
/// the panel's footer buttons (Open LunoPeak, Settings).
pub fn navigate_main(app: &AppHandle, route: &str) {
    // Window present (window process / single process): bring it forward and
    // tell the frontend to route. The agent has no window, so instead launch a
    // window process pointed at the route (or, if one's already running, the
    // single-instance callback focuses it and emits the same navigate event).
    if app.get_webview_window("main").is_some() {
        show_main_window(app);
        let _ = app.emit_to(
            tauri::EventTarget::WebviewWindow {
                label: "main".into(),
            },
            "tray://navigate",
            route.to_string(),
        );
        return;
    }
    #[cfg(target_os = "macos")]
    crate::macos_agent::launch_window(app, Some(route));
}

// ── Display formatting (title only — panel formats its own text) ─────

fn title_for(settings: &Settings, limits: &UsageLimits) -> Option<String> {
    let p = pick_leading(settings, limits)?;
    // Leading space gives the title a bit of breathing room from the icon —
    // macOS doesn't expose icon/title padding directly.
    let window = settings.tray.headline_window;
    let labeled = match settings.tray.title_style {
        TrayTitleStyle::Off => return None,
        TrayTitleStyle::Percent => false,
        TrayTitleStyle::PercentWindow => true,
    };
    headline_for(p, window, labeled).map(|s| format!(" {s}"))
}

fn pick_leading<'a>(
    settings: &Settings,
    limits: &'a UsageLimits,
) -> Option<&'a crate::models::ProviderUsage> {
    let providers = filter_enabled(settings, limits);
    match settings.tray.pinned_provider {
        TrayPinnedProvider::Auto => highest_pct_provider(&providers, settings.tray.headline_window),
        TrayPinnedProvider::Claude => providers.iter().find(|p| p.provider == "claude").copied(),
        TrayPinnedProvider::Codex => providers.iter().find(|p| p.provider == "codex").copied(),
        TrayPinnedProvider::Cursor => providers.iter().find(|p| p.provider == "cursor").copied(),
    }
}

fn tooltip_for(settings: &Settings, limits: &UsageLimits) -> String {
    if limits.providers.is_empty() {
        return "LunoPeak — no usage data".to_string();
    }
    let parts: Vec<String> = limits
        .providers
        .iter()
        .filter_map(|p| {
            headline_for(p, settings.tray.headline_window, true)
                .map(|s| format!("{}: {s}", provider_label(&p.provider)))
        })
        .collect();
    if parts.is_empty() {
        "LunoPeak".to_string()
    } else {
        format!("LunoPeak — {}", parts.join(" · "))
    }
}

fn filter_enabled<'a>(
    settings: &Settings,
    limits: &'a UsageLimits,
) -> Vec<&'a crate::models::ProviderUsage> {
    limits
        .providers
        .iter()
        .filter(|p| match p.provider.as_str() {
            "claude" => settings.agents.claude_code,
            "codex" => settings.agents.codex,
            "cursor" => settings.agents.cursor,
            _ => true,
        })
        .collect()
}

fn highest_pct_provider<'a>(
    providers: &[&'a crate::models::ProviderUsage],
    window: TrayHeadlineWindow,
) -> Option<&'a crate::models::ProviderUsage> {
    providers.iter().copied().max_by(|a, b| {
        let av = best_pct(a, window);
        let bv = best_pct(b, window);
        av.partial_cmp(&bv).unwrap_or(std::cmp::Ordering::Equal)
    })
}

fn best_pct(p: &crate::models::ProviderUsage, window: TrayHeadlineWindow) -> f64 {
    headline_windows(p, window).0 .0.used_percent.unwrap_or(-1.0)
}

/// A usage window and its short menu-bar name.
type Labeled<'a> = (&'a UsageWindow, &'static str);

/// The window the headline leads with and the one it falls back to. Fable
/// resolves to Claude's Fable-scoped weekly cap; any provider without one
/// (Codex, Cursor, or Claude when Anthropic reports no Fable limit) uses its
/// all-models weekly window instead, so picking Fable never blanks the other
/// rows.
fn headline_windows(
    p: &crate::models::ProviderUsage,
    window: TrayHeadlineWindow,
) -> (Labeled<'_>, Labeled<'_>) {
    let five_hour = (&p.five_hour, "5h");
    let weekly = (&p.weekly, "Wk");
    match window {
        TrayHeadlineWindow::FiveHour => (five_hour, weekly),
        TrayHeadlineWindow::Weekly => (weekly, five_hour),
        TrayHeadlineWindow::Fable => {
            let fable = p
                .model_limits
                .iter()
                .find(|l| l.model.eq_ignore_ascii_case("fable"))
                .map(|l| (&l.window, "Fable"));
            (fable.unwrap_or(weekly), five_hour)
        }
    }
}

/// One-liner for a provider — prefer the chosen window's percent; fall
/// back to the other window so the tray never displays nothing when only
/// one side has data. `labeled` appends the name of the window actually
/// shown ("42% 5h"), so a Fable or 5h pick that fell back to weekly reads
/// "Wk" rather than claiming a limit it isn't showing.
fn headline_for(
    p: &crate::models::ProviderUsage,
    window: TrayHeadlineWindow,
    labeled: bool,
) -> Option<String> {
    let (primary, secondary) = headline_windows(p, window);
    let shown = [primary, secondary]
        .into_iter()
        .find_map(|(w, label)| w.used_percent.map(|pct| (pct, label)));
    if let Some((pct, label)) = shown {
        return Some(if labeled {
            format!("{pct:.0}% {label}")
        } else {
            format!("{pct:.0}%")
        });
    }
    let (w, label) = primary;
    if w.tokens > 0 {
        return Some(format!(
            "{} tok / {}",
            compact_count(w.tokens),
            label.to_lowercase()
        ));
    }
    None
}

fn provider_label(p: &str) -> String {
    match p {
        "claude" => "Claude Code".to_string(),
        "codex" => "Codex".to_string(),
        "cursor" => "Cursor".to_string(),
        other => other.to_string(),
    }
}

fn compact_count(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", (n as f64) / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", (n as f64) / 1_000.0)
    } else {
        n.to_string()
    }
}

// ── Settings access ───────────────────────────────────────────────────

/// The Appearance setting ("light" / "dark" / "system").
#[cfg(target_os = "macos")]
pub(crate) fn current_theme(app: &AppHandle) -> String {
    current_settings(app).theme
}

/// Read the cached settings if available; fall back to defaults so we never
/// panic during tray refresh from a settings I/O hiccup.
pub(crate) fn current_settings(app: &AppHandle) -> Settings {
    if let Some(cache) = app.try_state::<SettingsCache>() {
        if let Ok(s) = cache.load(app) {
            return s;
        }
    }
    Settings::default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ModelLimit, ProviderUsage};

    fn window(pct: Option<f64>) -> UsageWindow {
        UsageWindow {
            used_percent: pct,
            tokens: 0,
            cost_usd: 0.0,
            message_count: 0,
            resets_at: None,
            window_seconds: 0,
            unlimited: false,
        }
    }

    fn provider(name: &str, five: f64, weekly: f64, fable: Option<f64>) -> ProviderUsage {
        ProviderUsage {
            provider: name.into(),
            plan: None,
            five_hour: window(Some(five)),
            weekly: window(Some(weekly)),
            notice: None,
            model_limits: fable
                .map(|pct| {
                    vec![ModelLimit {
                        model: "Fable".into(),
                        window: window(Some(pct)),
                        is_active: false,
                    }]
                })
                .unwrap_or_default(),
        }
    }

    #[test]
    fn fable_headline_uses_the_fable_cap() {
        let p = provider("claude", 10.0, 30.0, Some(63.0));
        assert_eq!(
            headline_for(&p, TrayHeadlineWindow::Fable, false).as_deref(),
            Some("63%")
        );
        // The other choices are unaffected by a Fable limit being present.
        assert_eq!(
            headline_for(&p, TrayHeadlineWindow::Weekly, false).as_deref(),
            Some("30%")
        );
        assert_eq!(
            headline_for(&p, TrayHeadlineWindow::FiveHour, false).as_deref(),
            Some("10%")
        );
    }

    #[test]
    fn fable_headline_falls_back_to_weekly_without_a_fable_cap() {
        let codex = provider("codex", 17.0, 22.0, None);
        assert_eq!(
            headline_for(&codex, TrayHeadlineWindow::Fable, false).as_deref(),
            Some("22%")
        );
    }

    /// Auto provider selection ranks by the chosen window, so with Fable
    /// picked a nearly-spent Fable cap wins over a busier Codex weekly.
    #[test]
    fn auto_leader_ranks_by_fable_when_selected() {
        let claude = provider("claude", 10.0, 30.0, Some(90.0));
        let codex = provider("codex", 50.0, 60.0, None);
        let providers = vec![&claude, &codex];
        let lead = highest_pct_provider(&providers, TrayHeadlineWindow::Fable).unwrap();
        assert_eq!(lead.provider, "claude");
        let lead = highest_pct_provider(&providers, TrayHeadlineWindow::Weekly).unwrap();
        assert_eq!(lead.provider, "codex");
    }

    #[test]
    fn labeled_headline_names_the_window_shown() {
        let claude = provider("claude", 2.0, 30.0, Some(63.0));
        let codex = provider("codex", 17.0, 22.0, None);
        let h = |p, w| headline_for(p, w, true);
        assert_eq!(h(&claude, TrayHeadlineWindow::FiveHour).as_deref(), Some("2% 5h"));
        assert_eq!(h(&claude, TrayHeadlineWindow::Weekly).as_deref(), Some("30% Wk"));
        assert_eq!(h(&claude, TrayHeadlineWindow::Fable).as_deref(), Some("63% Fable"));
        // No Fable cap: the weekly fallback is labelled as weekly.
        assert_eq!(h(&codex, TrayHeadlineWindow::Fable).as_deref(), Some("22% Wk"));
        // No 5h figure: falls back to weekly, and says so.
        let mut weekly_only = provider("cursor", 0.0, 40.0, None);
        weekly_only.five_hour.used_percent = None;
        assert_eq!(h(&weekly_only, TrayHeadlineWindow::FiveHour).as_deref(), Some("40% Wk"));
    }

    #[test]
    fn title_style_controls_the_menu_bar_text() {
        let limits = UsageLimits {
            providers: vec![provider("claude", 2.0, 30.0, None)],
        };
        let mut settings = Settings::default();
        assert_eq!(title_for(&settings, &limits).as_deref(), Some(" 2%"));
        settings.tray.title_style = TrayTitleStyle::PercentWindow;
        assert_eq!(title_for(&settings, &limits).as_deref(), Some(" 2% 5h"));
        settings.tray.title_style = TrayTitleStyle::Off;
        assert_eq!(title_for(&settings, &limits), None);
        // Settings saved before the option existed keep showing the percent.
        let legacy: crate::models::TrayPrefs = serde_json::from_str(
            r#"{"enabled":true,"closeToTray":true,"pinnedProvider":"auto","headlineWindow":"5h"}"#,
        )
        .unwrap();
        assert_eq!(legacy.title_style, TrayTitleStyle::Percent);
    }

    #[test]
    fn update_badge_cuts_a_ring_and_an_arrow_into_the_corner() {
        let plain = tray_icon(false).unwrap();
        let badged = tray_icon(true).unwrap();
        let (w, h) = (badged.width(), badged.height());
        let alpha = |img: &Image, x: u32, y: u32| img.rgba()[((y * w + x) * 4 + 3) as usize];
        let r = (h as f64 * 0.25).round() as u32;
        // Disc beside the arrow: solid. Arrow stem at the centre: cut out.
        assert_eq!(alpha(&badged, w - r - r / 2 - 1, h - r - r / 4), 255);
        assert_eq!(alpha(&badged, w - r, h - r - r / 4), 0);
        // Just outside the disc, toward the owl: the separating ring.
        let ring = h - 2 * r - 1;
        assert!(alpha(&plain, w - r, ring) > 0, "owl covers the ring's spot");
        assert_eq!(alpha(&badged, w - r, ring), 0);
        // The rest of the owl is untouched.
        assert_eq!(alpha(&badged, w / 4, h / 4), alpha(&plain, w / 4, h / 4));
    }

    #[test]
    fn fable_setting_round_trips_through_serde() {
        let v: TrayHeadlineWindow = serde_json::from_str("\"fable\"").unwrap();
        assert_eq!(v, TrayHeadlineWindow::Fable);
        assert_eq!(serde_json::to_string(&v).unwrap(), "\"fable\"");
    }
}
