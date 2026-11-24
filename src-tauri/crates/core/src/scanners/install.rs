//! Inventory of the user's Claude Code + Codex + Cursor installation: agent
//! config dirs, MCP servers, and installed Claude plugins.

use crate::models::{
    ClaudeConfig, CodexConfig, CursorConfig, InstalledAgents, McpServerEntry, PluginEntry,
};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

/// Filesystem probe for which agents are installed on this machine. Cheap —
/// just checks whether the canonical config dir exists. Lets the frontend
/// adapt copy and hide / disable Claude-specific features for users who only
/// run Codex or Cursor.
pub fn installed_agents() -> InstalledAgents {
    let home = dirs::home_dir();
    let claude = home
        .as_ref()
        .map(|h| h.join(".claude").is_dir())
        .unwrap_or(false);
    let codex = home
        .as_ref()
        .map(|h| h.join(".codex").is_dir())
        .unwrap_or(false);
    let cursor = home
        .as_ref()
        .map(|h| h.join(".cursor").is_dir())
        .unwrap_or(false);
    InstalledAgents {
        claude_code: claude,
        codex,
        cursor,
    }
}

/// Model + default permission mode from ~/.claude/settings.json.
pub fn claude_config() -> Option<ClaudeConfig> {
    let path = dirs::home_dir()?.join(".claude").join("settings.json");
    let raw = fs::read_to_string(&path).ok()?;
    let json = serde_json::from_str::<Value>(&raw).ok()?;
    let str_at = |v: Option<&Value>| v.and_then(|v| v.as_str()).map(|s| s.to_string());
    Some(ClaudeConfig {
        path: path.to_string_lossy().into_owned(),
        model: str_at(json.get("model")),
        permission_mode: str_at(json.get("permissions").and_then(|p| p.get("defaultMode"))),
    })
}

/// MCP servers declared in ~/.codex/config.toml (`[mcp_servers.<name>]`).
/// Returned with scope="codex".
pub fn codex_mcp_servers() -> Vec<McpServerEntry> {
    let Some(path) = dirs::home_dir().map(|h| h.join(".codex").join("config.toml")) else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(doc) = raw.parse::<toml_edit::DocumentMut>() else {
        return Vec::new();
    };
    let Some(servers) = doc.get("mcp_servers").and_then(|v| v.as_table_like()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (name, cfg) in servers.iter() {
        let Some(cfg) = cfg.as_table_like() else {
            continue;
        };
        let command = cfg
            .get("command")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let args = cfg
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(" "))
            .filter(|s| !s.is_empty())
            .or_else(|| cfg.get("url").and_then(|v| v.as_str()).map(|s| s.to_string()));
        out.push(McpServerEntry {
            name: name.to_string(),
            scope: "codex".into(),
            project_path: None,
            command,
            args_summary: args,
        });
    }
    out
}

pub fn codex_config() -> Option<CodexConfig> {
    let path = dirs::home_dir()?.join(".codex").join("config.toml");
    let raw = fs::read_to_string(&path).ok()?;
    Some(parse_codex_top_level(
        &raw,
        path.to_string_lossy().into_owned(),
    ))
}

/// Tiny TOML parser that only reads top-level `key = "value"` pairs and stops
/// at the first `[section]` header. Sufficient for the few fields we care
/// about — avoids adding a full TOML dep.
fn parse_codex_top_level(raw: &str, path: String) -> CodexConfig {
    let mut model = None;
    let mut reasoning_effort = None;
    let mut approval_policy = None;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            break;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"').to_string();
        match key {
            "model" => model = Some(value),
            "model_reasoning_effort" => reasoning_effort = Some(value),
            "approval_policy" => approval_policy = Some(value),
            _ => {}
        }
    }

    CodexConfig {
        path,
        model,
        reasoning_effort,
        approval_policy,
    }
}

/// Returns Some(_) when ~/.cursor exists. Counts project directories and
/// per-project rule files for the Setup card. Cheap: stat-only walk, doesn't
/// touch chat databases.
pub fn cursor_config() -> Option<CursorConfig> {
    let dir = dirs::home_dir()?.join(".cursor");
    if !dir.is_dir() {
        return None;
    }

    let mut project_count = 0u32;
    let mut rule_count = 0u32;
    let projects_dir = dir.join("projects");
    if let Ok(entries) = fs::read_dir(&projects_dir) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            project_count += 1;
            let rules_dir = entry.path().join("rules");
            if let Ok(rules) = fs::read_dir(&rules_dir) {
                for rule in rules.flatten() {
                    if rule.path().extension().and_then(|e| e.to_str()) == Some("md") {
                        rule_count += 1;
                    }
                }
            }
        }
    }

    Some(CursorConfig {
        path: dir.to_string_lossy().into_owned(),
        project_count,
        rule_count,
    })
}

