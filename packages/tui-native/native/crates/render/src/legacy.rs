//! Legacy Windows console (pre-ConPTY) compatibility.
//!
//! ConPTY shipped with Windows 10 1809 (build 17763). Older conhost builds
//! mis-handle incremental cursor updates — pending-wrap semantics at the last
//! column drift the real cursor away from the one the renderer believes it
//! has — so residue accumulates until a full repaint. This mirrors Ink's
//! `legacyConsole.ts` / `log-update.ts`: on affected machines we render one
//! column narrower and force a full clear+repaint about once per second.
//!
//! Overrides (first match wins, matching `legacyConsole.ts`):
//!   `CCH_LEGACY_CONSOLE=1`            periodic full repaint
//!   `CCH_LEGACY_CONSOLE=2|always`     full repaint on every frame
//!   `CCH_LEGACY_CONSOLE=0`            force off
//!   `CCH_LEGACY_CONSOLE=auto|`        auto-detect
//!   `CLAUDE_CODE_LEGACY_CONSOLE`      same, lower priority (compatibility)
//!   `CCH_LEGACY_CONSOLE_RESET_MS`     periodic interval, clamped [100, 10000]
//!   `CLAUDE_CODE_LEGACY_CONSOLE_RESET_MS`  same, lower priority

use std::env;
use std::time::{Duration, Instant};

/// ConPTY shipped in Windows 10 1809 (build 17763); older builds are legacy.
pub const LEGACY_BUILD_THRESHOLD: u32 = 17_763;

/// Default full repaint cadence on legacy consoles (Ink uses 1000 ms).
pub const LEGACY_RESET_INTERVAL: Duration = Duration::from_secs(1);

/// Bounds for the configurable interval (`log-update.ts` clamps the same way).
pub const MIN_LEGACY_RESET_MS: u64 = 100;
pub const MAX_LEGACY_RESET_MS: u64 = 10_000;

/// Primary environment override.
pub const LEGACY_ENV: &str = "CCH_LEGACY_CONSOLE";

/// Ink-compatible environment override, used when the primary is unset.
pub const LEGACY_ENV_COMPAT: &str = "CLAUDE_CODE_LEGACY_CONSOLE";

/// Primary reset-interval override.
pub const LEGACY_RESET_ENV: &str = "CCH_LEGACY_CONSOLE_RESET_MS";

/// Ink-compatible reset-interval override.
pub const LEGACY_RESET_ENV_COMPAT: &str = "CLAUDE_CODE_LEGACY_CONSOLE_RESET_MS";

/// How the legacy console compatibility layer is selected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyConsoleMode {
    /// Detect from the Windows build number.
    Auto,
    /// Periodic full repaint forced on by the environment.
    Periodic,
    /// Full repaint on every frame (`2` / `always`).
    Always,
    /// Forced off by the environment.
    Off,
}

impl LegacyConsoleMode {
    /// Parse an environment value. Unset, empty and unknown values select
    /// [`Self::Auto`]; `1`/`true`/`on` force periodic repaints, `2`/`always`
    /// repaint every frame, and `0`/`false`/`off` force off (case-insensitive).
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some(value)
                if value.eq_ignore_ascii_case("2") || value.eq_ignore_ascii_case("always") =>
            {
                Self::Always
            }
            Some(value)
                if value.eq_ignore_ascii_case("1")
                    || value.eq_ignore_ascii_case("true")
                    || value.eq_ignore_ascii_case("on") =>
            {
                Self::Periodic
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
            Self::Periodic | Self::Always => true,
            Self::Off => false,
            Self::Auto => {
                is_windows && build_number.is_some_and(|build| build < LEGACY_BUILD_THRESHOLD)
            }
        }
    }
}

/// Parse `CCH_LEGACY_CONSOLE_RESET_MS`, clamped to
/// [`MIN_LEGACY_RESET_MS`]..=[`MAX_LEGACY_RESET_MS`]. Unset, empty and
/// non-numeric values use [`LEGACY_RESET_INTERVAL`]; fractions are floored.
pub fn parse_reset_ms(raw: Option<&str>) -> Duration {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return LEGACY_RESET_INTERVAL;
    };
    let Ok(parsed) = value.parse::<f64>() else {
        return LEGACY_RESET_INTERVAL;
    };
    if !parsed.is_finite() {
        return LEGACY_RESET_INTERVAL;
    }
    let millis = parsed
        .floor()
        .clamp(MIN_LEGACY_RESET_MS as f64, MAX_LEGACY_RESET_MS as f64) as u64;
    Duration::from_millis(millis)
}

