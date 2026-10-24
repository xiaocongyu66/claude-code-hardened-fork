//! Component model, identity retention, and input routing.
//!
//! Deliberately free of any terminal dependency: the renderer crate consumes
//! the tree this module produces. Keep the public surface small — the goal is
//! to be replaceable, not to be a framework.

use std::any::TypeId;
use std::collections::HashMap;

pub mod history;
pub mod text;
pub mod vim;

pub use history::{HistoryRow, HistoryScope, HistorySearch};
pub use text::{
    KillDirection, KillRing, PASTE_FOLD_MAX_LINE_BREAKS, PASTE_FOLD_THRESHOLD, PastedContent,
    TextBuffer, format_pasted_text_ref, should_fold_paste,
};
pub use vim::{VimMode, VimState};

/// Stable identity supplied by the caller (list key, message id, ...).
#[derive(Debug, Default, Clone, PartialEq, Eq, Hash)]
pub struct ElementKey(pub String);

impl From<&str> for ElementKey {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl From<String> for ElementKey {
    fn from(value: String) -> Self {
        Self(value)
    }
}

/// Identity of a component instance across frames: key + concrete type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ElementId<'a> {
    pub key: &'a ElementKey,
    pub type_id: TypeId,
}

/// One retained component instance.
#[derive(Debug, Default)]
pub struct Node {
    pub key: ElementKey,
    pub type_id: Option<TypeId>,
    pub children: Vec<Node>,
    /// Opaque hook slots; the component owns the interpretation.
    pub slots: HashMap<&'static str, HookSlot>,
}

impl Node {
    pub fn new(key: impl Into<ElementKey>) -> Self {
        Self {
            key: key.into(),
            ..Self::default()
        }
    }

    fn same_identity(&self, key: &ElementKey, type_id: Option<TypeId>) -> bool {
        &self.key == key && self.type_id == type_id
    }
}

/// A retained hook value. Components downcast to their own state type.
#[derive(Debug, Default)]
pub struct HookSlot {
    pub value: Option<Box<dyn std::any::Any>>,
}

impl HookSlot {
    pub fn get_or_insert_with<T: 'static>(&mut self, init: impl FnOnce() -> T) -> &mut T {
        self.value
            .get_or_insert_with(|| Box::new(init()))
            .downcast_mut::<T>()
            .expect("hook slot type mismatch")
    }
}

/// Keep the previous tree's nodes whose identity still matches, in order.
///
/// Children are matched positionally by `(key, type_id)`; a changed identity
/// discards that subtree's state. This mirrors React's reconciliation for the
/// cases we actually use (stable list keys, conditional subtrees at the tail).
pub fn retain_children(previous: &mut Node, next: &mut Node) {
    let mut old: Vec<Node> = std::mem::take(&mut previous.children);
    for child in &mut next.children {
        if let Some(index) = old
            .iter()
            .position(|candidate| candidate.same_identity(&child.key, child.type_id))
        {
            let mut reused = old.remove(index);
            retain_children(&mut reused, child);
            *child = reused;
        }
    }
    // Move (do not clone) the reconciled nodes: `Clone` cannot carry hook
    // slots, so cloning here would silently drop retained state.
    previous.children = std::mem::take(&mut next.children);
}

impl Clone for Node {
    fn clone(&self) -> Self {
        Self {
            key: self.key.clone(),
            type_id: self.type_id,
            children: self.children.clone(),
            // Hook state is not Clone; a clone is only used as a template.
            slots: HashMap::new(),
        }
    }
}

/// Input routing: the topmost layer that consumes an event wins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    Low,
    Normal,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventResult {
    Ignored,
    Consumed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layer {
    pub id: String,
    pub priority: Priority,
}

/// Stack of input layers (modal dialog on top, prompt input below, globals last).
#[derive(Debug, Default)]
pub struct EventRouter {
    layers: Vec<Layer>,
}

impl EventRouter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Push a layer; later pushes are considered first.
    pub fn push(&mut self, layer: Layer) {
        self.layers.push(layer);
    }

    pub fn pop(&mut self, id: &str) -> Option<Layer> {
        let index = self.layers.iter().position(|layer| layer.id == id)?;
        Some(self.layers.remove(index))
    }

    /// Order in which handlers should be offered an event: highest priority
    /// first, and among equal priorities the most recently pushed first.
    pub fn order(&self) -> Vec<&Layer> {
        let mut ordered: Vec<&Layer> = self.layers.iter().collect();
        ordered.sort_by_key(|layer| std::cmp::Reverse(layer.priority));
        ordered
    }

    /// Dispatch until a handler consumes the event.
    pub fn dispatch(&self, mut handle: impl FnMut(&Layer) -> EventResult) -> Option<&Layer> {
        self.order()
            .into_iter()
            .find(|layer| handle(layer) == EventResult::Consumed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_state_for_matching_identity() {
        let mut previous = Node::new("root");
        let mut child = Node::new("msg-1");
        child.slots.insert(
            "count",
            HookSlot {
                value: Some(Box::new(7usize)),
            },
        );
        previous.children.push(child);

        let mut next = Node::new("root");
        next.children.push(Node::new("msg-1"));
        retain_children(&mut previous, &mut next);

        let retained = &mut previous.children[0];
        let count = retained
            .slots
            .get_mut("count")
            .expect("slot preserved")
            .get_or_insert_with(|| 0usize);
        assert_eq!(*count, 7);
    }

    #[test]
    fn drops_state_when_key_changes() {
        let mut previous = Node::new("root");
        previous.children.push(Node::new("msg-1"));
        let mut next = Node::new("root");
        next.children.push(Node::new("msg-2"));
        retain_children(&mut previous, &mut next);
        assert_eq!(previous.children[0].key, ElementKey::from("msg-2"));
        assert!(previous.children[0].slots.is_empty());
    }

    #[test]
    fn routes_to_highest_priority_then_most_recent() {
        let mut router = EventRouter::new();
        router.push(Layer {
            id: "global".into(),
            priority: Priority::Low,
        });
        router.push(Layer {
            id: "prompt".into(),
            priority: Priority::Normal,
        });
        router.push(Layer {
            id: "modal".into(),
            priority: Priority::High,
        });

        let order: Vec<_> = router.order().iter().map(|l| l.id.as_str()).collect();
        assert_eq!(order, ["modal", "prompt", "global"]);
    }

    #[test]
    fn dispatch_stops_at_first_consumer() {
        let mut router = EventRouter::new();
        router.push(Layer {
            id: "prompt".into(),
            priority: Priority::Normal,
        });
        router.push(Layer {
            id: "modal".into(),
            priority: Priority::High,
        });

        let mut seen = Vec::new();
        let winner = router.dispatch(|layer| {
            seen.push(layer.id.clone());
            if layer.id == "modal" {
                EventResult::Consumed
            } else {
                EventResult::Ignored
            }
        });

        assert_eq!(winner.map(|l| l.id.as_str()), Some("modal"));
        assert_eq!(seen, ["modal"]);
    }

    #[test]
    fn pop_removes_layer() {
        let mut router = EventRouter::new();
        router.push(Layer {
            id: "modal".into(),
            priority: Priority::High,
        });
        assert!(router.pop("modal").is_some());
        assert!(router.pop("modal").is_none());
        assert!(router.order().is_empty());
    }
}