/// MCP servers Cursor knows about. Reads ~/.cursor/mcp.json (global scope)
/// and ~/.cursor/projects/<id>/mcps/<server>/SERVER_METADATA.json
/// (per-project). Returned with scope="cursor" / "<project-id>".
pub fn cursor_mcp_servers() -> Vec<McpServerEntry> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();

    let global_path = home.join(".cursor").join("mcp.json");
    if let Ok(raw) = fs::read_to_string(&global_path) {
        if let Ok(json) = serde_json::from_str::<Value>(&raw) {
            if let Some(servers) = json.get("mcpServers").and_then(|v| v.as_object()) {
                for (name, cfg) in servers {
                    let entry = build_mcp_entry(name.clone(), "cursor".into(), None, cfg);
                    seen.insert((entry.name.clone(), entry.scope.clone()));
                    out.push(entry);
                }
            }
        }
    }

    // Per-project metadata: ~/.cursor/projects/<id>/mcps/<server>/SERVER_METADATA.json
    let projects_dir = home.join(".cursor").join("projects");
    if let Ok(entries) = fs::read_dir(&projects_dir) {
        for project in entries.flatten() {
            if !project.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let project_name = project.file_name().to_string_lossy().into_owned();
            let mcps_dir = project.path().join("mcps");
            let Ok(servers) = fs::read_dir(&mcps_dir) else {
                continue;
            };
            for server in servers.flatten() {
                if !server.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let meta_path = server.path().join("SERVER_METADATA.json");
                let Ok(raw) = fs::read_to_string(&meta_path) else {
                    continue;
                };
                let Ok(json) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                let name = json
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| server.file_name().to_string_lossy().into_owned());
                let scope = format!("cursor:{}", project_name);
                let key = (name.clone(), scope.clone());
                if seen.contains(&key) {
                    continue;
                }
                seen.insert(key);
                out.push(build_mcp_entry(name, scope, None, &json));
            }
        }
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub fn mcp_servers() -> Vec<McpServerEntry> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let path = home.join(".claude.json");
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();

    if let Some(global) = json.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, cfg) in global {
            let entry = build_mcp_entry(name.clone(), "global".to_string(), None, cfg);
            seen.insert((entry.name.clone(), entry.scope.clone()));
            out.push(entry);
        }
    }

    if let Some(projects) = json.get("projects").and_then(|v| v.as_object()) {
        for (path, project) in projects {
            let Some(servers) = project.get("mcpServers").and_then(|v| v.as_object()) else {
                continue;
            };
            let scope = project_basename(path);
            for (name, cfg) in servers {
                let key = (name.clone(), scope.clone());
                if seen.contains(&key) {
                    continue;
                }
                seen.insert(key);
                out.push(build_mcp_entry(
                    name.clone(),
                    scope.clone(),
                    Some(path.clone()),
                    cfg,
                ));
            }
        }
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn build_mcp_entry(
    name: String,
    scope: String,
    project_path: Option<String>,
    cfg: &Value,
) -> McpServerEntry {
    let command = cfg
        .get("command")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let args = cfg.get("args").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|v| v.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    });
    // Fall back to URL for HTTP-style servers so the user sees something useful.
    let args_summary = args.filter(|s| !s.is_empty()).or_else(|| {
        cfg.get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    });
    McpServerEntry {
        name,
        scope,
        project_path,
        command,
        args_summary,
    }
}

fn project_basename(path: &str) -> String {
    PathBuf::from(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// ~/.claude/settings.json `enabledPlugins` — `{"name@marketplace": bool}`.
/// A plugin missing from the map is enabled.
fn enabled_plugins() -> Option<Value> {
    let path = dirs::home_dir()?.join(".claude").join("settings.json");
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()?.get("enabledPlugins").cloned()
}

/// `(short name, install dir)` for every installed Claude plugin that isn't
/// switched off in ~/.claude/settings.json `enabledPlugins`. Skills and
/// subagents scan `<dir>/skills` and `<dir>/agents`.
pub fn plugin_install_dirs() -> Vec<(String, PathBuf)> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let claude = home.join(".claude");
    let Some(json) = fs::read_to_string(claude.join("plugins").join("installed_plugins.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    else {
        return Vec::new();
    };
    let enabled = enabled_plugins();
    let Some(plugins) = json.get("plugins").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (name, installs) in plugins {
        if enabled.as_ref().and_then(|e| e.get(name)).and_then(|v| v.as_bool()) == Some(false) {
            continue;
        }
        let install = installs.as_array().and_then(|arr| arr.first()).unwrap_or(installs);
        let Some(dir) = install.get("installPath").and_then(|v| v.as_str()) else {
            continue;
        };
        let short = name.split_once('@').map(|(p, _)| p).unwrap_or(name);
        out.push((short.to_string(), PathBuf::from(dir)));
    }
    out
}

pub fn plugins() -> Vec<PluginEntry> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let path = home
        .join(".claude")
        .join("plugins")
        .join("installed_plugins.json");
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let Some(plugins) = json.get("plugins").and_then(|v| v.as_object()) else {
        return Vec::new();
    };

    let enabled = enabled_plugins();
    let mut out = Vec::new();
    for (name, installs) in plugins {
        let install = installs
            .as_array()
            .and_then(|arr| arr.first())
            .or(Some(installs));
        let version = install
            .and_then(|v| v.get("version"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| s != "unknown");
        let (_plug, marketplace) = name
            .split_once('@')
            .map(|(p, m)| (p.to_string(), m.to_string()))
            .unwrap_or_else(|| (name.clone(), String::new()));
        out.push(PluginEntry {
            name: name.clone(),
            marketplace,
            version,
            enabled: enabled.as_ref().and_then(|e| e.get(name)).and_then(|v| v.as_bool())
                != Some(false),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}
