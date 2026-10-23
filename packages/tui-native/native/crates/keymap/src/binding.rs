//! Bindings and the string-identified actions they resolve to.

use std::fmt;

use crate::{Chord, Context, Key};

/// Stable identifier for a keybinding action.
///
/// Actions are plain `'static` strings so the table can grow (vim motions,
/// dialogs, plugins) without touching a closed enum. The constants below are
/// the actions the base table emits; callers match on [`Action::id`] or use
/// [`Action::new`] for their own extension tables.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Action(&'static str);

impl Action {
    pub const fn new(id: &'static str) -> Self {
        Self(id)
    }

    pub const fn id(self) -> &'static str {
        self.0
    }

    // Application-level actions.
    pub const APP_INTERRUPT: Self = Self::new("app.interrupt");
    pub const APP_EXIT: Self = Self::new("app.exit");
    pub const APP_REDRAW: Self = Self::new("app.redraw");
    pub const APP_TOGGLE_TRANSCRIPT: Self = Self::new("app.toggle_transcript");
    pub const APP_ESCAPE: Self = Self::new("app.escape");

    // Prompt-level actions.
    pub const PROMPT_SUBMIT: Self = Self::new("prompt.submit");
    pub const PROMPT_NEWLINE: Self = Self::new("prompt.newline");
    pub const PROMPT_ESCAPE: Self = Self::new("prompt.escape");
    pub const PROMPT_UNDO: Self = Self::new("prompt.undo");
    pub const PROMPT_EXTERNAL_EDITOR: Self = Self::new("prompt.external_editor");
    pub const PROMPT_STASH: Self = Self::new("prompt.stash");
    pub const PROMPT_KILL_AGENTS: Self = Self::new("prompt.kill_agents");

    // TextBuffer actions.
    pub const EDIT_BACKSPACE: Self = Self::new("edit.backspace");
    pub const EDIT_DELETE: Self = Self::new("edit.delete");
    pub const EDIT_LEFT: Self = Self::new("edit.left");
    pub const EDIT_RIGHT: Self = Self::new("edit.right");
    pub const EDIT_LINE_START: Self = Self::new("edit.line_start");
    pub const EDIT_LINE_END: Self = Self::new("edit.line_end");
    pub const EDIT_CHAR_BACKWARD: Self = Self::new("edit.char_backward");
    pub const EDIT_CHAR_FORWARD: Self = Self::new("edit.char_forward");
    pub const EDIT_KILL_TO_END: Self = Self::new("edit.kill_to_end");
    pub const EDIT_KILL_TO_START: Self = Self::new("edit.kill_to_start");
    pub const EDIT_KILL_WORD_BEFORE: Self = Self::new("edit.kill_word_before");
    pub const EDIT_YANK: Self = Self::new("edit.yank");

    // History actions.
    pub const HISTORY_PREVIOUS: Self = Self::new("history.previous");
    pub const HISTORY_NEXT: Self = Self::new("history.next");
    pub const HISTORY_SEARCH: Self = Self::new("history.search");
    pub const HISTORY_SEARCH_NEXT: Self = Self::new("history_search.next");
    pub const HISTORY_SEARCH_ACCEPT: Self = Self::new("history_search.accept");
    pub const HISTORY_SEARCH_CANCEL: Self = Self::new("history_search.cancel");
    pub const HISTORY_SEARCH_EXECUTE: Self = Self::new("history_search.execute");

    // Autocomplete actions.
    pub const AUTOCOMPLETE_ACCEPT: Self = Self::new("autocomplete.accept");
    pub const AUTOCOMPLETE_DISMISS: Self = Self::new("autocomplete.dismiss");
    pub const AUTOCOMPLETE_PREVIOUS: Self = Self::new("autocomplete.previous");
    pub const AUTOCOMPLETE_NEXT: Self = Self::new("autocomplete.next");

    // Dialog actions.
    pub const DIALOG_DISMISS: Self = Self::new("dialog.dismiss");
    pub const DIALOG_CONFIRM: Self = Self::new("dialog.confirm");
    pub const DIALOG_PREVIOUS: Self = Self::new("dialog.previous");
    pub const DIALOG_NEXT: Self = Self::new("dialog.next");

    // Modal actions.
    pub const MODAL_DISMISS: Self = Self::new("modal.dismiss");

    // Vim normal/insert actions (see [`crate::VIM_SPECS`]).
    pub const VIM_LEFT: Self = Self::new("vim.left");
    pub const VIM_DOWN: Self = Self::new("vim.down");
    pub const VIM_UP: Self = Self::new("vim.up");
    pub const VIM_RIGHT: Self = Self::new("vim.right");
    pub const VIM_INSERT: Self = Self::new("vim.insert");
    pub const VIM_APPEND: Self = Self::new("vim.append");
    pub const VIM_OPEN_LINE: Self = Self::new("vim.open_line");
    pub const VIM_LINE_START: Self = Self::new("vim.line_start");
    pub const VIM_LINE_END: Self = Self::new("vim.line_end");
    pub const VIM_WORD_FORWARD: Self = Self::new("vim.word_forward");
    pub const VIM_WORD_BACKWARD: Self = Self::new("vim.word_backward");
    pub const VIM_DELETE_CHAR: Self = Self::new("vim.delete_char");
    pub const VIM_DELETE_LINE: Self = Self::new("vim.delete_line");
    pub const VIM_UNDO: Self = Self::new("vim.undo");
    /// `Esc` in insert mode: leave insert, return to normal.
    pub const VIM_NORMAL: Self = Self::new("vim.normal");
}

impl fmt::Display for Action {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

/// One resolved keybinding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub chord: Chord,
    pub context: Context,
    pub action: Action,
}

impl Binding {
    pub fn new(context: Context, chord: impl Into<Chord>, action: Action) -> Self {
        Self {
            chord: chord.into(),
            context,
            action,
        }
    }
}

/// Borrowed, const-friendly binding used by the built-in tables.
///
/// ```
/// use cch_tui_keymap::{Action, BindingSpec, Context, Key};
///
/// const VIM_NORMAL: &[BindingSpec] = &[BindingSpec::new(
///     Context::VIM_NORMAL,
///     &[Key::char('h')],
///     Action::new("vim.left"),
/// )];
///
/// assert_eq!(VIM_NORMAL[0].to_binding().chord.len(), 1);
/// ```
#[derive(Debug, Clone, Copy)]
pub struct BindingSpec {
    pub context: Context,
    pub chord: &'static [Key],
    pub action: Action,
}

impl BindingSpec {
    pub const fn new(context: Context, chord: &'static [Key], action: Action) -> Self {
        Self {
            context,
            chord,
            action,
        }
    }

    pub fn to_binding(self) -> Binding {
        Binding {
            chord: Chord::new(self.chord.iter().copied()),
            context: self.context,
            action: self.action,
        }
    }
}

impl From<BindingSpec> for Binding {
    fn from(spec: BindingSpec) -> Self {
        spec.to_binding()
    }
}

impl From<&BindingSpec> for Binding {
    fn from(spec: &BindingSpec) -> Self {
        spec.to_binding()
    }
}
