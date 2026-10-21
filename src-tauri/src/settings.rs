use crate::models::{ApiKeys, Settings};
use anyhow::{Context, Result};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "settings.json";
const KEYCHAIN_SERVICE: &str = "com.lunopeak.app";

pub fn config_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .context("could not determine app config dir")?;
    Ok(dir)
}

pub fn ensure_config_dir(app: &AppHandle) -> Result<()> {
    let dir = config_dir(app)?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
    }
    Ok(())
}

pub fn load(app: &AppHandle) -> Result<Settings> {
    let path = config_dir(app)?.join(SETTINGS_FILE);
    let fresh_install = !path.exists();
    let mut settings: Settings = if fresh_install {
        let mut s = Settings::default();
        // Sentinel for the frontend's one-time Ollama probe. Cleared after
        // the probe runs, regardless of whether Ollama was found.
        s.first_run = true;
        s
    } else {
        let raw = std::fs::read_to_string(&path)?;
        serde_json::from_str(&raw).unwrap_or_default()
    };

    // Migrate any keys that older builds wrote into settings.json: move them
    // into the keychain, then rewrite the file without them so the plaintext
    // copy stops existing on disk. The menu-bar agent never touches the
    // keychain (see `crate::is_menubar_agent`): it leaves any legacy keys in
    // place for the window to migrate and round-trips them untouched.
    let agent = crate::is_menubar_agent();
    let mut migrated = false;
    let mut migrate = |provider: &str, slot: &mut Option<String>| {
        if let Some(value) = slot.take() {
            if !value.is_empty() {
                let _ = write_keychain_value(provider, Some(&value));
                migrated = true;
            }
        }
    };
    if !agent {
        migrate("anthropic", &mut settings.api_keys.anthropic);
        migrate("openai", &mut settings.api_keys.openai);
        migrate("gemini", &mut settings.api_keys.gemini);
        migrate("xai", &mut settings.api_keys.xai);
    }

    // Force-enable all known agents on first encounter. v1.0/v1.1 wrote
    // codex=false; this flips them on without overriding any later user
    // choice (the sentinel keeps the migration one-shot).
    if !settings.agents.initialized {
        settings.agents.claude_code = true;
        settings.agents.codex = true;
        settings.agents.cursor = true;
        settings.agents.initialized = true;
        migrated = true;
    }

    if !agent {
        settings.api_keys = read_api_keys();
    }

    if migrated {
        ensure_config_dir(app)?;
        let mut sanitized = settings.clone();
        if !agent {
            sanitized.api_keys = ApiKeys::default();
        }
        let raw = serde_json::to_string_pretty(&sanitized)?;
        std::fs::write(&path, raw)?;
    }

    Ok(settings)
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<()> {
    ensure_config_dir(app)?;
    let path = config_dir(app)?.join(SETTINGS_FILE);

    // API keys live in the OS keychain — Keychain on macOS, Credential Manager
    // on Windows, Secret Service on Linux. settings.json is for non-secret
    // prefs only. The agent never touches the keychain, and its loaded copy
    // of `api_keys` may be stale (the window can migrate legacy plaintext keys
    // out of the file after the agent loaded it). So it keeps whatever keys
    // the file holds right now — writing its own copy would resurrect keys
    // the window already stripped, which the next migration would then copy
    // over the user's newer keychain value.
    if crate::is_menubar_agent() {
        let on_disk = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
            .map(|s| s.api_keys)
            .unwrap_or_default();
        let mut out = settings.clone();
        out.api_keys = on_disk;
        let raw = serde_json::to_string_pretty(&out)?;
        std::fs::write(&path, raw)?;
        return Ok(());
    }
    write_keychain_value("anthropic", settings.api_keys.anthropic.as_deref())?;
    write_keychain_value("openai", settings.api_keys.openai.as_deref())?;
    write_keychain_value("gemini", settings.api_keys.gemini.as_deref())?;
    write_keychain_value("xai", settings.api_keys.xai.as_deref())?;

    let mut sanitized = settings.clone();
    sanitized.api_keys = ApiKeys::default();
    let raw = serde_json::to_string_pretty(&sanitized)?;
    std::fs::write(&path, raw)?;
    Ok(())
}

fn read_api_keys() -> ApiKeys {
    ApiKeys {
        anthropic: read_keychain_value("anthropic"),
        openai: read_keychain_value("openai"),
        gemini: read_keychain_value("gemini"),
        xai: read_keychain_value("xai"),
    }
}

fn read_keychain_value(provider: &str) -> Option<String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, provider).ok()?;
    let value = entry.get_password().ok()?;
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn write_keychain_value(provider: &str, value: Option<&str>) -> Result<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, provider).context("open keyring entry")?;
    match value {
        Some(v) if !v.is_empty() => entry.set_password(v).context("write keyring entry")?,
        _ => {
            // delete_credential returns NoEntry when nothing is stored — treat
            // that as a successful no-op.
            let _ = entry.delete_credential();
        }
    }
    Ok(())
}
