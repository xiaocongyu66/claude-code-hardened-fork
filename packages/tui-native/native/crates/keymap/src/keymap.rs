//! Built-in, table-driven keymap and its extension points.

use crate::{Action, Binding, BindingSpec, Context, ContextStack, Key, Resolution, Resolver};

/// Global shortcuts: interrupt, exit, redraw, transcript, history search.
pub const GLOBAL_SPECS: &[BindingSpec] = &[
    BindingSpec::new(
        Context::GLOBAL,
        &[Key::ctrl_char('c')],
        Action::APP_INTERRUPT,
    ),
    BindingSpec::new(Context::GLOBAL, &[Key::ctrl_char('d')], Action::APP_EXIT),
    BindingSpec::new(Context::GLOBAL, &[Key::ctrl_char('l')], Action::APP_REDRAW),
    BindingSpec::new(
        Context::GLOBAL,
        &[Key::ctrl_char('o')],
        Action::APP_TOGGLE_TRANSCRIPT,
    ),
    BindingSpec::new(
        Context::GLOBAL,
        &[Key::ctrl_char('r')],
        Action::HISTORY_SEARCH,
    ),
    // Catch-all escape; prompt/dialog/modal contexts override it.
    BindingSpec::new(Context::GLOBAL, &[Key::esc()], Action::APP_ESCAPE),
];

/// Prompt (chat input) editing and submission keys.
pub const PROMPT_SPECS: &[BindingSpec] = &[
    // Enter submits; the Ink implementation also treats this as the
    // non-multiline default.
    BindingSpec::new(Context::PROMPT, &[Key::enter()], Action::PROMPT_SUBMIT),
    BindingSpec::new(
        Context::PROMPT,
        &[Key::enter().with_shift()],
        Action::PROMPT_NEWLINE,
    ),
    BindingSpec::new(
        Context::PROMPT,
        &[Key::ctrl_char('j')],
        Action::PROMPT_NEWLINE,
    ),
    BindingSpec::new(Context::PROMPT, &[Key::esc()], Action::PROMPT_ESCAPE),
    // History navigation. The caller moves within the TextBuffer first and
    // falls back to these actions at the first/last line, as Ink does.
    BindingSpec::new(Context::PROMPT, &[Key::up()], Action::HISTORY_PREVIOUS),
    BindingSpec::new(Context::PROMPT, &[Key::down()], Action::HISTORY_NEXT),
    // Readline-style line editing.
    BindingSpec::new(
        Context::PROMPT,
        &[Key::ctrl_char('a')],
        Action::EDIT_LINE_START,
    ),
    BindingSpec::new(
        Context::PROMPT,
        &[Key::ctrl_char('e')],
        Action::EDIT_LINE_END,
    ),
    BindingSpec::new(
        Context::PROMPT,
        &[Key::ctrl_char('b')],
        Action::EDIT_CHAR_BACKWARD,
    ),
    BindingSpec::new(
        Context::PROMPT,
        &[Key::ctrl_char('f')],
        Action::EDIT_CHAR_FORWARD,
    ),
    BindingSpec::new(
        Context::PROMPT,
        &[Key::ctrl_char('k')],
        Action::EDIT_KILL_TO_END,
    ),
    BindingSpec::new(
        Context::PROMPT,
        &[Key::ctrl_char('u')],
        Action::EDIT_KILL_TO_START,
    ),
    BindingSpec::new(
        Context::PROMPT,
        &[Key::ctrl_char('w')],
        Action::EDIT_KILL_WORD_BEFORE,
    ),
    BindingSpec::new(Context::PROMPT, &[Key::ctrl_char('y')], Action::EDIT_YANK),
    BindingSpec::new(Context::PROMPT, &[Key::ctrl_char('_')], Action::PROMPT_UNDO),
    // Raw editing keys resolve to actions so the prompt can consume them
    // before generic character input inserts text.
    BindingSpec::new(Context::PROMPT, &[Key::left()], Action::EDIT_LEFT),
    BindingSpec::new(Context::PROMPT, &[Key::right()], Action::EDIT_RIGHT),
    BindingSpec::new(Context::PROMPT, &[Key::home()], Action::EDIT_LINE_START),
    BindingSpec::new(Context::PROMPT, &[Key::end()], Action::EDIT_LINE_END),
    BindingSpec::new(Context::PROMPT, &[Key::backspace()], Action::EDIT_BACKSPACE),
    BindingSpec::new(Context::PROMPT, &[Key::delete()], Action::EDIT_DELETE),
    // Explicit two-step submit, useful for terminals that rebind Enter.
    BindingSpec::new(
        Context::PROMPT,
        &[Key::ctrl_char('x'), Key::enter()],
        Action::PROMPT_SUBMIT,
    ),
    BindingSpec::new(
        Context::PROMPT,
        &[Key::ctrl_char('x'), Key::ctrl_char('e')],
        Action::PROMPT_EXTERNAL_EDITOR,
    ),
    BindingSpec::new(
        Context::PROMPT,
        &[Key::ctrl_char('x'), Key::ctrl_char('k')],
        Action::PROMPT_KILL_AGENTS,
    ),
    BindingSpec::new(
        Context::PROMPT,
        &[Key::ctrl_char('g')],
        Action::PROMPT_EXTERNAL_EDITOR,
    ),
    BindingSpec::new(
        Context::PROMPT,
        &[Key::ctrl_char('s')],
        Action::PROMPT_STASH,
    ),
];