/// Read the configured reset interval, primary env first.
pub fn reset_interval() -> Duration {
    let raw = env::var(LEGACY_RESET_ENV)
        .or_else(|_| env::var(LEGACY_RESET_ENV_COMPAT))
        .ok();
    parse_reset_ms(raw.as_deref())
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
/// Never writing the last column avoids the pending-wrap path entirely. Ink's
/// `effectiveColumns` floors at 20; here the result is clamped to at least one
/// column instead, so a degenerate host-reported width can never exceed the
/// frame buffer.
pub fn legacy_width(width: u16) -> u16 {
    width.saturating_sub(1).max(1)
}

/// State for the periodic full repaint.
///
/// The layer replaces the incremental diff with a full clear+repaint whenever
/// the configured interval has elapsed, which self-heals drifted cursors.
/// `Always` mode reports every frame as due.
#[derive(Debug, Clone, Copy, Default)]
pub struct LegacyRedraw {
    last: Option<Instant>,
    interval: Option<Duration>,
    every_frame: bool,
}

impl LegacyRedraw {
    /// Create state that is due on the first check, then every
    /// [`LEGACY_RESET_INTERVAL`].
    pub const fn new() -> Self {
        Self {
            last: None,
            interval: None,
            every_frame: false,
        }
    }

    /// Periodic state with a custom interval.
    pub const fn with_interval(interval: Duration) -> Self {
        Self {
            last: None,
            interval: Some(interval),
            every_frame: false,
        }
    }

    /// Full repaint on every frame (`CLAUDE_CODE_LEGACY_CONSOLE=2`).
    pub const fn always() -> Self {
        Self {
            last: None,
            interval: None,
            every_frame: true,
        }
    }

    fn interval(&self) -> Duration {
        self.interval.unwrap_or(LEGACY_RESET_INTERVAL)
    }

    /// Whether a full repaint is due at `now`.
    pub fn due(&self, now: Instant) -> bool {
        if self.every_frame {
            return true;
        }
        match self.last {
            None => true,
            Some(last) => now.saturating_duration_since(last) >= self.interval(),
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
        assert_eq!(
            LegacyConsoleMode::parse(Some("1")),
            LegacyConsoleMode::Periodic
        );
        assert_eq!(
            LegacyConsoleMode::parse(Some(" TRUE ")),
            LegacyConsoleMode::Periodic
        );
        assert_eq!(
            LegacyConsoleMode::parse(Some("2")),
            LegacyConsoleMode::Always
        );
        assert_eq!(
            LegacyConsoleMode::parse(Some(" always ")),
            LegacyConsoleMode::Always
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
        assert!(LegacyConsoleMode::Periodic.resolve(false, None));
        assert!(LegacyConsoleMode::Always.resolve(false, None));
        assert!(!LegacyConsoleMode::Off.resolve(true, Some(7600)));
    }

    #[test]
    fn reset_interval_is_parsed_and_clamped() {
        assert_eq!(parse_reset_ms(None), LEGACY_RESET_INTERVAL);
        assert_eq!(parse_reset_ms(Some("")), LEGACY_RESET_INTERVAL);
        assert_eq!(parse_reset_ms(Some("   ")), LEGACY_RESET_INTERVAL);
        assert_eq!(parse_reset_ms(Some("nope")), LEGACY_RESET_INTERVAL);
        assert_eq!(parse_reset_ms(Some("250")), Duration::from_millis(250));
        assert_eq!(parse_reset_ms(Some("250.9")), Duration::from_millis(250));
        // Clamped to [100, 10000], like Ink's parser.
        assert_eq!(parse_reset_ms(Some("1")), Duration::from_millis(100));
        assert_eq!(parse_reset_ms(Some("-50")), Duration::from_millis(100));
        assert_eq!(
            parse_reset_ms(Some("60000")),
            Duration::from_millis(MAX_LEGACY_RESET_MS)
        );
        assert_eq!(
            parse_reset_ms(Some("inf")),
            LEGACY_RESET_INTERVAL,
            "non-finite values fall back to the default"
        );
    }

    #[test]
    fn always_mode_repaints_every_frame() {
        let base = Instant::now();
        let mut redraw = LegacyRedraw::always();
        assert!(redraw.due(base));
        redraw.mark(base);
        assert!(redraw.due(base), "always mode ignores the interval");
        assert!(redraw.due(base + Duration::from_millis(1)));

        let mut custom = LegacyRedraw::with_interval(Duration::from_millis(250));
        assert!(custom.due(base));
        custom.mark(base);
        assert!(!custom.due(base + Duration::from_millis(249)));
        assert!(custom.due(base + Duration::from_millis(250)));
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
