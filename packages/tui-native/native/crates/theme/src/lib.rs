//! Semantic color themes for the terminal renderer.
//!
//! The built-in palettes use explicit RGB values copied from Claude Code's
//! `src/utils/theme.ts` (`lightTheme` / `darkTheme`) so the TUI looks the same
//! regardless of the user's terminal ANSI color configuration. Tokens with no
//! official counterpart keep their previous ANSI approximation, encoded as the
//! nearest RGB value and documented inline.

use ratatui::style::Color;

/// Semantic color tokens consumed by the renderer.
///
/// Roles are named by meaning ("what it is") instead of by hue, so a theme can
/// remap them without touching rendering code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Palette {
    /// Highlights, selection markers and other emphasis.
    pub accent: Color,
    /// User input rows.
    pub user: Color,
    /// Assistant prose and default body text.
    pub assistant: Color,
    /// System/status messages.
    pub system: Color,
    /// Errors.
    pub error: Color,
    /// Successful outcomes.
    pub success: Color,
    /// Tool calls and results.
    pub tool: Color,
    /// Markdown headings.
    pub heading: Color,
    /// Inline code spans.
    pub inline_code: Color,
    /// Fenced or indented code blocks.
    pub code_block: Color,
    /// Source comments.
    pub comment: Color,
    /// String literals.
    pub string: Color,
    /// Language keywords.
    pub keyword: Color,
    /// Numeric literals.
    pub number: Color,
    /// Function names.
    pub function: Color,
    /// Type names.
    pub r#type: Color,
    /// Punctuation in code.
    pub punctuation: Color,
    /// Terminal background.
    pub background: Color,
    /// Default foreground text.
    pub foreground: Color,
    /// De-emphasized text (hints, metadata).
    pub dim: Color,
    /// Dialog and panel borders.
    pub border: Color,
    /// Background of a user prompt block (Ink `userMessageBackground`).
    pub user_message_bg: Color,
    /// Background of added diff lines.
    pub diff_added_bg: Color,
    /// Background of removed diff lines.
    pub diff_removed_bg: Color,
}

/// A named palette.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Theme {
    pub name: &'static str,
    pub palette: Palette,
}

impl Default for Theme {
    fn default() -> Self {
        Self::dark()
    }
}

/// How the user wants the theme chosen.
///
/// Mirrors Ink's `THEME_SETTINGS`: `auto` resolves against the terminal,
/// while `dark` / `light` pin a palette.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThemeSetting {
    /// Follow the detected terminal background.
    #[default]
    Auto,
    /// Always use [`Theme::dark`].
    Dark,
    /// Always use [`Theme::light`].
    Light,
}

impl ThemeSetting {
    /// Parse a setting name (`dark`, `light`, `auto`). Unknown values fall
    /// back to [`ThemeSetting::Auto`], matching Ink's picker behavior.
    pub fn parse(value: &str) -> Self {
        match value {
            "dark" => Self::Dark,
            "light" => Self::Light,
            _ => Self::Auto,
        }
    }
}