/// History search overlay.
pub const HISTORY_SEARCH_SPECS: &[BindingSpec] = &[
    BindingSpec::new(
        Context::HISTORY_SEARCH,
        &[Key::ctrl_char('r')],
        Action::HISTORY_SEARCH_NEXT,
    ),
    BindingSpec::new(
        Context::HISTORY_SEARCH,
        &[Key::esc()],
        Action::HISTORY_SEARCH_ACCEPT,
    ),
    BindingSpec::new(
        Context::HISTORY_SEARCH,
        &[Key::tab()],
        Action::HISTORY_SEARCH_ACCEPT,
    ),
    BindingSpec::new(
        Context::HISTORY_SEARCH,
        &[Key::ctrl_char('c')],
        Action::HISTORY_SEARCH_CANCEL,
    ),
    BindingSpec::new(
        Context::HISTORY_SEARCH,
        &[Key::enter()],
        Action::HISTORY_SEARCH_EXECUTE,
    ),
];

/// Autocomplete popup.
pub const AUTOCOMPLETE_SPECS: &[BindingSpec] = &[
    BindingSpec::new(
        Context::AUTOCOMPLETE,
        &[Key::tab()],
        Action::AUTOCOMPLETE_ACCEPT,
    ),
    BindingSpec::new(
        Context::AUTOCOMPLETE,
        &[Key::esc()],
        Action::AUTOCOMPLETE_DISMISS,
    ),
    BindingSpec::new(
        Context::AUTOCOMPLETE,
        &[Key::up()],
        Action::AUTOCOMPLETE_PREVIOUS,
    ),
    BindingSpec::new(
        Context::AUTOCOMPLETE,
        &[Key::down()],
        Action::AUTOCOMPLETE_NEXT,
    ),
];

/// Generic dialog navigation.
pub const DIALOG_SPECS: &[BindingSpec] = &[
    BindingSpec::new(Context::DIALOG, &[Key::esc()], Action::DIALOG_DISMISS),
    BindingSpec::new(Context::DIALOG, &[Key::enter()], Action::DIALOG_CONFIRM),
    BindingSpec::new(Context::DIALOG, &[Key::up()], Action::DIALOG_PREVIOUS),
    BindingSpec::new(Context::DIALOG, &[Key::down()], Action::DIALOG_NEXT),
    BindingSpec::new(Context::DIALOG, &[Key::tab()], Action::DIALOG_NEXT),
    BindingSpec::new(
        Context::DIALOG,
        &[Key::tab().with_shift()],
        Action::DIALOG_PREVIOUS,
    ),
];

/// Full-screen modal layer; only dismissal is shared.
pub const MODAL_SPECS: &[BindingSpec] = &[BindingSpec::new(
    Context::MODAL,
    &[Key::esc()],
    Action::MODAL_DISMISS,
)];

/// All built-in tables, in lookup-precedence-independent order (the context
/// stack decides precedence, not table order).
pub const BASE_TABLES: &[&[BindingSpec]] = &[
    GLOBAL_SPECS,
    PROMPT_SPECS,
    HISTORY_SEARCH_SPECS,
    AUTOCOMPLETE_SPECS,
    DIALOG_SPECS,
    MODAL_SPECS,
];

