//! Headless entry points used by CI smoke tests and the interactive runner.

pub mod bench;
pub mod engine;

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Read};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::{Duration, Instant};

use cch_tui_actions::{
    ExpandLimits, ExpandState, MessageActions, RowKey, copy_target, message_metas, project,
    project_keyed, toggle_focused,
};
use cch_tui_core::{HistoryScope, HistorySearch, TextBuffer, VimState};
use cch_tui_dialog::PermissionDialog;
use cch_tui_fullscreen::TranscriptModel;
use cch_tui_keymap::{
    Action, Context, ContextStack, Key, KeyCode as KmKeyCode, Keymap, Modifiers as KmModifiers,
    Resolution, Resolver, VimAction, keymap_with_vim, vim_context,
};
use cch_tui_palette::{CommandPalette, CommandSpec};
use cch_tui_panel::TaskPanel;
use cch_tui_proto::{ControlRequest, EngineEvent, parse_line};
use cch_tui_render::{DEFAULT_INLINE_HEIGHT, Overlay, TerminalSession};
use cch_tui_search::TranscriptSearch;
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

    // `CCH_TUI_VIM=1` opts into the vim prompt, matching Ink's insert-mode
    // start and Esc-driven normal mode.
    let mut vim = VimState::new(std::env::var("CCH_TUI_VIM").is_ok_and(|value| value == "1"));
    let keymap = if vim.is_enabled() {
        keymap_with_vim()
    } else {
        Keymap::default()
    };
    let mut contexts = ContextStack::new();
    contexts.push(Context::GLOBAL);
    contexts.push(Context::PROMPT);
    if vim.is_enabled() {
        contexts.push(vim_context(vim));
    }
    let mut resolver = Resolver::new(keymap.bindings(), &contexts, 800);
    let mut buffer = TextBuffer::new();
    let mut history = PromptHistory::default();
    let mut transcript = TranscriptModel::new();
    let mut dialog: Option<PermissionDialog> = None;
    let mut search: Option<HistorySearch> = None;
    // Slash palette and transcript search share the overlay slot; the palette
    // is driven by the input line, the transcript search owns a modal loop.
    let mut palette = CommandPalette::new(Vec::new());
    let mut palette_seen = String::new();
    let mut transcript_search: Option<TranscriptSearch> = None;
    let mut search_navigating = false;
    // After accepting a command, hide the palette while the input still starts
    // with the inserted text so arguments can be typed without a popup.
    let mut palette_accept_prefix: Option<String> = None;
    let mut panel = TaskPanel::new();
    let mut expand = ExpandState::default();
    let mut all_expanded = false;
    // Message focus derived from `view.completed`. The cursor is rebuilt when
    // rows are appended and the numeric focus is preserved across rebuilds.
    let mut actions = MessageActions::new(Vec::new());
    let mut actions_rows = 0usize;
    let mut queued_prompts: Vec<String> = Vec::new();
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
                    if matches!(event, EngineEvent::Result { .. }) {
                        view.busy = false;
                    }
                    match &event {
                        EngineEvent::System { subtype, extra } if subtype == "init" => {
                            palette = CommandPalette::new(command_specs_from_init(extra));
                            palette.set_query(buffer.text());
                            palette_seen.clear();
                            palette_seen.push_str(buffer.text());
                        }
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
                    // Expansion keys are global row indexes; take the base
                    // before ingesting so a later focus toggle addresses the
                    // same rows.
                    let base = view.completed.len();
                    let frozen = view.ingest(&event);
                    // Inline rows are frozen into scrollback and cannot be
                    // re-projected, so collapse only applies to fullscreen.
                    let projected = if fullscreen {
                        let keys: Vec<RowKey> =
                            (base..base + frozen.len()).map(RowKey::Index).collect();
                        project_keyed(&frozen, &keys, &expand, ExpandLimits::default())
                    } else {
                        frozen.clone()
                    };
                    freeze(&mut session, &mut transcript, fullscreen, &projected)?;
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
        // The turn ended: send the next queued prompt, if any.
        if !view.busy
            && let Some(process) = engine.as_mut()
            && let Some(next) = queued_prompts.first().cloned()
        {
            queued_prompts.remove(0);
            process.send_prompt(next.trim())?;
            view.busy = true;
        }
        view.queued = queued_prompts.len();
        if view.busy {
            view.spinner_frame = (started.elapsed().as_millis() / 120) as usize;
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
        sync_palette(&mut palette, buffer.text(), &mut palette_seen);
        if palette_accept_prefix
            .as_deref()
            .is_some_and(|prefix| !buffer.text().starts_with(prefix))
        {
            palette_accept_prefix = None;
        }
        // Rebuild the message cursor whenever rows were appended, keeping the
        // numeric focus so the selection stays on the same message.
        if view.completed.len() != actions_rows {
            let focus = actions.focus();
            actions = MessageActions::new(message_metas(&view.completed));
            match focus {
                Some(index) => actions.set_focus(Some(index)),
                None => actions.clear(),
            }
            actions_rows = view.completed.len();
        }
        view.focus = actions.focus().map(|index| (index + 1, actions.len()));
        view.input = buffer.text().to_string();
        view.vim_mode = vim.status_indicator().map(str::to_owned);

        // Search replaces the palette when both could be visible; the palette
        // stays open (possibly empty) for any `/`-prefixed input, except while
        // the user is editing the arguments of an accepted command.
        let palette_hidden = palette_accept_prefix.is_some();
        let overlay = transcript_search.as_ref().map(search_overlay).or_else(|| {
            (!palette_hidden)
                .then(|| palette_overlay(&palette))
                .flatten()
        });

        match (dialog.as_ref(), fullscreen) {
            (Some(open), true) => {
                session.draw_transcript_with_permission(&view, &mut transcript, open)?
            }
            (Some(open), false) => session.draw_with_permission(&view, open)?,
            (None, true) => match overlay.as_ref() {
                Some(overlay) => session.draw_transcript_with_overlay(
                    &view,
                    &mut transcript,
                    (!panel.is_empty()).then_some(&panel),
                    overlay,
                )?,
                None if panel.is_empty() => session.draw_transcript(&view, &mut transcript)?,
                None => session.draw_transcript_with_panel(&view, &mut transcript, &panel)?,
            },
            (None, false) => match overlay.as_ref() {
                Some(overlay) => session.draw_with_overlay(&view, overlay)?,
                None => session.draw(&view)?,
            },
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

                // Transcript search owns the keyboard while it is open.
                if transcript_search.is_some() {
                    let command = search_command(&key, search_navigating);
                    let mut close = false;
                    if let Some(active) = transcript_search.as_mut() {
                        match command {
                            SearchCommand::Close => close = true,
                            SearchCommand::Jump => {
                                search_navigating = true;
                                jump_to_match(&mut transcript, fullscreen, active);
                            }
                            SearchCommand::Next => {
                                search_navigating = true;
                                if active.next().is_some() {
                                    jump_to_match(&mut transcript, fullscreen, active);
                                }
                            }
                            SearchCommand::Prev => {
                                search_navigating = true;
                                if active.prev().is_some() {
                                    jump_to_match(&mut transcript, fullscreen, active);
                                }
                            }
                            SearchCommand::Backspace => {
                                let mut query = active.query().to_string();
                                query.pop();
                                active.set_query(query);
                                search_navigating = false;
                            }
                            SearchCommand::Insert(ch) => {
                                let mut query = active.query().to_string();
                                query.push(ch);
                                active.set_query(query);
                                search_navigating = false;
                            }
                            SearchCommand::Ignore => {}
                        }
                    }
                    if close {
                        transcript_search = None;
                        search_navigating = false;
                        view.status = None;
                    } else if !fullscreen && let Some(active) = transcript_search.as_ref() {
                        view.status = Some(search_status(active));
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

                // Ctrl+F opens transcript search. It overrides the prompt's
                // forward-char binding; Right still moves the cursor.
                if key.code == KeyCode::Char('f')
                    && key.modifiers.contains(KeyModifiers::CONTROL)
                    && !key.modifiers.contains(KeyModifiers::ALT)
                {
                    transcript_search =
                        Some(begin_transcript_search(&view, &transcript, fullscreen));
                    search_navigating = false;
                    view.status = (!fullscreen).then(|| "match 0/0".to_string());
                    continue;
                }

                // The slash palette intercepts navigation and acceptance
                // while it has a visible row; Esc closes it even when empty.
                let palette_open = !palette_hidden
                    && palette.is_active()
                    && (!palette.matching().is_empty() || key.code == KeyCode::Esc);
                if let Some(command) = palette_command(key.code, palette_open) {
                    match command {
                        PaletteCommand::Previous => palette.prev(),
                        PaletteCommand::Next => palette.next(),
                        PaletteCommand::Accept => {
                            palette_accept_prefix =
                                accept_palette(&mut palette, &mut buffer, &mut palette_seen);
                        }
                        PaletteCommand::Dismiss => {
                            palette.dismiss();
                            palette_accept_prefix = None;
                            palette_seen.clear();
                            palette_seen.push_str(buffer.text());
                        }
                    }
                    continue;
                }

                // Esc clears an active message focus. History search,
                // transcript search and the permission dialog returned above,
                // so they keep their own Esc handling.
                if key.code == KeyCode::Esc && actions.focus().is_some() {
                    actions.clear();
                    view.focus = None;
                    continue;
                }

                if engine_closed
                    && buffer.is_empty()
                    && key.code == KeyCode::Esc
                    && !vim.is_enabled()
                {
                    break;
                }

                // Ctrl+Y (Ink-style message action) and Alt+C copy the focused
                // message, falling back to the newest assistant message when
                // nothing is focused (OSC52).
                let copy_requested = (key.code == KeyCode::Char('y')
                    && key.modifiers.contains(KeyModifiers::CONTROL)
                    && !key.modifiers.contains(KeyModifiers::ALT))
                    || (key.code == KeyCode::Char('c')
                        && key.modifiers.contains(KeyModifiers::ALT));
                if copy_requested {
                    match copy_target(&actions, &view.completed) {
                        Some(text) => {
                            session.copy_to_clipboard(&text)?;
                            view.status = Some(match actions.focus() {
                                Some(index) => {
                                    format!("copied message {}/{}", index + 1, actions.len())
                                }
                                None => "copied last message".into(),
                            });
                        }
                        None => view.status = Some("nothing to copy".into()),
                    }
                    continue;
                }

                // Alt+Up/Down move the message focus. These chords are not in
                // the keymap, so the resolver would ignore them; claim them
                // here instead.
                if key.modifiers.contains(KeyModifiers::ALT)
                    && !key.modifiers.contains(KeyModifiers::CONTROL)
                {
                    match key.code {
                        KeyCode::Up => {
                            actions.previous_or_last();
                            continue;
                        }
                        KeyCode::Down => {
                            actions.next_or_last();
                            continue;
                        }
                        _ => {}
                    }
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
                let mut vim_mode_changed = false;
                match resolver.resolve(to_key(&key), clock_ms) {
                    Resolution::Pending => {}
                    Resolution::Ignored => {
                        // In vim normal mode an unbound printable key is a
                        // no-op, not text to insert.
                        if !vim.is_normal()
                            && let KeyCode::Char(ch) = key.code
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
                            if vim.is_normal() {
                                // Esc in normal mode only cancels pending
                                // state; it never clears the prompt.
                                resolver.reset();
                            } else {
                                buffer.set_text("");
                            }
                        } else if action == Action::PROMPT_SUBMIT {
                            submit(
                                &mut view,
                                &mut buffer,
                                ScreenTarget {
                                    session: &mut session,
                                    transcript: &mut transcript,
                                    fullscreen,
                                },
                                engine.as_mut(),
                                &mut history,
                                &mut queued_prompts,
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
                        } else if action == Action::APP_TOGGLE_TRANSCRIPT {
                            if fullscreen {
                                // A focused message expands on its own; with
                                // no focus Ctrl+O keeps the all-tools toggle.
                                if let Some(key) = toggle_focused(&actions, &mut expand) {
                                    all_expanded = false;
                                    let expanded = expand.is_expanded(key.clone());
                                    rebuild_transcript(&mut transcript, &view.completed, &expand);
                                    view.status = Some(
                                        if expanded {
                                            "message expanded"
                                        } else {
                                            "message collapsed"
                                        }
                                        .into(),
                                    );
                                } else {
                                    all_expanded = !all_expanded;
                                    if all_expanded {
                                        expand.expand_all();
                                    } else {
                                        expand.collapse_all();
                                    }
                                    rebuild_transcript(&mut transcript, &view.completed, &expand);
                                    view.status = Some(
                                        if all_expanded {
                                            "tool output expanded"
                                        } else {
                                            "tool output collapsed"
                                        }
                                        .into(),
                                    );
                                }
                            } else {
                                view.completed.push(Row::new(
                                    RowStyle::System,
                                    "expand/collapse needs fullscreen mode".to_string(),
                                ));
                            }
                        } else if action == Action::HISTORY_SEARCH {
                            let candidates: Vec<String> =
                                history.entries().iter().rev().cloned().collect();
                            search = Some(HistorySearch::with_matches(
                                HistoryScope::Global,
                                candidates,
                            ));
                            view.status = Some("search: (0/0)".into());
                        } else if let Some(intent) = vim_intent(action) {
                            vim_mode_changed = apply_vim_intent(intent, &mut vim, &mut buffer);
                        }
                    }
                }

                if vim_mode_changed {
                    // The resolver borrows the context stack, so rebuild both
                    // after a mode switch. A pending chord belonged to the old
                    // mode and is discarded.
                    drop(resolver);
                    sync_vim_contexts(&mut contexts, &vim);
                    resolver = Resolver::new(keymap.bindings(), &contexts, 800);
                }
            }
            _ => {}
        }
    }

    Ok(())
}

/// What a resolved [`Action::VIM_*`](VimAction) asks the event loop to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VimIntent {
    /// Apply the buffer edit and stay in normal mode.
    Edit(VimAction),
    /// Apply the buffer edit, then enter insert mode (`i`/`a`/`o`).
    EnterInsert(VimAction),
    /// Leave insert mode without touching the buffer (`Esc`).
    EnterNormal,
}

/// Map a keymap action to a vim transition, if it is one.
///
/// Pure so the action wiring can be tested without a terminal.
fn vim_intent(action: Action) -> Option<VimIntent> {
    let vim_action = VimAction::from_action(action)?;
    Some(match vim_action {
        VimAction::Insert | VimAction::Append | VimAction::OpenLine => {
            VimIntent::EnterInsert(vim_action)
        }
        VimAction::NormalMode => VimIntent::EnterNormal,
        other => VimIntent::Edit(other),
    })
}

/// Apply `intent`; returns whether the vim mode changed.
fn apply_vim_intent(intent: VimIntent, vim: &mut VimState, buffer: &mut TextBuffer) -> bool {
    match intent {
        VimIntent::Edit(action) => {
            action.apply(buffer);
            false
        }
        VimIntent::EnterInsert(action) => {
            action.apply(buffer);
            vim.enter_insert();
            true
        }
        VimIntent::EnterNormal => {
            vim.enter_normal();
            true
        }
    }
}

/// Swap the mode-specific vim context for the one matching `vim`.
fn sync_vim_contexts(contexts: &mut ContextStack, vim: &VimState) {
    contexts.pop(Context::VIM_NORMAL);
    contexts.pop(Context::VIM_INSERT);
    if vim.is_enabled() {
        contexts.push(vim_context(*vim));
    }
}

/// What a key asks the slash palette to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PaletteCommand {
    Previous,
    Next,
    Accept,
    Dismiss,
}

