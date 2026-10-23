//! Pure vim-mode state machine.
//!
//! [`VimState`] only tracks whether vim bindings are enabled and which mode
//! the prompt is in. It deliberately knows nothing about keys or text: the
//! keymap crate resolves `i`/`a`/`o`/`Esc` to actions, the caller applies them
//! to the [`TextBuffer`](crate::TextBuffer), and this type owns the resulting
//! mode transition.
//!
//! Like the Ink prompt input, enabling vim starts in insert mode.

/// Prompt editing mode while vim bindings are enabled.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum VimMode {
    /// Plain prompt editing; `Esc` leaves for [`VimMode::Normal`].
    #[default]
    Insert,
    /// Motions and operators; `i`/`a`/`o` return to insert.
    Normal,
}

impl VimMode {
    /// Short uppercase label used by the status line (`INSERT`, `NORMAL`).
    pub const fn label(self) -> &'static str {
        match self {
            Self::Insert => "INSERT",
            Self::Normal => "NORMAL",
        }
    }

    /// Status-bar indicator, matching vim's own `-- INSERT --` style.
    pub const fn status_indicator(self) -> &'static str {
        match self {
            Self::Insert => "-- INSERT --",
            Self::Normal => "-- NORMAL --",
        }
    }
}

/// Whether vim keybindings are enabled plus the current mode.
///
/// The default is disabled and in insert mode, so callers that never opt in
/// behave exactly like the plain prompt.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct VimState {
    enabled: bool,
    mode: VimMode,
}

impl VimState {
    /// A state with vim bindings enabled (or not) that starts in insert mode.
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            mode: VimMode::Insert,
        }
    }

    /// A state with vim bindings enabled, starting in insert mode.
    pub fn enabled() -> Self {
        Self::new(true)
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn mode(&self) -> VimMode {
        self.mode
    }

    pub fn is_insert(&self) -> bool {
        self.enabled && self.mode == VimMode::Insert
    }

    pub fn is_normal(&self) -> bool {
        self.enabled && self.mode == VimMode::Normal
    }

    /// Status-bar indicator for the current mode; `None` while vim is off.
    pub fn status_indicator(&self) -> Option<&'static str> {
        if self.enabled {
            Some(self.mode.status_indicator())
        } else {
            None
        }
    }

    /// Flip vim mode availability.
    ///
    /// Disabling always returns to insert mode so re-enabling starts in the
    /// same place as a fresh vim-enabled prompt.
    pub fn toggle(&mut self) {
        self.enabled = !self.enabled;
        if !self.enabled {
            self.mode = VimMode::Insert;
        }
    }

    /// Enter insert mode (the `i`/`a`/`o` transition). No-op while disabled.
    pub fn enter_insert(&mut self) {
        if self.enabled {
            self.mode = VimMode::Insert;
        }
    }

    /// Enter normal mode. No-op while disabled.
    pub fn enter_normal(&mut self) {
        if self.enabled {
            self.mode = VimMode::Normal;
        }
    }

    /// Handle `Esc`: insert leaves for normal, normal stays put.
    ///
    /// Returns whether the mode changed, so the caller knows to rebuild the
    /// context stack. No-op (and `false`) while disabled.
    pub fn on_escape(&mut self) -> bool {
        if !self.enabled || self.mode == VimMode::Normal {
            return false;
        }
        self.mode = VimMode::Normal;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_state_is_disabled_insert() {
        let state = VimState::default();
        assert!(!state.is_enabled());
        assert_eq!(state.mode(), VimMode::Insert);
        assert!(!state.is_insert());
        assert!(!state.is_normal());
        assert_eq!(state.status_indicator(), None);
    }

    #[test]
    fn enabling_starts_in_insert_mode() {
        let state = VimState::new(true);
        assert!(state.is_enabled());
        assert_eq!(state.mode(), VimMode::Insert);
        assert_eq!(state.status_indicator(), Some("-- INSERT --"));
    }

    #[test]
    fn mode_transitions_only_apply_while_enabled() {
        let mut state = VimState::new(false);
        state.enter_normal();
        assert_eq!(state.mode(), VimMode::Insert);
        assert!(!state.on_escape());

        state.toggle();
        assert!(state.is_enabled());
        assert_eq!(state.mode(), VimMode::Insert, "toggle enables in insert");

        state.enter_normal();
        assert!(state.is_normal());
        assert_eq!(state.status_indicator(), Some("-- NORMAL --"));

        state.enter_insert();
        assert!(state.is_insert());
        assert_eq!(state.status_indicator(), Some("-- INSERT --"));
    }

    #[test]
    fn escape_leaves_insert_once_and_is_idempotent_in_normal() {
        let mut state = VimState::enabled();
        assert!(state.on_escape(), "insert -> normal");
        assert!(state.is_normal());
        assert!(!state.on_escape(), "normal stays normal");
        assert!(state.is_normal());
    }

    #[test]
    fn toggling_off_resets_to_insert_and_toggling_on_resumes_insert() {
        let mut state = VimState::enabled();
        state.enter_normal();

        state.toggle();
        assert!(!state.is_enabled());
        assert_eq!(state.mode(), VimMode::Insert);
        assert_eq!(state.status_indicator(), None);

        state.toggle();
        assert!(state.is_enabled());
        assert!(state.is_insert());
    }

    #[test]
    fn mode_labels_match_the_status_indicators() {
        assert_eq!(VimMode::Insert.label(), "INSERT");
        assert_eq!(VimMode::Normal.label(), "NORMAL");
        assert_eq!(VimMode::Insert.status_indicator(), "-- INSERT --");
        assert_eq!(VimMode::Normal.status_indicator(), "-- NORMAL --");
    }
}
