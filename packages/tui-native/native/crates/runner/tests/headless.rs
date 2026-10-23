//! Threaded integration test for the headless runner: start the loop on a
//! thread, feed engine frames through `send` (inbox), drain user commands
//! through `poll` (outbox), and stop it with the shutdown hook.

use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use cch_tui_proto::{EngineEvent, parse_line};
use cch_tui_runner::{
    RunOptions, TerminalMode, TuiCommand, request_shutdown, reset_shutdown,
    run_interactive_with_mode, set_vim_default,
};
use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};

fn key(code: KeyCode) -> Event {
    Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
}

fn event(line: &str) -> EngineEvent {
    parse_line(line).expect("valid engine frame")
}

fn recv_command(rx: &mpsc::Receiver<TuiCommand>) -> TuiCommand {
    rx.recv_timeout(Duration::from_secs(5))
        .expect("timed out waiting for a TuiCommand")
}

#[test]
fn thread_start_send_poll_stop() {
    reset_shutdown();
    set_vim_default(false);

    let (event_tx, event_rx) = mpsc::channel::<EngineEvent>();
    let (command_tx, command_rx) = mpsc::channel::<TuiCommand>();
    let (input_tx, input_rx) = mpsc::channel::<Event>();

    let handle = thread::spawn(move || {
        run_interactive_with_mode(
            RunOptions {
                inbox: event_rx,
                outbox: command_tx,
                fullscreen: false,
                theme: None,
            },
            TerminalMode::Headless { input: input_rx },
            None,
        )
    });

    event_tx
        .send(event(
            r#"{"type":"system","subtype":"init","session_id":"s1"}"#,
        ))
        .expect("send init");
    event_tx
        .send(event(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello from engine"}]}}"#,
        ))
        .expect("send assistant");

    // Typing "hi" then Enter emits a prompt command.
    input_tx.send(key(KeyCode::Char('h'))).expect("key h");
    input_tx.send(key(KeyCode::Char('i'))).expect("key i");
    input_tx.send(key(KeyCode::Enter)).expect("enter");
    assert_eq!(
        recv_command(&command_rx),
        TuiCommand::Prompt("hi".to_string())
    );

    // A permission request opens the dialog; Enter accepts "Allow once".
    event_tx
        .send(event(
            r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"t1","input":{"command":"ls"}}}"#,
        ))
        .expect("send permission");
    // The dialog opens asynchronously; retry the decision key (empty submits
    // before the dialog is up are no-ops) until the command comes back.
    let deadline = Instant::now() + Duration::from_secs(5);
    let permission = loop {
        input_tx.send(key(KeyCode::Enter)).expect("enter dialog");
        match command_rx.recv_timeout(Duration::from_millis(25)) {
            Ok(command) => break command,
            Err(RecvTimeoutError::Timeout) => {
                assert!(Instant::now() < deadline, "permission dialog never opened")
            }
            Err(RecvTimeoutError::Disconnected) => panic!("runner dropped the outbox"),
        }
    };
    match permission {
        TuiCommand::Permission {
            request_id,
            response,
        } => {
            assert_eq!(request_id, "r1");
            assert_eq!(
                response.get("behavior").and_then(|value| value.as_str()),
                Some("allow")
            );
        }
        other => panic!("expected permission command, got {other:?}"),
    }

    // Ending the turn and stopping the loop emits Exit before the thread ends.
    event_tx
        .send(event(r#"{"type":"result","subtype":"success"}"#))
        .expect("send result");
    request_shutdown();
    let report = handle.join().expect("join runner").expect("runner result");
    assert_eq!(recv_command(&command_rx), TuiCommand::Exit);

    assert!(
        report
            .rows
            .iter()
            .any(|row| row.text.contains("hello from engine")),
        "assistant row was not collected: {:?}",
        report.rows
    );
    assert!(
        report.rows.iter().any(|row| row.text.contains("> hi")),
        "user row was not collected: {:?}",
        report.rows
    );
}
