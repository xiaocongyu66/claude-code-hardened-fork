//! Vim-mode bindings and their [`TextBuffer`] semantics.
//!
//! [`VIM_SPECS`] is an opt-in extension table: push [`Context::VIM_NORMAL`] or
//! [`Context::VIM_INSERT`] onto the context stack and build the keymap with
//! [`crate::Keymap::with_extensions`]. The caller owns the mode transition
//! (`i`/`a`/`o` emit [`Action::VIM_INSERT`], `Esc` in insert mode emits
//! [`Action::VIM_NORMAL`]); [`VimAction::apply`] covers the buffer edits.

use cch_tui_core::TextBuffer;

use crate::{Action, BindingSpec, Context, Key};

/// Normal-mode motions/edits plus the insert-mode escape.
pub const VIM_SPECS: &[BindingSpec] = &[
    BindingSpec::new(Context::VIM_NORMAL, &[Key::char('h')], Action::VIM_LEFT),
    BindingSpec::new(Context::VIM_NORMAL, &[Key::char('j')], Action::VIM_DOWN),
    BindingSpec::new(Context::VIM_NORMAL, &[Key::char('k')], Action::VIM_UP),
    BindingSpec::new(Context::VIM_NORMAL, &[Key::char('l')], Action::VIM_RIGHT),
    BindingSpec::new(Context::VIM_NORMAL, &[Key::char('i')], Action::VIM_INSERT),
    BindingSpec::new(Context::VIM_NORMAL, &[Key::char('a')], Action::VIM_APPEND),
    BindingSpec::new(
        Context::VIM_NORMAL,
        &[Key::char('o')],
        Action::VIM_OPEN_LINE,
    ),
    BindingSpec::new(
        Context::VIM_NORMAL,
        &[Key::char('0')],
        Action::VIM_LINE_START,
    ),
    BindingSpec::new(Context::VIM_NORMAL, &[Key::char('$')], Action::VIM_LINE_END),
    BindingSpec::new(
        Context::VIM_NORMAL,
        &[Key::char('w')],
        Action::VIM_WORD_FORWARD,
    ),
    BindingSpec::new(
        Context::VIM_NORMAL,
        &[Key::char('b')],
        Action::VIM_WORD_BACKWARD,
    ),
    BindingSpec::new(
        Context::VIM_NORMAL,
        &[Key::char('x')],
        Action::VIM_DELETE_CHAR,
    ),
    BindingSpec::new(
        Context::VIM_NORMAL,
        &[Key::char('d'), Key::char('d')],
        Action::VIM_DELETE_LINE,
    ),
    BindingSpec::new(Context::VIM_NORMAL, &[Key::char('u')], Action::VIM_UNDO),
    BindingSpec::new(Context::VIM_INSERT, &[Key::esc()], Action::VIM_NORMAL),
];

/// Semantics of a [`VIM_SPECS`] action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VimAction {
    Left,
    Down,
    Up,
    Right,
    /// Enter insert mode at the cursor.
    Insert,
    /// Enter insert mode after the cursor.
    Append,
    /// Open a new line below and enter insert mode.
    OpenLine,
    LineStart,
    LineEnd,
    WordForward,
    WordBackward,
    DeleteChar,
    DeleteLine,
    Undo,
    /// Leave insert mode; the caller swaps the context.
    NormalMode,
}

impl VimAction {
    /// Map a keymap [`Action`] to its vim semantics, if it is one.
    pub fn from_action(action: Action) -> Option<Self> {
        if action == Action::VIM_LEFT {
            Some(Self::Left)
        } else if action == Action::VIM_DOWN {
            Some(Self::Down)
        } else if action == Action::VIM_UP {
            Some(Self::Up)
        } else if action == Action::VIM_RIGHT {
            Some(Self::Right)
        } else if action == Action::VIM_INSERT {
            Some(Self::Insert)
        } else if action == Action::VIM_APPEND {
            Some(Self::Append)
        } else if action == Action::VIM_OPEN_LINE {
            Some(Self::OpenLine)
        } else if action == Action::VIM_LINE_START {
            Some(Self::LineStart)
        } else if action == Action::VIM_LINE_END {
            Some(Self::LineEnd)
        } else if action == Action::VIM_WORD_FORWARD {
            Some(Self::WordForward)
        } else if action == Action::VIM_WORD_BACKWARD {
            Some(Self::WordBackward)
        } else if action == Action::VIM_DELETE_CHAR {
            Some(Self::DeleteChar)
        } else if action == Action::VIM_DELETE_LINE {
            Some(Self::DeleteLine)
        } else if action == Action::VIM_UNDO {
            Some(Self::Undo)
        } else if action == Action::VIM_NORMAL {
            Some(Self::NormalMode)
        } else {
            None
        }
    }

