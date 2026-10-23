//! Terminal-independent keybinding model for the native TUI.
//!
//! This crate mirrors the semantics of the existing Ink keybinding layer:
//!
//! - [`Key`]/[`Chord`] describe terminal-independent key presses;
//! - [`Context`]/[`ContextStack`] order `global < prompt < dialog < modal`,
//!   with the most recent context winning inside a layer (the same rule as
//!   [`cch_tui_core::EventRouter`]);
//! - [`Resolver`] resolves top-of-stack first and supports two-key chords
//!   with a caller-supplied timeout;
//! - [`Keymap::default`] is a table-driven cover of the base prompt keys.
//!
//! Everything is pure logic: feed [`Key`] values and logical milliseconds in,
//! receive [`Action`] values out. The caller applies actions to
//! [`cch_tui_core::TextBuffer`], pushes/removes contexts, and owns the clock.
//!
//! # Extension points
//!
//! Vim normal/insert bindings ship in [`VIM_SPECS`] as an opt-in table. Build
//! the keymap with [`Keymap::with_extensions`], push the vim context and
//! resolve as usual:
//!
//! ```
//! use cch_tui_keymap::{
//!     Action, Context, ContextStack, Key, Keymap, Resolution, VIM_SPECS,
//! };
//!
//! let keymap = Keymap::with_extensions(&[VIM_SPECS]);
//! let mut stack = ContextStack::new();
//! stack.push(Context::PROMPT);
//! stack.push(Context::VIM_NORMAL);
//! assert_eq!(
//!     keymap.resolve_once(&stack, Key::char('h'), 0),
//!     Resolution::Action(Action::VIM_LEFT),
//! );
//! ```
//!
//! Other contexts can be added the same way with [`BindingSpec`] tables and
//! [`Context::new`].

#![forbid(unsafe_code)]

mod binding;
mod context;
mod history;
mod key;
mod keymap;
mod resolver;
mod vim;

pub use binding::{Action, Binding, BindingSpec};
pub use context::{Context, ContextStack, Layer};
pub use history::{HistorySearchCommand, HistorySearchOutcome, apply_history_search};
pub use key::{Chord, Key, KeyCode, Modifiers};
pub use keymap::{
    AUTOCOMPLETE_SPECS, BASE_TABLES, DIALOG_SPECS, GLOBAL_SPECS, HISTORY_SEARCH_SPECS, Keymap,
    MODAL_SPECS, PROMPT_SPECS,
};
pub use resolver::{Resolution, Resolver};
pub use vim::{VIM_SPECS, VimAction, keymap_with_vim, vim_context};