/// Binding table plus the stack-aware resolver factory.
///
/// New contexts (vim, diffs, plugins) are added by pushing a
/// [`BindingSpec`] table onto a keymap, without changing the resolver:
///
/// ```
/// use cch_tui_keymap::{Action, BindingSpec, Context, Key, Keymap};
///
/// const VIM: &[BindingSpec] = &[BindingSpec::new(
///     Context::VIM_NORMAL,
///     &[Key::char('h')],
///     Action::new("vim.left"),
/// )];
/// let mut keymap = Keymap::default();
/// keymap.extend(VIM);
/// assert!(keymap.bindings().iter().any(|b| b.action.id() == "vim.left"));
/// ```
#[derive(Debug, Clone)]
pub struct Keymap {
    bindings: Vec<Binding>,
}

impl Default for Keymap {
    /// The built-in keymap (`Keymap::default()`).
    fn default() -> Self {
        Self::with_base()
    }
}

impl Keymap {
    /// An empty keymap, for tests and fully custom setups.
    pub fn new() -> Self {
        Self {
            bindings: Vec::new(),
        }
    }

    /// The built-in keymap.
    pub fn with_base() -> Self {
        let mut keymap = Self::new();
        for table in BASE_TABLES {
            keymap.extend(table);
        }
        keymap
    }

    /// The built-in keymap plus caller-provided extension tables.
    pub fn with_extensions(tables: &[&[BindingSpec]]) -> Self {
        let mut keymap = Self::default();
        for table in tables {
            keymap.extend(table);
        }
        keymap
    }

    /// Append a table. Later rows override earlier rows within a context.
    pub fn extend(&mut self, specs: &[BindingSpec]) {
        self.bindings.extend(specs.iter().map(Binding::from));
    }

    /// Append a single owned binding.
    pub fn bind(&mut self, binding: Binding) {
        self.bindings.push(binding);
    }

    pub fn bindings(&self) -> &[Binding] {
        &self.bindings
    }

    /// Build a resolver borrowed from this keymap and `stack`.
    pub fn resolver<'a>(&'a self, stack: &'a ContextStack, timeout_ms: u64) -> Resolver<'a> {
        Resolver::new(&self.bindings, stack, timeout_ms)
    }

