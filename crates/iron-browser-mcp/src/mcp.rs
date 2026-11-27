use std::io::{self, BufRead, Read, Write};

use anyhow::Result;
use serde_json::{Value, json};

use crate::{
    frame::truncate_utf8,
    socket::{DEFAULT_SOCKET_IO_TIMEOUT, LONG_SOCKET_IO_TIMEOUT, SocketClient},
};

const MAX_REQUEST: usize = 512 * 1024;
const VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
pub const DEFAULT_MAX_BYTES: usize = 32 * 1024;
pub const MIN_MAX_BYTES: usize = 256;
pub const HARD_MAX_BYTES_CAP: usize = 256 * 1024;

fn error_response(id: Value, code: i64, message: &str) -> Value {
    let (msg, _) = truncate_utf8(message, 1024);
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": msg}})
}

fn encode_line(value: &Value) -> Result<String> {
    let mut s = serde_json::to_string(value)?;
    s.push('\n');
    Ok(s)
}

/// Ensures the ENTIRE returned UTF-8 text payload (including truncation envelope JSON overhead
/// and any JSON escaping of quotes/backslashes/control chars) never exceeds `max_bytes`.
pub fn bound_text_envelope(serialized: &str, max_bytes: usize) -> String {
    if serialized.len() <= max_bytes {
        return serialized.to_string();
    }

    let original_bytes = serialized.len();
    let empty_envelope = json!({
        "truncated": true,
        "maxBytes": max_bytes,
        "originalBytes": original_bytes,
        "preview": ""
    });
    let empty_encoded = serde_json::to_string(&empty_envelope).unwrap_or_default();
    if empty_encoded.len() > max_bytes {
        // Fallback if max_bytes is smaller than the envelope metadata itself.
        let (prefix, _) = truncate_utf8(serialized, max_bytes);
        return prefix.to_string();
    }

    // Binary search largest UTF-8 prefix whose full serialized envelope fits within `max_bytes`.
    let mut low = 0usize;
    let mut high = max_bytes.saturating_sub(empty_encoded.len()).min(serialized.len());
    let mut best = empty_encoded;

    while low <= high {
        let mid = low + (high - low) / 2;
        let (candidate_preview, _) = truncate_utf8(serialized, mid);
        let candidate_env = json!({
            "truncated": true,
            "maxBytes": max_bytes,
            "originalBytes": original_bytes,
            "preview": candidate_preview
        });
        let encoded = serde_json::to_string(&candidate_env).unwrap_or_default();
        if encoded.len() <= max_bytes {
            best = encoded;
            if mid == usize::MAX {
                break;
            }
            low = mid + 1;
        } else if mid == 0 {
            break;
        } else {
            high = mid - 1;
        }
    }

    best
}

