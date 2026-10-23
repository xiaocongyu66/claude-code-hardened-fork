//! Focused-message actions: copy, rewind, and expand/collapse.
//!
//! [`MessageActions`] owns only the cursor over a list of [`MessageMeta`]
//! descriptors. [`MessageActions::can`] answers whether an action applies to
//! the focused message, and [`MessageActions::perform`] returns an
//! [`ActionOutcome`] describing what the caller should do. Neither method
//! touches the clipboard, the conversation, or any [`crate::ExpandState`], so
//! the binary can decide when to commit the effect.

use crate::expand::RowKey;

/// One message the action cursor can land on.
///
/// The key matches the row key used by [`crate::ExpandState`], so a
/// [`ActionOutcome::Toggled`] result can be fed straight into
/// [`crate::ExpandState::toggle`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageMeta {
    /// Expansion key for this message (UUID or row index).
    pub key: RowKey,
    /// Plain text copied by [`MessageAction::CopyText`].
    pub text: String,
    /// Whether [`MessageAction::ToggleExpand`] applies.
    pub expandable: bool,
    /// Whether [`MessageAction::RewindTo`] may target this message.
    pub rewindable: bool,
}

impl MessageMeta {
    /// A non-expandable, non-rewindable message.
    pub fn new(key: impl Into<RowKey>, text: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            text: text.into(),
            expandable: false,
            rewindable: false,
        }
    }

    /// Mark this message as having collapsible content.
    pub fn expandable(mut self) -> Self {
        self.expandable = true;
        self
    }

    /// Mark this message as a valid rewind target (typically a user prompt).
    pub fn rewindable(mut self) -> Self {
        self.rewindable = true;
        self
    }
}

/// An action the user can invoke on the focused message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MessageAction {
    /// Copy the focused message's text.
    CopyText,
    /// Rewind the conversation to the message at this index.
    RewindTo(usize),
    /// Toggle the focused message's expanded state.
    ToggleExpand,
}

/// What performing an action would do.
///
/// The variants are requests, not effects: returning one changes nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionOutcome {
    /// Put this text on the clipboard.
    Copied(String),
    /// Rewind the conversation to this message index.
    Rewound(usize),
    /// Toggle this key in the expansion state.
    Toggled(RowKey),
    /// The action does not apply; the enum carries it back for reporting.
    Unavailable(MessageAction),
}

/// Cursor over the transcript's messages plus action availability.
///
/// The cursor starts on the newest message. [`MessageActions::next`] and
/// [`MessageActions::previous`] stop at the ends rather than wrapping.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MessageActions {
    messages: Vec<MessageMeta>,
    focus: Option<usize>,
}

impl MessageActions {
    /// Build a cursor positioned on the last message.
    pub fn new(messages: Vec<MessageMeta>) -> Self {
        let focus = messages.len().checked_sub(1);
        Self { messages, focus }
    }

    pub fn len(&self) -> usize {
        self.messages.len()
    }

    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    /// Index of the focused message, if any.
    pub fn focus(&self) -> Option<usize> {
        self.focus
    }

    /// The focused message, if any.
    pub fn focused(&self) -> Option<&MessageMeta> {
        self.focus.and_then(|index| self.messages.get(index))
    }

