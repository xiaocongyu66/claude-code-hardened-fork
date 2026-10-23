use std::io::stdin;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use cch_tui_bin::Source;
use cch_tui_proto::PROTOCOL_VERSION;

const EX_USAGE: u8 = 64;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--protocol-version") => {
            println!("{PROTOCOL_VERSION}");
            ExitCode::SUCCESS
        }
        Some("--check-tui") => {
            let report = cch_tui_bin::check_stream(stdin());
            println!("{}", report.summary());
            if report.errors == 0 {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Some("--replay") => run_replay(&args),
        Some("--engine") => run_engine(&args),
        Some("--help") | Some("-h") => {
            print_help();
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("cch-tui: unknown argument `{other}`");
            ExitCode::from(EX_USAGE)
        }
        None => {
            print_help();
            ExitCode::from(EX_USAGE)
        }
    }
}

fn print_help() {
    println!(
        "cch-tui {PROTOCOL_VERSION}\n\n\
         --protocol-version        print the wire protocol version\n\
         --check-tui               parse NDJSON frames from stdin (CI smoke)\n\
         --replay <file> [opts]    replay a fixture in the interactive TUI\n\
             --delay-ms <n>        pacing between frames (default 80)\n\
             --fullscreen          use the alternate screen\n\
         --engine <program> [args...]  spawn the TS engine and drive it\n\
             (add --fullscreen before or after the program name)"
    );
}

fn run_replay(args: &[String]) -> ExitCode {
    let Some(path) = args.get(1) else {
        eprintln!("cch-tui: --replay requires a file path");
        return ExitCode::from(EX_USAGE);
    };
    let mut delay_ms = 80u64;
    let mut fullscreen = false;
    let mut index = 2;
    while index < args.len() {
        match args[index].as_str() {
            "--delay-ms" => {
                index += 1;
                match args.get(index).and_then(|v| v.parse().ok()) {
                    Some(value) => delay_ms = value,
                    None => {
                        eprintln!("cch-tui: --delay-ms requires a number");
                        return ExitCode::from(EX_USAGE);
                    }
                }
            }
            "--fullscreen" => fullscreen = true,
            other => {
                eprintln!("cch-tui: unknown replay option `{other}`");
                return ExitCode::from(EX_USAGE);
            }
        }
        index += 1;
    }

    let source = Source::Replay {
        path: PathBuf::from(path),
        frame_delay: Duration::from_millis(delay_ms),
    };
    match cch_tui_bin::run(source, fullscreen) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("cch-tui: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run_engine(args: &[String]) -> ExitCode {
    let Some(program) = args.get(1) else {
        eprintln!("cch-tui: --engine requires a program");
        return ExitCode::from(EX_USAGE);
    };
    let mut engine_args = Vec::new();
    let mut fullscreen = false;
    for arg in &args[2..] {
        if arg == "--fullscreen" {
            fullscreen = true;
        } else {
            engine_args.push(arg.clone());
        }
    }

    let source = Source::Engine {
        program: program.clone(),
        args: engine_args,
    };
    match cch_tui_bin::run(source, fullscreen) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("cch-tui: {error}");
            ExitCode::FAILURE
        }
    }
}