    /// Apply the action to `buffer`, returning whether it changed anything.
    ///
    /// `Insert` and `NormalMode` only signal a mode switch, so they report
    /// success without touching the buffer.
    pub fn apply(self, buffer: &mut TextBuffer) -> bool {
        match self {
            Self::Left => buffer.move_left(),
            Self::Down => buffer.move_down(),
            Self::Up => buffer.move_up(),
            Self::Right => buffer.move_right(),
            Self::Insert => true,
            Self::Append => {
                buffer.move_right();
                true
            }
            Self::OpenLine => {
                let line = buffer.cursor_position().0;
                let Some((_, end)) = buffer.line_bounds(line) else {
                    return false;
                };
                buffer.set_cursor(end);
                buffer.insert_str("\n")
            }
            Self::LineStart => buffer.move_home(),
            Self::LineEnd => buffer.move_end(),
            Self::WordForward => {
                let target = word_forward(buffer.text(), buffer.cursor());
                let moved = target != buffer.cursor();
                buffer.set_cursor(target);
                moved
            }
            Self::WordBackward => {
                let target = word_backward(buffer.text(), buffer.cursor());
                let moved = target != buffer.cursor();
                buffer.set_cursor(target);
                moved
            }
            Self::DeleteChar => buffer.delete_forward(),
            Self::DeleteLine => delete_line(buffer),
            Self::Undo => buffer.undo(),
            Self::NormalMode => true,
        }
    }
}

/// `dd`: remove the current line including its newline (and the preceding
/// newline when the cursor sits on the last, newline-less line).
fn delete_line(buffer: &mut TextBuffer) -> bool {
    let line = buffer.cursor_position().0;
    let Some((start, end)) = buffer.line_bounds(line) else {
        return false;
    };
    let end = if end < buffer.len() { end + 1 } else { end };
    let start = if end == buffer.len() && start > 0 {
        start - 1
    } else {
        start
    };
    if start == end {
        return false;
    }
    buffer.select(start, end);
    buffer.backspace()
}

fn word_forward(text: &str, cursor: usize) -> usize {
    let mut target = text.len();
    let mut chars = text[cursor..].char_indices().peekable();
    while let Some(&(_, ch)) = chars.peek() {
        if ch.is_whitespace() {
            break;
        }
        chars.next();
    }
    while let Some(&(index, ch)) = chars.peek() {
        if !ch.is_whitespace() {
            target = cursor + index;
            break;
        }
        chars.next();
    }
    target
}