impl Theme {
    /// The default palette, matching Claude Code's `darkTheme`.
    pub fn dark() -> Self {
        Self {
            name: "dark",
            palette: Palette {
                accent: Color::Rgb(215, 119, 87),     // claude, theme.ts:443
                user: Color::Rgb(177, 185, 249),      // suggestion, theme.ts:458
                assistant: Color::Rgb(255, 255, 255), // text, theme.ts:453
                // No official token; previous ANSI DarkGray as RGB.
                system: Color::Rgb(128, 128, 128),
                error: Color::Rgb(255, 107, 128),  // theme.ts:462
                success: Color::Rgb(78, 186, 101), // theme.ts:461
                // No official token; previous ANSI Yellow as RGB.
                tool: Color::Rgb(255, 255, 0),
                heading: Color::Rgb(255, 255, 255), // text, theme.ts:453
                // No official token; previous ANSI Magenta as RGB.
                inline_code: Color::Rgb(255, 0, 255),
                // No official token; previous ANSI Green as RGB.
                code_block: Color::Rgb(0, 255, 0),
                // No official token; previous ANSI DarkGray as RGB.
                comment: Color::Rgb(128, 128, 128),
                // No official token; previous ANSI Green as RGB.
                string: Color::Rgb(0, 255, 0),
                // No official token; previous ANSI Magenta as RGB.
                keyword: Color::Rgb(255, 0, 255),
                // No official token; previous ANSI Cyan as RGB.
                number: Color::Rgb(0, 255, 255),
                // No official token; previous ANSI Blue as RGB.
                function: Color::Rgb(0, 0, 255),
                // No official token; previous ANSI Yellow as RGB.
                r#type: Color::Rgb(255, 255, 0),
                // No official token; previous ANSI DarkGray as RGB.
                punctuation: Color::Rgb(128, 128, 128),
                background: Color::Reset,
                foreground: Color::Rgb(255, 255, 255), // text, theme.ts:453
                dim: Color::Rgb(80, 80, 80),           // subtle, theme.ts:457
                border: Color::Rgb(136, 136, 136),     // promptBorder, theme.ts:451
                user_message_bg: Color::Rgb(55, 55, 55), // theme.ts:488
                diff_added_bg: Color::Rgb(34, 92, 43), // diffAdded, theme.ts:466
                diff_removed_bg: Color::Rgb(122, 41, 54), // diffRemoved, theme.ts:467
            },
        }
    }

    /// A palette for light terminal backgrounds, matching Claude Code's
    /// `lightTheme`.
    pub fn light() -> Self {
        Self {
            name: "light",
            palette: Palette {
                accent: Color::Rgb(215, 119, 87), // claude, theme.ts:118
                user: Color::Rgb(87, 105, 247),   // suggestion, theme.ts:133
                assistant: Color::Rgb(0, 0, 0),   // text, theme.ts:128
                // No official token; previous ANSI DarkGray as RGB.
                system: Color::Rgb(128, 128, 128),
                error: Color::Rgb(171, 43, 63),   // theme.ts:137
                success: Color::Rgb(44, 122, 57), // theme.ts:136
                // No official token; previous ANSI Magenta as RGB.
                tool: Color::Rgb(255, 0, 255),
                heading: Color::Rgb(0, 0, 0), // text, theme.ts:128
                // No official token; previous ANSI Magenta as RGB.
                inline_code: Color::Rgb(255, 0, 255),
                // No official token; previous ANSI Green as RGB.
                code_block: Color::Rgb(0, 128, 0),
                // No official token; previous ANSI DarkGray as RGB.
                comment: Color::Rgb(128, 128, 128),
                // No official token; previous ANSI Green as RGB.
                string: Color::Rgb(0, 128, 0),
                // No official token; previous ANSI Blue as RGB.
                keyword: Color::Rgb(0, 0, 255),
                // No official token; previous ANSI Magenta as RGB.
                number: Color::Rgb(255, 0, 255),
                // No official token; previous ANSI Cyan as RGB.
                function: Color::Rgb(0, 128, 128),
                // No official token; previous ANSI Red as RGB.
                r#type: Color::Rgb(255, 0, 0),
                // No official token; previous ANSI DarkGray as RGB.
                punctuation: Color::Rgb(128, 128, 128),
                background: Color::Rgb(255, 255, 255),
                foreground: Color::Rgb(0, 0, 0), // text, theme.ts:128
                dim: Color::Rgb(175, 175, 175),  // subtle, theme.ts:132
                border: Color::Rgb(153, 153, 153), // promptBorder, theme.ts:126
                user_message_bg: Color::Rgb(240, 240, 240), // theme.ts:163
                diff_added_bg: Color::Rgb(199, 225, 203), // diffAddedDimmed, theme.ts:143
                diff_removed_bg: Color::Rgb(253, 210, 216), // diffRemovedDimmed, theme.ts:144
            },
        }
    }

    /// Look up a built-in theme by name. Unknown names fall back to
    /// [`Theme::dark`].
    pub fn from_name(name: &str) -> Self {
        match name {
            "light" => Self::light(),
            _ => Self::dark(),
        }
    }

