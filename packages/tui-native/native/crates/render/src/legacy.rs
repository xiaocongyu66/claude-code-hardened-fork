//! Legacy Windows console (pre-ConPTY) compatibility.
//!
//! ConPTY shipped with Windows 10 1809 (build 17763). Older conhost builds
//! mis-handle incremental cursor updates — pending-wrap semantics at the last
//! column drift the real cursor away from the one the renderer believes it
//! has — so residue accumulates until a full repaint. This mirrors Ink's
//! `legacyConsole.ts` / `log-update.ts`: on affected machines we render one
//! column narrower and force a full clear+repaint about once per second.
//!
//! Overrides (first match wins):
//!   `CCH_LEGACY_CONSOLE=1`            force on
//!   `CCH_LEGACY_CONSOLE=0`            force off
//!   `CCH_LEGACY_CONSOLE=auto|`        auto-detect
//!   `CLAUDE_CODE_LEGACY_CONSOLE`      same, lower priority (compatibility)

use std::env;
use std::time::{Duration, Instant};

/// ConPTY shipped in Windows 10 1809 (build 17763); older builds are legacy.
pub const LEGACY_BUILD_THRESHOLD: u32 = 17_763;

/// Full repaint cadence on legacy consoles (Ink uses 1000 ms).
pub const LEGACY_RESET_INTERVAL: Duration = Duration::from_secs(1);

/// Primary environment override.
pub const LEGACY_ENV: &str = "CCH_LEGACY_CONSOLE";

/// Ink-compatible environment override, used when the primary is unset.
pub const LEGACY_ENV_COMPAT: &str = "CLAUDE_CODE_LEGACY_CONSOLE";

/// How the legacy console compatibility layer is selected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyConsoleMode {
    /// Detect from the Windows build number.
    Auto,
    /// Forced on by the environment.
    On,
    /// Forced off by the environment.
    Off,
}

impl LegacyConsoleMode {
    /// Parse an environment value. Unset, empty and unknown values select
    /// [`Self::Auto`]; `1`/`true`/`on` force on and `0`/`false`/`off` force
    /// off (case-insensitive).
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some(value)
                if value.eq_ignore_ascii_case("1")
                    || value.eq_ignore_ascii_case("true")
                    || value.eq_ignore_ascii_case("on") =>
            {
                Self::On
            }
            Some(value)
                if value.eq_ignore_ascii_case("0")
                    || value.eq_ignore_ascii_case("false")
                    || value.eq_ignore_ascii_case("off") =>
            {
                Self::Off
            }
            _ => Self::Auto,
        }
    }

    /// Read [`LEGACY_ENV`], falling back to [`LEGACY_ENV_COMPAT`].
    pub fn from_env() -> Self {
        let raw = env::var(LEGACY_ENV)
            .or_else(|_| env::var(LEGACY_ENV_COMPAT))
            .ok();
        Self::parse(raw.as_deref())
    }

    /// Resolve the mode for a platform and build number.
    ///
    /// An explicit override always wins (even off Windows, matching Ink).
    /// `Auto` only enables the layer on Windows builds older than
    /// [`LEGACY_BUILD_THRESHOLD`]; an unknown build number stays modern.
    pub fn resolve(self, is_windows: bool, build_number: Option<u32>) -> bool {
        match self {
            Self::On => true,
            Self::Off => false,
            Self::Auto => {
                is_windows && build_number.is_some_and(|build| build < LEGACY_BUILD_THRESHOLD)
            }
        }
    }
}

/// Whether the legacy console layer should be active on this machine.
///
/// `build_number` is the Windows build (e.g. `17763`), or `None` when it could
/// not be detected. Off Windows `Auto` always resolves to `false`.
pub fn should_use_legacy(build_number: Option<u32>) -> bool {
    LegacyConsoleMode::from_env().resolve(cfg!(windows), build_number)
}

/// Effective content width for a legacy console.
///
/// Never writing the last column avoids the pending-wrap path entirely. The
/// result is clamped to at least one column so degenerate sizes stay drawable.
pub fn legacy_width(width: u16) -> u16 {
    width.saturating_sub(1).max(1)
}

/// State for the periodic full repaint.
///
/// The layer replaces the incremental diff with a full clear+repaint whenever
/// [`LEGACY_RESET_INTERVAL`] has elapsed, which self-heals drifted cursors.
#[derive(Debug, Clone, Copy, Default)]
pub struct LegacyRedraw {
    last: Option<Instant>,
}

impl LegacyRedraw {
    /// Create state that is due on the first check.
    pub const fn new() -> Self {
        Self { last: None }
    }

