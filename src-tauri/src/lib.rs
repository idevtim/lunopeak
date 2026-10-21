mod app_menu;
mod commands;
mod logger;
#[cfg(target_os = "macos")]
mod macos_agent;
mod models;
mod pricing;
mod process_ext;
mod scanners;
mod settings;
mod statusline;
mod tray;
#[cfg(target_os = "macos")]
mod tray_popover;
mod updates;

use commands::{AuditCache, GithubCache, RepoCache, SettingsCache};
use scanners::codex::Cache as CodexCache;
use scanners::sessions::Cache as SessionsCache;
#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::{Manager, PhysicalPosition, PhysicalSize, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// `LunoPeak statusline [--chain]` — Claude Code's status line command.
/// Dispatched from `main` before any Tauri / GUI setup so a repaint costs a
/// process spawn and a few file reads, nothing more.
pub fn statusline_cli(args: &[String]) -> i32 {
    statusline::run_cli(args)
}

/// Set once at startup in the macOS menu-bar agent process. Each process's
/// Keychain reads prompt separately (the agent is its own bundle identity),
/// so secrets are split by owner: the window reads the API keys, the agent
/// reads the browser cookies. Always false on Windows/Linux, where one
/// process does everything.
static MENUBAR_AGENT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) fn is_menubar_agent() -> bool {
    MENUBAR_AGENT.load(std::sync::atomic::Ordering::Relaxed)
}