/// Map a key to a palette action; `open` means the palette owns the key.
fn palette_command(code: KeyCode, open: bool) -> Option<PaletteCommand> {
    if !open {
        return None;
    }
    match code {
        KeyCode::Up => Some(PaletteCommand::Previous),
        KeyCode::Down => Some(PaletteCommand::Next),
        KeyCode::Tab | KeyCode::Enter => Some(PaletteCommand::Accept),
        KeyCode::Esc => Some(PaletteCommand::Dismiss),
        _ => None,
    }
}

/// What a key asks the transcript search modal to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchCommand {
    Close,
    Jump,
    Next,
    Prev,
    Backspace,
    Insert(char),
    Ignore,
}

/// Map a key to a transcript-search action.
///
/// `navigating` becomes true after Enter jumps to a match; from then on `n`/`N`
/// cycle matches instead of editing the query (like a vim search).
fn search_command(key: &ratatui::crossterm::event::KeyEvent, navigating: bool) -> SearchCommand {
    match key.code {
        KeyCode::Esc => return SearchCommand::Close,
        KeyCode::Enter => return SearchCommand::Jump,
        KeyCode::Backspace => return SearchCommand::Backspace,
        _ => {}
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) || key.modifiers.contains(KeyModifiers::ALT) {
        return SearchCommand::Ignore;
    }
    match key.code {
        KeyCode::Up => SearchCommand::Prev,
        KeyCode::Down => SearchCommand::Next,
        KeyCode::Char('n') if navigating => SearchCommand::Next,
        KeyCode::Char('N') if navigating => SearchCommand::Prev,
        KeyCode::Char(ch) => SearchCommand::Insert(ch),
        _ => SearchCommand::Ignore,
    }
}

