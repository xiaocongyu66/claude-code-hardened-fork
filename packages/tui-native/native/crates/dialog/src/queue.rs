//! FIFO input queue with a send-now lane and head backfill.

use std::collections::VecDeque;

/// Where a queued input sits relative to the current turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum QueuePriority {
    /// Send as soon as the current turn ends, ahead of normal queued input.
    SendNow,
    /// Send in FIFO order after all send-now input.
    Normal,
}

/// One queued user input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedInput {
    pub text: String,
    pub priority: QueuePriority,
}

impl QueuedInput {
    pub fn new(text: impl Into<String>, priority: QueuePriority) -> Self {
        Self {
            text: text.into(),
            priority,
        }
    }

    pub fn normal(text: impl Into<String>) -> Self {
        Self::new(text, QueuePriority::Normal)
    }

    pub fn send_now(text: impl Into<String>) -> Self {
        Self::new(text, QueuePriority::SendNow)
    }
}

/// Two FIFO lanes: send-now input is drained before normal input.
///
/// Within a lane order is strict FIFO. [`Queue::backfill`] inserts at the
/// front of its lane, so an interrupted draft is the next normal input.
#[derive(Debug, Default, Clone)]
pub struct Queue {
    send_now: VecDeque<QueuedInput>,
    normal: VecDeque<QueuedInput>,
}

impl Queue {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append normal-priority input (FIFO).
    pub fn enqueue(&mut self, text: impl Into<String>) {
        self.normal.push_back(QueuedInput::normal(text));
    }

    /// Append send-now input. It jumps ahead of normal queued input but stays
    /// behind earlier send-now input (FIFO within the lane).
    pub fn send_now(&mut self, text: impl Into<String>) {
        self.send_now.push_back(QueuedInput::send_now(text));
    }

    /// Push an input back to the head of its lane, ahead of every other input
    /// at the same priority. Used when an interrupt returns the in-flight
    /// draft to the queue.
    pub fn backfill(&mut self, input: QueuedInput) {
        match input.priority {
            QueuePriority::SendNow => self.send_now.push_front(input),
            QueuePriority::Normal => self.normal.push_front(input),
        }
    }

    /// Convenience for backfilling a normal-priority draft.
    pub fn backfill_text(&mut self, text: impl Into<String>) {
        self.backfill(QueuedInput::normal(text));
    }

    /// Remove the next input: send-now lane first, then normal lane.
    pub fn take_next(&mut self) -> Option<QueuedInput> {
        self.send_now
            .pop_front()
            .or_else(|| self.normal.pop_front())
    }

    /// The input `take_next` would return, without removing it.
    pub fn peek(&self) -> Option<&QueuedInput> {
        self.send_now.front().or_else(|| self.normal.front())
    }

    /// Total number of queued inputs across both lanes.
    pub fn len(&self) -> usize {
        self.send_now.len() + self.normal.len()
    }

    pub fn is_empty(&self) -> bool {
        self.send_now.is_empty() && self.normal.is_empty()
    }

    /// Number of send-now inputs waiting.
    pub fn send_now_len(&self) -> usize {
        self.send_now.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(queue: &mut Queue) -> Vec<String> {
        std::iter::from_fn(|| queue.take_next())
            .map(|input| input.text)
            .collect()
    }

    #[test]
    fn normal_inputs_are_fifo() {
        let mut queue = Queue::new();
        assert!(queue.is_empty());
        queue.enqueue("one");
        queue.enqueue("two");
        queue.enqueue("three");
        assert_eq!(queue.len(), 3);
        assert_eq!(queue.peek().map(|input| input.text.as_str()), Some("one"));
        assert_eq!(texts(&mut queue), ["one", "two", "three"]);
        assert!(queue.is_empty());
        assert_eq!(queue.take_next(), None);
    }

    #[test]
    fn send_now_jumps_ahead_of_normal_input() {
        let mut queue = Queue::new();
        queue.enqueue("normal-1");
        queue.enqueue("normal-2");
        queue.send_now("now-1");
        queue.send_now("now-2");

        assert_eq!(queue.len(), 4);
        assert_eq!(queue.send_now_len(), 2);
        assert_eq!(
            queue
                .peek()
                .map(|input| (input.text.as_str(), input.priority)),
            Some(("now-1", QueuePriority::SendNow))
        );
        // Send-now inputs stay FIFO among themselves, then normal inputs run.
        assert_eq!(
            texts(&mut queue),
            ["now-1", "now-2", "normal-1", "normal-2"]
        );
    }

    #[test]
    fn backfill_returns_an_interrupted_draft_to_the_head() {
        let mut queue = Queue::new();
        queue.enqueue("first");
        queue.enqueue("second");
        queue.backfill_text("interrupted");

        assert_eq!(
            queue.peek().map(|input| input.text.as_str()),
            Some("interrupted")
        );
        assert_eq!(texts(&mut queue), ["interrupted", "first", "second"]);
    }

    #[test]
    fn backfill_of_send_now_keeps_that_lane_ahead() {
        let mut queue = Queue::new();
        queue.enqueue("normal");
        queue.backfill(QueuedInput::send_now("backfilled-now"));
        queue.send_now("queued-now");

        assert_eq!(
            texts(&mut queue),
            ["backfilled-now", "queued-now", "normal"]
        );
    }

    #[test]
    fn backfill_of_normal_stays_behind_send_now() {
        let mut queue = Queue::new();
        queue.send_now("now");
        queue.enqueue("normal");
        queue.backfill_text("draft");

        // Send-now is the "immediately after this turn" lane; a normal draft
        // is next within the normal lane.
        assert_eq!(texts(&mut queue), ["now", "draft", "normal"]);
    }
}