pub fn run() {
    // Linux/Wayland taskbar icon: GTK3 (which webkit2gtk uses) sets the
    // Wayland window app-id from g_get_prgname() — the program name — NOT from
    // the GtkApplication id (so `enableGTKAppId` alone can't fix the icon).
    // GNOME matches that app-id against a .desktop file (by basename or
    // StartupWMClass) to pick the dock/taskbar icon; with the default prgname
    // ("LunoPeak", the binary name) nothing matches our installed entry and the
    // shell shows a generic icon. Pin prgname to the reverse-DNS identifier so
    // it matches StartupWMClass=com.lunopeak.app baked into the .desktop. Must
    // run before GTK init, i.e. before the Tauri builder below.
    #[cfg(target_os = "linux")]
    glib::set_prgname(Some("com.lunopeak.app"));

    // macOS GUI launches inherit launchd's minimal PATH, so user-installed
    // CLIs (gh, git from Homebrew) aren't visible to Command::new("gh") etc.
    // Prepend the common dirs before anything spawns a subprocess.
    process_ext::augment_path();

    // macOS runs as TWO processes from this one binary: a `.regular` window app
    // (dock icon, app menu) and a `.accessory` menu-bar agent (the tray + usage
    // popover, which can overlay other apps' fullscreen Spaces). Activation
    // policy is per-process, so this is the only way to have both a real
    // dock-icon window AND a fullscreen-overlay popover — flipping one process
    // between policies always loses one or the other. The window process spawns
    // the agent as `current_exe --menubar`. A login launch (`--from-autostart`)
    // boots straight into the agent (silent menu bar, no window). On
    // Windows/Linux this split doesn't exist — one process owns both.
    #[cfg(target_os = "macos")]
    let menubar_mode =
        std::env::args().any(|a| a == "--menubar" || a == "--from-autostart");
    #[cfg(target_os = "macos")]
    MENUBAR_AGENT.store(menubar_mode, std::sync::atomic::Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    macos_agent::debug_log(&format!(
        "run() start: menubar_mode={menubar_mode} exe={:?} args={:?}",
        std::env::current_exe(),
        std::env::args().collect::<Vec<_>>()
    ));

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Pass `--from-autostart` to the registered LaunchAgent so a
        // login launch is distinguishable from a manual one. We use it in
        // setup to start silently in the tray (hidden window + .accessory)
        // instead of popping the main window and stealing focus at login.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--from-autostart"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    // Window-state persistence belongs to the window/single process only. The
    // macOS menu-bar agent positions its popover per-open and has no persistent
    // window, so giving it the plugin would risk clobbering the window
    // process's saved geometry when the agent exits.
    #[cfg(target_os = "macos")]
    let builder = if menubar_mode {
        builder
    } else {
        builder.plugin(window_state_plugin())
    };
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(window_state_plugin());

    builder
        .manage(RepoCache::default())
        .manage(AuditCache::default())
        .manage(SettingsCache::default())
        .manage(SessionsCache::new())
        .manage(CodexCache::new())
        .manage(GithubCache::default())
        .setup(move |app| {
            logger::init(app.handle());
            settings::ensure_config_dir(app.handle())?;
            // A login launch carries `--from-autostart` (registered on the
            // LaunchAgent above). When present we boot silently into the
            // tray — hidden window — instead of popping the main window and
            // stealing focus the moment the user logs in.
            let from_autostart = std::env::args().any(|a| a == "--from-autostart");

            // ── macOS menu-bar agent process ──────────────────────────────
            // Set `.accessory` (no dock icon) once, never flipped — so the
            // popover reliably overlays other apps' fullscreen Spaces. This
            // process owns ONLY the tray + popover; tear down the main window
            // (we never show it here) so we run as a pure menu-bar agent.
            #[cfg(target_os = "macos")]
            if menubar_mode {
                use tauri::ActivationPolicy;
                app.set_activation_policy(ActivationPolicy::Accessory);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.destroy();
                }
                macos_agent::record_agent(app.handle());
                if let Err(err) = tray::install(app.handle()) {
                    crate::elog!(error, "tray", "install failed: {err}");
                }
                // Restarted onto an update from the menu bar while the window
                // was open: bring the window back on the new version too.
                if macos_agent::take_relaunch_window(app.handle()) {
                    macos_agent::launch_window(app.handle(), None);
                }
                return Ok(());
            }

            // ── Window process (macOS) / single process (Windows, Linux) ──
            // macOS window process is `.regular`: dock icon with a running
            // dot, and a fully-active native menu bar. Closing the window
            // exits this process (dock icon disappears); the separate agent
            // keeps the menu bar alive.
            #[cfg(target_os = "macos")]
            {
                use tauri::ActivationPolicy;
                app.set_activation_policy(ActivationPolicy::Regular);
                // Record our PID so the menu-bar agent's "Quit" can terminate
                // this window process too — and handle that SIGTERM gracefully
                // so window geometry is still saved.
                macos_agent::record_window(app.handle());
                macos_agent::install_graceful_term(app.handle().clone());
                // Dev fallback only: the dev-exec path passes the route as an
                // arg. Packaged builds carry it in the pending-route file the
                // agent wrote, which the frontend pulls via `take_pending_route`
                // on mount. Normalize the arg form into that same file.
                if let Some(route) = macos_agent::route_from_args(std::env::args()) {
                    macos_agent::write_pending_route(app.handle(), &route);
                }
            }
            apply_window_effects(app)?;
            // Restore geometry after vibrancy/decoration changes have settled —
            // dropping decorations on Windows/Linux shifts the window.
            if let Some(window) = app.get_webview_window("main") {
                apply_saved_window_geometry(app.handle(), &window);

                // The window-state plugin only flushes its cache to disk on
                // RunEvent::Exit, which is unreliable on macOS Cmd+Q with our
                // transparent + overlay-titlebar setup. Persist on close too.
                let app_handle = app.handle().clone();
                let window_for_event = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        if let Err(err) = app_handle.save_window_state(StateFlags::all()) {
                            crate::elog!(error, "window-state", "save_window_state failed: {err}");
                        }
                        // macOS: the window IS the window process. Closing it
                        // exits the process, so the dock icon (and running dot)
                        // disappears — exactly "remove from the dock on close."
                        // The menu-bar agent is a separate process and keeps
                        // running; reopen via the menu bar or a Finder relaunch.
                        #[cfg(target_os = "macos")]
                        {
                            let _ = (&api, &window_for_event);
                            app_handle.exit(0);
                        }
                        // Windows/Linux stay single-process: hide-to-tray when
                        // the user has the tray enabled and close-to-tray on,
                        // swallowing the close so the process keeps running.
                        #[cfg(not(target_os = "macos"))]
                        if let Some(cache) = app_handle.try_state::<SettingsCache>() {
                            if let Ok(s) = cache.load(&app_handle) {
                                if s.tray.enabled && s.tray.close_to_tray {
                                    api.prevent_close();
                                    let _ = window_for_event.hide();
                                }
                            }
                        }
                    }
                });
            }
            // Tray ownership splits by platform. On Windows/Linux this single
            // process owns the tray directly. On macOS the tray lives in the
            // separate `.accessory` agent process, so the window process spawns
            // that agent (once) instead of installing a tray itself.
            #[cfg(not(target_os = "macos"))]
            if let Err(err) = tray::install(app.handle()) {
                crate::elog!(error, "tray", "install failed: {err}");
            }
            #[cfg(target_os = "macos")]
            macos_agent::spawn_if_needed(app.handle());
            // Native menu bar is macOS-only. On Windows/Linux we hide chrome
            // (decorations:false) and render a custom titlebar — installing a
            // menu there draws an extra horizontal bar above the titlebar that
            // can't be clicked into and looks broken.
            #[cfg(target_os = "macos")]
            if let Err(err) = app_menu::install(app.handle()) {
                crate::elog!(error, "app-menu", "install failed: {err}");
            }
            // The window is configured `visible: false` so a login launch can
            // stay hidden in the tray with no flash. For a normal launch,
            // reveal it now — after geometry + vibrancy have settled, so it
            // appears already centered and styled rather than jumping.
            if !from_autostart {
                #[cfg(target_os = "macos")]
                macos_agent::debug_log(&format!(
                    "window setup: from_autostart={from_autostart} main_exists={}",
                    app.get_webview_window("main").is_some()
                ));
                if let Some(window) = app.get_webview_window("main") {
                    let _shown = window.show();
                    let _focused = window.set_focus();
                    #[cfg(target_os = "macos")]
                    macos_agent::debug_log(&format!(
                        "window setup: show={_shown:?} focus={_focused:?} visible={:?}",
                        window.is_visible()
                    ));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_username,
            commands::get_settings,
            commands::update_settings,
            commands::scan_repos,
            commands::get_repos,
            commands::get_repos_overview,
            commands::get_repo_detail,
            commands::open_in_terminal,
            commands::open_in_vscode,
            commands::open_in_claude,
            commands::open_in_codex,
            commands::open_in_cursor,
            commands::open_path_in_editor,
            commands::get_available_editors,
            commands::git_pull,
            commands::git_delete_branch,
            commands::git_drop_stash,
            commands::get_repo_stashes,
            commands::get_repo_dirty_files,
            commands::get_repo_file_diffs,
            commands::get_repo_branches,
            commands::create_claude_md,
            commands::get_dashboard_summary,
            commands::get_sessions,
            commands::get_session_stats,
            commands::get_session_detail,
            commands::search_transcripts,
            commands::get_costs,
            commands::get_repo_cost_detail,
            commands::get_active_processes,
            commands::kill_process,
            commands::reveal_in_finder,
            commands::get_live_activity,
            commands::get_live_contexts,
            commands::get_terminal_integrations,
            commands::preview_statusline,
            commands::set_claude_statusline,
            commands::set_codex_statusline,
            commands::get_claude_md,
            commands::get_skills,
            commands::read_skill_body,
            commands::get_agents,
            commands::read_agent_body,
            commands::get_hooks,
            commands::get_hygiene,
            commands::list_audit_targets,
            commands::run_audit,
            commands::run_audit_fix,
            commands::get_setup,
            commands::get_setup_overview,
            commands::get_installed_agents,
            commands::get_listening_ports,
            commands::get_diffs,
            commands::get_timeline,
            commands::get_repo_activity,
            commands::get_tool_stats,
            commands::get_deps,
            commands::get_worktrees,
            commands::prune_worktrees,
            commands::unlock_worktree,
            commands::get_env_files,
            commands::get_claude_md_lint_reports,
            commands::take_snapshot,
            commands::list_snapshots,
            commands::delete_snapshot,
            commands::get_usage_limits,
            commands::get_provider_status,
            commands::get_pull_requests,
            commands::write_diagnostics_log,
            commands::append_log_entry,
            commands::read_diagnostics_log,
            commands::refresh_tray,
            commands::open_about_window,
            commands::hide_tray_panel,
            commands::tray_navigate,
            commands::open_main_window,
            commands::take_pending_route,
            commands::quit_app,
            commands::restart_app,
            commands::get_available_update,
            commands::install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app_handle, event| {
            #[cfg(target_os = "macos")]
            match event {
                // Menu-bar agent: it has no window once the panel is hidden, so
                // the "last window closed" signal (code None) would quit it.
                // Keep it alive — it's a background agent. An explicit
                // `app.exit(code)` (Quit) still carries a code and passes through.
                tauri::RunEvent::ExitRequested { code: None, api, .. } if menubar_mode => {
                    api.prevent_exit();
                }
                // Window process: macOS sends Reopen when the running window app
                // is re-activated — a Finder/Launchpad/dock click, or an
                // `open <main.app>` from the agent's "Open"/"Settings". Bring the
                // window forward and honor any pending route the agent stashed.
                // (Dock clicks land here, not on the agent: separate bundle ids.)
                tauri::RunEvent::Reopen { .. } if !menubar_mode => {
                    macos_agent::debug_log("RunEvent::Reopen in window process");
                    tray::show_main_window(app_handle);
                    if let Some(route) = macos_agent::read_pending_route(app_handle) {
                        let _ = app_handle.emit_to(
                            tauri::EventTarget::WebviewWindow {
                                label: "main".into(),
                            },
                            "tray://navigate",
                            route,
                        );
                    }
                }
                // Clear our pidfile on exit so a recycled PID can't later be
                // mistaken for a live counterpart by `terminate_counterpart`.
                tauri::RunEvent::Exit => {
                    macos_agent::clear_pidfile(app_handle, menubar_mode);
                }
                _ => {}
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app_handle, event);
        });
}

