//! Semantic color themes for the terminal renderer.
//!
//! The renderer owns presentation concerns, so this crate deliberately reuses
//! [`ratatui::style::Color`] rather than inventing an RGB color type: the
//! built-in palettes rely on ANSI named colors (`Cyan`, `DarkGray`, …), whose
//! exact appearance is chosen by the user's terminal. Encoding them as RGB
//! would silently change the default look on every terminal.

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
    /// The default palette; matches the colors the renderer used before themes
    /// existed, so enabling it changes nothing on screen.
    pub fn dark() -> Self {
        Self {
            name: "dark",
            palette: Palette {
                accent: Color::Cyan,
                user: Color::Cyan,
                assistant: Color::Reset,
                system: Color::DarkGray,
                error: Color::Red,
                tool: Color::Yellow,
                heading: Color::Reset,
                inline_code: Color::Magenta,
                code_block: Color::Green,
                comment: Color::DarkGray,
                string: Color::Green,
                keyword: Color::Magenta,
                number: Color::Cyan,
                function: Color::Blue,
                r#type: Color::Yellow,
                punctuation: Color::DarkGray,
                background: Color::Reset,
                foreground: Color::Reset,
                dim: Color::DarkGray,
                border: Color::Yellow,
            },
        }
    }

    /// A palette for light terminal backgrounds, using darker hues with enough
    /// contrast against white.
    pub fn light() -> Self {
        Self {
            name: "light",
            palette: Palette {
                accent: Color::Blue,
                user: Color::Blue,
                assistant: Color::Black,
                system: Color::DarkGray,
                error: Color::Red,
                tool: Color::Magenta,
                heading: Color::Black,
                inline_code: Color::Magenta,
                code_block: Color::Green,
                comment: Color::DarkGray,
                string: Color::Green,
                keyword: Color::Blue,
                number: Color::Magenta,
                function: Color::Cyan,
                r#type: Color::Red,
                punctuation: Color::DarkGray,
                background: Color::White,
                foreground: Color::Black,
                dim: Color::DarkGray,
                border: Color::Blue,
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
        assert_eq!(dark.palette.keyword, Color::Magenta);
    }
}
