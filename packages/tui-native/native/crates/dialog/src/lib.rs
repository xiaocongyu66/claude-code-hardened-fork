//! Permission/diff dialogs, queued input, and the interaction state machine.
//!
//! Everything here is pure logic: no terminal, clock, or engine I/O. The
//! caller feeds protocol requests and keymap actions in and turns the returned
//! decisions/inputs into control responses and prompts.
//!
//! # States
//!
//! [`InteractionState`] derives its phase from three facts: whether a turn is
//! streaming, whether a permission dialog is open, and whether input is
//! queued. A permission dialog always wins, then an active turn, then a
//! non-empty queue:
//!
//! ```text
//!                 start_turn
//!        Idle ─────────────────▶ Streaming
//!          ▲                       │  ▲
//!          │ finish_turn (empty)   │  │ resolve/cancel permission
//!          │                       │  │
//!          │      permission_request│  │
//!          │            ┌──────────┘  │
//!          │            ▼             │
//!          │     PermissionPending ───┘
//!          │
//!          │ finish_turn / next_to_send drained
//!     Queueing ◀──────────────── Streaming
//!          │ next_to_send
//!          └────────────────▶ Streaming
//! ```
//!
//! `enqueue`, `send_now`, and `backfill` move an idle machine to `Queueing`;
//! `finish_turn` moves a streaming machine to `Idle` or `Queueing` depending
//! on the queue. [`InteractionState::accepts`] answers which
//! [`cch_tui_keymap::Action`] values the current phase should route.

#![forbid(unsafe_code)]

mod diff;
mod permission;
mod queue;
mod state;

pub use diff::{
    DialogLine, DialogLineKind, DiffDialog, DiffDialogState, DiffHunk, DiffLine, DiffLineKind,
    FileDiff, parse_file_diff,
};
pub use permission::{
    PermissionDecision, PermissionDialog, PermissionKind, PermissionOption, PlanDecision,
};
pub use queue::{Queue, QueuePriority, QueuedInput};
pub use state::{InteractionPhase, InteractionState};