    /// Resolve a single key with a throwaway resolver. Intended for tests and
    /// display code that never uses chords.
    pub fn resolve_once(&self, stack: &ContextStack, key: Key, now_ms: u64) -> Resolution {
        self.resolver(stack, 0).resolve(key, now_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt_stack() -> ContextStack {
        let mut stack = ContextStack::new();
        stack.push(Context::PROMPT);
        stack
    }

    fn resolve(stack: &ContextStack, key: Key) -> Resolution {
        Keymap::default().resolve_once(stack, key, 0)
    }

    #[test]
    fn base_prompt_bindings_match_the_ink_semantics() {
        let stack = prompt_stack();
        assert_eq!(
            resolve(&stack, Key::enter()),
            Resolution::Action(Action::PROMPT_SUBMIT)
        );
        assert_eq!(
            resolve(&stack, Key::enter().with_shift()),
            Resolution::Action(Action::PROMPT_NEWLINE)
        );
        assert_eq!(
            resolve(&stack, Key::ctrl_char('j')),
            Resolution::Action(Action::PROMPT_NEWLINE)
        );
        assert_eq!(
            resolve(&stack, Key::ctrl_char('c')),
            Resolution::Action(Action::APP_INTERRUPT)
        );
        assert_eq!(
            resolve(&stack, Key::ctrl_char('r')),
            Resolution::Action(Action::HISTORY_SEARCH)
        );
        assert_eq!(
            resolve(&stack, Key::up()),
            Resolution::Action(Action::HISTORY_PREVIOUS)
        );
        assert_eq!(
            resolve(&stack, Key::down()),
            Resolution::Action(Action::HISTORY_NEXT)
        );
    }

    #[test]
    fn ctrl_line_editing_keys_are_all_bound() {
        let stack = prompt_stack();
        for (key, action) in [
            ('a', Action::EDIT_LINE_START),
            ('e', Action::EDIT_LINE_END),
            ('b', Action::EDIT_CHAR_BACKWARD),
            ('f', Action::EDIT_CHAR_FORWARD),
            ('k', Action::EDIT_KILL_TO_END),
            ('u', Action::EDIT_KILL_TO_START),
            ('w', Action::EDIT_KILL_WORD_BEFORE),
            ('y', Action::EDIT_YANK),
            ('_', Action::PROMPT_UNDO),
        ] {
            assert_eq!(
                resolve(&stack, Key::ctrl_char(key)),
                Resolution::Action(action),
                "ctrl+{key}"
            );
        }
    }

    #[test]
    fn escape_walks_the_context_stack_layer_by_layer() {
        let keymap = Keymap::default();
        let mut stack = prompt_stack();

        let mut resolver = keymap.resolver(&stack, 500);
        assert_eq!(
            resolver.resolve(Key::esc(), 0),
            Resolution::Action(Action::PROMPT_ESCAPE)
        );

        stack.push(Context::DIALOG);
        let mut resolver = keymap.resolver(&stack, 500);
        assert_eq!(
            resolver.resolve(Key::esc(), 0),
            Resolution::Action(Action::DIALOG_DISMISS)
        );

        stack.push(Context::MODAL);
        let mut resolver = keymap.resolver(&stack, 500);
        assert_eq!(
            resolver.resolve(Key::esc(), 0),
            Resolution::Action(Action::MODAL_DISMISS)
        );

        stack.pop(Context::MODAL);
        let mut resolver = keymap.resolver(&stack, 500);
        assert_eq!(
            resolver.resolve(Key::esc(), 0),
            Resolution::Action(Action::DIALOG_DISMISS)
        );

        stack.pop(Context::DIALOG);
        let mut resolver = keymap.resolver(&stack, 500);
        assert_eq!(
            resolver.resolve(Key::esc(), 0),
            Resolution::Action(Action::PROMPT_ESCAPE)
        );

        stack.pop(Context::PROMPT);
        let mut resolver = keymap.resolver(&stack, 500);
        assert_eq!(
            resolver.resolve(Key::esc(), 0),
            Resolution::Action(Action::APP_ESCAPE)
        );
    }

    #[test]
    fn default_chord_submits_on_ctrl_x_enter() {
        let keymap = Keymap::default();
        let stack = prompt_stack();
        let mut resolver = keymap.resolver(&stack, 500);
        assert_eq!(
            resolver.resolve(Key::ctrl_char('x'), 0),
            Resolution::Pending
        );
        assert_eq!(
            resolver.resolve(Key::enter(), 50),
            Resolution::Action(Action::PROMPT_SUBMIT)
        );
    }

    #[test]
    fn history_search_context_overrides_global_ctrl_r() {
        let keymap = Keymap::default();
        let mut stack = prompt_stack();
        stack.push(Context::HISTORY_SEARCH);
        let mut resolver = keymap.resolver(&stack, 500);
        assert_eq!(
            resolver.resolve(Key::ctrl_char('r'), 0),
            Resolution::Action(Action::HISTORY_SEARCH_NEXT)
        );
        assert_eq!(
            resolver.resolve(Key::esc(), 0),
            Resolution::Action(Action::HISTORY_SEARCH_ACCEPT)
        );
        assert_eq!(
            resolver.resolve(Key::ctrl_char('c'), 0),
            Resolution::Action(Action::HISTORY_SEARCH_CANCEL)
        );
    }

    #[test]
    fn autocomplete_context_captures_tab_and_arrows() {
        let keymap = Keymap::default();
        let mut stack = prompt_stack();
        stack.push(Context::AUTOCOMPLETE);
        let mut resolver = keymap.resolver(&stack, 500);
        assert_eq!(
            resolver.resolve(Key::tab(), 0),
            Resolution::Action(Action::AUTOCOMPLETE_ACCEPT)
        );
        assert_eq!(
            resolver.resolve(Key::up(), 0),
            Resolution::Action(Action::AUTOCOMPLETE_PREVIOUS)
        );
        assert_eq!(
            resolver.resolve(Key::down(), 0),
            Resolution::Action(Action::AUTOCOMPLETE_NEXT)
        );
    }

    #[test]
    fn extensions_can_add_vim_context_bindings() {
        let mut keymap = Keymap::default();
        keymap.bind(Binding::new(
            Context::VIM_NORMAL,
            [Key::char('h'), Key::char('j')],
            Action::new("vim.motion"),
        ));
        let stack = prompt_stack();
        let mut resolver = keymap.resolver(&stack, 500);
        // The vim context is not active yet.
        assert_eq!(resolver.resolve(Key::char('h'), 0), Resolution::Ignored);

        let mut stack = prompt_stack();
        stack.push(Context::VIM_NORMAL);
        let mut resolver = keymap.resolver(&stack, 500);
        assert_eq!(resolver.resolve(Key::char('h'), 0), Resolution::Pending);
        assert_eq!(
            resolver.resolve(Key::char('j'), 10),
            Resolution::Action(Action::new("vim.motion"))
        );
    }

    #[test]
    fn unbound_keys_are_ignored() {
        let stack = prompt_stack();
        assert_eq!(resolve(&stack, Key::char('z')), Resolution::Ignored);
    }
}
