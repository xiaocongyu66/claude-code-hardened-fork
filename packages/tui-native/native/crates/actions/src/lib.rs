//! Message-level actions and transcript expansion, as pure logic.
//!
//! This crate mirrors the parts of Ink's transcript UI that decide *what* the
//! user sees and *what* an action would do, without touching the terminal:
//!
//! - [`ExpandState`] remembers which rows are expanded, keyed by UUID or row
//!   index. Tool output starts collapsed; prose rows are never affected.
//! - [`project`] produces the visible rows for a frame, capping tool blocks at
//!   [`ExpandLimits::collapsed_lines`] or [`ExpandLimits::expanded_lines`].
//! - [`MessageActions`] tracks the focused message and answers whether
//!   `copy`, `rewind`, and `toggle expand` are available, returning an
//!   [`ActionOutcome`] instead of performing side effects.
//! - [`block_starts`] and the other focus helpers derive that cursor from the
//!   transcript rows, skipping spacing rows and tool-result continuations.
//!
//! The renderer and the binary key bindings consume these results; neither is
//! touched here.

mod actions;
mod expand;
mod focus;

pub use actions::{ActionOutcome, MessageAction, MessageActions, MessageMeta};
pub use expand::{ExpandLimits, ExpandState, RowKey, project, project_keyed};
pub use focus::{block_starts, copy_target, latest_assistant_text, message_metas, toggle_focused};
