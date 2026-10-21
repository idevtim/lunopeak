//! Application menu (top-of-screen on macOS, hidden on Win/Linux which use
//! their own custom titlebar via `decorations: false`).
//!
//! Tauri auto-generates a default macOS menu when none is set, but it only
//! exposes About + Hide + Quit. We replace it so we can add Check for
//! Updates, Settings, the View jump-to-panel shortcuts, and a Cmd+P command
//! palette item — all of which fan out to the webview through `app://*`
//! events that App.tsx listens for.
//!
//! Menu item IDs are stable strings (not auto-generated u64s) so the
//! dispatcher in `handle_menu_event` can match on them without a lookup
//! table.
//!
//! `install` and its helpers are macOS-only — Windows/Linux callers must
//! skip them. `open_about_window[_with]` is cross-platform; commands.rs
//! invokes it from the in-app About button on every OS.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

const ABOUT_WINDOW_LABEL: &str = "about";

/// Build + install the application menu. Called once during setup.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()));
    Ok(())
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let pkg = app.package_info();
    let app_name = pkg.name.clone();

    // ── App submenu (named after the app on macOS) ────────────────────
    //
    // The standard NSAboutPanel item is replaced with `about-custom` —
    // that ID routes to our redesigned webview-based About window
    // instead of the bare gray AppKit panel.
    let about_custom =
        MenuItemBuilder::with_id("about-custom", format!("About {app_name}")).build(app)?;
    let check_updates =
        MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?;
    let settings_item = MenuItemBuilder::with_id("nav:settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    // Custom Quit (not `PredefinedMenuItem::quit`, which calls `terminate:`
    // directly and can't be hooked). On macOS "Quit" / Cmd+Q must close BOTH
    // processes — the window AND the separate menu-bar agent — whereas the red
    // close button exits only the window process and leaves the menu bar alive.
    // Routing through our own ID lets `handle_menu_event` do that.
    let quit = MenuItemBuilder::with_id("quit-all", format!("Quit {app_name}"))
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    #[allow(unused_mut)]
    let mut app_submenu = SubmenuBuilder::new(app, &app_name)
        .item(&about_custom)
        .item(&check_updates)
        .separator()
        .item(&settings_item);

    #[cfg(target_os = "macos")]
    {
        let services = PredefinedMenuItem::services(app, None)?;
        let hide = PredefinedMenuItem::hide(app, None)?;
        let hide_others = PredefinedMenuItem::hide_others(app, None)?;
        let show_all = PredefinedMenuItem::show_all(app, None)?;
        app_submenu = app_submenu
            .separator()
            .item(&services)
            .separator()
            .item(&hide)
            .item(&hide_others)
            .item(&show_all);
    }

    let app_submenu = app_submenu.separator().item(&quit).build()?;

    // ── View submenu — jump-to-panel shortcuts + reload + palette ─────
    let palette = MenuItemBuilder::with_id("palette", "Go to…")
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    let toggle_fullscreen = MenuItemBuilder::with_id("toggle-fullscreen", "Toggle Fullscreen")
        .accelerator("Ctrl+Cmd+F")
        .build(app)?;

    let mut view_builder = SubmenuBuilder::new(app, "View").item(&palette).separator();

    for (idx, (id, label)) in NAV_ITEMS.iter().enumerate() {
        // ⌘1–⌘9 jump straight to the matching panel. Past 9 we drop the
        // accelerator — single-digit keys aren't enough for 27 routes,
        // and the palette covers the rest.
        let mut item = MenuItemBuilder::with_id(format!("nav:{id}"), *label);
        if idx < 9 {
            item = item.accelerator(format!("CmdOrCtrl+{}", idx + 1));
        }
        let item = item.build(app)?;
        view_builder = view_builder.item(&item);
    }

    let view_submenu = view_builder.separator().item(&toggle_fullscreen).build()?;

    // ── Window submenu — standard mac items ───────────────────────────
    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let zoom = PredefinedMenuItem::maximize(app, Some("Zoom"))?;
    let close_window = PredefinedMenuItem::close_window(app, None)?;
    let window_submenu = SubmenuBuilder::new(app, "Window")
        .item(&minimize)
        .item(&zoom)
        .separator()
        .item(&close_window)
        .build()?;

    // ── Help submenu — external links + diagnostics ──────────────────
    let github = MenuItemBuilder::with_id("help:github", "LunoPeak on GitHub").build(app)?;
    let releases = MenuItemBuilder::with_id("help:releases", "Release Notes").build(app)?;
    let issues = MenuItemBuilder::with_id("help:issues", "Report an Issue").build(app)?;
    let sponsor = MenuItemBuilder::with_id("help:sponsor", "Sponsor on GitHub").build(app)?;
    let export_log =
        MenuItemBuilder::with_id("export-log", "Export Diagnostics Log…").build(app)?;
    let help_submenu = SubmenuBuilder::new(app, "Help")
        .item(&github)
        .item(&releases)
        .item(&issues)
        .separator()
        .item(&sponsor)
        .separator()
        .item(&export_log)
        .build()?;

    // Mark this submenu as the NSHelpMenu so macOS auto-inserts its native
    // search field at the top — same effect Electron gets from `role: 'help'`.
    // The search box indexes our help-menu items (and Apple's system-wide
    // help) and lets the user fuzzy-jump to any of them by name. macOS-only;
    // no equivalent on Windows/Linux, and `install` already short-circuits
    // there, but guard anyway in case that changes.
    #[cfg(target_os = "macos")]
    help_submenu.set_as_help_menu_for_nsapp()?;

    // ── Top-level assembly ────────────────────────────────────────────
    let menu = MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&view_submenu)
        .item(&window_submenu)
        .item(&help_submenu)
        .build()?;

    Ok(menu)
}

