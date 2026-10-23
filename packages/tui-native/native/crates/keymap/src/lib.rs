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
//! Vim and the remaining Ink contexts are intentionally not implemented here.
//! Add them as data, using [`BindingSpec`] tables and
//! [`Context::VIM_NORMAL`] / [`Context::new`]:
//!
//! ```
//! use cch_tui_keymap::{Action, BindingSpec, Context, Key, Keymap};
//!
//! const VIM: &[BindingSpec] = &[
//!     BindingSpec::new(Context::VIM_NORMAL, &[Key::char('h')], Action::new("vim.left")),
//!     BindingSpec::new(Context::VIM_NORMAL, &[Key::char('i')], Action::new("vim.insert")),
//! ];
//! let keymap = Keymap::with_extensions(&[VIM]);
//! assert_eq!(keymap.bindings().len(), Keymap::default().bindings().len() + 2);
//! ```

#![forbid(unsafe_code)]

mod binding;
mod context;
mod key;
mod keymap;
mod resolver;

pub use binding::{Action, Binding, BindingSpec};
pub use context::{Context, ContextStack, Layer};
pub use key::{Chord, Key, KeyCode, Modifiers};
pub use keymap::{
    AUTOCOMPLETE_SPECS, BASE_TABLES, DIALOG_SPECS, GLOBAL_SPECS, HISTORY_SEARCH_SPECS, Keymap,
    MODAL_SPECS, PROMPT_SPECS,
};
pub use resolver::{Resolution, Resolver};
