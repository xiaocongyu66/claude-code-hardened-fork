//! Clipboard transport selection.
//!
//! OSC52 works through the terminal (including tmux and SSH) and needs no
//! external binary, but some terminals ignore it. On local sessions we prefer
//! the platform clipboard program (`pbcopy`, `wl-copy`, `xclip`, `xsel` or
//! `clip`) and fall back to OSC52. Over SSH OSC52 wins, because the platform
//! command would write to the *remote* machine's clipboard.
//!
//! Every failure is silent: the caller treats copying as best-effort.

use std::env;
use std::io::{self, Write};
use std::process::{Command, Stdio};

use super::osc52_sequence;

/// A platform clipboard program.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardCommand {
    /// macOS.
    PbCopy,
    /// Wayland.
    WlCopy,
    /// X11 (xclip).
    Xclip,
    /// X11 (xsel).
    Xsel,
    /// Windows.
    Clip,
}

impl ClipboardCommand {
    pub const fn program(self) -> &'static str {
        match self {
            Self::PbCopy => "pbcopy",
            Self::WlCopy => "wl-copy",
            Self::Xclip => "xclip",
            Self::Xsel => "xsel",
            Self::Clip => "clip",
        }
    }

    pub const fn args(self) -> &'static [&'static str] {
        match self {
            Self::Xclip => &["-selection", "clipboard"],
            Self::Xsel => &["--clipboard", "--input"],
            Self::PbCopy | Self::WlCopy | Self::Clip => &[],
        }
    }
}

/// One way to deliver text to the clipboard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardMethod {
    /// Terminal escape sequence (`OSC 52`), works over SSH.
    Osc52,
    /// Pipe the text into a platform program.
    Command(ClipboardCommand),
}

/// Platform programs in preference order.
///
/// Linux prefers Wayland (`wl-copy`) and then the two X11 tools; macOS and
/// Windows have a single program each. Unknown platforms have none, so OSC52
/// remains the only option.
pub fn platform_commands(
    is_macos: bool,
    is_windows: bool,
    is_linux: bool,
) -> &'static [ClipboardCommand] {
    const MACOS: &[ClipboardCommand] = &[ClipboardCommand::PbCopy];
    const WINDOWS: &[ClipboardCommand] = &[ClipboardCommand::Clip];
    const LINUX: &[ClipboardCommand] = &[
        ClipboardCommand::WlCopy,
        ClipboardCommand::Xclip,
        ClipboardCommand::Xsel,
    ];
    if is_macos {
        MACOS
    } else if is_windows {
        WINDOWS
    } else if is_linux {
        LINUX
    } else {
        &[]
    }
}

/// Ordered transports to try for a session.
///
/// `available` decides whether a program can be spawned; unavailable programs
/// are skipped. OSC52 is always present: first over SSH, last otherwise.
pub fn clipboard_order(
    ssh: bool,
    is_macos: bool,
    is_windows: bool,
    is_linux: bool,
    available: impl Fn(&str) -> bool,
) -> Vec<ClipboardMethod> {
    let mut commands: Vec<ClipboardMethod> = platform_commands(is_macos, is_windows, is_linux)
        .iter()
        .copied()
        .filter(|command| available(command.program()))
        .map(ClipboardMethod::Command)
        .collect();
    if ssh {
        let mut order = Vec::with_capacity(commands.len() + 1);
        order.push(ClipboardMethod::Osc52);
        order.append(&mut commands);
        order
    } else {
        commands.push(ClipboardMethod::Osc52);
        commands
    }
}

/// Copy `text` using the best available transport. Errors are swallowed.
pub fn copy(text: &str) -> bool {
    let order = clipboard_order(
        is_ssh(),
        cfg!(target_os = "macos"),
        cfg!(target_os = "windows"),
        cfg!(target_os = "linux"),
        command_exists,
    );
    for method in order {
        let ok = match method {
            ClipboardMethod::Osc52 => write_osc52(text).is_ok(),
            ClipboardMethod::Command(command) => pipe_to(command, text).is_ok(),
        };
        if ok {
            return true;
        }
    }
    false
}

