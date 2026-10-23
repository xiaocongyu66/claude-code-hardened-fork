//! End-to-end smoke tests that drive the real `cch-tui` binary through a
//! pseudo-terminal.
//!
//! The binary is launched with `--replay` against the checked-in fixture and
//! `--exit-after-ms`, so every test terminates deterministically instead of
//! waiting for a keypress. All blocking reads and child waits are bounded by
//! deadlines; a hung child is killed rather than failing the suite by timeout.
//!
//! PTY plumbing is Unix-only for now: the Windows ConPTY backend is supported
//! by `portable-pty` but has historically been flaky in CI, so on Windows this
//! file compiles without running anything.
#![cfg(unix)]

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{CommandBuilder, PtySize, native_pty_system};

/// How long the binary runs before its test-only deadline fires.
const EXIT_AFTER_MS: u64 = 800;
/// Upper bound on child lifetime; anything beyond this is treated as a hang.
const CHILD_TIMEOUT: Duration = Duration::from_secs(20);
/// Upper bound on draining output after the child has exited.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

struct Run {
    output: String,
    exit_code: u32,
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/frames.ndjson")
}

/// Run the binary in a fresh PTY and collect everything it writes until exit.
fn run_tui(extra_args: &[&str]) -> Run {
    let pty = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("open pty");

    let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_cch-tui"));
    command.arg("--replay");
    command.arg(fixture_path());
    command.args([
        "--delay-ms",
        "10",
        "--exit-after-ms",
        &EXIT_AFTER_MS.to_string(),
    ]);
    command.args(extra_args);

    let mut child = pty.slave.spawn_command(command).expect("spawn cch-tui");
    // The parent must not hold the slave open or the child never sees EOF.
    drop(pty.slave);

    let mut reader = pty.master.try_clone_reader().expect("pty reader");
    let mut writer = pty.master.take_writer().expect("pty writer");
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        // Ratatui's inline viewport asks where the cursor is (`ESC [ 6 n`) and
        // blocks until the terminal answers. A bare PTY has no emulator, so
        // play one and report the top-left corner. The last three bytes are
        // carried over so a query split across reads is still recognised.
        let mut carry: Vec<u8> = Vec::new();
        let mut queries = 0usize;
        let mut answered = 0usize;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let mut seen = carry.clone();
                    seen.extend_from_slice(&buf[..n]);
                    queries += seen
                        .windows(b"\x1b[6n".len())
                        .filter(|window| *window == b"\x1b[6n")
                        .count();
                    while answered < queries {
                        if writer.write_all(b"\x1b[1;1R").is_err() {
                            return;
                        }
                        answered += 1;
                    }
                    carry = seen[seen.len().saturating_sub(3)..].to_vec();
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                // Linux reports EIO once the last slave handle closes; that is
                // the normal end of output on this side.
                Err(_) => break,
            }
        }
    });

    let mut output = Vec::new();
    let deadline = Instant::now() + CHILD_TIMEOUT;
    let status = loop {
        drain_ready(&rx, &mut output);
        if let Some(status) = child.try_wait().expect("try_wait") {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!(
                "cch-tui did not exit within {CHILD_TIMEOUT:?}; output so far:\n{}",
                String::from_utf8_lossy(&output)
            );
        }
        // Wake up regularly to re-check the child and drain new output.
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(chunk) => output.extend_from_slice(&chunk),
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {}
        }
    };

    // Collect whatever the reader still had buffered after the exit, but do not
    // wait forever for a reader that may be blocked on a lingering fd.
    let drain_deadline = Instant::now() + DRAIN_TIMEOUT;
    loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(chunk) => output.extend_from_slice(&chunk),
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) if Instant::now() >= drain_deadline => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }

    Run {
        output: String::from_utf8_lossy(&output).into_owned(),
        exit_code: status.exit_code(),
    }
}

fn drain_ready(rx: &mpsc::Receiver<Vec<u8>>, output: &mut Vec<u8>) {
    while let Ok(chunk) = rx.try_recv() {
        output.extend_from_slice(&chunk);
    }
}

/// The fixture is replayed at 10 ms pacing, so a burst of frames can land
/// between two draws (the event loop polls every 33 ms). When that burst spans
/// both `control_request` and `engine_closed`, the live status line jumps from
/// the permission banner to the exit banner and the transient
/// `model · session` header is never painted. Retry with fresh processes so the
/// assertion does not depend on scheduler timing; the prompt and exit code are
/// checked on every attempt.
const HEADER_ATTEMPTS: usize = 5;

#[test]
fn replay_renders_session_and_prompt_then_exits_cleanly() {
    let mut missing_header = Vec::new();
    for _ in 0..HEADER_ATTEMPTS {
        let run = run_tui(&[]);

        assert!(
            run.output.contains("> "),
            "missing input prompt in output:\n{}",
            run.output
        );
        assert_eq!(run.exit_code, 0, "output:\n{}", run.output);

        if run.output.contains("claude-test") && run.output.contains("fixture-session") {
            return;
        }
        missing_header.push(run.output);
    }

    panic!(
        "model/session header never rendered in {HEADER_ATTEMPTS} runs:\n{}",
        missing_header.join("\n--- run ---\n")
    );
}

#[test]
fn fullscreen_enters_and_leaves_the_alternate_screen() {
    let run = run_tui(&["--fullscreen"]);

    assert!(
        run.output.contains("\x1b[?1049h"),
        "missing alternate-screen enter sequence:\n{:?}",
        run.output
    );
    assert!(
        run.output.contains("\x1b[?1049l"),
        "missing alternate-screen leave sequence:\n{:?}",
        run.output
    );
    assert!(
        run.output.contains("> "),
        "missing input prompt in output:\n{}",
        run.output
    );
    assert_eq!(run.exit_code, 0, "output:\n{}", run.output);
}