pub fn definitions(hard_max_bytes: usize) -> Value {
    let tab_id = json!({"type": "string", "minLength": 1, "maxLength": 64});
    let viewport = json!({"type": "string", "enum": ["portrait", "landscape"]});
    let viewport_or_both = json!({"type": "string", "enum": ["portrait", "landscape", "both"], "default": "both"});
    let limit = json!({"type": "integer", "minimum": 1, "maximum": 200, "default": 50});
    let max_bytes = json!({
        "type": "integer",
        "minimum": MIN_MAX_BYTES,
        "maximum": hard_max_bytes,
        "default": hard_max_bytes.min(16384)
    });
    let dims = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["width", "height"],
        "properties": {
            "width": {"type": "integer", "minimum": 200, "maximum": 3840},
            "height": {"type": "integer", "minimum": 200, "maximum": 3840},
            "dpr": {"type": "number", "minimum": 1, "maximum": 4}
        }
    });
    let clip_rect = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["x", "y", "width", "height"],
        "properties": {
            "x": {"type": "number", "minimum": 0, "maximum": 10000},
            "y": {"type": "number", "minimum": 0, "maximum": 10000},
            "width": {"type": "number", "minimum": 1, "maximum": 3840},
            "height": {"type": "number", "minimum": 1, "maximum": 3840}
        }
    });
    let emulate_network_custom = json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "offline": {"type": "boolean"},
            "latency": {"type": "number", "minimum": 0, "maximum": 60000},
            "latency_ms": {"type": "number", "minimum": 0, "maximum": 60000},
            "down": {"type": "number", "minimum": -1},
            "down_kbps": {"type": "number", "minimum": -1},
            "download_kbps": {"type": "number", "minimum": -1},
            "download_bytes_per_sec": {"type": "number", "minimum": -1},
            "up": {"type": "number", "minimum": -1},
            "up_kbps": {"type": "number", "minimum": -1},
            "upload_kbps": {"type": "number", "minimum": -1},
            "upload_bytes_per_sec": {"type": "number", "minimum": -1}
        }
    });
    let emulate_tool = json!({
        "name": "browser_emulate",
        "description": "Apply or reset per-viewport slow-device CDP emulation (profiles: sunmi-v2-pro, low-end-android, none; or custom cpu_rate 1..20, network preset/custom latency/down/up, device preset, user_agent, hardware_concurrency, device_memory, reduced_motion, save_data, and optional host-to-target CPU rate calibration) surviving tab reloads and navigations.",
        "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "tab": tab_id,
                "tab_id": tab_id,
                "viewport": viewport_or_both,
                "profile": {"type": "string", "enum": ["none", "sunmi-v2-pro", "low-end-android"]},
                "cpu_rate": {"type": "number", "minimum": 1, "maximum": 20},
                "network": {
                    "oneOf": [
                        {"type": "string", "enum": ["none", "fast-4g", "slow-4g", "3g", "offline"]},
                        emulate_network_custom
                    ]
                },
                "preset": {"type": "string", "maxLength": 64},
                "user_agent": {"type": ["string", "null"], "maxLength": 512},
                "hardware_concurrency": {"type": ["integer", "null"], "minimum": 0, "maximum": 128},
                "device_memory": {"type": ["number", "null"], "minimum": 0, "maximum": 64},
                "reduced_motion": {"type": "boolean"},
                "save_data": {"type": "boolean"},
                "target_score": {"type": "number", "minimum": 1},
                "calibrate": {"type": "boolean", "default": false},
                "reset": {"type": "boolean", "default": false}
            }
        }
    });
    let profile_tool = json!({
        "name": "browser_profile",
        "description": "Start or stop an off-thread V8 CDP CPU profile (Profiler.start / Profiler.stop) on portrait or landscape (compatible with active slow-device CPU throttling and page navigations), writing a size-capped 0600 .cpuprofile file to disk and returning a bottom-up hotspot summary (selfMs + totalMs per function + script URL:line), top-30 inclusive call-tree frames with their caller parentChain, and selfMs per script URL.",
        "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false},
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["action"],
            "properties": {
                "tab": tab_id,
                "tab_id": tab_id,
                "viewport": viewport,
                "action": {"type": "string", "enum": ["start", "stop"]},
                "top": {"type": "integer", "minimum": 1, "maximum": 200, "default": 30},
                "interval_us": {"type": "integer", "minimum": 200, "maximum": 10000, "default": 1000}
            }
        }
    });
    let heap_tool = json!({
        "name": "browser_heap",
        "description": "Capture and analyze V8 heap snapshots, allocation sampling profiles, and snapshot diffs off the Electron main thread (compatible with slow-device CPU throttling): snapshot streams HeapProfiler.takeHeapSnapshot to a 0600 .heapsnapshot file and computes total/used heap, top 30 constructors by retained & self bytes + count, detached DOM node count, and top retainers/dominator chains of the 5 largest objects; sampling_start/sampling_stop records allocating call stacks + .heapprofile; diff compares two snapshots for constructor count/byte leaks.",
        "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false},
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["action"],
            "properties": {
                "tab": tab_id,
                "tab_id": tab_id,
                "viewport": viewport,
                "action": {"type": "string", "enum": ["snapshot", "sampling_start", "sampling_stop", "diff"]},
                "top": {"type": "integer", "minimum": 1, "maximum": 200, "default": 30},
                "top_largest": {"type": "integer", "minimum": 1, "maximum": 20, "default": 5},
                "sampling_interval_bytes": {"type": "integer", "minimum": 512, "maximum": 1048576, "default": 32768},
                "before_path": {"type": "string", "minLength": 1, "maxLength": 4096},
                "after_path": {"type": "string", "minLength": 1, "maxLength": 4096}
            }
        }
    });
    let health_tool = json!({
        "name": "browser_health",
        "description": "Inspect IronBrowser process health and post-mortem diagnostics (works even if the browser crashed or ctl.sock is offline): socket reachability, main-thread watchdog stall count, pending RPCs, active CPU profiles, per-viewport renderer state (crashed/unresponsive/exitCode), latest Crashpad minidump path, and the last N structured lines of main.log.",
        "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "lines": {"type": "integer", "minimum": 1, "maximum": 500, "default": 50}
            }
        }
    });
    let webgl_tool = json!({
        "name": "browser_webgl",
        "description": "Inspect WebGL/WebGL2 draw calls, triangles/vertices, instanced draws, shader program switches, texture binds, FBO render passes, GPU resource counts, context-loss state, chronological single-frame draw-call execution order (capture_frame), and CSS/Canvas stacking-context & compositor layer rendering order across portrait, landscape, or both viewports.",
        "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "tab": tab_id,
                "tab_id": tab_id,
                "viewport": viewport_or_both,
                "action": {
                    "type": "string",
                    "enum": ["snapshot", "capture_frame", "rendering_order", "reset_counters"],
                    "default": "snapshot"
                },
                "max_calls": {"type": "integer", "minimum": 1, "maximum": 2048, "default": 256},
                "max_layers": {"type": "integer", "minimum": 8, "maximum": 200, "default": 64},
                "timeout_ms": {"type": "integer", "minimum": 100, "maximum": 3000, "default": 700}
            }
        }
    });

    let tools = vec![
        json!({
            "name": "browser_tabs",
            "description": "List open IronBrowser tabs, URLs, view modes (single/dual), mirror state, session partition mode, active tab ID, and effective viewport sizing report (requestedSize, effectiveCssSize, dpr, capturedPixels, sizeMismatch).",
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
            "inputSchema": {"type": "object", "additionalProperties": false, "properties": {}}
        }),
        json!({
            "name": "browser_open",
            "description": "Open a new IronBrowser tab in single or dual (Portrait + Landscape) mode with optional shared/isolated session partition and viewport dimensions, immediately reporting effective viewport sizing and sizeMismatch.",
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true},
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["url"],
                "properties": {
                    "url": {"type": "string", "minLength": 1, "maxLength": 4096},
                    "mode": {"type": "string", "enum": ["single", "dual"], "default": "dual"},
                    "session": {"type": "string", "enum": ["shared", "isolated"], "default": "shared"},
                    "portrait_preset": {"type": "string", "maxLength": 64},
                    "landscape_preset": {"type": "string", "maxLength": 64},
                    "portrait_size": dims,
                    "landscape_size": dims
                }
            }
        }),
        json!({
            "name": "browser_navigate",
            "description": "Navigate an IronBrowser tab to a URL, syncing both Portrait and Landscape viewports in dual mode.",
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true},
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["url"],
                "properties": {
                    "tab_id": tab_id,
                    "url": {"type": "string", "minLength": 1, "maxLength": 4096}
                }
            }
        }),
        json!({
            "name": "browser_screenshot",
            "description": "Capture PNG screenshot(s) of portrait, landscape, or both viewports with independent per-pane timeout recovery, effective viewport sizing report, layoutAudit (including clippedItems selectors/bounds/overflowPx), optional exact_size override, and optional highlight_clipped visual overlay.",
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "tab_id": tab_id,
                    "target": viewport_or_both,
                    "exact_size": {"type": "boolean", "default": false},
                    "highlight_clipped": {"type": "boolean", "default": false},
                    "clip": clip_rect,
                    "timeout_ms": {"type": "integer", "minimum": 150, "maximum": 8000}
                }
            }
        }),
        json!({
            "name": "browser_metrics",
            "description": "Return live structured telemetry: gpuProcessCpuPercent (host GPU-process CPU%, labeled separately from gpuExecutionTimeMs), Portrait/Landscape OS CPU% & RAM MB, rAF FPS & p95 frame ms, CDP JS heap & DOM nodes, console error count, failed network count, and active slow-device emulation state.",
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
            "inputSchema": {"type": "object", "additionalProperties": false, "properties": {}}
        }),
        json!({
            "name": "browser_interact",
            "description": "Dispatch a trusted Chromium interaction (click, type, scroll, key, hover) via CSS selector or normalized coordinates, optionally mirrored across both viewports.",
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true},
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["action"],
                "properties": {
                    "tab_id": tab_id,
                    "viewport": viewport,
                    "action": {"type": "string", "enum": ["click", "type", "scroll", "key", "hover"]},
                    "selector": {"type": "string", "maxLength": 512},
                    "text": {"type": "string", "maxLength": 8192},
                    "key": {"type": "string", "maxLength": 64},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "ratio_y": {"type": "number", "minimum": 0, "maximum": 1},
                    "mirror": {"type": "boolean"}
                }
            }
        }),
        json!({
            "name": "browser_console",
            "description": "Read recent bounded console logs/warnings/errors from portrait, landscape, or both viewports, with optional diagnostic incident grouping.",
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "tab_id": tab_id,
                    "viewport": viewport_or_both,
                    "level": {"type": "string", "enum": ["all", "log", "info", "warn", "error", "debug"], "default": "all"},
                    "limit": limit,
                    "include_incidents": {"type": "boolean", "default": false}
                }
            }
        }),
        json!({
            "name": "browser_network",
            "description": "Inspect recent HTTP/WebSocket requests filtered by status (all, failed, 4xx, 5xx) and optional URL substring (url_contains), including CDP initiator JS + async parent call stacks (url:line:col + functionName), TTFB/total durationMs (requestWillBeSent -> responseEnd), encoded/decoded byte sizes, and optional diagnostic incident grouping.",
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "tab_id": tab_id,
                    "viewport": viewport_or_both,
                    "filter": {"type": "string", "enum": ["all", "failed", "4xx", "5xx"], "default": "all"},
                    "url_contains": {"type": "string", "maxLength": 1024},
                    "limit": limit,
                    "include_incidents": {"type": "boolean", "default": false}
                }
            }
        }),
        json!({
            "name": "browser_eval",
            "description": "Evaluate a JS expression in portrait or landscape viewport with a hard UTF-8 serialized byte ceiling (max_bytes).",
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true},
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["expression"],
                "properties": {
                    "tab_id": tab_id,
                    "viewport": viewport,
                    "expression": {"type": "string", "minLength": 1, "maxLength": 16384},
                    "max_bytes": max_bytes
                }
            }
        }),
        json!({
            "name": "browser_incidents",
            "description": "Group matching cross-pane HTTP failures (method + sanitizedPath + status) and linked console errors across Portrait and Landscape while keeping single-pane JS exceptions distinct (observational, separate from R2 HTTP dedup).",
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "tab_id": tab_id,
                    "viewport": viewport_or_both,
                    "window_ms": {"type": "integer", "minimum": 100, "maximum": 120000, "default": 15000},
                    "limit": limit
                }
            }
        }),
        json!({
            "name": "browser_repro",
            "description": "Manage saved reproduction recipes (save, load, list, delete, open) and step both Portrait and Landscape panes in lockstep to an exact frame, seed, phase, and multiplier via the dev scene-driver hook.",
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true},
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["action"],
                "properties": {
                    "action": {"type": "string", "enum": ["save", "load", "list", "delete", "open", "step"]},
                    "name": {"type": "string", "minLength": 1, "maxLength": 64},
                    "tab_id": tab_id,
                    "url": {"type": "string", "minLength": 1, "maxLength": 4096},
                    "mode": {"type": "string", "enum": ["single", "dual"]},
                    "session": {"type": "string", "enum": ["shared", "isolated"]},
                    "seed": {"type": ["string", "number"]},
                    "phase": {"type": "string", "maxLength": 128},
                    "frame": {"type": "integer", "minimum": 0},
                    "delta_frames": {"type": "integer", "minimum": -3600, "maximum": 3600},
                    "multiplier": {"type": "number"},
                    "time_ms": {"type": "number", "minimum": 0},
                    "fps": {"type": "number", "minimum": 1, "maximum": 240},
                    "portrait_preset": {"type": "string", "maxLength": 64},
                    "landscape_preset": {"type": "string", "maxLength": 64},
                    "portrait_size": dims,
                    "landscape_size": dims,
                    "canvas_selector": {"type": "string", "maxLength": 256},
                    "clip_region": clip_rect
                }
            }
        }),
        json!({
            "name": "browser_filmstrip",
            "description": "Step across a frame range or saved reproduction recipe across both Portrait and Landscape panes, optionally cropping a canvas/clip region, and export a labelled PNG filmstrip stamped with frame, seed, multiplier, and phase metadata.",
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "tab_id": tab_id,
                    "recipe_name": {"type": "string", "minLength": 1, "maxLength": 64},
                    "seed": {"type": ["string", "number"]},
                    "phase": {"type": "string", "maxLength": 128},
                    "multiplier": {"type": "number"},
                    "fps": {"type": "number", "minimum": 1, "maximum": 240},
                    "frames": {"type": "array", "maxItems": 24, "items": {"type": "integer", "minimum": 0}},
                    "start_frame": {"type": "integer", "minimum": 0},
                    "end_frame": {"type": "integer", "minimum": 0},
                    "frame_step": {"type": "integer", "minimum": 1, "maximum": 3600},
                    "exact_size": {"type": "boolean", "default": true},
                    "canvas_only": {"type": "boolean", "default": false},
                    "canvas_selector": {"type": "string", "maxLength": 256},
                    "clip_region": clip_rect,
                    "max_tile_width": {"type": "integer", "minimum": 120, "maximum": 1920}
                }
            }
        }),
        json!({
            "name": "browser_trace_start",
            "description": "Start a short bounded rolling frame-time and User Timing (performance.mark / performance.measure) trace across Portrait and Landscape viewports, including active slow-device emulation metadata.",
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "tab_id": tab_id,
                    "max_duration_ms": {"type": "integer", "minimum": 100, "maximum": 30000, "default": 15000},
                    "max_frames": {"type": "integer", "minimum": 60, "maximum": 3600, "default": 1800}
                }
            }
        }),
        json!({
            "name": "browser_trace_stop",
            "description": "Stop an active performance trace and return side-by-side frame durations, before/during/after mark breakdowns, active slow-device emulation state, and gpuProcessCpuPercent labeled separately from gpuExecutionTimeMs.",
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false},
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "tab_id": tab_id
                }
            }
        }),
        json!({
            "name": "browser_events",
            "description": "Query the native Rust TabEventBus causal stream (gestures, HTTP/WS/SFS2X dedup, sessionStorage sync, popup & download dedup claims, navigation, console/network errors, mirror misses, and perf traces) filtered by tab, domain, viewport, since_seq, or causal gesture_seq.",
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "tab_id": tab_id,
                    "domain": {
                        "type": "string",
                        "enum": ["all", "gesture", "navigation", "http_dedup", "ws_mux", "storage", "download", "popup", "callback", "console", "network", "trace", "mirror", "lifecycle"],
                        "default": "all"
                    },
                    "viewport": viewport_or_both,
                    "since_seq": {"type": "integer", "minimum": 0},
                    "gesture_seq": {"type": "integer", "minimum": 1},
                    "limit": limit
                }
            }
        }),
        emulate_tool,
        profile_tool,
        heap_tool,
        health_tool,
        webgl_tool,
    ];
    json!({"tools": tools})
}

