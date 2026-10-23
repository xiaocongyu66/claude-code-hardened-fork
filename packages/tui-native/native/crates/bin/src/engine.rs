//! Engine process plumbing: spawn the TS engine, read NDJSON from its stdout,
//! and write prompts to its stdin.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Duration;

use cch_tui_proto::{EngineEvent, encode, parse_line};
use serde_json::json;

/// One line from the engine, or a transport error.
#[derive(Debug)]
pub enum EngineMessage {
    Event(EngineEvent),
    Malformed(String),
    Closed,
}

/// A running engine child process.
pub struct EngineProcess {
    child: Child,
    stdin: Option<ChildStdin>,
}

impl EngineProcess {
    /// Spawn `program` with `args` and start reading NDJSON frames. The
    /// receiver is returned separately so the caller owns the event loop.
    pub fn spawn(
        program: &str,
        args: &[String],
    ) -> std::io::Result<(Self, Receiver<EngineMessage>)> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::other("engine stdout unavailable"))?;
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    let _ = tx.send(EngineMessage::Malformed("<io error>".into()));
                    break;
                };
                if line.trim().is_empty() {
                    continue;
                }
                match parse_line(&line) {
                    Ok(event) => {
                        if tx.send(EngineMessage::Event(event)).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        if tx
                            .send(EngineMessage::Malformed(format!("{error}: {line}")))
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            }
            let _ = tx.send(EngineMessage::Closed);
        });
        Ok((Self { child, stdin }, rx))
    }

    /// Send a user prompt as a stream-json user message (the shape the engine
    /// consumes with `--input-format stream-json`).
    pub fn send_prompt(&mut self, text: &str) -> std::io::Result<()> {
        let frame = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": text }],
            },
        });
        self.send_frame(&frame.to_string())
    }

    /// Send a control response (e.g. a permission decision).
    pub fn send_control_response(
        &mut self,
        request_id: &str,
        response: serde_json::Value,
    ) -> std::io::Result<()> {
        let frame = json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": response,
            },
        });
        self.send_frame(&frame.to_string())
    }

    fn send_frame(&mut self, line: &str) -> std::io::Result<()> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| std::io::Error::other("engine stdin closed"))?;
        stdin.write_all(line.as_bytes())?;
        stdin.write_all(b"\n")?;
        stdin.flush()
    }
}

impl Drop for EngineProcess {
    fn drop(&mut self) {
        // Closing stdin is the protocol's shutdown signal; follow up with a
        // kill so a wedged engine cannot outlive the TUI.
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Replay a fixture file as if it were an engine, with optional pacing.
pub fn replay(
    path: impl AsRef<Path>,
    frame_delay: Duration,
) -> std::io::Result<Receiver<EngineMessage>> {
    let content = std::fs::read_to_string(path)?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in content.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let message = match parse_line(line) {
                Ok(event) => EngineMessage::Event(event),
                Err(error) => EngineMessage::Malformed(format!("{error}: {line}")),
            };
            if tx.send(message).is_err() {
                return;
            }
            if !frame_delay.is_zero() {
                thread::sleep(frame_delay);
            }
        }
        let _ = tx.send(EngineMessage::Closed);
    });
    Ok(rx)
}

/// Encode a frame for tests and diagnostics.
pub fn encode_event(event: &EngineEvent) -> Option<String> {
    encode(event).ok()
}
