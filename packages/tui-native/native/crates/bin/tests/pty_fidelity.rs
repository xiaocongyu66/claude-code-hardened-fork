//! End-to-end visual fidelity through a real PTY.
//!
//! The binary replays [`fixtures/frames.ndjson`] at 5 ms pacing so the test
//! sees the frozen transcript, the prompt line and a tool result before the
//! test-only deadline fires. ANSI cursor/colour sequences may be interleaved
//! with the glyphs, so the output is normalised to visible characters first
//! and matched loosely.
#![cfg(unix)]

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{CommandBuilder, PtySize, native_pty_system};

/// Frame pacing passed to `--replay` (fast enough for CI).
const DELAY_MS: &str = "5";
/// How long the binary runs before its test-only deadline fires.
const EXIT_AFTER_MS: u64 = 600;
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
fn run_tui() -> Run {
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
        DELAY_MS,
        "--exit-after-ms",
        &EXIT_AFTER_MS.to_string(),
    ]);

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
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(chunk) => output.extend_from_slice(&chunk),
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {}
        }
    };

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

/// Drop ANSI escape sequences and other control characters so glyphs that
/// were split by cursor/colour sequences become contiguous again.
fn visible_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\x1b' {
            if ch == '\n' {
                out.push('\n');
            } else if !ch.is_control() {
                out.push(ch);
            }
            continue;
        }
        match chars.next() {
            // CSI: parameter/intermediate bytes, then a final byte 0x40..=0x7e.
            Some('[') => {
                for next in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&next) {
                        break;
                    }
                }
            }
            // OSC / DCS / APC / PM: terminated by BEL or ST (ESC `\`).
            Some(']') | Some('P') | Some('_') | Some('^') => {
                let mut after_esc = false;
                for next in chars.by_ref() {
                    if next == '\x07' || (after_esc && next == '\\') {
                        break;
                    }
                    after_esc = next == '\x1b';
                }
            }
            // Two-byte escapes such as `ESC ( B`.
            Some(_) => {}
            None => {}
        }
    }
    out
}

#[test]
fn replay_paints_prompt_bullet_and_tool_result_gutter() {
    let run = run_tui();
    let visible = visible_text(&run.output);

    assert_eq!(run.exit_code, 0, "output:\n{visible}");
    assert!(
        visible.contains('❯'),
        "prompt pointer missing from replay:\n{visible}"
    );
    assert!(
        visible.contains('⏺') || visible.contains('●'),
        "message/tool bullet missing from replay:\n{visible}"
    );
    let gutter = visible
        .find('⎿')
        .unwrap_or_else(|| panic!("tool result gutter missing from replay:\n{visible}"));
    assert!(
        visible[..gutter].ends_with("  "),
        "gutter must be preceded by the two-space indent:\n{visible}"
    );
}
