//! macOS tray popover. The panel's webview lives in a system `NSPopover`
//! anchored to the status item's button — the same approach ChillMac uses —
//! so AppKit draws the arrow, the material, the shadow and the rounded
//! corners, and places the popover under the icon on whichever display and
//! Space the menu bar is on.
//!
//! Tauri still builds the `tray-panel` webview window (that's what IPC,
//! events and capabilities are keyed on), but the window itself is never
//! shown: on first open we lift its content view — wry's parent view holding
//! the WKWebView — out of the window and make it the popover's content.
//!
//! Everything here runs on the main thread. Tray clicks already arrive there;
//! other callers hop over with `run_on_main_thread`, which runs inline when
//! the caller is already on it.

use std::cell::RefCell;
use std::ptr::NonNull;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSAppearance, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSApplication,
    NSAutoresizingMaskOptions, NSBox, NSBoxType, NSColor, NSEvent, NSEventMask, NSPopover,
    NSPopoverBehavior, NSStatusBarButton, NSStatusItem, NSTitlePosition, NSView, NSViewController, NSWindow,
    NSWindowOrderingMode,
};
use objc2_foundation::{
    ns_string, NSDistributedNotificationCenter, NSNotification, NSObjectProtocol,
    NSOperationQueue, NSRectEdge, NSSize, NSUserDefaults,
};
use tauri::{AppHandle, Emitter, Manager};

thread_local! {
    static POPOVER: RefCell<Option<Retained<NSPopover>>> = const { RefCell::new(None) };
    /// Global mouse-down monitor that closes the popover on a click in any
    /// other app, installed while the popover is shown.
    static OUTSIDE_CLICKS: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    /// Backdrop tint under the popover's frame (see `ensure_tint`).
    static TINT: RefCell<Option<Retained<NSBox>>> = const { RefCell::new(None) };
    /// Observer for the OS light/dark switch (see `observe_system_theme`).
    static THEME_OBSERVER: RefCell<Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>> =
        const { RefCell::new(None) };
    /// Whether the tint should be the dark shade, from `resolves_dark`.
    static TINT_DARK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// The status item button the popover is anchored to, so the outside-click
    /// monitor can tell a click on our own icon apart.
    static ANCHOR: RefCell<Option<Retained<NSStatusBarButton>>> = const { RefCell::new(None) };
}

/// Backdrop tint opacity. The system popover material alone is see-through
/// enough on recent macOS that whatever sits behind it washes out the panel's
/// secondary text.
/// Dark mode: about the dark window-background grey.
const TINT_WHITE_DARK: f64 = 0.16;
const TINT_ALPHA_DARK: f64 = 0.82;
/// Light mode uses a soft grey of its own: the window-background grey turns
/// murky under the glass, and near-white loses the white cards against it.
const TINT_WHITE_LIGHT: f64 = 0.93;
const TINT_ALPHA_LIGHT: f64 = 0.84;

pub fn is_shown() -> bool {
    POPOVER.with_borrow(|p| p.as_ref().is_some_and(|p| p.isShown()))
}

/// Show the popover under `item`, adopting `window`'s webview on first use.
/// Returns false when the popover couldn't be shown.
pub fn show(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    item: &NSStatusItem,
    theme: &str,
) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        crate::elog!(error, "tray-panel", "popover show off the main thread");
        return false;
    };
    let Some(button) = item.button(mtm) else {
        crate::elog!(warn, "tray-panel", "status item has no button to anchor to");
        return false;
    };
    let Some(popover) = POPOVER.with_borrow(|p| p.clone()).or_else(|| build(mtm, window)) else {
        return false;
    };

    apply_shade(&popover, resolves_dark(mtm, theme));
    popover.showRelativeToRect_ofView_preferredEdge(button.bounds(), &button, NSRectEdge::MinY);
    // Same as ChillMac: activate so the webview's window becomes key (typing
    // in the budget fields, DOM focus/blur). The agent owns no other windows,
    // so activating can't pull the user to another Space.
    #[allow(deprecated)]
    NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
    let popover_window = popover.contentViewController().and_then(|vc| vc.view().window());
    if let Some(w) = &popover_window {
        ensure_tint(mtm, w);
        w.makeKeyAndOrderFront(None);
    }
    crate::elog!(
        info,
        "tray-panel",
        "popover shown: onActiveSpace={:?} key={:?} theme={theme} dark={}",
        popover_window.as_ref().map(|w| w.isOnActiveSpace()),
        popover_window.as_ref().map(|w| w.isKeyWindow()),
        TINT_DARK.get(),
    );
    ANCHOR.with_borrow_mut(|a| *a = Some(button));
    watch_outside_clicks(app);
    true
}