const TOOL_NAMES: [&str; 20] = [
    "browser_tabs",
    "browser_open",
    "browser_navigate",
    "browser_screenshot",
    "browser_metrics",
    "browser_interact",
    "browser_console",
    "browser_network",
    "browser_eval",
    "browser_incidents",
    "browser_repro",
    "browser_filmstrip",
    "browser_trace_start",
    "browser_trace_stop",
    "browser_events",
    "browser_emulate",
    "browser_profile",
    "browser_heap",
    "browser_health",
    "browser_webgl",
];

pub struct Session {
    initialized: bool,
    ready: bool,
    hard_max_bytes: usize,
}

impl Session {
    pub fn new(hard_max_bytes: usize) -> Self {
        Self {
            initialized: false,
            ready: false,
            hard_max_bytes: hard_max_bytes.clamp(MIN_MAX_BYTES, HARD_MAX_BYTES_CAP),
        }
    }

    fn format_tool_result(&self, name: &str, value: Value, max_bytes: usize) -> Value {
        if name == "browser_screenshot"
            && let Some(captures) = value.get("captures").and_then(Value::as_object)
        {
            let mut content = Vec::new();
            let mut summary = serde_json::Map::new();
            if let Some(tab_id) = value.get("tabId") {
                summary.insert("tabId".into(), tab_id.clone());
            }
            if let Some(url) = value.get("url") {
                summary.insert("url".into(), url.clone());
            }
            if let Some(mode) = value.get("mode") {
                summary.insert("mode".into(), mode.clone());
            }
            if let Some(partial) = value.get("partial") {
                summary.insert("partial".into(), partial.clone());
            }
            if let Some(errors) = value.get("errors") {
                summary.insert("errors".into(), errors.clone());
            }
            if let Some(vp_report) = value.get("viewportReport") {
                summary.insert("viewportReport".into(), vp_report.clone());
            }

            let mut audits = serde_json::Map::new();
            for (role, cap) in captures {
                if let Some(b64) = cap.get("pngBase64").and_then(Value::as_str) {
                    let mime = cap
                        .get("mimeType")
                        .and_then(Value::as_str)
                        .unwrap_or("image/png");
                    content.push(json!({
                        "type": "image",
                        "data": b64,
                        "mimeType": mime
                    }));
                }
                audits.insert(
                    role.clone(),
                    json!({
                        "width": cap.get("width").cloned().unwrap_or(Value::Null),
                        "height": cap.get("height").cloned().unwrap_or(Value::Null),
                        "bytes": cap.get("bytes").cloned().unwrap_or(Value::Null),
                        "layoutAudit": cap.get("layoutAudit").cloned().unwrap_or(Value::Null),
                        "viewportReport": cap.get("viewportReport").cloned().unwrap_or(Value::Null)
                    }),
                );
            }
            summary.insert("viewports".into(), Value::Object(audits));
            let text = serde_json::to_string(&Value::Object(summary)).unwrap_or_default();
            let bounded = bound_text_envelope(&text, max_bytes);
            content.push(json!({"type": "text", "text": bounded}));
            return json!({"content": content, "isError": captures.is_empty()});
        }

        if name == "browser_filmstrip"
            && let Some(b64) = value.get("filmstripPngBase64").and_then(Value::as_str)
        {
            let mime = value
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("image/png");
            let mut meta = value.clone();
            if let Some(obj) = meta.as_object_mut() {
                obj.remove("filmstripPngBase64");
            }
            let text = serde_json::to_string(&meta).unwrap_or_default();
            let bounded = bound_text_envelope(&text, max_bytes);
            return json!({
                "content": [
                    {"type": "image", "data": b64, "mimeType": mime},
                    {"type": "text", "text": bounded}
                ],
                "isError": false
            });
        }

        let serialized = serde_json::to_string(&value).unwrap_or_else(|_| "null".to_string());
        let text = bound_text_envelope(&serialized, max_bytes);
        json!({"content": [{"type": "text", "text": text}], "isError": false})
    }

