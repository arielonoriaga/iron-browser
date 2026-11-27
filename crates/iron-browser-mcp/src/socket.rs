use std::{
    env,
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::frame::{read_frame_sync, write_frame_sync};

const SOCKET_IO_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CtlRpcRequest {
    pub id: u64,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CtlRpcError {
    pub code: i64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CtlRpcResponse {
    pub id: Value,
    pub ok: bool,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<CtlRpcError>,
}

/// Resolves the IronBrowser control socket path with exact parity to `app/src/main/ctl-socket.ts`:
/// 1. `IRON_BROWSER_SOCKET` override (if non-empty)
/// 2. `$XDG_RUNTIME_DIR/iron-browser/ctl.sock` (if non-empty)
/// 3. `<temp_dir>/iron-browser-<euid>/ctl.sock`
pub fn default_socket_path() -> PathBuf {
    if let Ok(explicit) = env::var("IRON_BROWSER_SOCKET")
        && !explicit.trim().is_empty()
    {
        return PathBuf::from(explicit.trim());
    }
    if let Ok(runtime_dir) = env::var("XDG_RUNTIME_DIR")
        && !runtime_dir.trim().is_empty()
    {
        return PathBuf::from(runtime_dir)
            .join("iron-browser")
            .join("ctl.sock");
    }
    let uid = unsafe { libc::geteuid() };
    env::temp_dir()
        .join(format!("iron-browser-{uid}"))
        .join("ctl.sock")
}

pub struct SocketClient {
    socket_path: PathBuf,
    next_id: AtomicU64,
}

impl SocketClient {
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            socket_path,
            next_id: AtomicU64::new(1),
        }
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value> {
        let deadline = Instant::now() + SOCKET_IO_TIMEOUT;
        let mut stream = UnixStream::connect(&self.socket_path).with_context(|| {
            format!(
                "cannot connect to IronBrowser control socket at {} (is IronBrowser running?)",
                self.socket_path.display()
            )
        })?;

        let write_rem = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .context("IronBrowser RPC timed out before write")?;
        stream
            .set_write_timeout(Some(write_rem))
            .context("set socket write timeout")?;

        let req_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = CtlRpcRequest {
            id: req_id,
            method: method.to_string(),
            params,
        };
        write_frame_sync(&mut stream, &req)?;

        let read_rem = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .context("IronBrowser RPC timed out before read")?;
        stream
            .set_read_timeout(Some(read_rem))
            .context("set socket read timeout")?;

        let resp: CtlRpcResponse = read_frame_sync(&mut stream)?;
        if resp.id != json!(req_id) {
            bail!(
                "IronBrowser RPC response id mismatch: expected {}, got {}",
                req_id,
                resp.id
            );
        }

        if resp.ok {
            Ok(resp.result.unwrap_or(Value::Null))
        } else {
            let err = resp.error.unwrap_or(CtlRpcError {
                code: -32000,
                message: "unknown IronBrowser RPC error".to_string(),
            });
            bail!("IronBrowser RPC error ({}): {}", err.code, err.message);
        }
    }
}