/// Feed the current input to the palette only when the text actually changed,
/// so Up/Down navigation is not reset on every frame and a dismissed palette
/// stays dismissed until the user edits again.
fn sync_palette(palette: &mut CommandPalette, text: &str, seen: &mut String) {
    if text != seen {
        palette.set_query(text);
        seen.clear();
        seen.push_str(text);
    }
}

/// Accept the selected palette row into `buffer`, returning the inserted text.
fn accept_palette(
    palette: &mut CommandPalette,
    buffer: &mut TextBuffer,
    seen: &mut String,
) -> Option<String> {
    let accepted = palette.accept()?;
    buffer.set_text(accepted.clone());
    seen.clear();
    seen.push_str(buffer.text());
    Some(accepted)
}

/// Extract palette commands from an init frame, tolerating missing fields.
///
/// `slash_commands` is an array of names in the SDK schema; objects with
/// `name`/`description`/`argumentHint` are accepted too so richer engines can
/// keep working. Anything else is skipped.
fn command_specs_from_init(extra: &serde_json::Map<String, serde_json::Value>) -> Vec<CommandSpec> {
    let Some(commands) = extra
        .get("slash_commands")
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };
    commands
        .iter()
        .filter_map(command_spec_from_value)
        .collect()
}

fn command_spec_from_value(value: &serde_json::Value) -> Option<CommandSpec> {
    match value {
        serde_json::Value::String(name) => command_spec_from_name(name),
        serde_json::Value::Object(fields) => {
            let name = fields
                .get("name")
                .or_else(|| fields.get("command"))?
                .as_str()?;
            let mut spec = command_spec_from_name(name)?;
            if let Some(description) = fields
                .get("description")
                .and_then(serde_json::Value::as_str)
            {
                spec = spec.with_description(description);
            }
            let hint = fields
                .get("argumentHint")
                .or_else(|| fields.get("argument_hint"))
                .and_then(serde_json::Value::as_str);
            if let Some(hint) = hint {
                spec = spec.with_argument_hint(hint);
            }
            let hidden = fields
                .get("isHidden")
                .or_else(|| fields.get("hidden"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            if hidden {
                spec = spec.hide();
            }
            Some(spec)
        }
        _ => None,
    }
}

fn command_spec_from_name(name: &str) -> Option<CommandSpec> {
    let name = name.trim().trim_start_matches('/');
    (!name.is_empty()).then(|| CommandSpec::new(name))
}

/// The palette overlay while the input line starts with `/`.
///
/// The overlay is shown even when there are no matches (or no commands were
/// announced in the init frame); it is then just an empty titled box.
fn palette_overlay(palette: &CommandPalette) -> Option<Overlay> {
    if !palette.is_active() {
        return None;
    }
    let lines: Vec<String> = palette.rows(76).into_iter().map(|row| row.text).collect();
    let selected = lines.iter().position(|line| line.starts_with('>'));
    Some(Overlay::new(" Commands ", lines, selected))
}

/// The transcript-search overlay with up to [`MAX_SEARCH_ROWS`] results.
fn search_overlay(search: &TranscriptSearch) -> Overlay {
    let lines = search.rows(search.query(), 76, MAX_SEARCH_ROWS);
    let selected = search
        .current_index()
        .map(|index| index.min(lines.len().saturating_sub(1)));
    Overlay::new(format!(" Search: {} ", search.query()), lines, selected).centered()
}

/// Visible result rows in the transcript-search overlay.
const MAX_SEARCH_ROWS: usize = 8;

/// Status-line text for inline search: `match i/n` (zero when no matches).
fn search_status(search: &TranscriptSearch) -> String {
    let index = search.current_index().map_or(0, |index| index + 1);
    format!("match {index}/{}", search.count())
}

/// Snapshot the rows the search should scan for the current mode.
fn begin_transcript_search(
    view: &ChatView,
    transcript: &TranscriptModel,
    fullscreen: bool,
) -> TranscriptSearch {
    let rows: Vec<Row> = if fullscreen {
        transcript.rows().to_vec()
    } else {
        view.completed.clone()
    };
    TranscriptSearch::new(&rows)
}

/// Jump to the current search match. Inline mode has no transcript to scroll,
/// so the status line is the only feedback (updated by the caller).
fn jump_to_match(transcript: &mut TranscriptModel, fullscreen: bool, search: &TranscriptSearch) {
    if !fullscreen {
        return;
    }
    let Some(found) = search.current() else {
        return;
    };
    scroll_to_row(transcript, found.row_index);
}

/// Scroll the transcript so `row` is near the middle of the viewport.
///
/// Rows map to display lines through the cached heights; the target is the
/// first display line of the row, centred by half a viewport.
fn scroll_to_row(transcript: &mut TranscriptModel, row: usize) {
    let mut start = 0usize;
    for index in 0..row {
        let Some(height) = transcript.row_height(index) else {
            return;
        };
        start += height;
    }
    let target = start.saturating_sub(transcript.viewport_height() / 2);
    let delta = target as isize - transcript.offset() as isize;
    transcript.scroll_by(delta);
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

/// Insert the blank separator rows the inline renderer would add, so the
/// fullscreen model's heights match what is drawn. `previous` carries the last
/// row already in the model (its style and whether it is a blank separator).
fn with_spacing(rows: &[Row], mut previous: Option<(RowStyle, bool)>) -> Vec<Row> {
    let mut out: Vec<Row> = Vec::with_capacity(rows.len() + 4);
    for row in rows {
        let starts_block = matches!(row.style, RowStyle::Assistant | RowStyle::ToolCall)
            || (row.style == RowStyle::User
                && previous.map(|(style, _)| style) != Some(RowStyle::User));
        let last_blank = previous.is_some_and(|(_, blank)| blank);
        if starts_block && previous.is_some() && !last_blank {
            out.push(Row::new(RowStyle::System, String::new()));
        }
        out.push(row.clone());
        previous = Some((
            row.style,
            row.text.is_empty() && row.style == RowStyle::System,
        ));
    }
    out
}

/// Rebuild the fullscreen transcript from `rows` under `expand`, restoring the
/// same separator rows the incremental freeze path inserts.
fn rebuild_transcript(transcript: &mut TranscriptModel, rows: &[Row], expand: &ExpandState) {
    let projected = project(rows, expand, ExpandLimits::default());
    transcript.set_rows(with_spacing(&projected, None));
    transcript.scroll_to_bottom();
}

fn freeze(
    session: &mut TerminalSession,
    transcript: &mut TranscriptModel,
    fullscreen: bool,
    rows: &[Row],
) -> io::Result<()> {
    if fullscreen {
        freeze_fullscreen(transcript, rows);
        Ok(())
    } else {
        session.insert_rows(rows)
    }
}

/// Append a completed batch to the full-screen transcript, inserting the blank
/// separator rows the inline renderer adds. Shared with the replay benchmark so
/// both paths perform the same work.
pub(crate) fn freeze_fullscreen(transcript: &mut TranscriptModel, rows: &[Row]) {
    let previous = transcript.rows().last().map(|last| {
        (
            last.style,
            last.text.is_empty() && last.style == RowStyle::System,
        )
    });
    transcript.append(with_spacing(rows, previous));
}

/// Freeze the current buffer as a user row and forward it to the engine.
///
/// Folded pastes are expanded before sending: the transcript and the engine
/// see the original text, while the input line only ever showed placeholders.
struct ScreenTarget<'a> {
    session: &'a mut TerminalSession,
    transcript: &'a mut TranscriptModel,
    fullscreen: bool,
}

fn submit(
    view: &mut ChatView,
    buffer: &mut TextBuffer,
    screen: ScreenTarget<'_>,
    engine: Option<&mut EngineProcess>,
    history: &mut PromptHistory,
    queued_prompts: &mut Vec<String>,
) -> io::Result<()> {
    let ScreenTarget {
        session,
        transcript,
        fullscreen,
    } = screen;
    let draft = buffer.expand_pastes();
    if !draft.trim().is_empty() {
        let row = Row::new(RowStyle::User, format!("> {draft}"));
        freeze(session, transcript, fullscreen, std::slice::from_ref(&row))?;
        view.completed.push(row);
        history.push(draft.clone());
        if let Some(process) = engine {
            if view.busy {
                queued_prompts.push(draft.clone());
                view.status = Some("queued".into());
            } else {
                process.send_prompt(draft.trim())?;
                view.busy = true;
                view.status = Some("sent".into());
            }
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
    fn vim_intent_maps_actions_to_transitions() {
        assert_eq!(
            vim_intent(Action::VIM_INSERT),
            Some(VimIntent::EnterInsert(VimAction::Insert))
        );
        assert_eq!(
            vim_intent(Action::VIM_APPEND),
            Some(VimIntent::EnterInsert(VimAction::Append))
        );
        assert_eq!(
            vim_intent(Action::VIM_OPEN_LINE),
            Some(VimIntent::EnterInsert(VimAction::OpenLine))
        );
        assert_eq!(vim_intent(Action::VIM_NORMAL), Some(VimIntent::EnterNormal));
        assert_eq!(
            vim_intent(Action::VIM_LEFT),
            Some(VimIntent::Edit(VimAction::Left))
        );
        assert_eq!(
            vim_intent(Action::VIM_DELETE_LINE),
            Some(VimIntent::Edit(VimAction::DeleteLine))
        );

        // Non-vim actions are untouched.
        for action in [
            Action::PROMPT_SUBMIT,
            Action::EDIT_BACKSPACE,
            Action::APP_INTERRUPT,
        ] {
            assert_eq!(vim_intent(action), None, "{action}");
        }
    }

    #[test]
    fn vim_intents_drive_the_mode_state_machine() {
        let mut vim = VimState::enabled();
        let mut buffer = TextBuffer::from_text("abc");
        buffer.set_cursor(0);

        // `a` moves past the cursor and enters insert mode.
        assert!(apply_vim_intent(
            VimIntent::EnterInsert(VimAction::Append),
            &mut vim,
            &mut buffer
        ));
        assert!(vim.is_insert());
        assert_eq!(buffer.cursor(), 1);

        // Esc leaves insert without touching the text.
        assert!(apply_vim_intent(
            VimIntent::EnterNormal,
            &mut vim,
            &mut buffer
        ));
        assert!(vim.is_normal());
        assert_eq!(buffer.text(), "abc");

        // Motions apply but keep normal mode.
        assert!(!apply_vim_intent(
            VimIntent::Edit(VimAction::LineEnd),
            &mut vim,
            &mut buffer
        ));
        assert!(vim.is_normal());
        assert_eq!(buffer.cursor(), 3);
    }

    #[test]
    fn sync_vim_contexts_swaps_the_mode_context() {
        let mut contexts = ContextStack::new();
        contexts.push(Context::PROMPT);
        let mut vim = VimState::enabled();

        sync_vim_contexts(&mut contexts, &vim);
        assert!(contexts.contains(Context::VIM_INSERT));
        assert!(!contexts.contains(Context::VIM_NORMAL));

        vim.enter_normal();
        sync_vim_contexts(&mut contexts, &vim);
        assert!(contexts.contains(Context::VIM_NORMAL));
        assert!(!contexts.contains(Context::VIM_INSERT));

        vim.toggle();
        sync_vim_contexts(&mut contexts, &vim);
        assert!(!contexts.contains(Context::VIM_NORMAL));
        assert!(!contexts.contains(Context::VIM_INSERT));
        assert!(contexts.contains(Context::PROMPT));
    }

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
    fn palette_accept_inserts_text_and_closes() {
        let mut palette = CommandPalette::new(vec![
            CommandSpec::new("compact"),
            CommandSpec::new("diff").with_argument_hint("<file>"),
        ]);
        palette.set_query("/di");
        let mut buffer = TextBuffer::new();
        let mut seen = "/di".to_string();

        assert_eq!(
            accept_palette(&mut palette, &mut buffer, &mut seen),
            Some("/diff <file>".to_string())
        );
        assert_eq!(buffer.text(), "/diff <file>");
        assert_eq!(buffer.cursor(), buffer.len());
        assert!(!palette.is_active());
        assert_eq!(seen, "/diff <file>");
    }

    #[test]
    fn palette_command_closes_on_escape_and_accepts_on_enter() {
        assert_eq!(
            palette_command(KeyCode::Esc, true),
            Some(PaletteCommand::Dismiss)
        );
        assert_eq!(
            palette_command(KeyCode::Enter, true),
            Some(PaletteCommand::Accept)
        );
        assert_eq!(
            palette_command(KeyCode::Tab, true),
            Some(PaletteCommand::Accept)
        );
        assert_eq!(
            palette_command(KeyCode::Up, true),
            Some(PaletteCommand::Previous)
        );
        assert_eq!(
            palette_command(KeyCode::Down, true),
            Some(PaletteCommand::Next)
        );
        // A closed palette leaves the keys to prompt history/editing.
        assert_eq!(palette_command(KeyCode::Enter, false), None);
        assert_eq!(palette_command(KeyCode::Char('x'), true), None);
    }

    #[test]
    fn search_command_routes_keys_and_escape_closes() {
        use ratatui::crossterm::event::KeyEvent;

        let key = |code, modifiers| KeyEvent::new(code, modifiers);
        let plain = KeyModifiers::NONE;
        assert_eq!(
            search_command(&key(KeyCode::Esc, plain), false),
            SearchCommand::Close
        );
        assert_eq!(
            search_command(&key(KeyCode::Enter, plain), false),
            SearchCommand::Jump
        );
        assert_eq!(
            search_command(&key(KeyCode::Backspace, plain), false),
            SearchCommand::Backspace
        );
        assert_eq!(
            search_command(&key(KeyCode::Char('a'), plain), false),
            SearchCommand::Insert('a')
        );
        // `n` edits the query until Enter starts navigation.
        assert_eq!(
            search_command(&key(KeyCode::Char('n'), plain), false),
            SearchCommand::Insert('n')
        );
        assert_eq!(
            search_command(&key(KeyCode::Char('n'), plain), true),
            SearchCommand::Next
        );
        assert_eq!(
            search_command(&key(KeyCode::Char('N'), plain), true),
            SearchCommand::Prev
        );
        assert_eq!(
            search_command(&key(KeyCode::Up, plain), false),
            SearchCommand::Prev
        );
        assert_eq!(
            search_command(&key(KeyCode::Char('f'), KeyModifiers::CONTROL), false),
            SearchCommand::Ignore
        );
    }

    #[test]
    fn search_status_counts_matches_and_navigation() {
        let rows = vec![
            Row::new(RowStyle::Assistant, "alpha"),
            Row::new(RowStyle::Assistant, "beta alpha"),
        ];
        let mut search = TranscriptSearch::new(&rows);
        search.set_query("alpha");
        assert_eq!(search_status(&search), "match 1/2");
        search.next();
        assert_eq!(search_status(&search), "match 2/2");
        search.next();
        assert_eq!(search_status(&search), "match 1/2");
        search.set_query("zzz");
        assert_eq!(search_status(&search), "match 0/0");
    }

    #[test]
    fn search_overlay_lists_matches_and_marks_the_current_one() {
        let rows = vec![
            Row::new(RowStyle::Assistant, "alpha"),
            Row::new(RowStyle::Assistant, "alpha again"),
        ];
        let mut search = TranscriptSearch::new(&rows);
        search.set_query("alpha");
        let overlay = search_overlay(&search);
        assert_eq!(overlay.title, " Search: alpha ");
        assert_eq!(overlay.lines, vec!["1/2  alpha", "2/2  alpha again"]);
        assert_eq!(overlay.selected, Some(0));
        assert_eq!(
            overlay.placement,
            cch_tui_render::OverlayPlacement::Centered
        );
    }

    #[test]
    fn scroll_to_row_centers_the_matched_row() {
        let rows: Vec<Row> = (0..20)
            .map(|index| Row::new(RowStyle::Assistant, format!("row {index}")))
            .collect();
        let mut model = TranscriptModel::new();
        model.set_rows(rows);
        model.window(4, 40);
        assert_eq!(model.offset(), 16);

        scroll_to_row(&mut model, 0);
        assert_eq!(model.offset(), 0);
        scroll_to_row(&mut model, 10);
        assert_eq!(model.offset(), 8);
        assert!(!model.is_following());
    }

    #[test]
    fn init_slash_commands_are_parsed_tolerantly() {
        let extra = serde_json::Map::from_iter([(
            "slash_commands".to_string(),
            serde_json::json!([
                "compact",
                "/diff",
                42,
                {"name": "help", "description": "Show help", "argumentHint": "<topic>"},
                {"command": "/hidden", "isHidden": true}
            ]),
        )]);
        let specs = command_specs_from_init(&extra);
        let names: Vec<&str> = specs.iter().map(|spec| spec.name.as_str()).collect();
        assert_eq!(names, ["compact", "diff", "help", "hidden"]);
        assert_eq!(specs[2].description.as_deref(), Some("Show help"));
        assert_eq!(specs[2].argument_hint.as_deref(), Some("<topic>"));
        assert!(specs[3].hidden);

        // Missing/blank input yields an empty (but usable) palette.
        assert!(command_specs_from_init(&serde_json::Map::new()).is_empty());
        let blank =
            serde_json::Map::from_iter([("slash_commands".to_string(), serde_json::json!([]))]);
        assert!(command_specs_from_init(&blank).is_empty());
    }

    #[test]
    fn palette_overlay_only_appears_for_slash_input_with_matches() {
        let mut palette = CommandPalette::new(vec![CommandSpec::new("compact")]);
        assert!(palette_overlay(&palette).is_none());

        palette.set_query("/");
        let overlay = palette_overlay(&palette).expect("visible palette");
        assert_eq!(overlay.lines, vec!["> /compact"]);
        assert_eq!(overlay.selected, Some(0));
        assert_eq!(
            overlay.placement,
            cch_tui_render::OverlayPlacement::AboveInput
        );

        // No match still opens an empty panel, so the user can keep editing.
        palette.set_query("/zzz");
        let empty = palette_overlay(&palette).expect("empty palette stays open");
        assert!(empty.lines.is_empty());
        assert_eq!(empty.selected, None);

        // ...but a non-slash input closes it entirely.
        palette.set_query("zzz");
        assert!(palette_overlay(&palette).is_none());
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