/// Window-state plugin for the main window process. `main` skips the
/// plugin's automatic restore-on-create: that pass applies the saved position
/// and `show()`s the window (VISIBLE flag) before `setup` runs, which both
/// breaks the hidden autostart launch and races our own placement below.
/// The plugin still tracks moves/resizes and persists state for `main`.
fn window_state_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_window_state::Builder::default()
        .skip_initial_state("main")
        .build()
}

/// Physical-pixel rectangle (monitor work area or window frame).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Rect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// The subset of the plugin's `.window-state.json` entry we restore.
/// Width/height are the plugin's `inner_size()` and x/y its
/// `outer_position()`, all physical pixels.
#[derive(Clone, Copy, Debug, Default)]
struct SavedGeometry {
    x: i32,
    y: i32,
    prev_x: i32,
    prev_y: i32,
    width: u32,
    height: u32,
    maximized: bool,
    fullscreen: bool,
}

fn read_saved_geometry(app: &tauri::AppHandle) -> Option<SavedGeometry> {
    let path = app.path().app_config_dir().ok()?.join(".window-state.json");
    let contents = std::fs::read_to_string(&path).ok()?;
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&contents) else {
        crate::elog!(error, "window-state", "could not parse {}", path.display());
        return None;
    };
    let state = value.get("main")?.as_object()?;
    let int = |k: &str| state.get(k).and_then(|v| v.as_i64()).map(|v| v as i32);
    let flag = |k: &str| state.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    let width = state.get("width").and_then(|v| v.as_u64())? as u32;
    let height = state.get("height").and_then(|v| v.as_u64())? as u32;
    if width == 0 || height == 0 {
        return None;
    }
    let x = int("x")?;
    let y = int("y")?;
    Some(SavedGeometry {
        x,
        y,
        prev_x: int("prev_x").unwrap_or(x),
        prev_y: int("prev_y").unwrap_or(y),
        width,
        height,
        maximized: flag("maximized"),
        fullscreen: flag("fullscreen"),
    })
}