    fn call_tool(
        &self,
        client: &SocketClient,
        params: &Value,
    ) -> std::result::Result<Value, (i64, String)> {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .ok_or((-32602, "tool name is required".to_string()))?;

        if !TOOL_NAMES.contains(&name) {
            return Err((-32602, format!("unknown tool: {name}")));
        }

        let mut arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if !arguments.is_object() {
            return Err((-32602, "arguments must be an object".to_string()));
        }

        // Enforce hard UTF-8 byte cap for browser_eval and all text tool outputs.
        let requested_cap = arguments
            .get("max_bytes")
            .and_then(Value::as_u64)
            .map(|v| v as usize);
        let effective_cap = requested_cap
            .unwrap_or(self.hard_max_bytes)
            .clamp(MIN_MAX_BYTES, self.hard_max_bytes);

        if name == "browser_eval"
            && let Some(obj) = arguments.as_object_mut()
        {
            if obj
                .get("expression")
                .and_then(Value::as_str)
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                return Err((-32602, "expression is required".to_string()));
            }
            obj.insert("max_bytes".into(), json!(effective_cap));
        }

        if name == "browser_health" {
            let lines = arguments
                .get("lines")
                .and_then(Value::as_u64)
                .map(|v| v as usize)
                .unwrap_or(50)
                .clamp(1, 500);
            let health = client.query_health(lines);
            return Ok(self.format_tool_result(name, health, effective_cap));
        }

