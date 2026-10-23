use std::io::stdin;
use std::process::ExitCode;

use cch_tui_proto::PROTOCOL_VERSION;

const EX_USAGE: u8 = 64;
const EX_UNAVAILABLE: u8 = 69;

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
        Some("--help") | Some("-h") => {
            println!(
                "cch-tui {PROTOCOL_VERSION}\n\n\
                 --protocol-version  print the wire protocol version\n\
                 --check-tui         parse NDJSON frames from stdin (CI smoke)\n\n\
                 The interactive TUI lands in M1."
            );
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("cch-tui: unknown argument `{other}`");
            ExitCode::from(EX_USAGE)
        }
        None => {
            eprintln!("cch-tui: interactive TUI not implemented yet (M0); use --check-tui");
            ExitCode::from(EX_UNAVAILABLE)
        }
    }
}