/// True when enough of the window's top edge (where the title bar / drag
/// region lives) lands inside `area` for the user to grab it.
fn title_bar_visible(frame: Rect, area: Rect) -> bool {
    const STRIP: i64 = 40;
    let left = (frame.x as i64).max(area.x as i64);
    let right = (frame.x as i64 + frame.width as i64).min(area.x as i64 + area.width as i64);
    let top = (frame.y as i64).max(area.y as i64);
    let bottom = (frame.y as i64 + STRIP).min(area.y as i64 + area.height as i64);
    right - left >= 100 && bottom - top >= STRIP / 2
}

/// Decide where the main window opens. Returns the frame to apply.
///
/// - A saved frame whose title bar is still reachable on some monitor is
///   reused verbatim — the window reopens exactly where it was left.
/// - Otherwise (first launch, monitor unplugged, layout changed) the window
///   is centered on the primary monitor's work area, with the size clamped to
///   fit. Centering uses the size we are about to apply rather than reading
///   `outer_size()` back, which lags behind `set_size` on some platforms and
///   used to land the window toward the bottom-right.
fn plan_window_frame(
    saved: Option<SavedGeometry>,
    default_size: (u32, u32),
    work_areas: &[Rect],
    primary: Option<Rect>,
) -> Option<Rect> {
    let (width, height) = saved.map_or(default_size, |s| (s.width, s.height));
    if let Some(s) = saved {
        // Position isn't recorded while maximized; `prev_*` holds the last
        // un-maximized spot, which is what the plugin restores too.
        let (x, y) = if s.maximized {
            (s.prev_x, s.prev_y)
        } else {
            (s.x, s.y)
        };
        let frame = Rect {
            x,
            y,
            width,
            height,
        };
        if work_areas.iter().any(|a| title_bar_visible(frame, *a)) {
            return Some(frame);
        }
    }
    let area = primary.or_else(|| work_areas.first().copied())?;
    let width = width.min(area.width);
    let height = height.min(area.height);
    Some(Rect {
        x: area.x + (area.width - width) as i32 / 2,
        y: area.y + (area.height - height) as i32 / 2,
        width,
        height,
    })
}

