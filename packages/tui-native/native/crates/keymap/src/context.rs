//! Keybinding contexts and the stack that orders them.
//!
//! Resolution mirrors [`cch_tui_core::EventRouter`]: higher layers are offered
//! an event first and, within a layer, the most recently pushed context wins.
//! The four layers are ordered `global < prompt < dialog < modal`, so a modal
//! can never leak a key to the prompt underneath it.

use std::fmt;

/// Coarse layering used to order contexts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Layer {
    Global,
    Prompt,
    Dialog,
    Modal,
}

/// A named keybinding context plus the layer it lives on.
///
/// Custom contexts are cheap value types, so new dialogs and vim modes can be
/// added without touching the resolver:
///
/// ```
/// use cch_tui_keymap::{Context, Layer};
///
/// let custom = Context::new("diff.preview", Layer::Dialog);
/// assert_eq!(custom.layer(), Layer::Dialog);
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Context {
    name: &'static str,
    layer: Layer,
}

impl Context {
    pub const fn new(name: &'static str, layer: Layer) -> Self {
        Self { name, layer }
    }

    pub const fn name(self) -> &'static str {
        self.name
    }

    pub const fn layer(self) -> Layer {
        self.layer
    }

    pub const GLOBAL: Self = Self::new("global", Layer::Global);
    pub const PROMPT: Self = Self::new("prompt", Layer::Prompt);
    pub const VIM_NORMAL: Self = Self::new("vim.normal", Layer::Prompt);
    pub const VIM_INSERT: Self = Self::new("vim.insert", Layer::Prompt);

    pub const HISTORY_SEARCH: Self = Self::new("history_search", Layer::Dialog);
    pub const AUTOCOMPLETE: Self = Self::new("autocomplete", Layer::Dialog);
    pub const DIALOG: Self = Self::new("dialog", Layer::Dialog);
    pub const SELECT: Self = Self::new("select", Layer::Dialog);
    pub const CONFIRMATION: Self = Self::new("confirmation", Layer::Dialog);
    pub const SETTINGS: Self = Self::new("settings", Layer::Dialog);
    pub const TRANSCRIPT: Self = Self::new("transcript", Layer::Dialog);
    pub const HELP: Self = Self::new("help", Layer::Dialog);
    pub const FOOTER: Self = Self::new("footer", Layer::Dialog);
    pub const ATTACHMENTS: Self = Self::new("attachments", Layer::Dialog);
    pub const DIFF_DIALOG: Self = Self::new("diff_dialog", Layer::Dialog);
    pub const MESSAGE_SELECTOR: Self = Self::new("message_selector", Layer::Dialog);
    pub const PLUGIN: Self = Self::new("plugin", Layer::Dialog);
    pub const SCROLL: Self = Self::new("scroll", Layer::Dialog);
    pub const EFFORT_PANEL: Self = Self::new("effort_panel", Layer::Dialog);
    pub const MODEL_PICKER: Self = Self::new("model_picker", Layer::Dialog);
    pub const TABS: Self = Self::new("tabs", Layer::Dialog);
    pub const FORM_FIELD: Self = Self::new("form_field", Layer::Dialog);
    pub const TASK: Self = Self::new("task", Layer::Dialog);
    pub const THEME_PICKER: Self = Self::new("theme_picker", Layer::Dialog);
    pub const MESSAGE_ACTIONS: Self = Self::new("message_actions", Layer::Dialog);

    pub const MODAL: Self = Self::new("modal", Layer::Modal);
}

impl fmt::Display for Context {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.name)
    }
}

#[derive(Debug, Clone, Copy)]
struct Entry {
    context: Context,
    sequence: u64,
}

/// Active contexts, ordered by layer and then recency.
///
/// `ContextStack::new()` starts with [`Context::GLOBAL`] on the bottom, so
/// global bindings (interrupt, redraw) keep working with no other context
/// pushed. `Default` is equivalent.
#[derive(Debug, Clone)]
pub struct ContextStack {
    entries: Vec<Entry>,
    next_sequence: u64,
}

impl Default for ContextStack {
    fn default() -> Self {
        Self::new()
    }
}

impl ContextStack {
    pub fn new() -> Self {
        let mut stack = Self {
            entries: Vec::new(),
            next_sequence: 0,
        };
        stack.push(Context::GLOBAL);
        stack
    }

    /// Push a context. Later pushes win within the same layer.
    pub fn push(&mut self, context: Context) {
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.wrapping_add(1);
        self.entries.push(Entry { context, sequence });
    }

    /// Remove the most recently pushed instance of `context`.
    pub fn pop(&mut self, context: Context) -> Option<Context> {
        let index = self
            .entries
            .iter()
            .rposition(|entry| entry.context == context)?;
        Some(self.entries.remove(index).context)
    }

    pub fn contains(&self, context: Context) -> bool {
        self.entries.iter().any(|entry| entry.context == context)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Remove every context, including the implicit global layer.
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Resolution order: highest layer first, most recent first within a layer.
    pub fn order(&self) -> Vec<Context> {
        let mut ordered: Vec<&Entry> = self.entries.iter().collect();
        ordered.sort_by_key(|entry| {
            (
                std::cmp::Reverse(entry.context.layer),
                std::cmp::Reverse(entry.sequence),
            )
        });
        ordered.into_iter().map(|entry| entry.context).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_context_is_present_by_default() {
        let stack = ContextStack::new();
        assert_eq!(stack.len(), 1);
        assert!(stack.contains(Context::GLOBAL));
        assert_eq!(stack.order(), [Context::GLOBAL]);
    }

    #[test]
    fn layer_order_is_modal_dialog_prompt_global() {
        let mut stack = ContextStack::new();
        stack.push(Context::PROMPT);
        stack.push(Context::DIALOG);
        stack.push(Context::MODAL);
        assert_eq!(
            stack.order(),
            [
                Context::MODAL,
                Context::DIALOG,
                Context::PROMPT,
                Context::GLOBAL
            ]
        );

        assert_eq!(stack.pop(Context::MODAL), Some(Context::MODAL));
        assert_eq!(
            stack.order(),
            [Context::DIALOG, Context::PROMPT, Context::GLOBAL]
        );
        assert_eq!(stack.pop(Context::DIALOG), Some(Context::DIALOG));
        assert_eq!(stack.pop(Context::DIALOG), None);
    }

    #[test]
    fn recent_context_wins_within_a_layer() {
        let mut stack = ContextStack::new();
        stack.push(Context::PROMPT);
        stack.push(Context::AUTOCOMPLETE);
        stack.push(Context::HISTORY_SEARCH);
        assert_eq!(
            stack.order(),
            [
                Context::HISTORY_SEARCH,
                Context::AUTOCOMPLETE,
                Context::PROMPT,
                Context::GLOBAL
            ]
        );

        // Pop removes the topmost matching instance.
        stack.push(Context::PROMPT);
        assert_eq!(stack.pop(Context::PROMPT), Some(Context::PROMPT));
        assert!(stack.contains(Context::PROMPT), "earlier instance remains");
    }

    #[test]
    fn custom_contexts_keep_their_layer() {
        let custom = Context::new("diff.preview", Layer::Dialog);
        assert_eq!(custom.name(), "diff.preview");
        assert_eq!(custom.layer(), Layer::Dialog);
        assert_eq!(custom.to_string(), "diff.preview");
    }
}
