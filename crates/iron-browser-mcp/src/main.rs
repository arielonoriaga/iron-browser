use std::{env, path::PathBuf};

use anyhow::{Context, Result, bail};
use iron_browser_mcp::{
    mcp::{DEFAULT_MAX_BYTES, HARD_MAX_BYTES_CAP, MIN_MAX_BYTES, serve_stdio},
    socket::{SocketClient, default_socket_path},
};

struct CliArgs {
    socket: PathBuf,
    max_bytes: usize,
}

fn parse_args() -> Result<Option<CliArgs>> {
    let mut socket = default_socket_path();
    let mut max_bytes = DEFAULT_MAX_BYTES;
    let mut args = env::args().skip(1);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                println!(
                    "iron-browser-mcp {}\n\
                     Native stdio MCP sidecar for IronBrowser (0600 Unix control socket)\n\n\
                     USAGE:\n  iron-browser-mcp [--socket PATH] [--max-bytes N]\n\n\
                     OPTIONS:\n  --socket PATH     Path to IronBrowser ctl.sock (default: $XDG_RUNTIME_DIR/iron-browser/ctl.sock)\n  \
                     --max-bytes N     Hard UTF-8 byte ceiling for text/eval payloads ({MIN_MAX_BYTES}..={HARD_MAX_BYTES_CAP}, default: {DEFAULT_MAX_BYTES})\n  \
                     -V, --version     Print version",
                    env!("CARGO_PKG_VERSION")
                );
                return Ok(None);
            }
            "-V" | "--version" => {
                println!("iron-browser-mcp {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            "--socket" => {
                let val = args.next().context("--socket requires a path")?;
                socket = PathBuf::from(val);
            }
            "--max-bytes" => {
                let raw = args.next().context("--max-bytes requires an integer")?;
                let parsed: usize = raw
                    .parse()
                    .with_context(|| format!("invalid --max-bytes value: {raw}"))?;
                if !(MIN_MAX_BYTES..=HARD_MAX_BYTES_CAP).contains(&parsed) {
                    bail!(
                        "--max-bytes must be between {MIN_MAX_BYTES} and {HARD_MAX_BYTES_CAP} (got {parsed})"
                    );
                }
                max_bytes = parsed;
            }
            other => {
                bail!("unknown argument: {other} (try --help)");
            }
        }
    }

    Ok(Some(CliArgs { socket, max_bytes }))
}

fn main() -> Result<()> {
    let Some(cfg) = parse_args()? else {
        return Ok(());
    };
    let client = SocketClient::new(cfg.socket);
    serve_stdio(&client, cfg.max_bytes)
}
