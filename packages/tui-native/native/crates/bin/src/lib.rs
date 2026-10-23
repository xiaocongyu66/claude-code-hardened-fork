//! Headless entry points used by CI smoke tests and the interactive runner.

pub mod engine;

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Read};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::{Duration, Instant};

use cch_tui_core::{HistoryScope, HistorySearch, TextBuffer};
use cch_tui_dialog::PermissionDialog;
use cch_tui_fullscreen::TranscriptModel;
use cch_tui_keymap::{
    Action, Context, ContextStack, Key, KeyCode as KmKeyCode, Keymap, Modifiers as KmModifiers,
    Resolution, Resolver,
};
use cch_tui_panel::TaskPanel;
use cch_tui_proto::{ControlRequest, EngineEvent, parse_line};
use cch_tui_render::{DEFAULT_INLINE_HEIGHT, TerminalSession};
use cch_tui_ui::{ChatView, Row, RowStyle, SessionView};
use engine::{EngineMessage, EngineProcess};
use ratatui::crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};

#[derive(Debug, Default, PartialEq, Eq)]
pub struct CheckReport {
    pub frames: usize,
    pub errors: usize,
    pub by_kind: BTreeMap<&'static str, usize>,
    pub view: SessionView,
}

impl CheckReport {
    pub fn summary(&self) -> String {
        let kinds = self
            .by_kind
            .iter()
            .map(|(kind, count)| format!("{kind}={count}"))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "frames={} errors={} kinds=[{}] session={} model={} user={} assistant={} deltas={} pending_permissions={}",
            self.frames,
            self.errors,
            kinds,
            self.view.session_id.as_deref().unwrap_or("-"),
            self.view.model.as_deref().unwrap_or("-"),
            self.view.user_messages,
            self.view.assistant_messages,
            self.view.stream_deltas,
            self.view.pending_permissions,
        )
    }
}

