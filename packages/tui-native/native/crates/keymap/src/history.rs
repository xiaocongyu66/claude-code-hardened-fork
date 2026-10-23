//! Bridge between `HISTORY_SEARCH_*` keymap actions and [`HistorySearch`].

use cch_tui_core::HistorySearch;

use crate::Action;

/// Commands the history-search overlay understands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistorySearchCommand {
    Next,
    Accept,
    Cancel,
    Execute,
}

impl HistorySearchCommand {
    /// Map an [`Action`] to a command, or `None` for unrelated actions.
    pub fn from_action(action: Action) -> Option<Self> {
        if action == Action::HISTORY_SEARCH_NEXT {
            Some(Self::Next)
        } else if action == Action::HISTORY_SEARCH_ACCEPT {
            Some(Self::Accept)
        } else if action == Action::HISTORY_SEARCH_CANCEL {
            Some(Self::Cancel)
        } else if action == Action::HISTORY_SEARCH_EXECUTE {
            Some(Self::Execute)
        } else {
            None
        }
    }
}

/// Result of feeding a keymap action to [`apply_history_search`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistorySearchOutcome {
    /// Not a history-search action.
    Ignored,
    /// The selection moved (or no match was available).
    Updated,
    /// Search ended with `value` left in the input.
    Accepted(String),
    /// Search abandoned; restore the original input.
    Cancelled,
    /// Search ended and `value` should be submitted.
    Executed(String),
}

/// Apply a keymap action to the history-search model.
///
/// The prompt's event loop resolves keys with the `HistorySearch` context on
/// top of the stack, then forwards the resulting action here. Query text is
/// fed separately through [`HistorySearch::set_query`].
pub fn apply_history_search(search: &mut HistorySearch, action: Action) -> HistorySearchOutcome {
    match HistorySearchCommand::from_action(action) {
        None => HistorySearchOutcome::Ignored,
        Some(HistorySearchCommand::Next) => {
            search.next();
            HistorySearchOutcome::Updated
        }
        Some(HistorySearchCommand::Accept) => match search.accept() {
            Some(value) => HistorySearchOutcome::Accepted(value),
            None => HistorySearchOutcome::Updated,
        },
        Some(HistorySearchCommand::Cancel) => {
            search.cancel();
            HistorySearchOutcome::Cancelled
        }
        Some(HistorySearchCommand::Execute) => match search.accept() {
            Some(value) => HistorySearchOutcome::Executed(value),
            None => HistorySearchOutcome::Updated,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Context, ContextStack, Key, Keymap, Resolution};
    use cch_tui_core::HistoryScope;

    fn search() -> HistorySearch {
        let mut search = HistorySearch::new(HistoryScope::Global);
        search.set_query(
            "fix",
            &[
                "Fix one".to_owned(),
                "fix two".to_owned(),
                "unrelated".to_owned(),
            ],
        );
        search
    }

    #[test]
    fn history_search_actions_map_to_commands() {
        for (action, command) in [
            (Action::HISTORY_SEARCH_NEXT, HistorySearchCommand::Next),
            (Action::HISTORY_SEARCH_ACCEPT, HistorySearchCommand::Accept),
            (Action::HISTORY_SEARCH_CANCEL, HistorySearchCommand::Cancel),
            (
                Action::HISTORY_SEARCH_EXECUTE,
                HistorySearchCommand::Execute,
            ),
        ] {
            assert_eq!(HistorySearchCommand::from_action(action), Some(command));
        }
        assert_eq!(
            HistorySearchCommand::from_action(Action::PROMPT_SUBMIT),
            None
        );
    }

    #[test]
    fn keymap_actions_drive_the_search_model() {
        let keymap = Keymap::default();
        let mut stack = ContextStack::new();
        stack.push(Context::PROMPT);
        stack.push(Context::HISTORY_SEARCH);
        let mut search = search();

        let next = match keymap.resolve_once(&stack, Key::ctrl_char('r'), 0) {
            Resolution::Action(action) => action,
            other => panic!("ctrl+r should resolve, got {other:?}"),
        };
        assert_eq!(
            apply_history_search(&mut search, next),
            HistorySearchOutcome::Updated
        );
        assert_eq!(search.current(), Some("fix two"));

        let execute = match keymap.resolve_once(&stack, Key::enter(), 0) {
            Resolution::Action(action) => action,
            other => panic!("enter should resolve, got {other:?}"),
        };
        assert_eq!(
            apply_history_search(&mut search, execute),
            HistorySearchOutcome::Executed("fix two".to_owned())
        );
        assert!(!search.is_active());

        let cancel = match keymap.resolve_once(&stack, Key::ctrl_char('c'), 0) {
            Resolution::Action(action) => action,
            other => panic!("ctrl+c should resolve, got {other:?}"),
        };
        assert_eq!(
            apply_history_search(&mut search, cancel),
            HistorySearchOutcome::Cancelled
        );
    }

    #[test]
    fn accept_returns_the_current_match() {
        let mut search = search();
        search.next();
        assert_eq!(
            apply_history_search(&mut search, Action::HISTORY_SEARCH_ACCEPT),
            HistorySearchOutcome::Accepted("fix two".to_owned())
        );
    }
}
