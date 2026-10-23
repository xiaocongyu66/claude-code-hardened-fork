//! Headless entry points used by CI smoke tests and the interactive runner.

pub mod engine;

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Read};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::Duration;

use cch_tui_core::TextBuffer;
use cch_tui_keymap::{
    Action, Context, ContextStack, Key, KeyCode as KmKeyCode, Keymap, Modifiers as KmModifiers,
    Resolution, Resolver,
};
use cch_tui_proto::{ControlRequest, EngineEvent, parse_line};
use cch_tui_render::{DEFAULT_INLINE_HEIGHT, TerminalSession};
use cch_tui_ui::{ChatView, SessionView};
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
    let mut session = if fullscreen {
        TerminalSession::fullscreen()?
    } else {
        TerminalSession::inline(DEFAULT_INLINE_HEIGHT)?
    };
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
    let mut clock_ms = 0u64;

    let mut engine_closed = false;
    let mut pending_permission: Option<(String, String, serde_json::Value)> = None;
    loop {
        // Drain engine/replay frames.
        loop {
            match rx.try_recv() {
                Ok(EngineMessage::Event(event)) => {
                    match &event {
                        EngineEvent::ControlRequest {
                            request_id,
                            request: ControlRequest::CanUseTool(permission),
                        } => {
                            pending_permission = Some((
                                request_id.clone(),
                                permission.tool_name.clone(),
                                serde_json::Value::Object(permission.input.clone()),
                            ));
                        }
                        EngineEvent::ControlResponse { .. } => pending_permission = None,
                        _ => {}
                    }
                    let frozen = view.ingest(&event);
                    session.insert_rows(&frozen)?;
                }
                Ok(EngineMessage::Malformed(line)) => {
                    view.completed.push(cch_tui_ui::Row::new(
                        cch_tui_ui::RowStyle::Error,
                        format!("[protocol] {line}"),
                    ));
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
        view.input = buffer.text().to_string();

        session.draw(&view)?;

        if !event::poll(Duration::from_millis(33))? {
            continue;
        }
        let Event::Key(key) = event::read()? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        // Permission prompt: y allows, n (or Esc) denies. Takes precedence over
        // text input while a request is pending.
        if let Some((request_id, tool_name, input)) = pending_permission.clone() {
            let decision = match key.code {
                KeyCode::Char('y') | KeyCode::Char('Y') => Some(true),
                KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => Some(false),
                _ => None,
            };
            if let Some(allow) = decision {
                if let Some(process) = engine.as_mut() {
                    let response = if allow {
                        serde_json::json!({ "behavior": "allow", "updatedInput": input })
                    } else {
                        serde_json::json!({ "behavior": "deny", "message": "Denied by user" })
                    };
                    process.send_control_response(&request_id, response)?;
                }
                view.status = Some(format!(
                    "{} {}",
                    if allow { "allowed" } else { "denied" },
                    tool_name
                ));
                pending_permission = None;
                continue;
            }
        }

        // Once the engine is gone, Esc quits instead of clearing the prompt.
        if engine_closed && buffer.is_empty() && key.code == KeyCode::Esc {
            break;
        }

        clock_ms = clock_ms.saturating_add(33);
        let resolution = resolver.resolve(to_key(&key), clock_ms);
        match resolution {
            Resolution::Pending => {}
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
                    submit(&mut view, &mut buffer, &mut session, engine.as_mut())?;
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
                    buffer.move_up();
                } else if action == Action::HISTORY_NEXT {
                    buffer.move_down();
                } else if action == Action::HISTORY_SEARCH {
                    view.status = Some("history search: not wired yet".into());
                }
            }
            Resolution::Ignored => {
                // Unbound printable keys type into the prompt.
                if let KeyCode::Char(ch) = key.code
                    && !key.modifiers.contains(KeyModifiers::CONTROL)
                    && !key.modifiers.contains(KeyModifiers::ALT)
                {
                    buffer.insert_char(ch);
                }
            }
        }
    }

    Ok(())
}

/// Freeze the current buffer as a user row and forward it to the engine.
fn submit(
    view: &mut ChatView,
    buffer: &mut TextBuffer,
    session: &mut TerminalSession,
    engine: Option<&mut EngineProcess>,
) -> io::Result<()> {
    view.input = buffer.text().to_string();
    if let Some(row) = view.submit_input() {
        session.insert_rows(std::slice::from_ref(&row))?;
        if let Some(process) = engine {
            process.send_prompt(row.text.trim_start_matches("> "))?;
            view.status = Some("sent".into());
        }
    }
    buffer.set_text("");
    Ok(())
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
