//! Rendering backend (ratatui + crossterm).
//!
//! M0 keeps this crate as a placeholder so the workspace builds without
//! pulling the terminal stack; the backend lands in M1 together with the
//! inline viewport and `insert_before` scrollback handling.

/// Cells the inline viewport reserves below frozen scrollback.
pub const DEFAULT_INLINE_HEIGHT: u16 = 24;
