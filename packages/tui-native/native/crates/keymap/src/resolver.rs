//! Stack-aware chord resolver.
//!
//! The resolver is pure logic: the caller supplies a monotonic timestamp in
//! milliseconds so prefix timeouts are deterministic in tests. A two-key
//! binding such as `ctrl+x enter` first returns [`Resolution::Pending`], then
//! [`Resolution::Action`] when the second key arrives in time.
//!
//! Fallback rules:
//! - a key that continues no chord cancels the pending prefix and is
//!   re-processed as a fresh key;
//! - an expired prefix is discarded, so the next key resolves fresh;
//! - `Esc` while pending always cancels the chord and is consumed, matching
//!   the Ink implementation.

use crate::{Action, Binding, ContextStack, Key, KeyCode};

/// Result of offering one key to the resolver.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    /// A binding fired.
    Action(Action),
    /// The key is a prefix of a longer chord; wait for the next key.
    Pending,
    /// No binding in any active context.
    Ignored,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lookup {
    Exact(Action),
    Longer,
    None,
}

/// Stateful resolver over a binding table and a [`ContextStack`].
#[derive(Debug)]
pub struct Resolver<'a> {
    bindings: &'a [Binding],
    stack: &'a ContextStack,
    timeout_ms: u64,
    pending: Vec<Key>,
    pending_since: u64,
}

impl<'a> Resolver<'a> {
    pub fn new(bindings: &'a [Binding], stack: &'a ContextStack, timeout_ms: u64) -> Self {
        Self {
            bindings,
            stack,
            timeout_ms,
            pending: Vec::new(),
            pending_since: 0,
        }
    }

    /// Keys collected while waiting for the rest of a chord.
    pub fn pending(&self) -> &[Key] {
        &self.pending
    }

    pub fn is_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    pub fn timeout_ms(&self) -> u64 {
        self.timeout_ms
    }

    /// Drop any pending prefix.
    pub fn reset(&mut self) {
        self.pending.clear();
    }

    /// Offer one key at logical time `now_ms`.
    pub fn resolve(&mut self, key: Key, now_ms: u64) -> Resolution {
        if self.expired(now_ms) {
            self.pending.clear();
        }

        if !self.pending.is_empty() {
            if key.code == KeyCode::Esc {
                // An escape always aborts a chord and is not re-dispatched.
                self.pending.clear();
                return Resolution::Ignored;
            }

            let mut candidate = self.pending.clone();
            candidate.push(key);
            match self.lookup(&candidate) {
                Lookup::Longer => {
                    self.pending = candidate;
                    return Resolution::Pending;
                }
                Lookup::Exact(action) => {
                    self.pending.clear();
                    return Resolution::Action(action);
                }
                Lookup::None => {
                    // Unknown continuation: unwind the prefix and let this
                    // key stand on its own.
                    self.pending.clear();
                }
            }
        }

        match self.lookup(std::slice::from_ref(&key)) {
            Lookup::Exact(action) => Resolution::Action(action),
            Lookup::Longer => {
                self.pending.push(key);
                self.pending_since = now_ms;
                Resolution::Pending
            }
            Lookup::None => Resolution::Ignored,
        }
    }

    /// Check whether a pending prefix has timed out.
    ///
    /// Call this from the event loop's idle tick. While the prefix is still
    /// alive this returns [`Resolution::Pending`]. On expiry it returns the
    /// prefix's own exact binding if one exists, otherwise
    /// [`Resolution::Ignored`].
    pub fn poll(&mut self, now_ms: u64) -> Resolution {
        if self.pending.is_empty() {
            return Resolution::Ignored;
        }
        if !self.expired(now_ms) {
            return Resolution::Pending;
        }
        let prefix = std::mem::take(&mut self.pending);
        match self.lookup_exact(&prefix) {
            Some(action) => Resolution::Action(action),
            None => Resolution::Ignored,
        }
    }

    fn expired(&self, now_ms: u64) -> bool {
        now_ms.saturating_sub(self.pending_since) >= self.timeout_ms
    }