    /// Whether a full repaint is due at `now`.
    pub fn due(&self, now: Instant) -> bool {
        match self.last {
            None => true,
            Some(last) => now.saturating_duration_since(last) >= LEGACY_RESET_INTERVAL,
        }
    }

    /// Record that a full repaint happened at `now`.
    pub fn mark(&mut self, now: Instant) {
        self.last = Some(now);
    }
}

/// Windows build number of the current machine, or `None` when unknown.
///
/// Uses `cmd /c ver` (no extra dependency). Windows-only; other platforms
/// always return `None`.
#[cfg(windows)]
pub fn detect_build_number() -> Option<u32> {
    let output = std::process::Command::new("cmd")
        .args(["/c", "ver"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_windows_build(&String::from_utf8_lossy(&output.stdout))
}

/// Windows build number of the current machine, or `None` when unknown.
#[cfg(not(windows))]
pub fn detect_build_number() -> Option<u32> {
    None
}

/// Parse the build component of `Microsoft Windows [Version 10.0.17763.1]`.
pub fn parse_windows_build(text: &str) -> Option<u32> {
    let start = text.find("Version")? + "Version".len();
    let rest = text[start..].trim_start();
    let rest = rest.strip_prefix('[').unwrap_or(rest);
    let version = rest
        .split(|ch: char| !ch.is_ascii_digit() && ch != '.')
        .next()?;
    version.split('.').nth(2)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_environment_modes() {
        assert_eq!(LegacyConsoleMode::parse(None), LegacyConsoleMode::Auto);
        assert_eq!(LegacyConsoleMode::parse(Some("")), LegacyConsoleMode::Auto);
        assert_eq!(
            LegacyConsoleMode::parse(Some("auto")),
            LegacyConsoleMode::Auto
        );
        assert_eq!(LegacyConsoleMode::parse(Some("1")), LegacyConsoleMode::On);
        assert_eq!(
            LegacyConsoleMode::parse(Some(" TRUE ")),
            LegacyConsoleMode::On
        );
        assert_eq!(LegacyConsoleMode::parse(Some("0")), LegacyConsoleMode::Off);
        assert_eq!(
            LegacyConsoleMode::parse(Some("off")),
            LegacyConsoleMode::Off
        );
        // Unknown values fall back to detection rather than forcing a mode.
        assert_eq!(
            LegacyConsoleMode::parse(Some("maybe")),
            LegacyConsoleMode::Auto
        );
    }

    #[test]
    fn resolves_build_boundary() {
        let auto = LegacyConsoleMode::Auto;
        assert!(auto.resolve(true, Some(17_762)));
        assert!(!auto.resolve(true, Some(17_763)));
        assert!(!auto.resolve(true, Some(17_764)));
        assert!(!auto.resolve(true, None));
    }

    #[test]
    fn non_windows_auto_is_always_off() {
        assert!(!LegacyConsoleMode::Auto.resolve(false, Some(7600)));
        assert!(!LegacyConsoleMode::Auto.resolve(false, None));
        // An explicit override still wins, matching Ink.
        assert!(LegacyConsoleMode::On.resolve(false, None));
        assert!(!LegacyConsoleMode::Off.resolve(true, Some(7600)));
    }

    #[test]
    fn redraw_is_due_after_interval() {
        let base = Instant::now();
        let mut redraw = LegacyRedraw::new();
        assert!(redraw.due(base), "first check is always due");
        redraw.mark(base);
        assert!(!redraw.due(base + Duration::from_millis(999)));
        assert!(redraw.due(base + LEGACY_RESET_INTERVAL));
        assert!(redraw.due(base + Duration::from_secs(5)));

        let later = base + Duration::from_secs(2);
        redraw.mark(later);
        assert!(!redraw.due(later + Duration::from_millis(1)));
        assert!(redraw.due(later + LEGACY_RESET_INTERVAL));
    }

    #[test]
    fn legacy_width_reserves_last_column() {
        assert_eq!(legacy_width(80), 79);
        assert_eq!(legacy_width(2), 1);
        assert_eq!(legacy_width(1), 1);
        assert_eq!(legacy_width(0), 1);
    }

    #[test]
    fn parses_cmd_ver_output() {
        let text = "Microsoft Windows [Version 10.0.17763.1234]\r\n";
        assert_eq!(parse_windows_build(text), Some(17_763));
        let text = "Microsoft Windows [Version 6.1.7601]";
        assert_eq!(parse_windows_build(text), Some(7601));
        assert_eq!(parse_windows_build("no version here"), None);
    }
}