const NAV_ITEMS: &[(&str, &str)] = &[
    ("dashboard", "Home"),
    ("live", "Live"),
    ("sessions", "Sessions"),
    ("costs", "Costs"),
    ("repos", "Repos"),
    ("assistant", "Assistant"),
    ("setup", "Setup Checklist"),
    ("hygiene", "Hygiene"),
    ("ports", "Ports"),
    ("transcripts", "Transcripts"),
    ("tools", "Tools"),
    ("work-graph", "Work Graph"),
    ("timeline", "Timeline"),
    ("diffs", "Diffs"),
    ("repo-pulse", "Repo Pulse"),
    ("skills", "Skills"),
    ("agents", "Subagents"),
    ("memory", "Memory"),
    ("hooks", "Hooks"),
    ("lint", "Lint"),
    ("deps", "Dependencies"),
    ("env", "Environment"),
    ("snapshots", "Snapshots"),
    ("worktrees", "Worktrees"),
];

fn handle_menu_event(app: &AppHandle, id: &str) {
    if let Some(route) = id.strip_prefix("nav:") {
        focus_main_window(app);
        let _ = app.emit_to(
            tauri::EventTarget::WebviewWindow {
                label: "main".into(),
            },
            "tray://navigate",
            route.to_string(),
        );
        return;
    }
    if let Some(target) = id.strip_prefix("help:") {
        let url = match target {
            "github" => "https://github.com/idevtim/lunopeak",
            "releases" => "https://github.com/idevtim/lunopeak/releases",
            "issues" => "https://github.com/idevtim/lunopeak/issues/new",
            "sponsor" => "https://github.com/sponsors/idevtim",
            _ => return,
        };
        open_external(app, url);
        return;
    }

    match id {
        "quit-all" => {
            // Cmd+Q / app-menu Quit: close the window AND the menu-bar agent.
            crate::commands::quit_all(app);
        }
        "about-custom" => {
            if let Err(err) = open_about_window_with(app, None) {
                crate::elog!(error, "about", "open failed: {err}");
            }
        }
        "check-updates" => {
            // Funnel through the About window — the redesigned panel is
            // where the check-flow visibly lives. The query hint tells
            // the About view to auto-trigger a check on mount.
            if let Err(err) = open_about_window_with(app, Some("check=1")) {
                crate::elog!(error, "about", "open failed: {err}");
            }
        }
        "palette" => {
            focus_main_window(app);
            emit(app, "app://palette", "");
        }
        "toggle-fullscreen" => {
            if let Some(window) = app.get_webview_window("main") {
                let next = !window.is_fullscreen().unwrap_or(false);
                let _ = window.set_fullscreen(next);
            }
        }
        "export-log" => {
            // Direct trigger — the frontend listens for this event,
            // builds a redacted JSON payload, and shows the save dialog.
            // No window-opening; the export is the entire interaction.
            focus_main_window(app);
            emit(app, "app://export-log", "");
        }
        _ => {}
    }
}

fn emit(app: &AppHandle, event: &str, payload: &str) {
    let _ = app.emit_to(
        tauri::EventTarget::WebviewWindow {
            label: "main".into(),
        },
        event,
        payload.to_string(),
    );
}

fn focus_main_window(app: &AppHandle) {
    // App is permanently `.accessory` on macOS — see lib.rs setup. No dock
    // flip needed; accessory apps can still focus arbitrary windows.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn open_external(app: &AppHandle, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_url(url, None::<&str>);
}

/// Open (or focus) the redesigned About window. The frontend renders at
/// `index.html#/about` — small, frameless, transparent so the design carries
/// the chrome instead of the OS title bar.
pub fn open_about_window(app: &AppHandle) -> tauri::Result<()> {
    open_about_window_with(app, None)
}

/// Same as `open_about_window` but appends a query string to the hash so
/// the React side can react (e.g. `check=1` auto-triggers a version check).
pub fn open_about_window_with(app: &AppHandle, query: Option<&str>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(ABOUT_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(q) = query {
            // Window already exists — tell React via an event since we can't
            // mutate its URL without a full reload.
            let _ = app.emit_to(
                tauri::EventTarget::WebviewWindow {
                    label: ABOUT_WINDOW_LABEL.into(),
                },
                "about://hint",
                q.to_string(),
            );
        }
        return Ok(());
    }

    let path = match query {
        Some(q) => format!("index.html#/about?{q}"),
        None => "index.html#/about".to_string(),
    };
    let url = tauri::WebviewUrl::App(path.into());
    // No transparency / vibrancy on the about window. The translucent
    // HudWindow material clashed with `text-zinc-900` text in light mode
    // and made the panel read as just a logo on glass; a solid themed bg
    // is more reliable for a small fixed-size popover.
    #[allow(unused_mut)]
    let mut builder = tauri::WebviewWindowBuilder::new(app, ABOUT_WINDOW_LABEL, url)
        .title("About LunoPeak")
        .inner_size(460.0, 410.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .visible(true)
        .focused(true);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    let _ = builder.build()?;
    Ok(())
}