        let timeout = if name == "browser_profile"
            || name == "browser_filmstrip"
            || (name == "browser_emulate" && arguments.get("calibrate") == Some(&json!(true)))
        {
            LONG_SOCKET_IO_TIMEOUT
        } else {
            DEFAULT_SOCKET_IO_TIMEOUT
        };

        match client.call_with_timeout(name, arguments, timeout) {
            Ok(value) => Ok(self.format_tool_result(name, value, effective_cap)),
            Err(err) => {
                let msg = format!("{err:#}");
                let (bounded, _) = truncate_utf8(&msg, 1024);
                Ok(json!({
                    "content": [{"type": "text", "text": bounded}],
                    "isError": true
                }))
            }
        }
    }

    pub fn respond(&mut self, client: &SocketClient, request: Value) -> Option<Value> {
        let id = request.get("id").cloned();
        if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
            || !request.is_object()
            || id
                .as_ref()
                .is_some_and(|value| !value.is_string() && !value.is_number())
        {
            return Some(error_response(
                Value::Null,
                -32600,
                "invalid JSON-RPC request",
            ));
        }
        let Some(method) = request.get("method").and_then(Value::as_str) else {
            return Some(error_response(
                id.unwrap_or(Value::Null),
                -32600,
                "method is required",
            ));
        };
        if id.is_none() {
            if method == "notifications/initialized" && self.initialized {
                self.ready = true;
            }
            return None;
        }
        let id = id.unwrap();
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));

        let result = match method {
            "initialize" => {
                if self.initialized {
                    return Some(error_response(id, -32600, "already initialized"));
                }
                let Some(version) = params.get("protocolVersion").and_then(Value::as_str) else {
                    return Some(error_response(id, -32602, "protocolVersion is required"));
                };
                if !params.get("capabilities").is_some_and(Value::is_object)
                    || !params.get("clientInfo").is_some_and(Value::is_object)
                {
                    return Some(error_response(
                        id,
                        -32602,
                        "clientInfo and capabilities are required",
                    ));
                }
                let negotiated = if VERSIONS.contains(&version) {
                    version
                } else {
                    VERSIONS[0]
                };
                self.initialized = true;
                json!({
                    "protocolVersion": negotiated,
                    "capabilities": {"tools": {}},
                    "serverInfo": {
                        "name": "iron-browser-mcp",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                })
            }
            "ping" => json!({}),
            _ if !self.ready => {
                return Some(error_response(
                    id,
                    -32002,
                    "initialize and send notifications/initialized first",
                ));
            }
            "tools/list" => {
                if params.get("cursor").is_some() {
                    return Some(error_response(
                        id,
                        -32602,
                        "no pagination cursor is supported",
                    ));
                }
                definitions(self.hard_max_bytes)
            }
            "tools/call" => match self.call_tool(client, &params) {
                Ok(result) => result,
                Err((code, message)) => return Some(error_response(id, code, &message)),
            },
            _ => return Some(error_response(id, -32601, "method not found")),
        };

        Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
    }
}