/// Whether the session looks like SSH (`ssh`/`mosh`/remote shells set these).
pub fn is_ssh() -> bool {
    ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]
        .iter()
        .any(|name| env::var_os(name).is_some_and(|value| !value.is_empty()))
}

/// Whether `program` exists on `PATH`. Spawn failures are handled anyway;
/// this only keeps the preference list tidy.
pub fn command_exists(program: &str) -> bool {
    let Some(path) = env::var_os("PATH") else {
        return false;
    };
    let mut extensions: Vec<&str> = vec![""];
    if cfg!(windows) {
        extensions.extend([".exe", ".cmd", ".bat"]);
    }
    env::split_paths(&path).any(|dir| {
        extensions
            .iter()
            .any(|extension| dir.join(format!("{program}{extension}")).is_file())
    })
}

fn write_osc52(text: &str) -> io::Result<()> {
    let mut stdout = io::stdout();
    stdout.write_all(osc52_sequence(text).as_bytes())?;
    stdout.flush()
}

fn pipe_to(command: ClipboardCommand, text: &str) -> io::Result<()> {
    let mut child = Command::new(command.program())
        .args(command.args())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes())?;
        // Dropping stdin closes the pipe so the child can finish.
    }
    let status = child.wait()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("clipboard command failed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(_: &str) -> bool {
        true
    }

    fn none(_: &str) -> bool {
        false
    }

    #[test]
    fn local_sessions_prefer_the_platform_program() {
        assert_eq!(
            clipboard_order(false, true, false, false, all),
            [
                ClipboardMethod::Command(ClipboardCommand::PbCopy),
                ClipboardMethod::Osc52,
            ]
        );
        assert_eq!(
            clipboard_order(false, false, true, false, all),
            [
                ClipboardMethod::Command(ClipboardCommand::Clip),
                ClipboardMethod::Osc52,
            ]
        );
        assert_eq!(
            clipboard_order(false, false, false, true, all),
            [
                ClipboardMethod::Command(ClipboardCommand::WlCopy),
                ClipboardMethod::Command(ClipboardCommand::Xclip),
                ClipboardMethod::Command(ClipboardCommand::Xsel),
                ClipboardMethod::Osc52,
            ]
        );
    }

    #[test]
    fn ssh_sessions_prefer_osc52() {
        assert_eq!(
            clipboard_order(true, true, false, false, all),
            [
                ClipboardMethod::Osc52,
                ClipboardMethod::Command(ClipboardCommand::PbCopy),
            ]
        );
        assert_eq!(
            clipboard_order(true, false, false, false, all),
            [ClipboardMethod::Osc52]
        );
    }

    #[test]
    fn missing_programs_are_skipped() {
        let available = |program: &str| program == "xclip";
        assert_eq!(
            clipboard_order(false, false, false, true, available),
            [
                ClipboardMethod::Command(ClipboardCommand::Xclip),
                ClipboardMethod::Osc52,
            ]
        );
        // Nothing installed still leaves OSC52.
        assert_eq!(
            clipboard_order(false, false, false, true, none),
            [ClipboardMethod::Osc52]
        );
        // Unknown platform has no native program at all.
        assert_eq!(
            clipboard_order(false, false, false, false, all),
            [ClipboardMethod::Osc52]
        );
    }

    #[test]
    fn commands_carry_the_right_arguments() {
        assert_eq!(ClipboardCommand::PbCopy.program(), "pbcopy");
        assert!(ClipboardCommand::PbCopy.args().is_empty());
        assert_eq!(ClipboardCommand::WlCopy.program(), "wl-copy");
        assert!(ClipboardCommand::WlCopy.args().is_empty());
        assert_eq!(ClipboardCommand::Xclip.args(), ["-selection", "clipboard"]);
        assert_eq!(ClipboardCommand::Xsel.args(), ["--clipboard", "--input"]);
        assert_eq!(ClipboardCommand::Clip.program(), "clip");
        assert!(ClipboardCommand::Clip.args().is_empty());
    }
}