    /// Resolve the effective theme the way Ink's `auto` setting does.
    ///
    /// Priority:
    /// 1. `CCH_THEME` — `dark` / `light` force a palette; `auto` (or an
    ///    unset variable) continues detection; anything else falls back to
    ///    dark.
    /// 2. `$COLORFGBG` background index — the last segment (e.g. the `0` in
    ///    `15;0`); indices `0..8` are dark, `8..=15` light.
    /// 3. `platform_dark` supplied by the caller (OS appearance).
    /// 4. Dark, as the conservative default.
    ///
    /// `env` is injected so callers (and tests) do not need to touch the
    /// process environment.
    pub fn detect(env: &dyn Fn(&str) -> Option<String>, platform_dark: Option<bool>) -> Self {
        match env("CCH_THEME").as_deref() {
            Some("dark") => Self::dark(),
            Some("light") => Self::light(),
            Some("auto") | None => Self::detect_auto(env, platform_dark),
            Some(_) => Self::dark(),
        }
    }

    /// Detection used by `auto`: `$COLORFGBG`, then the platform hint, then
    /// dark.
    fn detect_auto(env: &dyn Fn(&str) -> Option<String>, platform_dark: Option<bool>) -> Self {
        let dark = env("COLORFGBG")
            .as_deref()
            .and_then(colorfgbg_background_is_dark)
            .or(platform_dark)
            .unwrap_or(true);
        if dark { Self::dark() } else { Self::light() }
    }
}