/// Restore the main window to its last size and position (see
/// `plan_window_frame`), then re-apply maximized/fullscreen.
fn apply_saved_window_geometry(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let saved = read_saved_geometry(app);
    let default_size = window
        .inner_size()
        .map(|s| (s.width, s.height))
        .unwrap_or((1280, 800));
    let to_rect = |m: &tauri::Monitor| {
        let a = m.work_area();
        Rect {
            x: a.position.x,
            y: a.position.y,
            width: a.size.width,
            height: a.size.height,
        }
    };
    let work_areas: Vec<Rect> = window
        .available_monitors()
        .map(|ms| ms.iter().map(to_rect).collect())
        .unwrap_or_default();
    let primary = window.primary_monitor().ok().flatten().map(|m| to_rect(&m));

    match plan_window_frame(saved, default_size, &work_areas, primary) {
        Some(frame) => {
            // Size first, then position: on macOS a resize keeps the top-left
            // fixed, so the reverse order would leave the window offset.
            if let Err(err) = window.set_size(PhysicalSize::new(frame.width, frame.height)) {
                crate::elog!(error, "window-state", "set_size failed: {err}");
            }
            if let Err(err) = window.set_position(PhysicalPosition::new(frame.x, frame.y)) {
                crate::elog!(error, "window-state", "set_position failed: {err}");
            }
        }
        // No monitor info at all — let the platform pick.
        None => {
            let _ = window.center();
        }
    }

    if let Some(s) = saved {
        if s.maximized {
            let _ = window.maximize();
        }
        if s.fullscreen {
            let _ = window.set_fullscreen(true);
        }
    }
}