    /// Move to the next (newer) message. Returns the new focus, or `None`
    /// when already at the end or empty.
    // Moves a cursor rather than yielding items; the name matches the UI
    // keybinding, so `Iterator` would be misleading.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> Option<usize> {
        let next = self.focus?.checked_add(1)?;
        if next >= self.messages.len() {
            return None;
        }
        self.focus = Some(next);
        Some(next)
    }

    /// Move to the previous (older) message. Returns the new focus, or `None`
    /// when already at the start or empty.
    pub fn previous(&mut self) -> Option<usize> {
        let previous = self.focus?.checked_sub(1)?;
        self.focus = Some(previous);
        Some(previous)
    }

    /// Move to the previous (older) message, entering the newest one first
    /// when nothing is focused yet.
    pub fn previous_or_last(&mut self) -> Option<usize> {
        if self.focus.is_none() {
            self.focus_last();
            return self.focus;
        }
        self.previous()
    }

    /// Move to the next (newer) message, entering the newest one first when
    /// nothing is focused yet.
    pub fn next_or_last(&mut self) -> Option<usize> {
        if self.focus.is_none() {
            self.focus_last();
            return self.focus;
        }
        self.next()
    }

    /// Focus the newest message. A no-op on an empty transcript.
    pub fn focus_last(&mut self) {
        self.focus = self.messages.len().checked_sub(1);
    }

    /// Clear the focus without changing the messages.
    pub fn clear(&mut self) {
        self.focus = None;
    }

    /// Restore the focus to a message index. An out-of-range index clears it.
    pub fn set_focus(&mut self, index: Option<usize>) {
        self.focus = index.filter(|index| *index < self.messages.len());
    }

    /// Whether `action` applies to the focused message.
    ///
    /// - `CopyText`: the focused message has non-empty text.
    /// - `RewindTo(i)`: `i` is strictly older than the focus and the target is
    ///   marked rewindable.
    /// - `ToggleExpand`: the focused message is marked expandable.
    pub fn can(&self, action: MessageAction) -> bool {
        match action {
            MessageAction::CopyText => self
                .focused()
                .is_some_and(|message| !message.text.is_empty()),
            MessageAction::RewindTo(index) => self.focus.is_some_and(|focus| {
                index < focus
                    && self
                        .messages
                        .get(index)
                        .is_some_and(|message| message.rewindable)
            }),
            MessageAction::ToggleExpand => self.focused().is_some_and(|message| message.expandable),
        }
    }

    /// Describe the effect of `action`, or report it unavailable.
    pub fn perform(&self, action: MessageAction) -> ActionOutcome {
        let Some(message) = self.focused() else {
            return ActionOutcome::Unavailable(action);
        };
        if !self.can(action) {
            return ActionOutcome::Unavailable(action);
        }
        match action {
            MessageAction::CopyText => ActionOutcome::Copied(message.text.clone()),
            MessageAction::RewindTo(index) => ActionOutcome::Rewound(index),
            MessageAction::ToggleExpand => ActionOutcome::Toggled(message.key.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expand::ExpandState;

    fn transcript() -> Vec<MessageMeta> {
        vec![
            MessageMeta::new("u0", "first prompt").rewindable(),
            MessageMeta::new("a0", "answer").expandable(),
            MessageMeta::new("u1", "second prompt").rewindable(),
            MessageMeta::new("a1", ""),
        ]
    }

    #[test]
    fn focus_starts_on_the_newest_message() {
        let mut actions = MessageActions::new(transcript());
        assert_eq!(actions.focus(), Some(3));
        assert_eq!(
            actions.focused().map(|m| m.key.clone()),
            Some(RowKey::uuid("a1"))
        );

        assert_eq!(actions.previous(), Some(2));
        assert_eq!(actions.next(), Some(3));
        assert_eq!(actions.next(), None);
        assert_eq!(actions.focus(), Some(3));
    }

    #[test]
    fn focus_walks_to_the_start_and_stops() {
        let mut actions = MessageActions::new(transcript());
        assert_eq!(actions.previous(), Some(2));
        assert_eq!(actions.previous(), Some(1));
        assert_eq!(actions.previous(), Some(0));
        assert_eq!(actions.previous(), None);
        assert_eq!(actions.focus(), Some(0));
    }

    #[test]
    fn focus_can_be_cleared_restored_and_entered_at_the_newest() {
        let mut actions = MessageActions::new(transcript());
        actions.clear();
        assert_eq!(actions.focus(), None);
        assert!(!actions.can(MessageAction::CopyText));

        // Entering from no focus lands on the newest message.
        assert_eq!(actions.previous_or_last(), Some(3));
        actions.clear();
        assert_eq!(actions.next_or_last(), Some(3));

        // Restoring an index in range keeps it; out of range clears.
        actions.set_focus(Some(1));
        assert_eq!(actions.focus(), Some(1));
        actions.set_focus(Some(99));
        assert_eq!(actions.focus(), None);

        actions.focus_last();
        assert_eq!(actions.focus(), Some(3));
    }

    #[test]
    fn empty_transcript_has_no_focus_or_actions() {
        let mut actions = MessageActions::new(Vec::new());
        assert!(actions.is_empty());
        assert_eq!(actions.len(), 0);
        assert_eq!(actions.focus(), None);
        assert_eq!(actions.next(), None);
        assert_eq!(actions.previous(), None);
        for action in [
            MessageAction::CopyText,
            MessageAction::RewindTo(0),
            MessageAction::ToggleExpand,
        ] {
            assert!(!actions.can(action));
            assert_eq!(actions.perform(action), ActionOutcome::Unavailable(action));
        }
    }

    #[test]
    fn copy_requires_non_empty_focused_text() {
        let mut actions = MessageActions::new(transcript());
        // Newest message is empty.
        assert!(!actions.can(MessageAction::CopyText));
        assert_eq!(
            actions.perform(MessageAction::CopyText),
            ActionOutcome::Unavailable(MessageAction::CopyText)
        );

        actions.previous();
        assert!(actions.can(MessageAction::CopyText));
        assert_eq!(
            actions.perform(MessageAction::CopyText),
            ActionOutcome::Copied("second prompt".into())
        );
    }

    #[test]
    fn rewind_only_targets_earlier_rewindable_messages() {
        let actions = MessageActions::new(transcript());
        assert!(actions.can(MessageAction::RewindTo(0)));
        assert!(actions.can(MessageAction::RewindTo(2)));
        // Assistant messages are not rewind targets in this model.
        assert!(!actions.can(MessageAction::RewindTo(1)));
        // The focus itself and anything newer are unavailable.
        assert!(!actions.can(MessageAction::RewindTo(3)));
        assert!(!actions.can(MessageAction::RewindTo(4)));

        assert_eq!(
            actions.perform(MessageAction::RewindTo(2)),
            ActionOutcome::Rewound(2)
        );
        assert_eq!(
            actions.perform(MessageAction::RewindTo(1)),
            ActionOutcome::Unavailable(MessageAction::RewindTo(1))
        );
    }

    #[test]
    fn toggle_expand_requires_an_expandable_focused_message() {
        let mut actions = MessageActions::new(transcript());
        assert!(!actions.can(MessageAction::ToggleExpand));

        actions.previous(); // u1
        assert!(!actions.can(MessageAction::ToggleExpand));

        actions.previous(); // a0
        assert!(actions.can(MessageAction::ToggleExpand));
        assert_eq!(
            actions.perform(MessageAction::ToggleExpand),
            ActionOutcome::Toggled(RowKey::uuid("a0"))
        );
    }

    #[test]
    fn toggle_outcome_key_drives_expand_state() {
        let actions =
            MessageActions::new(vec![MessageMeta::new(9usize, "tool output").expandable()]);
        let ActionOutcome::Toggled(key) = actions.perform(MessageAction::ToggleExpand) else {
            panic!("expandable message should toggle");
        };

        let mut state = ExpandState::new();
        assert!(!state.is_expanded(key.clone()));
        state.toggle(key.clone());
        assert!(state.is_expanded(key));
    }
}