fn word_backward(text: &str, cursor: usize) -> usize {
    let mut target = cursor;
    let mut chars = text[..cursor].char_indices().rev().peekable();
    while let Some(&(index, ch)) = chars.peek() {
        if !ch.is_whitespace() {
            break;
        }
        target = index;
        chars.next();
    }
    while let Some(&(index, ch)) = chars.peek() {
        if ch.is_whitespace() {
            break;
        }
        target = index;
        chars.next();
    }
    target
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ContextStack, Keymap, Resolution};

    fn normal_stack() -> ContextStack {
        let mut stack = ContextStack::new();
        stack.push(Context::PROMPT);
        stack.push(Context::VIM_NORMAL);
        stack
    }

    fn action_of(keymap: &Keymap, stack: &ContextStack, key: Key) -> Option<Action> {
        match keymap.resolve_once(stack, key, 0) {
            Resolution::Action(action) => Some(action),
            _ => None,
        }
    }

    #[test]
    fn normal_mode_keys_resolve_through_with_extensions() {
        let keymap = Keymap::with_extensions(&[VIM_SPECS]);
        let stack = normal_stack();
        for (key, action) in [
            ('h', Action::VIM_LEFT),
            ('j', Action::VIM_DOWN),
            ('k', Action::VIM_UP),
            ('l', Action::VIM_RIGHT),
            ('i', Action::VIM_INSERT),
            ('a', Action::VIM_APPEND),
            ('o', Action::VIM_OPEN_LINE),
            ('0', Action::VIM_LINE_START),
            ('$', Action::VIM_LINE_END),
            ('w', Action::VIM_WORD_FORWARD),
            ('b', Action::VIM_WORD_BACKWARD),
            ('x', Action::VIM_DELETE_CHAR),
            ('u', Action::VIM_UNDO),
        ] {
            assert_eq!(
                action_of(&keymap, &stack, Key::char(key)),
                Some(action),
                "{key}"
            );
        }
    }

    #[test]
    fn insert_mode_escape_returns_to_normal() {
        let keymap = Keymap::with_extensions(&[VIM_SPECS]);
        let mut stack = normal_stack();

        // `i` asks the caller to enter insert mode.
        assert_eq!(
            action_of(&keymap, &stack, Key::char('i')),
            Some(Action::VIM_INSERT)
        );

        stack.pop(Context::VIM_NORMAL);
        stack.push(Context::VIM_INSERT);
        assert_eq!(
            action_of(&keymap, &stack, Key::esc()),
            Some(Action::VIM_NORMAL)
        );
        // Plain letters are not bound while inserting.
        assert_eq!(
            keymap.resolve_once(&stack, Key::char('i'), 0),
            Resolution::Ignored
        );

        // Esc in normal mode is not consumed by the vim table.
        stack.pop(Context::VIM_INSERT);
        stack.push(Context::VIM_NORMAL);
        assert_eq!(
            action_of(&keymap, &stack, Key::esc()),
            Some(Action::PROMPT_ESCAPE)
        );
    }

    #[test]
    fn dd_deletes_a_line_and_u_undoes_it() {
        let keymap = Keymap::with_extensions(&[VIM_SPECS]);
        let stack = normal_stack();
        let mut resolver = keymap.resolver(&stack, 500);

        assert_eq!(resolver.resolve(Key::char('d'), 0), Resolution::Pending);
        let Resolution::Action(action) = resolver.resolve(Key::char('d'), 20) else {
            panic!("dd should complete the chord");
        };
        assert_eq!(action, Action::VIM_DELETE_LINE);
        assert!(!resolver.is_pending());

        let mut buffer = TextBuffer::from_text("one\ntwo");
        buffer.set_cursor(0);
        assert!(VimAction::from_action(action).unwrap().apply(&mut buffer));
        assert_eq!(buffer.text(), "two");

        let undo = action_of(&keymap, &stack, Key::char('u')).unwrap();
        assert_eq!(undo, Action::VIM_UNDO);
        assert!(VimAction::from_action(undo).unwrap().apply(&mut buffer));
        assert_eq!(buffer.text(), "one\ntwo");
    }

    #[test]
    fn dd_on_the_last_line_removes_the_preceding_newline() {
        let mut buffer = TextBuffer::from_text("one\ntwo");
        buffer.set_cursor(buffer.len());
        assert!(VimAction::DeleteLine.apply(&mut buffer));
        assert_eq!(buffer.text(), "one");
    }

    #[test]
    fn motions_and_word_jumps_move_the_cursor() {
        let mut buffer = TextBuffer::from_text("one two\nthree");
        assert_eq!(buffer.cursor(), 13);

        assert!(VimAction::WordBackward.apply(&mut buffer));
        assert_eq!(buffer.cursor(), 8, "start of `three`");
        assert!(VimAction::WordBackward.apply(&mut buffer));
        assert_eq!(buffer.cursor(), 4, "start of `two`");
        assert!(VimAction::WordForward.apply(&mut buffer));
        assert_eq!(buffer.cursor(), 8, "start of `three`");

        buffer.set_cursor(10);
        assert!(VimAction::LineStart.apply(&mut buffer));
        assert_eq!(buffer.cursor(), 8);
        assert!(VimAction::LineEnd.apply(&mut buffer));
        assert_eq!(buffer.cursor(), 13);

        buffer.set_cursor(0);
        assert!(VimAction::DeleteChar.apply(&mut buffer));
        assert_eq!(buffer.text(), "ne two\nthree");
    }

    #[test]
    fn append_and_open_line_enter_insert_positions() {
        let mut buffer = TextBuffer::from_text("ab");
        buffer.set_cursor(0);
        assert!(VimAction::Append.apply(&mut buffer));
        assert_eq!(buffer.cursor(), 1);

        assert!(VimAction::OpenLine.apply(&mut buffer));
        assert_eq!(buffer.text(), "ab\n");
        assert_eq!(buffer.cursor(), 3);
    }
}