/// Interpret the background ANSI index in a `$COLORFGBG` value such as
/// `15;0` (foreground;background) or `0;default;15`.
///
/// Returns `None` when the value is missing, malformed, out of the ANSI
/// 0–15 range, or has no background segment.
fn colorfgbg_background_is_dark(value: &str) -> Option<bool> {
    let parts: Vec<&str> = value.split(';').collect();
    let background = *parts.last()?;
    if parts.len() < 2 || background.is_empty() {
        return None;
    }
    let index: u8 = background.parse().ok()?;
    if index > 15 {
        return None;
    }
    Some(index < 8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_name_selects_builtin_themes() {
        assert_eq!(Theme::from_name("dark"), Theme::dark());
        assert_eq!(Theme::from_name("light"), Theme::light());
    }

    #[test]
    fn unknown_name_falls_back_to_dark() {
        assert_eq!(Theme::from_name("solarized"), Theme::dark());
        assert_eq!(Theme::from_name(""), Theme::dark());
        assert_eq!(Theme::from_name("LIGHT").name, "dark");
    }

    #[test]
    fn default_theme_is_dark() {
        assert_eq!(Theme::default(), Theme::dark());
    }

    #[test]
    fn dark_and_light_palettes_differ() {
        let dark = Theme::dark();
        let light = Theme::light();
        assert_ne!(dark.palette, light.palette);
        assert_ne!(dark.palette.foreground, light.palette.foreground);
        assert_ne!(dark.palette.keyword, light.palette.keyword);
        assert_eq!(dark.palette.keyword, Color::Rgb(255, 0, 255));
    }

    #[test]
    fn dark_palette_matches_official_rgb_values() {
        let palette = Theme::dark().palette;
        assert_eq!(palette.foreground, Color::Rgb(255, 255, 255));
        assert_eq!(palette.dim, Color::Rgb(80, 80, 80));
        assert_eq!(palette.error, Color::Rgb(255, 107, 128));
        assert_eq!(palette.success, Color::Rgb(78, 186, 101));
        assert_eq!(palette.accent, Color::Rgb(215, 119, 87));
        assert_eq!(palette.user, Color::Rgb(177, 185, 249));
        assert_eq!(palette.user_message_bg, Color::Rgb(55, 55, 55));
        assert_eq!(palette.diff_added_bg, Color::Rgb(34, 92, 43));
        assert_eq!(palette.diff_removed_bg, Color::Rgb(122, 41, 54));
    }

    #[test]
    fn light_palette_matches_official_rgb_values() {
        let palette = Theme::light().palette;
        assert_eq!(palette.foreground, Color::Rgb(0, 0, 0));
        assert_eq!(palette.dim, Color::Rgb(175, 175, 175));
        assert_eq!(palette.error, Color::Rgb(171, 43, 63));
        assert_eq!(palette.success, Color::Rgb(44, 122, 57));
        assert_eq!(palette.accent, Color::Rgb(215, 119, 87));
        assert_eq!(palette.user, Color::Rgb(87, 105, 247));
        assert_eq!(palette.user_message_bg, Color::Rgb(240, 240, 240));
        assert_eq!(palette.diff_added_bg, Color::Rgb(199, 225, 203));
        assert_eq!(palette.diff_removed_bg, Color::Rgb(253, 210, 216));
    }

    /// Build an env lookup from constant `(name, value)` pairs.
    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        }
    }

    fn no_env() -> impl Fn(&str) -> Option<String> {
        |_| None
    }

    #[test]
    fn theme_setting_parse_known_and_unknown() {
        assert_eq!(ThemeSetting::parse("auto"), ThemeSetting::Auto);
        assert_eq!(ThemeSetting::parse("dark"), ThemeSetting::Dark);
        assert_eq!(ThemeSetting::parse("light"), ThemeSetting::Light);
        assert_eq!(ThemeSetting::parse("solarized"), ThemeSetting::Auto);
        assert_eq!(ThemeSetting::parse(""), ThemeSetting::Auto);
        assert_eq!(ThemeSetting::default(), ThemeSetting::Auto);
    }

    #[test]
    fn cch_theme_forces_palette_over_detection() {
        let forced_dark = env(&[("CCH_THEME", "dark"), ("COLORFGBG", "15;15")]);
        assert_eq!(Theme::detect(&forced_dark, Some(false)), Theme::dark());

        let forced_light = env(&[("CCH_THEME", "light"), ("COLORFGBG", "15;0")]);
        assert_eq!(Theme::detect(&forced_light, Some(true)), Theme::light());
    }

    #[test]
    fn colorfgbg_background_selects_palette() {
        // Background indices 0 and 7 are dark, 8 and 15 are light.
        for (value, expected) in [
            ("15;0", Theme::dark()),
            ("15;7", Theme::dark()),
            ("15;8", Theme::light()),
            ("15;15", Theme::light()),
        ] {
            let lookup = |name: &str| -> Option<String> {
                match name {
                    "CCH_THEME" => Some("auto".to_owned()),
                    "COLORFGBG" => Some(value.to_owned()),
                    _ => None,
                }
            };
            assert_eq!(Theme::detect(&lookup, None), expected, "COLORFGBG={value}");
        }
    }

    #[test]
    fn missing_env_uses_platform_dark() {
        let dark = no_env();
        assert_eq!(Theme::detect(&dark, Some(true)), Theme::dark());

        let light = no_env();
        assert_eq!(Theme::detect(&light, Some(false)), Theme::light());
    }

    #[test]
    fn platform_dark_is_ignored_when_colorfgbg_is_valid() {
        let env = env(&[("COLORFGBG", "15;15")]);
        assert_eq!(Theme::detect(&env, Some(true)), Theme::light());
    }

    #[test]
    fn invalid_cch_theme_falls_back_to_dark() {
        // Unknown CCH_THEME wins over every other hint and yields dark.
        let invalid_setting = env(&[("CCH_THEME", "solarized"), ("COLORFGBG", "15;15")]);
        assert_eq!(Theme::detect(&invalid_setting, Some(false)), Theme::dark());
    }

    #[test]
    fn malformed_colorfgbg_falls_through_to_platform() {
        // Malformed COLORFGBG is ignored and detection continues.
        let invalid_colorfgbg = env(&[("COLORFGBG", "not-a-color")]);
        assert_eq!(
            Theme::detect(&invalid_colorfgbg, Some(false)),
            Theme::light()
        );

        // Out-of-range indices are also ignored.
        let out_of_range = env(&[("COLORFGBG", "15;42")]);
        assert_eq!(Theme::detect(&out_of_range, Some(true)), Theme::dark());
    }

    #[test]
    fn auto_defaults_to_dark_without_hints() {
        let env = env(&[("CCH_THEME", "auto")]);
        assert_eq!(Theme::detect(&env, None), Theme::dark());

        let empty = no_env();
        assert_eq!(Theme::detect(&empty, None), Theme::dark());
    }
}