fn apply_window_effects(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        // `Sidebar` matches the SwiftUI/AppKit sidebar material — the canonical
        // translucent gray that reads as "Mac-native" rather than HUD.
        let _ = apply_vibrancy(
            &window,
            NSVisualEffectMaterial::Sidebar,
            Some(NSVisualEffectState::Active),
            Some(10.0),
        );
    }

    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::apply_mica;
        let _ = window.set_decorations(false);
        let _ = apply_mica(&window, Some(true));
    }

    #[cfg(target_os = "linux")]
    {
        // Most compositors lack window-level blur; just drop chrome for a custom titlebar.
        let _ = window.set_decorations(false);
    }

    let _ = &window;
    Ok(())
}

#[cfg(test)]
mod window_frame_tests {
    use super::*;

    const LAPTOP: Rect = Rect {
        x: 0,
        y: 50,
        width: 3024,
        height: 1840,
    };
    const EXTERNAL: Rect = Rect {
        x: 3024,
        y: 0,
        width: 2560,
        height: 1440,
    };

    fn saved(x: i32, y: i32) -> SavedGeometry {
        SavedGeometry {
            x,
            y,
            prev_x: x,
            prev_y: y,
            width: 2000,
            height: 1200,
            ..Default::default()
        }
    }

    #[test]
    fn restores_last_position_when_on_screen() {
        let f = plan_window_frame(Some(saved(400, 300)), (1280, 800), &[LAPTOP], Some(LAPTOP));
        assert_eq!(
            f,
            Some(Rect {
                x: 400,
                y: 300,
                width: 2000,
                height: 1200
            })
        );
    }

    #[test]
    fn restores_onto_secondary_monitor() {
        let f = plan_window_frame(
            Some(saved(3200, 100)),
            (1280, 800),
            &[LAPTOP, EXTERNAL],
            Some(LAPTOP),
        );
        assert_eq!(f.map(|r| (r.x, r.y)), Some((3200, 100)));
    }

    #[test]
    fn recenters_when_saved_monitor_is_gone() {
        let f = plan_window_frame(Some(saved(3200, 100)), (1280, 800), &[LAPTOP], Some(LAPTOP))
            .unwrap();
        assert_eq!(
            (f.x, f.y),
            (LAPTOP.x + (3024 - 2000) / 2, LAPTOP.y + (1840 - 1200) / 2)
        );
    }

    #[test]
    fn recenters_when_title_bar_is_offscreen() {
        // Top edge above the work area (e.g. under the macOS menu bar).
        let f = plan_window_frame(Some(saved(400, -500)), (1280, 800), &[LAPTOP], Some(LAPTOP))
            .unwrap();
        assert_eq!(f.x, 512);
    }

    #[test]
    fn first_launch_centers_default_size() {
        let f = plan_window_frame(None, (2560, 1600), &[LAPTOP], Some(LAPTOP)).unwrap();
        assert_eq!(
            f,
            Rect {
                x: 232,
                y: 50 + 120,
                width: 2560,
                height: 1600
            }
        );
    }

    #[test]
    fn oversized_window_is_clamped_when_recentering() {
        let mut s = saved(9000, 9000);
        s.width = 5000;
        s.height = 4000;
        let f = plan_window_frame(Some(s), (1280, 800), &[LAPTOP], Some(LAPTOP)).unwrap();
        assert_eq!(f, LAPTOP);
    }

    #[test]
    fn maximized_uses_prev_position() {
        let s = SavedGeometry {
            maximized: true,
            x: 0,
            y: 0,
            prev_x: 300,
            prev_y: 200,
            ..saved(0, 0)
        };
        let f = plan_window_frame(Some(s), (1280, 800), &[LAPTOP], Some(LAPTOP)).unwrap();
        assert_eq!((f.x, f.y), (300, 200));
    }
}