/// Parse every line from `reader`, folding valid frames into a session view.
/// Blank lines are ignored; a malformed line counts as an error but does not
/// abort, mirroring the interactive TUI's forward-compatible parsing.
pub fn check_stream(reader: impl Read) -> CheckReport {
    let mut report = CheckReport::default();
    for line in BufReader::new(reader).lines() {
        let Ok(line) = line else {
            report.errors += 1;
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        match parse_line(&line) {
            Ok(event) => {
                report.frames += 1;
                if event == EngineEvent::Unknown {
                    report.errors += 1;
                }
                *report.by_kind.entry(event.kind()).or_default() += 1;
                report.view.apply(&event);
            }
            Err(_) => report.errors += 1,
        }
    }
    report
}

/// Where the interactive runner gets events from.
pub enum Source {
    /// Replay an NDJSON fixture with the given pacing.
    Replay {
        path: PathBuf,
        frame_delay: Duration,
    },
    /// Spawn a real engine process.
    Engine { program: String, args: Vec<String> },
}

/// Run the interactive TUI until the user quits.
pub fn run(source: Source, fullscreen: bool) -> io::Result<()> {
    run_with_deadline(source, fullscreen, None)
}

/// Run the interactive TUI with an optional wall-clock budget.
///
/// `exit_after` is a test-only escape hatch (`--exit-after-ms`): once the
/// duration has elapsed the loop breaks and the terminal session is dropped,
/// which runs the normal restore path. `None` keeps the interactive behaviour.
pub fn run_with_deadline(
    source: Source,
    fullscreen: bool,
    exit_after: Option<Duration>,
) -> io::Result<()> {
    let started = Instant::now();
    let mut session = if fullscreen {
        TerminalSession::fullscreen()?
    } else {
        TerminalSession::inline(DEFAULT_INLINE_HEIGHT)?
    };
    if let Ok(name) = std::env::var("CCH_TUI_THEME") {
        session.set_theme_name(&name);
    }
    let mut view = ChatView::new();
    let mut engine: Option<EngineProcess> = None;

    let rx: Receiver<EngineMessage> = match source {
        Source::Replay { path, frame_delay } => engine::replay(path, frame_delay)?,
        Source::Engine { program, args } => {
            let (process, rx) = EngineProcess::spawn(&program, &args)?;
            engine = Some(process);
            rx
        }
    };

    let keymap = Keymap::default();
    let mut contexts = ContextStack::new();
    contexts.push(Context::GLOBAL);
    contexts.push(Context::PROMPT);
    let mut resolver = Resolver::new(keymap.bindings(), &contexts, 800);
    let mut buffer = TextBuffer::new();
    let mut history = PromptHistory::default();
    let mut transcript = TranscriptModel::new();
    let mut dialog: Option<PermissionDialog> = None;
    let mut search: Option<HistorySearch> = None;
    let mut panel = TaskPanel::new();
    let mut clock_ms = 0u64;
    let mut engine_closed = false;
    let mut next_context_poll = Instant::now() + Duration::from_secs(2);
    let mut pending_context_request: Option<String> = None;
    let mut request_seq = 0u64;

    loop {
        // Test-only deterministic exit: checked before any blocking work so the
        // process always leaves through the same drop path as a user quit.
        if exit_after.is_some_and(|limit| started.elapsed() >= limit) {
            break;
        }

        // Drain engine/replay frames.
        loop {
            match rx.try_recv() {
                Ok(EngineMessage::Event(event)) => {
                    match &event {
                        EngineEvent::ControlRequest {
                            request_id,
                            request: ControlRequest::CanUseTool(permission),
                        } => {
                            dialog = Some(PermissionDialog::from_can_use_tool(
                                request_id.clone(),
                                permission,
                            ));
                        }
                        EngineEvent::ControlResponse { response } => {
                            if let cch_tui_proto::ControlResponse::Success {
                                request_id,
                                response: Some(payload),
                            } = response
                                && pending_context_request.as_deref() == Some(request_id.as_str())
                            {
                                if let Some(percent) =
                                    payload.get("percent").and_then(serde_json::Value::as_f64)
                                {
                                    view.context_percent = Some(percent);
                                }
                                pending_context_request = None;
                            }
                            dialog = None;
                        }
                        EngineEvent::ControlCancelRequest { .. } => {
                            if let Some(open) = dialog.as_mut() {
                                open.cancel_from_engine();
                            }
                            dialog = None;
                        }
                        _ => {}
                    }
                    panel.apply_engine_event(&event);
                    let frozen = view.ingest(&event);
                    freeze(&mut session, &mut transcript, fullscreen, &frozen)?;
                }
                Ok(EngineMessage::Malformed(line)) => {
                    view.completed
                        .push(Row::new(RowStyle::Error, format!("[protocol] {line}")));
                }
                Ok(EngineMessage::Closed) => {
                    engine_closed = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    engine_closed = true;
                    break;
                }
            }
        }
        if engine_closed {
            view.status = Some("engine exited — press q".into());
        }
        view.panel_summary = Some(panel.summary_line()).filter(|line| !line.is_empty());
        if let Some(process) = engine.as_mut()
            && pending_context_request.is_none()
            && Instant::now() >= next_context_poll
        {
            request_seq = request_seq.wrapping_add(1);
            let request_id = format!("ctx-{request_seq}");
            if process
                .send_control_request(&request_id, "get_context_usage")
                .is_ok()
            {
                pending_context_request = Some(request_id);
            }
            next_context_poll = Instant::now() + Duration::from_secs(5);
        }
        view.input = buffer.text().to_string();

        match (dialog.as_ref(), fullscreen) {
            (Some(open), true) => {
                session.draw_transcript_with_permission(&view, &mut transcript, open)?
            }
            (Some(open), false) => session.draw_with_permission(&view, open)?,
            (None, true) => {
                if panel.is_empty() {
                    session.draw_transcript(&view, &mut transcript)?
                } else {
                    session.draw_transcript_with_panel(&view, &mut transcript, &panel)?
                }
            }
            (None, false) => session.draw(&view)?,
        }

        if !event::poll(Duration::from_millis(33))? {
            continue;
        }
        match event::read()? {
            Event::Paste(text) => {
                buffer.insert_paste(&text);
            }
            Event::Key(key) => {
                if key.kind != KeyEventKind::Press {
                    continue;
                }

                // History search owns the keyboard while it is open.
                if search.is_some() {
                    let mut close = false;
                    if let Some(active) = search.as_mut() {
                        match key.code {
                            KeyCode::Esc => {
                                active.cancel();
                                close = true;
                            }
                            KeyCode::Enter => {
                                if let Some(entry) = active.accept() {
                                    buffer.set_text(entry);
                                }
                                close = true;
                            }
                            KeyCode::Up => {
                                active.prev();
                            }
                            KeyCode::Down => {
                                active.next();
                            }
                            KeyCode::Backspace => {
                                let mut query = active.query.clone();
                                query.pop();
                                active.set_query(query, &history.entries);
                            }
                            KeyCode::Char(ch)
                                if !key.modifiers.contains(KeyModifiers::CONTROL)
                                    && !key.modifiers.contains(KeyModifiers::ALT) =>
                            {
                                let mut query = active.query.clone();
                                query.push(ch);
                                active.set_query(query, &history.entries);
                            }
                            _ => {}
                        }
                        if !close {
                            let total = active.matches.len();
                            let position = if total == 0 { 0 } else { active.index + 1 };
                            view.status =
                                Some(format!("search: {} ({position}/{total})", active.query));
                        }
                    }
                    if close {
                        search = None;
                        view.status = None;
                    }
                    continue;
                }

                // A permission dialog owns the keyboard while it is open.
                if dialog.is_some() {
                    let mut answer: Option<(String, String, serde_json::Value)> = None;
                    if let Some(open) = dialog.as_mut() {
                        let decision = match key.code {
                            KeyCode::Up => {
                                open.select_previous();
                                None
                            }
                            KeyCode::Down => {
                                open.select_next();
                                None
                            }
                            KeyCode::Enter => open.resolve(),
                            KeyCode::Esc => open.cancel(),
                            _ => None,
                        };
                        if let Some(decision) = decision {
                            answer = Some((
                                open.request_id().to_owned(),
                                open.tool_name().to_owned(),
                                decision.to_response(),
                            ));
                        }
                    }
                    if let Some((request_id, tool_name, response)) = answer {
                        answer_permission(
                            &mut view,
                            &mut dialog,
                            engine.as_mut(),
                            &request_id,
                            &tool_name,
                            response,
                        )?;
                    }
                    continue;
                }

                if engine_closed && buffer.is_empty() && key.code == KeyCode::Esc {
                    break;
                }

                // Fullscreen scrolling owns the page keys.
                if fullscreen {
                    match key.code {
                        KeyCode::PageUp => {
                            transcript.page_up();
                            continue;
                        }
                        KeyCode::PageDown => {
                            transcript.page_down();
                            continue;
                        }
                        KeyCode::End => {
                            transcript.scroll_to_bottom();
                            continue;
                        }
                        KeyCode::Home => {
                            transcript.scroll_to_top();
                            continue;
                        }
                        _ => {}
                    }
                }

                clock_ms = clock_ms.saturating_add(33);
                match resolver.resolve(to_key(&key), clock_ms) {
                    Resolution::Pending => {}
                    Resolution::Ignored => {
                        if let KeyCode::Char(ch) = key.code
                            && !key.modifiers.contains(KeyModifiers::CONTROL)
                            && !key.modifiers.contains(KeyModifiers::ALT)
                        {
                            buffer.insert_char(ch);
                            history.reset();
                        }
                    }
                    Resolution::Action(action) => {
                        if action == Action::APP_INTERRUPT {
                            break;
                        } else if action == Action::APP_EXIT {
                            if buffer.is_empty() {
                                break;
                            }
                        } else if action == Action::PROMPT_ESCAPE || action == Action::APP_ESCAPE {
                            buffer.set_text("");
                        } else if action == Action::PROMPT_SUBMIT {
                            submit(
                                &mut view,
                                &mut buffer,
                                &mut session,
                                &mut transcript,
                                fullscreen,
                                engine.as_mut(),
                                &mut history,
                            )?;
                        } else if action == Action::PROMPT_NEWLINE {
                            buffer.insert_str("\n");
                        } else if action == Action::EDIT_BACKSPACE {
                            buffer.backspace();
                        } else if action == Action::EDIT_DELETE {
                            buffer.delete_forward();
                        } else if action == Action::EDIT_LEFT {
                            buffer.move_left();
                        } else if action == Action::EDIT_RIGHT {
                            buffer.move_right();
                        } else if action == Action::EDIT_LINE_START {
                            buffer.move_home();
                        } else if action == Action::EDIT_LINE_END {
                            buffer.move_end();
                        } else if action == Action::EDIT_KILL_TO_END {
                            buffer.kill_to_line_end();
                        } else if action == Action::EDIT_KILL_TO_START {
                            buffer.kill_to_line_start();
                        } else if action == Action::EDIT_KILL_WORD_BEFORE {
                            buffer.kill_word_before();
                        } else if action == Action::EDIT_YANK {
                            buffer.yank();
                        } else if action == Action::PROMPT_UNDO {
                            buffer.undo();
                        } else if action == Action::HISTORY_PREVIOUS {
                            if buffer.cursor_position().0 > 0 {
                                buffer.move_up();
                            } else if let Some(entry) = history.previous().map(ToOwned::to_owned) {
                                buffer.set_text(entry);
                            }
                        } else if action == Action::HISTORY_NEXT {
                            if buffer.cursor_position().0 + 1 < buffer.line_count() {
                                buffer.move_down();
                            } else {
                                match history.next().map(ToOwned::to_owned) {
                                    Some(entry) => buffer.set_text(entry),
                                    None => buffer.set_text(""),
                                }
                            }
                        } else if action == Action::HISTORY_SEARCH {
                            let candidates: Vec<String> =
                                history.entries().iter().rev().cloned().collect();
                            search = Some(HistorySearch::with_matches(
                                HistoryScope::Global,
                                candidates,
                            ));
                            view.status = Some("search: (0/0)".into());
                        }
                    }
                }
            }
            _ => {}
        }
    }

    Ok(())
}

fn answer_permission(
    view: &mut ChatView,
    dialog: &mut Option<PermissionDialog>,
    engine: Option<&mut EngineProcess>,
    request_id: &str,
    tool_name: &str,
    response: serde_json::Value,
) -> io::Result<()> {
    if let Some(process) = engine {
        process.send_control_response(request_id, response)?;
    }
    view.status = Some(format!("permission answered: {tool_name}"));
    *dialog = None;
    Ok(())
}

fn freeze(
    session: &mut TerminalSession,
    transcript: &mut TranscriptModel,
    fullscreen: bool,
    rows: &[Row],
) -> io::Result<()> {
    if fullscreen {
        transcript.append(rows.iter().cloned());
        Ok(())
    } else {
        session.insert_rows(rows)
    }
}

/// Freeze the current buffer as a user row and forward it to the engine.
///
/// Folded pastes are expanded before sending: the transcript and the engine
/// see the original text, while the input line only ever showed placeholders.
fn submit(
    view: &mut ChatView,
    buffer: &mut TextBuffer,
    session: &mut TerminalSession,
    transcript: &mut TranscriptModel,
    fullscreen: bool,
    engine: Option<&mut EngineProcess>,
    history: &mut PromptHistory,
) -> io::Result<()> {
    let draft = buffer.expand_pastes();
    if !draft.trim().is_empty() {
        let row = Row::new(RowStyle::User, format!("> {draft}"));
        freeze(session, transcript, fullscreen, std::slice::from_ref(&row))?;
        view.completed.push(row);
        history.push(draft.clone());
        if let Some(process) = engine {
            process.send_prompt(draft.trim())?;
            view.status = Some("sent".into());
        }
    }
    buffer.set_text("");
    Ok(())
}

/// Prompt history with a cursor that survives repeated Up/Down presses.
#[derive(Debug, Default)]
struct PromptHistory {
    entries: Vec<String>,
    index: Option<usize>,
}

impl PromptHistory {
    fn push(&mut self, entry: String) {
        if !entry.trim().is_empty() {
            self.entries.push(entry);
        }
        self.index = None;
    }

    /// Previous entry (older), clamped at the oldest.
    fn previous(&mut self) -> Option<&str> {
        if self.entries.is_empty() {
            return None;
        }
        let index = match self.index {
            None => self.entries.len() - 1,
            Some(0) => 0,
            Some(index) => index - 1,
        };
        self.index = Some(index);
        self.entries.get(index).map(String::as_str)
    }

    /// Next entry (newer); past the newest returns `None` (empty prompt).
    fn next(&mut self) -> Option<&str> {
        match self.index {
            Some(index) if index + 1 < self.entries.len() => {
                self.index = Some(index + 1);
                self.entries.get(index + 1).map(String::as_str)
            }
            Some(_) => {
                self.index = None;
                None
            }
            None => None,
        }
    }

    fn reset(&mut self) {
        self.index = None;
    }

    fn entries(&self) -> &[String] {
        &self.entries
    }
}

/// Translate a crossterm key event into the terminal-independent key model.
fn to_key(key: &ratatui::crossterm::event::KeyEvent) -> Key {
    use ratatui::crossterm::event::KeyCode as CKey;
    let code = match key.code {
        CKey::Char(ch) => KmKeyCode::Char(ch),
        CKey::Enter => KmKeyCode::Enter,
        CKey::Tab => KmKeyCode::Tab,
        CKey::Esc => KmKeyCode::Esc,
        CKey::Backspace => KmKeyCode::Backspace,
        CKey::Delete => KmKeyCode::Delete,
        CKey::Left => KmKeyCode::Left,
        CKey::Right => KmKeyCode::Right,
        CKey::Up => KmKeyCode::Up,
        CKey::Down => KmKeyCode::Down,
        CKey::Home => KmKeyCode::Home,
        CKey::End => KmKeyCode::End,
        CKey::PageUp => KmKeyCode::PageUp,
        CKey::PageDown => KmKeyCode::PageDown,
        // Keys the model does not represent are inert (`\0` has no binding).
        _ => KmKeyCode::Char('\0'),
    };
    let mut modifiers = KmModifiers::NONE;
    modifiers.ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    modifiers.alt = key.modifiers.contains(KeyModifiers::ALT);
    modifiers.shift = key.modifiers.contains(KeyModifiers::SHIFT);
    Key::new(code, modifiers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_walks_older_then_newer_and_resets() {
        let mut history = PromptHistory::default();
        history.push("one".into());
        history.push("two".into());
        history.push("   ".into()); // blank drafts are not recorded

        assert_eq!(history.previous(), Some("two"));
        assert_eq!(history.previous(), Some("one"));
        assert_eq!(history.previous(), Some("one"));
        assert_eq!(history.next(), Some("two"));
        assert_eq!(history.next(), None);
        assert_eq!(history.next(), None);

        // Typing after a recall restarts the walk.
        let _ = history.previous();
        history.reset();
        assert_eq!(history.previous(), Some("two"));
    }

    #[test]
    fn maps_special_keys_and_modifiers() {
        use ratatui::crossterm::event::{KeyCode as CKey, KeyEvent, KeyEventKind, KeyEventState};

        let enter = KeyEvent::new(CKey::Enter, KeyModifiers::NONE);
        assert_eq!(to_key(&enter), Key::enter());

        let ctrl_c = KeyEvent::new(CKey::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(to_key(&ctrl_c), Key::ctrl_char('c'));

        let cjk = KeyEvent::new(CKey::Char('汉'), KeyModifiers::NONE);
        assert_eq!(to_key(&cjk), Key::char('汉'));

        // Unmodelled keys stay inert.
        let f1 = KeyEvent {
            code: CKey::F(1),
            modifiers: KeyModifiers::NONE,
            kind: KeyEventKind::Press,
            state: KeyEventState::NONE,
        };
        assert_eq!(to_key(&f1), Key::char('\0'));
    }

    #[test]
    fn counts_frames_and_tolerates_bad_lines() {
        let input = concat!(
            r#"{"type":"system","subtype":"init","session_id":"s1","model":"m"}"#,
            "\n",
            "\n",
            "not json\n",
            r#"{"type":"assistant","uuid":"a1"}"#,
            "\n",
            r#"{"type":"brand_new","x":1}"#,
            "\n",
        );
        let report = check_stream(input.as_bytes());

        assert_eq!(report.frames, 3);
        // One bad JSON line + one unknown frame type.
        assert_eq!(report.errors, 2);
        assert_eq!(report.by_kind.get("assistant"), Some(&1));
        assert_eq!(report.view.session_id.as_deref(), Some("s1"));
        assert_eq!(report.view.assistant_messages, 1);
    }
}
