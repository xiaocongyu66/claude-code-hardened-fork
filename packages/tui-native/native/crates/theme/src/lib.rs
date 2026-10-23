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
}