    fn lookup(&self, keys: &[Key]) -> Lookup {
        for context in self.stack.order() {
            let mut longer = false;
            let mut exact = None;
            for binding in self.bindings {
                if binding.context != context {
                    continue;
                }
                let chord = binding.chord.keys();
                if chord.len() > keys.len() && chord.starts_with(keys) {
                    longer = true;
                } else if chord == keys {
                    // Later rows override earlier rows within a context.
                    exact = Some(binding.action);
                }
            }
            // Like the Ink resolver, a longer chord wins over an exact match
            // in the same context.
            if longer {
                return Lookup::Longer;
            }
            if let Some(action) = exact {
                return Lookup::Exact(action);
            }
        }
        Lookup::None
    }

    /// Exact-only lookup used for timeout fallback; ignores longer chords.
    fn lookup_exact(&self, keys: &[Key]) -> Option<Action> {
        for context in self.stack.order() {
            let mut exact = None;
            for binding in self.bindings {
                if binding.context == context && binding.chord.keys() == keys {
                    exact = Some(binding.action);
                }
            }
            if exact.is_some() {
                return exact;
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Binding, Chord, Context, Key};

    const TIMEOUT: u64 = 500;

    fn binding(context: Context, keys: impl Into<Chord>, action: Action) -> Binding {
        Binding::new(context, keys, action)
    }

    fn chord_enter() -> Binding {
        binding(
            Context::PROMPT,
            [Key::ctrl_char('x'), Key::enter()],
            Action::PROMPT_SUBMIT,
        )
    }

    fn prompt_stack() -> ContextStack {
        let mut stack = ContextStack::new();
        stack.push(Context::PROMPT);
        stack
    }

    #[test]
    fn two_stage_chord_waits_for_the_second_key() {
        let bindings = [chord_enter()];
        let stack = prompt_stack();
        let mut resolver = Resolver::new(&bindings, &stack, TIMEOUT);

        assert_eq!(
            resolver.resolve(Key::ctrl_char('x'), 0),
            Resolution::Pending
        );
        assert_eq!(resolver.pending(), [Key::ctrl_char('x')]);
        assert_eq!(
            resolver.resolve(Key::enter(), 100),
            Resolution::Action(Action::PROMPT_SUBMIT)
        );
        assert!(!resolver.is_pending());
    }

    #[test]
    fn prefix_wins_over_an_exact_binding_for_the_same_key() {
        let bindings = [
            binding(
                Context::PROMPT,
                [Key::ctrl_char('x')],
                Action::new("prefix.alone"),
            ),
            chord_enter(),
        ];
        let stack = prompt_stack();
        let mut resolver = Resolver::new(&bindings, &stack, TIMEOUT);

        assert_eq!(
            resolver.resolve(Key::ctrl_char('x'), 0),
            Resolution::Pending
        );
    }

    #[test]
    fn expired_prefix_resolves_the_next_key_fresh() {
        let bindings = [
            binding(
                Context::PROMPT,
                [Key::ctrl_char('x'), Key::enter()],
                Action::new("chord.submit"),
            ),
            binding(Context::PROMPT, [Key::enter()], Action::PROMPT_SUBMIT),
        ];
        let stack = prompt_stack();
        let mut resolver = Resolver::new(&bindings, &stack, TIMEOUT);

        assert_eq!(
            resolver.resolve(Key::ctrl_char('x'), 0),
            Resolution::Pending
        );
        // The prefix timed out, so Enter is handled as a standalone submit
        // rather than completing the chord.
        assert_eq!(
            resolver.resolve(Key::enter(), TIMEOUT),
            Resolution::Action(Action::PROMPT_SUBMIT)
        );
    }

    #[test]
    fn poll_reports_timeout_and_emits_the_prefix_binding() {
        let bindings = [
            binding(
                Context::PROMPT,
                [Key::ctrl_char('x')],
                Action::new("prefix.alone"),
            ),
            chord_enter(),
        ];
        let stack = prompt_stack();
        let mut resolver = Resolver::new(&bindings, &stack, TIMEOUT);

        assert_eq!(
            resolver.resolve(Key::ctrl_char('x'), 0),
            Resolution::Pending
        );
        assert_eq!(resolver.poll(TIMEOUT - 1), Resolution::Pending);
        assert_eq!(
            resolver.poll(TIMEOUT),
            Resolution::Action(Action::new("prefix.alone"))
        );
        assert!(!resolver.is_pending());
    }

    #[test]
    fn poll_without_a_direct_prefix_binding_is_ignored() {
        let bindings = [chord_enter()];
        let stack = prompt_stack();
        let mut resolver = Resolver::new(&bindings, &stack, TIMEOUT);

        resolver.resolve(Key::ctrl_char('x'), 0);
        assert_eq!(resolver.poll(TIMEOUT), Resolution::Ignored);
    }

    #[test]
    fn unknown_continuation_cancels_and_reprocesses_the_key() {
        let bindings = [
            chord_enter(),
            binding(Context::PROMPT, [Key::char('a')], Action::new("text.a")),
        ];
        let stack = prompt_stack();
        let mut resolver = Resolver::new(&bindings, &stack, TIMEOUT);

        assert_eq!(
            resolver.resolve(Key::ctrl_char('x'), 0),
            Resolution::Pending
        );
        assert_eq!(
            resolver.resolve(Key::char('a'), 10),
            Resolution::Action(Action::new("text.a"))
        );
        assert!(!resolver.is_pending());
    }

    #[test]
    fn escape_cancels_a_pending_chord_without_dispatching() {
        let bindings = [chord_enter()];
        let stack = prompt_stack();
        let mut resolver = Resolver::new(&bindings, &stack, TIMEOUT);

        assert_eq!(
            resolver.resolve(Key::ctrl_char('x'), 0),
            Resolution::Pending
        );
        assert_eq!(resolver.resolve(Key::esc(), 10), Resolution::Ignored);
        assert!(!resolver.is_pending());
    }

    #[test]
    fn context_stack_priority_decides_between_contexts() {
        let bindings = [
            binding(Context::PROMPT, [Key::char('k')], Action::new("prompt.k")),
            binding(Context::DIALOG, [Key::char('k')], Action::new("dialog.k")),
        ];
        let mut stack = ContextStack::new();
        stack.push(Context::PROMPT);
        let mut resolver = Resolver::new(&bindings, &stack, TIMEOUT);
        assert_eq!(
            resolver.resolve(Key::char('k'), 0),
            Resolution::Action(Action::new("prompt.k"))
        );

        stack.push(Context::DIALOG);
        let mut resolver = Resolver::new(&bindings, &stack, TIMEOUT);
        assert_eq!(
            resolver.resolve(Key::char('k'), 0),
            Resolution::Action(Action::new("dialog.k"))
        );

        stack.pop(Context::DIALOG);
        let mut resolver = Resolver::new(&bindings, &stack, TIMEOUT);
        assert_eq!(
            resolver.resolve(Key::char('k'), 0),
            Resolution::Action(Action::new("prompt.k"))
        );
    }

    #[test]
    fn lookup_falls_through_to_lower_contexts() {
        let bindings = [binding(
            Context::GLOBAL,
            [Key::ctrl_char('c')],
            Action::APP_INTERRUPT,
        )];
        let mut stack = ContextStack::new();
        stack.push(Context::PROMPT);
        stack.push(Context::MODAL);
        let mut resolver = Resolver::new(&bindings, &stack, TIMEOUT);
        assert_eq!(
            resolver.resolve(Key::ctrl_char('c'), 0),
            Resolution::Action(Action::APP_INTERRUPT)
        );
    }

    #[test]
    fn later_bindings_override_earlier_ones_in_the_same_context() {
        let bindings = [
            binding(Context::PROMPT, [Key::enter()], Action::new("first")),
            binding(Context::PROMPT, [Key::enter()], Action::new("second")),
        ];
        let stack = prompt_stack();
        let mut resolver = Resolver::new(&bindings, &stack, TIMEOUT);
        assert_eq!(
            resolver.resolve(Key::enter(), 0),
            Resolution::Action(Action::new("second"))
        );
    }
}