pub fn serve_io<R: BufRead, W: Write>(
    client: &SocketClient,
    hard_max_bytes: usize,
    mut input: R,
    mut output: W,
) -> Result<()> {
    let mut session = Session::new(hard_max_bytes);
    loop {
        let mut bytes = Vec::new();
        let length = input
            .by_ref()
            .take(MAX_REQUEST as u64 + 1)
            .read_until(b'\n', &mut bytes)?;
        if length == 0 {
            break;
        }
        if length > MAX_REQUEST {
            let err = error_response(Value::Null, -32600, "request exceeds 524288 bytes");
            output.write_all(encode_line(&err)?.as_bytes())?;
            output.flush()?;
            break;
        }
        let response = match serde_json::from_slice::<Value>(&bytes) {
            Ok(request) => session.respond(client, request),
            Err(_) => Some(error_response(Value::Null, -32700, "invalid JSON")),
        };
        if let Some(response) = response {
            output.write_all(encode_line(&response)?.as_bytes())?;
            output.flush()?;
        }
    }
    Ok(())
}

pub fn serve_stdio(client: &SocketClient, hard_max_bytes: usize) -> Result<()> {
    let input = io::stdin().lock();
    let output = io::stdout().lock();
    serve_io(client, hard_max_bytes, input, output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_tools_declare_four_boolean_annotations() {
        let defs = definitions(DEFAULT_MAX_BYTES);
        let tools = defs["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 20);
        assert_eq!(tools.len(), TOOL_NAMES.len());
        for tool in tools {
            let ann = tool["annotations"].as_object().expect("annotations object");
            for key in [
                "readOnlyHint",
                "destructiveHint",
                "idempotentHint",
                "openWorldHint",
            ] {
                assert!(
                    ann.get(key).and_then(Value::as_bool).is_some(),
                    "tool {} missing boolean annotation {}",
                    tool["name"],
                    key
                );
            }
        }
    }

    #[test]
    fn screenshot_formatting_handles_partial_success_vs_zero_capture_failure() {
        let session = Session::new(DEFAULT_MAX_BYTES);

        let partial_ok = session.format_tool_result(
            "browser_screenshot",
            json!({
                "tabId": "tab-1",
                "partial": true,
                "captures": {
                    "landscape": {
                        "mimeType": "image/png",
                        "width": 1280,
                        "height": 720,
                        "bytes": 4,
                        "pngBase64": "iVBORw==",
                        "layoutAudit": {"clippedElements": 0}
                    }
                },
                "errors": [{"stage": "layout_audit", "viewport": "portrait", "error": "dom query timeout"}]
            }),
            4096,
        );
        assert_eq!(partial_ok["isError"], false);
        assert_eq!(partial_ok["content"].as_array().unwrap().len(), 2);

        let zero_captures = session.format_tool_result(
            "browser_screenshot",
            json!({
                "tabId": "tab-1",
                "partial": false,
                "captures": {},
                "errors": [{"stage": "capture_page", "viewport": "portrait", "error": "stalled"}]
            }),
            4096,
        );
        assert_eq!(zero_captures["isError"], true);
    }
}