/// Close the popover if it's open. Tells the webview so it can drop to
/// invisible before the next show replays the entry animation.
pub fn close(app: &AppHandle) {
    let was_shown = POPOVER.with_borrow(|p| {
        let shown = p.as_ref().is_some_and(|p| p.isShown());
        if let Some(p) = p.as_ref().filter(|_| shown) {
            p.close();
        }
        shown
    });
    stop_watching_outside_clicks();
    if was_shown {
        if let Some(window) = app.get_webview_window(crate::tray::TRAY_PANEL_LABEL) {
            let _ = window.emit("tray-panel://hide", ());
        }
    }
}

/// Re-apply the theme to an open popover, so the material and arrow follow
/// an Appearance change made from inside it.
pub fn set_theme(theme: &str) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    if let Some(p) = POPOVER.with_borrow(|p| p.clone()) {
        apply_shade(&p, resolves_dark(mtm, theme));
    }
}

fn build(mtm: MainThreadMarker, window: &tauri::WebviewWindow) -> Option<Retained<NSPopover>> {
    let Ok(ns_window) = window.ns_window() else {
        crate::elog!(error, "tray-panel", "popover build: no NSWindow");
        return None;
    };
    // SAFETY: Tauri hands back its live NSWindow; we're on the main thread.
    let ns_window = unsafe { &*(ns_window as *const objc2_app_kit::NSWindow) };
    let Some(content) = ns_window.contentView() else {
        crate::elog!(error, "tray-panel", "popover build: window has no content view");
        return None;
    };
    // Detach wry's parent view (and the WKWebView inside it) from the hidden
    // window, leaving an empty placeholder behind.
    ns_window.setContentView(Some(&NSView::new(mtm)));

    let size = NSSize::new(crate::tray::PANEL_WIDTH, crate::tray::PANEL_HEIGHT);
    content.setFrameSize(size);
    let controller = NSViewController::new(mtm);
    controller.setView(&content);

    let popover = NSPopover::new(mtm);
    // We close it ourselves: on a tray click, a click in another app, or an
    // action in the panel. `Transient` doesn't see clicks while the agent is
    // inactive, and it races the tray icon's own toggle.
    popover.setBehavior(NSPopoverBehavior::ApplicationDefined);
    // The webview plays its own staggered entry animation on every show.
    popover.setAnimates(false);
    popover.setContentSize(size);
    popover.setContentViewController(Some(&controller));
    POPOVER.with_borrow_mut(|p| *p = Some(popover.clone()));
    observe_system_theme(window.app_handle());
    Some(popover)
}

/// Lay a window-background tint under the popover's frame view, so it covers
/// the arrow as well as the body — tinting the page instead would leave the
/// arrow a different shade from the panel under it. Re-inserted whenever
/// AppKit hands the popover a fresh window.
fn ensure_tint(mtm: MainThreadMarker, popover_window: &NSWindow) {
    // SAFETY: plain view-hierarchy reads on the main thread.
    let Some(frame) = popover_window.contentView().and_then(|v| unsafe { v.superview() }) else {
        return;
    };
    let attached = TINT.with_borrow(|t| {
        t.as_ref()
            .and_then(|t| unsafe { t.superview() })
            .is_some_and(|sv| Retained::as_ptr(&sv) == Retained::as_ptr(&frame))
    });
    if attached {
        return;
    }
    let tint = TINT.with_borrow(|t| t.clone()).unwrap_or_else(|| {
        let tint = NSBox::new(mtm);
        tint.setBoxType(NSBoxType::Custom);
        tint.setTitlePosition(NSTitlePosition::NoTitle);
        tint.setBorderWidth(0.0);
        tint.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        TINT.with_borrow_mut(|t| *t = Some(tint.clone()));
        tint
    });
    tint.setFillColor(&tint_color());
    tint.removeFromSuperview();
    tint.setFrame(frame.bounds());
    frame.addSubview_positioned_relativeTo(&tint, NSWindowOrderingMode::Below, None);
}

