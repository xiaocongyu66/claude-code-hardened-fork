//! User configuration for the native TUI.
//!
//! Settings live in `~/.cch/tui.json` by default. `CCH_TUI_CONFIG` can point
//! at a different file, and environment variables override individual file
//! values (see [`load`]). Precedence is:
//!
//! 1. An explicit path passed to [`load`].
//! 2. `CCH_TUI_CONFIG`.
//! 3. `$HOME/.cch/tui.json`.
//!
//! Missing files, invalid JSON and wrong field types never fail the TUI: the
//! affected values fall back to [`TuiConfig::default`] and a human-readable
//! message is recorded in [`TuiConfig::warnings`].

use std::fmt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Theme used when the config does not select one.
pub const DEFAULT_THEME: &str = "auto";

/// Number of lines scrolled per wheel/key event when unset.
pub const DEFAULT_SCROLL_LINES: u16 = 5;

/// Name of a theme palette.
///
/// Kept as a string so new palettes do not require a config crate release;
/// lookups happen in the theme layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ThemeSetting(String);

impl ThemeSetting {
    /// The theme name exactly as configured.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for ThemeSetting {
    fn default() -> Self {
        Self(DEFAULT_THEME.to_owned())
    }
}

impl From<&str> for ThemeSetting {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl From<String> for ThemeSetting {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl fmt::Display for ThemeSetting {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Resolved TUI configuration.
///
/// `warnings` is populated by [`load`] with every problem encountered while
/// reading the file or applying environment overrides. Problems never abort
/// loading; the corresponding field keeps its default value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TuiConfig {
    /// Theme palette name (`"auto"` by default).
    pub theme: ThemeSetting,
    /// Start the prompt in vim normal mode.
    pub vim: bool,
    /// Use the alternate screen instead of inline rendering.
    pub fullscreen: bool,
    /// Keep the prompt pinned to the bottom.
    pub sticky_prompt: bool,
    /// Lines moved per scroll event (always at least 1).
    pub scroll_lines: u16,
    /// Non-fatal problems found while loading.
    pub warnings: Vec<String>,
}

impl Default for TuiConfig {
    fn default() -> Self {
        Self {
            theme: ThemeSetting::default(),
            vim: false,
            fullscreen: false,
            sticky_prompt: true,
            scroll_lines: DEFAULT_SCROLL_LINES,
            warnings: Vec::new(),
        }
    }
}

/// Parse config JSON without touching the filesystem.
///
/// Unknown fields are ignored. A field with the wrong JSON type is reported in
/// [`TuiConfig::warnings`] and keeps its default value without affecting the
/// other fields. A non-object root or malformed JSON yields the full default
/// configuration plus a warning.
pub fn parse(source: &str) -> TuiConfig {
    let mut config = TuiConfig::default();
    let value: serde_json::Value = match serde_json::from_str(source) {
        Ok(value) => value,
        Err(error) => {
            config
                .warnings
                .push(format!("invalid TUI config JSON: {error}"));
            return config;
        }
    };

    let serde_json::Value::Object(fields) = value else {
        config
            .warnings
            .push("TUI config root must be a JSON object".to_owned());
        return config;
    };

    if let Some(value) = fields.get("theme") {
        match value.as_str() {
            Some(theme) => config.theme = ThemeSetting::from(theme),
            None => config
                .warnings
                .push("`theme` must be a string; using default".to_owned()),
        }
    }

    read_bool(&fields, "vim", &mut config.vim, &mut config.warnings);
    read_bool(
        &fields,
        "fullscreen",
        &mut config.fullscreen,
        &mut config.warnings,
    );
    read_bool(
        &fields,
        "sticky_prompt",
        &mut config.sticky_prompt,
        &mut config.warnings,
    );

    if let Some(value) = fields.get("scroll_lines") {
        match value.as_u64().and_then(|n| u16::try_from(n).ok()) {
            Some(lines) => config.scroll_lines = lines.max(1),
            None => config.warnings.push(format!(
                "`scroll_lines` must be an integer in 0..={}; using default",
                u16::MAX
            )),
        }
    }

    config
}

fn read_bool(
    fields: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    target: &mut bool,
    warnings: &mut Vec<String>,
) {
    let Some(value) = fields.get(key) else {
        return;
    };
    match value.as_bool() {
        Some(flag) => *target = flag,
        None => warnings.push(format!("`{key}` must be a boolean; using default")),
    }
}

/// Load the configuration from disk and apply environment overrides.
///
/// `path` is an explicit override (for example from a CLI flag). When it is
/// `None`, `CCH_TUI_CONFIG` is consulted first and then
/// `$HOME/.cch/tui.json`. `env` is passed in so tests do not need to mutate
/// the process environment.
///
/// Environment overrides (applied after the file, in this order):
/// `CCH_TUI_THEME`, `CCH_TUI_VIM` (`1`/`0`), `CCH_TUI_FULLSCREEN` (`1`/`0`)
/// and `CCH_TUI_STICKY` (`1`/`0`). Values other than `1`/`0` are ignored and
/// reported in [`TuiConfig::warnings`].
pub fn load(path: Option<&Path>, env: &dyn Fn(&str) -> Option<String>) -> TuiConfig {
    let mut config = match resolve_path(path, env) {
        Some(path) => match std::fs::read_to_string(&path) {
            Ok(source) => parse(&source),
            Err(error) => {
                let mut config = TuiConfig::default();
                config.warnings.push(format!(
                    "could not read TUI config {}: {error}; using defaults",
                    path.display()
                ));
                config
            }
        },
        None => {
            let mut config = TuiConfig::default();
            config
                .warnings
                .push("could not resolve TUI config path; using defaults".to_owned());
            config
        }
    };

    apply_env(&mut config, env);
    config
}

fn resolve_path(path: Option<&Path>, env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(path) = path {
        return Some(path.to_path_buf());
    }
    if let Some(path) = non_empty(env("CCH_TUI_CONFIG")) {
        return Some(PathBuf::from(path));
    }
    non_empty(env("HOME")).map(|home| Path::new(&home).join(".cch").join("tui.json"))
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

fn apply_env(config: &mut TuiConfig, env: &dyn Fn(&str) -> Option<String>) {
    if let Some(theme) = env("CCH_TUI_THEME") {
        config.theme = ThemeSetting::from(theme);
    }
    apply_bool_env(env, "CCH_TUI_VIM", &mut config.vim, &mut config.warnings);
    apply_bool_env(
        env,
        "CCH_TUI_FULLSCREEN",
        &mut config.fullscreen,
        &mut config.warnings,
    );
    apply_bool_env(
        env,
        "CCH_TUI_STICKY",
        &mut config.sticky_prompt,
        &mut config.warnings,
    );
}

fn apply_bool_env(
    env: &dyn Fn(&str) -> Option<String>,
    name: &str,
    target: &mut bool,
    warnings: &mut Vec<String>,
) {
    let Some(raw) = env(name) else {
        return;
    };
    match raw.as_str() {
        "1" => *target = true,
        "0" => *target = false,
        _ => warnings.push(format!("{name}={raw:?} is not 1 or 0; ignoring")),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    /// Wrapper around a unique temp directory, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "cch-tui-config-test-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, relative: &str, contents: &str) -> PathBuf {
            let path = self.0.join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("create parent");
            }
            std::fs::write(&path, contents).expect("write temp file");
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn with_env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        move |key: &str| map.get(key).cloned()
    }

    fn missing_path() -> PathBuf {
        let dir = TempDir::new();
        dir.path().join("does-not-exist.json")
    }

    #[test]
    fn defaults_match_env_semantics() {
        let config = TuiConfig::default();
        assert_eq!(config.theme.as_str(), "auto");
        assert!(!config.vim);
        assert!(!config.fullscreen);
        assert!(config.sticky_prompt);
        assert_eq!(config.scroll_lines, 5);
        assert!(config.warnings.is_empty());
    }

    #[test]
    fn parses_partial_config() {
        let config = parse(r#"{"theme": "dark", "scroll_lines": 9}"#);
        assert_eq!(config.theme.as_str(), "dark");
        assert_eq!(config.scroll_lines, 9);
        assert!(!config.vim);
        assert!(config.sticky_prompt);
        assert!(config.warnings.is_empty());
    }

    #[test]
    fn malformed_json_returns_defaults_with_warning() {
        let config = parse(r#"{"theme": "dark", "#);
        assert_eq!(config.theme, ThemeSetting::default());
        assert_eq!(config.scroll_lines, DEFAULT_SCROLL_LINES);
        assert_eq!(config.warnings.len(), 1);
        assert!(config.warnings[0].contains("invalid TUI config JSON"));
    }

    #[test]
    fn non_object_root_returns_defaults_with_warning() {
        let config = parse(r#"["dark"]"#);
        assert_eq!(config.theme.as_str(), "auto");
        assert_eq!(config.warnings.len(), 1);
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let config = parse(r#"{"theme": "light", "keymap": {"x": "y"}, "future": 1}"#);
        assert_eq!(config.theme.as_str(), "light");
        assert!(config.warnings.is_empty());
        assert_eq!(
            config,
            TuiConfig {
                theme: ThemeSetting::from("light"),
                ..TuiConfig::default()
            }
        );
    }

    #[test]
    fn type_errors_fall_back_per_field() {
        let config = parse(
            r#"{
                "theme": 7,
                "vim": "yes",
                "fullscreen": true,
                "sticky_prompt": 0,
                "scroll_lines": "many"
            }"#,
        );
        assert_eq!(config.theme.as_str(), "auto");
        assert!(!config.vim);
        assert!(config.fullscreen);
        assert!(config.sticky_prompt);
        assert_eq!(config.scroll_lines, 5);
        assert_eq!(config.warnings.len(), 4);
    }

    #[test]
    fn scroll_lines_zero_clamps_to_one() {
        let config = parse(r#"{"scroll_lines": 0}"#);
        assert_eq!(config.scroll_lines, 1);
        assert!(config.warnings.is_empty());
    }

    #[test]
    fn scroll_lines_out_of_range_uses_default() {
        let config = parse(r#"{"scroll_lines": 70000}"#);
        assert_eq!(config.scroll_lines, 5);
        assert_eq!(config.warnings.len(), 1);

        let negative = parse(r#"{"scroll_lines": -3}"#);
        assert_eq!(negative.scroll_lines, 5);
        assert_eq!(negative.warnings.len(), 1);
    }

    #[test]
    fn env_overrides_file_values() {
        let dir = TempDir::new();
        let path = dir.write(
            "tui.json",
            r#"{"theme": "dark", "vim": false, "fullscreen": false, "sticky_prompt": true}"#,
        );
        let env = with_env(&[
            ("CCH_TUI_THEME", "light"),
            ("CCH_TUI_VIM", "1"),
            ("CCH_TUI_FULLSCREEN", "1"),
            ("CCH_TUI_STICKY", "0"),
        ]);
        let config = load(Some(&path), &env);
        assert_eq!(config.theme.as_str(), "light");
        assert!(config.vim);
        assert!(config.fullscreen);
        assert!(!config.sticky_prompt);
        assert!(config.warnings.is_empty());
    }

    #[test]
    fn invalid_bool_env_is_ignored_with_warning() {
        let path = missing_path();
        let env = with_env(&[("CCH_TUI_VIM", "true")]);
        let config = load(Some(&path), &env);
        assert!(!config.vim);
        assert!(config.warnings.iter().any(|w| w.contains("CCH_TUI_VIM")));
    }

    #[test]
    fn missing_file_returns_defaults_with_warning() {
        let path = missing_path();
        let env = |_: &str| None;
        let config = load(Some(&path), &env);
        assert_eq!(config.theme, ThemeSetting::default());
        assert!(!config.vim);
        assert!(!config.fullscreen);
        assert!(config.sticky_prompt);
        assert_eq!(config.scroll_lines, DEFAULT_SCROLL_LINES);
        assert_eq!(config.warnings.len(), 1);
    }

    #[test]
    fn explicit_path_wins_over_env() {
        let dir = TempDir::new();
        let explicit = dir.write("explicit.json", r#"{"theme": "dark"}"#);
        dir.write("env.json", r#"{"theme": "light"}"#);
        let env = with_env(&[("CCH_TUI_CONFIG", "env.json")]);
        let config = load(Some(&explicit), &env);
        assert_eq!(config.theme.as_str(), "dark");
    }

    #[test]
    fn cch_tui_config_wins_over_home() {
        let dir = TempDir::new();
        let configured = dir.write("configured.json", r#"{"theme": "dark"}"#);
        let env = with_env(&[
            ("CCH_TUI_CONFIG", configured.to_str().unwrap()),
            ("HOME", dir.path().to_str().unwrap()),
        ]);
        let config = load(None, &env);
        assert_eq!(config.theme.as_str(), "dark");
    }

    #[test]
    fn home_fallback_is_used() {
        let dir = TempDir::new();
        dir.write(".cch/tui.json", r#"{"theme": "light"}"#);
        let env = with_env(&[("HOME", dir.path().to_str().unwrap())]);
        let config = load(None, &env);
        assert_eq!(config.theme.as_str(), "light");
        assert!(config.warnings.is_empty());
    }

    #[test]
    fn missing_home_returns_defaults_with_warning() {
        let env = |_: &str| None;
        let config = load(None, &env);
        assert_eq!(config.theme.as_str(), "auto");
        assert_eq!(config.warnings.len(), 1);
        assert!(config.warnings[0].contains("resolve"));
    }

    #[test]
    fn empty_cch_tui_config_falls_back_to_home() {
        let dir = TempDir::new();
        dir.write(".cch/tui.json", r#"{"theme": "light"}"#);
        let env = with_env(&[
            ("CCH_TUI_CONFIG", ""),
            ("HOME", dir.path().to_str().unwrap()),
        ]);
        let config = load(None, &env);
        assert_eq!(config.theme.as_str(), "light");
    }
}
