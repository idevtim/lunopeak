// Prevents an additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("statusline") {
        std::process::exit(lunopeak_lib::statusline_cli(&args[2..]));
    }
    lunopeak_lib::run();
}