/// Pin the popover to light or dark and tint to match. Always explicit, even
/// for "Match system": left unset (`nil`), the popover renders its material
/// differently — murkier — than when pinned, so "Match system" looked wrong
/// next to the same choice made explicitly.
fn apply_shade(popover: &NSPopover, dark: bool) {
    TINT_DARK.set(dark);
    let name = if dark {
        unsafe { NSAppearanceNameDarkAqua }
    } else {
        unsafe { NSAppearanceNameAqua }
    };
    popover.setAppearance(NSAppearance::appearanceNamed(name).as_deref());
    if let Some(tint) = TINT.with_borrow(|t| t.clone()) {
        tint.setFillColor(&tint_color());
    }
}

/// Whether the panel is dark: straight from the theme setting, or the OS
/// setting for "Match system".
fn resolves_dark(_mtm: MainThreadMarker, theme: &str) -> bool {
    match theme {
        "dark" => true,
        "light" => false,
        _ => system_is_dark(),
    }
}

/// The OS light/dark setting itself. Not the app's or a view's appearance:
/// once the popover is pinned (see `apply_shade`), everything inside it —
/// the webview's `prefers-color-scheme` included — reports the pinned shade.
fn system_is_dark() -> bool {
    NSUserDefaults::standardUserDefaults()
        .stringForKey(ns_string!("AppleInterfaceStyle"))
        .is_some_and(|style| style.to_string() == "Dark")
}

/// Follow OS light/dark switches under "Match system" — including while the
/// popover is open, which no show-time check would catch.
fn observe_system_theme(app: &AppHandle) {
    if THEME_OBSERVER.with_borrow(|o| o.is_some()) {
        return;
    }
    let app = app.clone();
    let handler = block2::RcBlock::new(move |_note: NonNull<NSNotification>| {
        if crate::tray::current_theme(&app) != "system" {
            return;
        }
        if let Some(p) = POPOVER.with_borrow(|p| p.clone()) {
            let dark = system_is_dark();
            apply_shade(&p, dark);
            crate::elog!(info, "tray-panel", "popover follows OS switch: dark={dark}");
        }
    });
    // SAFETY: the block only captures an `AppHandle` (Send) and runs on the
    // main queue, where the popover state lives.
    let token = unsafe {
        NSDistributedNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(ns_string!("AppleInterfaceThemeChangedNotification")),
            None,
            Some(&NSOperationQueue::mainQueue()),
            &handler,
        )
    };
    THEME_OBSERVER.with_borrow_mut(|o| *o = Some(token));
}

/// A fixed colour for the current `TINT_DARK`; re-set whenever it changes.
fn tint_color() -> Retained<NSColor> {
    if TINT_DARK.get() {
        NSColor::colorWithWhite_alpha(TINT_WHITE_DARK, TINT_ALPHA_DARK)
    } else {
        NSColor::colorWithWhite_alpha(TINT_WHITE_LIGHT, TINT_ALPHA_LIGHT)
    }
}

fn watch_outside_clicks(app: &AppHandle) {
    stop_watching_outside_clicks();
    let app = app.clone();
    let handler = block2::RcBlock::new(move |_event: NonNull<NSEvent>| {
        // A click on our own menu bar icon reaches this monitor as well as the
        // tray toggle. Closing here would leave the toggle to find a hidden
        // popover a moment later and reopen it, so leave that click to it.
        if anchor_contains_mouse() {
            return;
        }
        close(&app);
    });
    let monitor = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
        NSEventMask::LeftMouseDown | NSEventMask::RightMouseDown | NSEventMask::OtherMouseDown,
        &handler,
    );
    OUTSIDE_CLICKS.with_borrow_mut(|m| *m = monitor);
}

/// Whether the pointer is over the status item button the popover hangs from.
fn anchor_contains_mouse() -> bool {
    ANCHOR.with_borrow(|a| {
        let Some(button) = a.as_ref() else { return false };
        let Some(window) = button.window() else { return false };
        let in_window = button.convertRect_toView(button.bounds(), None);
        let on_screen = window.convertRectToScreen(in_window);
        let mouse = NSEvent::mouseLocation();
        mouse.x >= on_screen.origin.x
            && mouse.x <= on_screen.origin.x + on_screen.size.width
            && mouse.y >= on_screen.origin.y
            && mouse.y <= on_screen.origin.y + on_screen.size.height
    })
}

fn stop_watching_outside_clicks() {
    if let Some(monitor) = OUTSIDE_CLICKS.with_borrow_mut(|m| m.take()) {
        // SAFETY: `monitor` came from `addGlobalMonitorForEventsMatchingMask`
        // and is removed exactly once.
        unsafe { NSEvent::removeMonitor(&monitor) };
    }
}
