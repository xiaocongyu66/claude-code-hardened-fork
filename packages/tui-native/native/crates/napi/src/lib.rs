//! In-process TUI bindings for the TypeScript host.
//!
//! The host owns the engine transport: it pushes engine NDJSON frames in with
//! [`send`] and drains [`TuiCommand`] JSON at its own cadence with [`poll`].
//! All terminal I/O happens on the runner thread spawned by [`start`]; the
//! exported functions themselves never touch the terminal.

use std::io::IsTerminal;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, MutexGuard};
use std::thread::{self, JoinHandle};

use cch_tui_proto::{EngineEvent, parse_line};
use cch_tui_runner::{
    RunOptions, TuiCommand, request_shutdown, reset_shutdown, run_interactive, set_vim_default,
};
use napi::{Error, Result};
use napi_derive::napi;
use serde::Deserialize;

/// Options accepted by [`start`].
#[derive(Debug, Default, Deserialize)]
struct StartOptions {
    #[serde(default)]
    fullscreen: Option<bool>,
    #[serde(default)]
    theme: Option<String>,
    #[serde(default)]
    vim: Option<bool>,
}

struct Handle {
    inbox: Sender<EngineEvent>,
    outbox: Receiver<TuiCommand>,
    thread: JoinHandle<std::io::Result<()>>,
}

/// One TUI per process; `start`/`stop` serialize through this slot.
static HANDLE: Mutex<Option<Handle>> = Mutex::new(None);

fn lock_handle() -> Result<MutexGuard<'static, Option<Handle>>> {
    HANDLE
        .lock()
        .map_err(|_| Error::from_reason("cch-tui handle poisoned"))
}

fn shutdown_handle(handle: Handle) -> Result<()> {
    request_shutdown();
    let joined = handle.thread.join();
    reset_shutdown();
    match joined {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(Error::from_reason(format!("cch-tui loop failed: {error}"))),
        Err(_) => Err(Error::from_reason("cch-tui thread panicked")),
    }
}

/// Start the interactive TUI on a dedicated thread.
///
/// `options_json` is `{"fullscreen": bool, "theme": "dark"|"light"|null,
/// "vim": bool}`; every field is optional.
#[napi]
pub fn start(options_json: String) -> Result<()> {
    let options: StartOptions = serde_json::from_str(&options_json)
        .map_err(|error| Error::from_reason(format!("invalid cch-tui options: {error}")))?;
    let mut guard = lock_handle()?;
    if let Some(previous) = guard.take() {
        shutdown_handle(previous)?;
    }
    reset_shutdown();
    // File config supplies defaults; explicit start options win.
    let config = cch_tui_config::load(None, &|key| std::env::var(key).ok());
    for warning in &config.warnings {
        eprintln!("[cch-tui] {warning}");
    }
    let config_theme = config.theme.as_str().to_string();
    let vim = options.vim.unwrap_or(config.vim);
    set_vim_default(vim);

    let (inbox, events) = mpsc::channel();
    let (commands, outbox) = mpsc::channel();
    let run_options = RunOptions {
        inbox: events,
        outbox: commands,
        fullscreen: options.fullscreen.unwrap_or(config.fullscreen),
        theme: Some(options.theme.unwrap_or(config_theme)),
    };
    let thread = thread::Builder::new()
        .name("cch-tui".into())
        .spawn(move || run_interactive(run_options))
        .map_err(|error| Error::from_reason(format!("failed to spawn cch-tui thread: {error}")))?;
    *guard = Some(Handle {
        inbox,
        outbox,
        thread,
    });
    Ok(())
}

/// Push one engine NDJSON frame (the `parse_line` wire format) into the TUI.
#[napi]
pub fn send(event_json: String) -> Result<()> {
    let event = parse_line(&event_json)
        .map_err(|error| Error::from_reason(format!("invalid engine event: {error}")))?;
    let guard = lock_handle()?;
    let handle = guard
        .as_ref()
        .ok_or_else(|| Error::from_reason("cch-tui is not started"))?;
    handle
        .inbox
        .send(event)
        .map_err(|_| Error::from_reason("cch-tui thread has stopped"))
}

/// Take one queued [`TuiCommand`] as JSON, or `None` when the queue is empty.
///
/// The host is expected to call this every ~20 ms.
#[napi]
pub fn poll() -> Option<String> {
    let guard = HANDLE.lock().ok()?;
    let handle = guard.as_ref()?;
    handle
        .outbox
        .try_recv()
        .ok()
        .map(|command| command.to_json())
}

/// Ask the TUI to quit and wait for the runner thread to restore the terminal.
#[napi]
pub fn stop() -> Result<()> {
    let mut guard = lock_handle()?;
    let Some(handle) = guard.take() else {
        return Ok(());
    };
    shutdown_handle(handle)
}

/// Whether stdin is a terminal (the TUI is attachable).
#[napi]
pub fn is_supported() -> bool {
    std::io::stdin().is_terminal()
}
