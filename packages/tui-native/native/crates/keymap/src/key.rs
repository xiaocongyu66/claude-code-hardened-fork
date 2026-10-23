//! Terminal-independent key and chord primitives.

use std::fmt;

/// Physical/logical key without modifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KeyCode {
    Char(char),
    Enter,
    Tab,
    Esc,
    Backspace,
    Delete,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
}

/// Modifiers attached to a key event.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct Modifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

impl Modifiers {
    pub const NONE: Self = Self {
        ctrl: false,
        alt: false,
        shift: false,
    };
    pub const CTRL: Self = Self {
        ctrl: true,
        alt: false,
        shift: false,
    };
    pub const ALT: Self = Self {
        ctrl: false,
        alt: true,
        shift: false,
    };
    pub const SHIFT: Self = Self {
        ctrl: false,
        alt: false,
        shift: true,
    };

    pub const fn is_empty(self) -> bool {
        !self.ctrl && !self.alt && !self.shift
    }
}

/// One key press: a [`KeyCode`] plus [`Modifiers`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Key {
    pub code: KeyCode,
    pub modifiers: Modifiers,
}

impl Key {
    pub const fn new(code: KeyCode, modifiers: Modifiers) -> Self {
        Self { code, modifiers }
    }

    pub const fn char(ch: char) -> Self {
        Self::new(KeyCode::Char(ch), Modifiers::NONE)
    }

    pub const fn with_ctrl(mut self) -> Self {
        self.modifiers.ctrl = true;
        self
    }

    pub const fn with_alt(mut self) -> Self {
        self.modifiers.alt = true;
        self
    }

    pub const fn with_shift(mut self) -> Self {
        self.modifiers.shift = true;
        self
    }

    pub const fn ctrl_char(ch: char) -> Self {
        Self::char(ch).with_ctrl()
    }

    pub const fn alt_char(ch: char) -> Self {
        Self::char(ch).with_alt()
    }

    pub const fn shift_char(ch: char) -> Self {
        Self::char(ch).with_shift()
    }

    pub const fn ctrl_of(code: KeyCode) -> Self {
        Self::new(code, Modifiers::CTRL)
    }

    pub const fn alt_of(code: KeyCode) -> Self {
        Self::new(code, Modifiers::ALT)
    }

    pub const fn shift_of(code: KeyCode) -> Self {
        Self::new(code, Modifiers::SHIFT)
    }

    pub const fn enter() -> Self {
        Self::new(KeyCode::Enter, Modifiers::NONE)
    }

    pub const fn tab() -> Self {
        Self::new(KeyCode::Tab, Modifiers::NONE)
    }

    pub const fn esc() -> Self {
        Self::new(KeyCode::Esc, Modifiers::NONE)
    }

    pub const fn backspace() -> Self {
        Self::new(KeyCode::Backspace, Modifiers::NONE)
    }

    pub const fn delete() -> Self {
        Self::new(KeyCode::Delete, Modifiers::NONE)
    }

    pub const fn left() -> Self {
        Self::new(KeyCode::Left, Modifiers::NONE)
    }

    pub const fn right() -> Self {
        Self::new(KeyCode::Right, Modifiers::NONE)
    }

    pub const fn up() -> Self {
        Self::new(KeyCode::Up, Modifiers::NONE)
    }

    pub const fn down() -> Self {
        Self::new(KeyCode::Down, Modifiers::NONE)
    }

    pub const fn home() -> Self {
        Self::new(KeyCode::Home, Modifiers::NONE)
    }

    pub const fn end() -> Self {
        Self::new(KeyCode::End, Modifiers::NONE)
    }

    pub const fn page_up() -> Self {
        Self::new(KeyCode::PageUp, Modifiers::NONE)
    }

    pub const fn page_down() -> Self {
        Self::new(KeyCode::PageDown, Modifiers::NONE)
    }
}

impl fmt::Display for Key {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut first = true;
        for (set, name) in [
            (self.modifiers.ctrl, "ctrl"),
            (self.modifiers.alt, "alt"),
            (self.modifiers.shift, "shift"),
        ] {
            if set {
                if !first {
                    formatter.write_str("+")?;
                }
                formatter.write_str(name)?;
                first = false;
            }
        }
        if !first {
            formatter.write_str("+")?;
        }
        match self.code {
            KeyCode::Char(' ') => formatter.write_str("space"),
            KeyCode::Char(ch) => write!(formatter, "{ch}"),
            KeyCode::Enter => formatter.write_str("enter"),
            KeyCode::Tab => formatter.write_str("tab"),
            KeyCode::Esc => formatter.write_str("esc"),
            KeyCode::Backspace => formatter.write_str("backspace"),
            KeyCode::Delete => formatter.write_str("delete"),
            KeyCode::Left => formatter.write_str("left"),
            KeyCode::Right => formatter.write_str("right"),
            KeyCode::Up => formatter.write_str("up"),
            KeyCode::Down => formatter.write_str("down"),
            KeyCode::Home => formatter.write_str("home"),
            KeyCode::End => formatter.write_str("end"),
            KeyCode::PageUp => formatter.write_str("pageup"),
            KeyCode::PageDown => formatter.write_str("pagedown"),
        }
    }
}

/// A sequence of keys, for example `ctrl+x enter`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Chord(Vec<Key>);

impl Chord {
    pub fn new(keys: impl IntoIterator<Item = Key>) -> Self {
        Self(keys.into_iter().collect())
    }

    pub fn single(key: Key) -> Self {
        Self(vec![key])
    }

    pub fn keys(&self) -> &[Key] {
        &self.0
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Whether this chord begins with `prefix`.
    pub fn starts_with(&self, prefix: &[Key]) -> bool {
        self.0.starts_with(prefix)
    }
}

impl From<Vec<Key>> for Chord {
    fn from(keys: Vec<Key>) -> Self {
        Self(keys)
    }
}

impl<const N: usize> From<[Key; N]> for Chord {
    fn from(keys: [Key; N]) -> Self {
        Self(keys.to_vec())
    }
}

impl fmt::Display for Chord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut first = true;
        for key in &self.0 {
            if !first {
                formatter.write_str(" ")?;
            }
            write!(formatter, "{key}")?;
            first = false;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_carry_modifiers_and_display_canonically() {
        assert_eq!(Key::ctrl_char('x').to_string(), "ctrl+x");
        assert_eq!(
            Key::enter().with_shift().to_string(),
            "shift+enter",
            "shift+enter is the newline binding"
        );
        assert_eq!(Key::esc().to_string(), "esc");
        assert_eq!(Key::char(' ').to_string(), "space");
        assert_eq!(Key::alt_of(KeyCode::Up).to_string(), "alt+up");
    }

    #[test]
    fn chords_compare_and_report_prefixes() {
        let chord = Chord::from([Key::ctrl_char('x'), Key::enter()]);
        assert_eq!(chord.len(), 2);
        assert_eq!(chord.to_string(), "ctrl+x enter");
        assert!(chord.starts_with(&[Key::ctrl_char('x')]));
        assert!(!chord.starts_with(&[Key::char('x')]));
        assert_eq!(Chord::single(Key::esc()).keys(), [Key::esc()]);
    }

    #[test]
    fn modifiers_are_distinct_in_key_equality() {
        assert_ne!(Key::ctrl_char('a'), Key::char('a'));
        assert_ne!(Key::shift_char('a'), Key::char('A'));
        assert!(Modifiers::NONE.is_empty());
        assert!(!Modifiers::CTRL.is_empty());
    }
}
