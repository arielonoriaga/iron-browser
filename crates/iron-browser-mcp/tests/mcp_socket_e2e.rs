use std::{
    io::Cursor,
    os::unix::net::UnixListener,
    thread,
    time::Duration,
};

use iron_browser_mcp::{
    frame::{read_frame_sync, write_frame_sync},
    mcp::serve_io,
    socket::{CtlRpcRequest, CtlRpcResponse, SocketClient},
};
use serde_json::{Value, json};
use tempfile::tempdir;

fn spawn_mock_browser_socket(
    expected_requests: usize,
) -> (tempfile::TempDir, std::path::PathBuf, thread::JoinHandle<Vec<CtlRpcRequest>>) {
    let dir = tempdir().expect("tempdir");
    let sock_path = dir.path().join("ctl.sock");
    let listener = UnixListener::bind(&sock_path).expect("bind unix socket");
    listener
        .set_nonblocking(false)
        .expect("blocking listener");

    let handle = thread::spawn(move || {
        let mut received = Vec::new();
        for _ in 0..expected_requests {
            let (mut stream, _) = listener.accept().expect("accept client");
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("read timeout");
            let req: CtlRpcRequest = read_frame_sync(&mut stream).expect("read rpc request");
            let result = match req.method.as_str() {
                "browser_tabs" => json!({
                    "activeTabId": "tab-1",
                    "tabs": [{"id": "tab-1", "url": "https://example.com", "mode": "dual", "mirror": true}]
                }),
                "browser_open" => json!({
                    "activeTabId": "tab-2",
                    "tab": {"id": "tab-2", "url": req.params["url"], "mode": req.params["mode"]}
                }),
                "browser_navigate" => json!({
                    "activeTabId": "tab-1",
                    "tab": {"id": "tab-1", "url": req.params["url"]}
                }),
                "browser_screenshot" => json!({
                    "tabId": "tab-1",
                    "url": "https://example.com",
                    "mode": "dual",
                    "captures": {
                        "portrait": {
                            "mimeType": "image/png",
                            "width": 390,
                            "height": 844,
                            "bytes": 4,
                            "pngBase64": "iVBORw==",
                            "layoutAudit": {"horizontalOverflow": false, "clippedElements": 0, "viewportWidth": 390, "viewportHeight": 844}
                        },
                        "landscape": {
                            "mimeType": "image/png",
                            "width": 1280,
                            "height": 720,
                            "bytes": 4,
                            "pngBase64": "iVBORw==",
                            "layoutAudit": {"horizontalOverflow": false, "clippedElements": 0, "viewportWidth": 1280, "viewportHeight": 720}
                        }
                    }
                }),
                "browser_metrics" => json!({
                    "gpuCpuPercent": 11.2,
                    "gpuMemoryMb": 142.0,
                    "totalMemoryMb": 390.5,
                    "portrait": {"fps": 60.0, "p95FrameMs": 16.4, "cpuPercent": 5.2, "memoryMb": 88.0, "jsHeapUsedMb": 24.5, "domNodes": 420},
                    "landscape": {"fps": 60.0, "p95FrameMs": 16.3, "cpuPercent": 6.1, "memoryMb": 96.0, "jsHeapUsedMb": 28.0, "domNodes": 420},
                    "consoleErrorCount": 0,
                    "failedNetworkCount": 0
                }),
                "browser_interact" => json!({
                    "tabId": "tab-1",
                    "action": req.params["action"],
                    "mirrored": true,
                    "outcomes": {
                        "portrait": {"ok": true, "tier": 2, "x": 120, "y": 400},
                        "landscape": {"ok": true, "tier": 2, "x": 980, "y": 48}
                    }
                }),
                "browser_console" => json!({
                    "tabId": "tab-1",
                    "count": 1,
                    "entries": [{"id": 1, "viewport": "portrait", "level": "error", "text": "Boom"}]
                }),
                "browser_network" => json!({
                    "tabId": "tab-1",
                    "count": 1,
                    "entries": [{"id": "1:1", "viewport": "landscape", "method": "GET", "url": "https://api.example.com/x", "status": 500, "failed": true}]
                }),
                "browser_eval" => {
                    // Return oversized multibyte + JSON-escaped payload to test hard UTF-8 byte ceiling.
                    let repeated = "\"🚀\\n".repeat(300);
                    json!({
                        "tabId": "tab-1",
                        "viewport": "portrait",
                        "value": repeated,
                        "requestedMaxBytes": req.params["max_bytes"]
                    })
                }
                "browser_incidents" => json!({
                    "tabId": "tab-1",
                    "count": 1,
                    "incidents": [{
                        "id": "inc-net-1",
                        "kind": "network-failure",
                        "method": "GET",
                        "sanitizedPath": "/api/room/history",
                        "status": 401,
                        "affectedViewports": ["portrait", "landscape"]
                    }]
                }),
                "browser_repro" => json!({
                    "ok": true,
                    "action": req.params["action"],
                    "pairedMatch": true
                }),
                "browser_filmstrip" => json!({
                    "tabId": "tab-1",
                    "mimeType": "image/png",
                    "width": 640,
                    "height": 360,
                    "bytes": 4,
                    "filmstripPngBase64": "iVBORw==",
                    "steps": [{"frame": 100, "seed": "forest-1", "multiplier": 1.94}]
                }),
                "browser_trace_start" => json!({
                    "ok": true,
                    "traceId": "trace-tab-1",
                    "tabId": "tab-1"
                }),
                "browser_trace_stop" => json!({
                    "ok": true,
                    "traceId": "trace-tab-1",
                    "tabId": "tab-1",
                    "gpu": {
                        "gpuProcessCpuPercent": 4.2,
                        "gpuExecutionTimeMs": null
                    },
                    "viewports": {
                        "portrait": {"summary": {"fps": 60.0}},
                        "landscape": {"summary": {"fps": 60.0}}
                    }
                }),
                "browser_events" => json!({
                    "tabId": "tab-1",
                    "backend": "rust-napi",
                    "latestSeq": 4,
                    "totalPublished": 4,
                    "totalSuppressed": 1,
                    "count": 2,
                    "events": [
                        {"seq": 1, "tsMs": 1000, "tabId": "tab-1", "viewport": "portrait", "domain": "gesture", "kind": "click", "summary": "gesture:click on portrait", "gestureSeq": 1},
                        {"seq": 4, "tsMs": 1020, "tabId": "tab-1", "viewport": "landscape", "domain": "download", "kind": "dedup_suppressed", "summary": "suppressed duplicate download -> owner #3", "gestureSeq": 1}
                    ]
                }),
                "browser_emulate" => json!({
                    "ok": true,
                    "tabId": req.params.get("tab").or_else(|| req.params.get("tab_id")).cloned().unwrap_or_else(|| json!("tab-1")),
                    "emulation": {
                        "active": req.params.get("reset") != Some(&json!(true)) && req.params.get("profile") != Some(&json!("none")),
                        "profile": req.params.get("profile").cloned().unwrap_or_else(|| json!("custom")),
                        "label": "Sunmi V2 Pro · 6× CPU · slow-4g",
                        "portrait": {
                            "cpuRate": req.params.get("cpu_rate").cloned().unwrap_or_else(|| json!(6)),
                            "deviceMemory": req.params.get("device_memory").cloned().unwrap_or_else(|| json!(2)),
                            "hardwareConcurrency": req.params.get("hardware_concurrency").cloned().unwrap_or_else(|| json!(4))
                        }
                    },
                    "calibration": if req.params.get("calibrate") == Some(&json!(true)) {
                        json!({"hostScore": 96000, "targetScore": 18000, "chosenRate": 5, "resultingScore": 19100})
                    } else {
                        Value::Null
                    }
                }),
                "browser_profile" => json!({
                    "ok": true,
                    "action": req.params["action"],
                    "tabId": req.params.get("tab").or_else(|| req.params.get("tab_id")).cloned().unwrap_or_else(|| json!("tab-1")),
                    "viewport": req.params.get("viewport").cloned().unwrap_or_else(|| json!("portrait")),
                    "profilePath": if req.params["action"] == json!("stop") {
                        json!("/tmp/profile-tab-1-portrait.cpuprofile")
                    } else {
                        Value::Null
                    },
                    "summary": if req.params["action"] == json!("stop") {
                        json!({
                            "activeMs": 142.5,
                            "functions": [{"functionName": "reconcileCart", "location": "https://app.test/pos.js:88", "selfMs": 95.2, "totalMs": 110.4}],
                            "scripts": [{"url": "https://app.test/pos.js", "selfMs": 120.0}]
                        })
                    } else {
                        Value::Null
                    }
                }),
                "browser_health" => json!({
                    "ok": true,
                    "socketReachable": true,
                    "pid": 12345,
                    "uptimeMs": 9000,
                    "watchdog": {"running": true, "stallCount": 0, "shuttingDown": false},
                    "pendingRpcs": [],
                    "activeProfiles": [],
                    "viewports": [{"tabId": "tab-1", "viewport": "portrait", "crashed": false, "unresponsive": false}],
                    "lastCrashDump": Value::Null,
                    "recentLogs": ["{\"event\":\"lifecycle.ready\"}"]
                }),
                other => {
                    let resp = CtlRpcResponse {
                        id: json!(req.id),
                        ok: false,
                        result: None,
                        error: Some(iron_browser_mcp::socket::CtlRpcError {
                            code: -32601,
                            message: format!("unexpected method {other}"),
                        }),
                    };
                    write_frame_sync(&mut stream, &resp).expect("write error");
                    received.push(req);
                    continue;
                }
            };
            let resp = CtlRpcResponse {
                id: json!(req.id),
                ok: true,
                result: Some(result),
                error: None,
            };
            write_frame_sync(&mut stream, &resp).expect("write rpc response");
            received.push(req);
        }
        received
    });

    (dir, sock_path, handle)
}

#[test]
fn mcp_end_to_end_exercises_all_eighteen_tools_over_framed_unix_socket() {
    let (_dir, sock_path, server) = spawn_mock_browser_socket(18);
    let client = SocketClient::new(sock_path);

    let requests = vec![
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_tabs","arguments":{}}}),
        json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"browser_open","arguments":{"url":"http://127.0.0.1:3000","mode":"dual","session":"isolated"}}}),
        json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"https://example.com"}}}),
        json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"browser_screenshot","arguments":{"target":"both","exact_size":true,"highlight_clipped":true}}}),
        json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"browser_metrics","arguments":{}}}),
        json!({"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"browser_interact","arguments":{"action":"click","selector":"[data-testid=\"play\"]","mirror":true}}}),
        json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"browser_console","arguments":{"viewport":"both","level":"error","include_incidents":true}}}),
        json!({"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"browser_network","arguments":{"filter":"5xx","include_incidents":true}}}),
        json!({"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"browser_eval","arguments":{"expression":"document.title","max_bytes":999999}}}),
        json!({"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"browser_incidents","arguments":{"viewport":"both"}}}),
        json!({"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"browser_repro","arguments":{"action":"step","frame":120,"seed":"s1","multiplier":1.94}}}),
        json!({"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"browser_filmstrip","arguments":{"frames":[110,120,130],"seed":"s1","multiplier":1.94}}}),
        json!({"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"browser_trace_start","arguments":{"max_duration_ms":2000}}}),
        json!({"jsonrpc":"2.0","id":16,"method":"tools/call","params":{"name":"browser_trace_stop","arguments":{}}}),
        json!({"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"browser_events","arguments":{"domain":"download","gesture_seq":1}}}),
        json!({"jsonrpc":"2.0","id":18,"method":"tools/call","params":{"name":"browser_emulate","arguments":{"tab":"tab-1","profile":"sunmi-v2-pro","calibrate":true}}}),
        json!({"jsonrpc":"2.0","id":19,"method":"tools/call","params":{"name":"browser_profile","arguments":{"tab":"tab-1","viewport":"portrait","action":"stop","top":10}}}),
        json!({"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"browser_health","arguments":{"lines":25}}}),
    ];

    let mut wire_in = String::new();
    for req in &requests {
        wire_in.push_str(&serde_json::to_string(req).unwrap());
        wire_in.push('\n');
    }

    let mut wire_out = Vec::new();
    // Hard CLI ceiling of 512 bytes must clamp browser_eval's requested 999999!
    serve_io(&client, 512, Cursor::new(wire_in.as_bytes()), &mut wire_out)
        .expect("serve_io succeeds");

    let received = server.join().expect("mock socket thread joined");
    assert_eq!(received.len(), 18);
    // Verify browser_eval received clamped max_bytes = 512
    assert_eq!(received[8].method, "browser_eval");
    assert_eq!(received[8].params["max_bytes"], json!(512));
    assert_eq!(received[3].params["exact_size"], json!(true));
    assert_eq!(received[3].params["highlight_clipped"], json!(true));
    assert_eq!(received[14].method, "browser_events");
    assert_eq!(received[14].params["domain"], json!("download"));
    assert_eq!(received[15].method, "browser_emulate");
    assert_eq!(received[15].params["profile"], json!("sunmi-v2-pro"));
    assert_eq!(received[15].params["calibrate"], json!(true));
    assert_eq!(received[16].method, "browser_profile");
    assert_eq!(received[16].params["action"], json!("stop"));
    assert_eq!(received[16].params["top"], json!(10));
    assert_eq!(received[17].method, "browser_health");
    assert_eq!(received[17].params["lines"], json!(25));

    let lines: Vec<Value> = String::from_utf8(wire_out)
        .expect("utf8 output")
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).expect("valid json line"))
        .collect();

    // 21 input lines minus 1 notification = 20 responses
    assert_eq!(lines.len(), 20);

    // Initialize negotiated 2025-06-18
    assert_eq!(lines[0]["result"]["protocolVersion"], "2025-06-18");

    // tools/list returns all 18 tools
    assert_eq!(lines[1]["result"]["tools"].as_array().unwrap().len(), 18);

    // browser_emulate response includes active profile & calibration result
    let emu_text = lines[17]["result"]["content"][0]["text"].as_str().unwrap();
    let emu_json: Value = serde_json::from_str(emu_text).expect("emulate response json");
    assert_eq!(emu_json["ok"], true);
    assert_eq!(emu_json["emulation"]["profile"], "sunmi-v2-pro");
    assert_eq!(emu_json["calibration"]["chosenRate"], 5);

    // browser_screenshot returns 2 image blocks + 1 layoutAudit text block
    let shot_content = lines[5]["result"]["content"].as_array().unwrap();
    let image_count = shot_content.iter().filter(|c| c["type"] == "image").count();
    assert_eq!(image_count, 2);
    assert_eq!(lines[5]["result"]["isError"], false);

    // browser_filmstrip returns 1 image block + 1 metadata text block
    let strip_content = lines[13]["result"]["content"].as_array().unwrap();
    assert_eq!(strip_content[0]["type"], "image");
    assert_eq!(strip_content[0]["mimeType"], "image/png");
    assert_eq!(strip_content[1]["type"], "text");

    // browser_eval ENTIRE emitted text string (including JSON envelope & escaping) must fit <= 512 bytes!
    let eval_text = lines[10]["result"]["content"][0]["text"].as_str().unwrap();
    assert!(
        eval_text.len() <= 512,
        "expected full emitted text <= 512 bytes, got {}",
        eval_text.len()
    );
    let eval_json: Value = serde_json::from_str(eval_text).expect("truncated envelope json");
    assert_eq!(eval_json["truncated"], true);
    assert_eq!(eval_json["maxBytes"], 512);
}

#[test]
fn socket_client_rejects_mismatched_rpc_response_id() {
    let dir = tempdir().expect("tempdir");
    let sock_path = dir.path().join("ctl.sock");
    let listener = UnixListener::bind(&sock_path).expect("bind unix socket");

    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let req: CtlRpcRequest = read_frame_sync(&mut stream).expect("read req");
        let bad_resp = CtlRpcResponse {
            id: json!(req.id + 999),
            ok: true,
            result: Some(json!({"tabs": []})),
            error: None,
        };
        write_frame_sync(&mut stream, &bad_resp).expect("write bad resp");
    });

    let client = SocketClient::new(sock_path);
    let err = client.call("browser_tabs", json!({})).unwrap_err();
    assert!(err.to_string().contains("response id mismatch"));
    handle.join().expect("server thread joined");
}

#[test]
fn mcp_reports_clean_tool_error_when_browser_socket_is_offline() {
    let dir = tempdir().expect("tempdir");
    let missing_sock = dir.path().join("does-not-exist.sock");
    let client = SocketClient::new(missing_sock);

    let input = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_tabs","arguments":{}}}),
    ]
    .iter()
    .map(|v| serde_json::to_string(v).unwrap())
    .collect::<Vec<_>>()
    .join("\n")
        + "\n";

    let mut out = Vec::new();
    serve_io(&client, 4096, Cursor::new(input.as_bytes()), &mut out).expect("serve_io");

    let responses: Vec<Value> = String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0]["result"]["protocolVersion"], "2024-11-05");
    assert_eq!(responses[1]["result"]["isError"], true);
    assert!(
        responses[1]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("is IronBrowser running?")
    );
}

#[test]
fn browser_emulate_forwards_custom_overrides_and_reset_over_socket() {
    let (_dir, sock_path, server) = spawn_mock_browser_socket(2);
    let client = SocketClient::new(sock_path);

    let input = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"emu-test","version":"1"}}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_emulate","arguments":{
            "tab_id":"tab-9",
            "viewport":"portrait",
            "cpu_rate":8,
            "network":{"latency_ms":220,"down_kbps":900,"up_kbps":400},
            "hardware_concurrency":4,
            "device_memory":2,
            "reduced_motion":true,
            "save_data":true
        }}}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_emulate","arguments":{
            "tab":"tab-9",
            "reset":true
        }}}),
    ]
    .iter()
    .map(|v| serde_json::to_string(v).unwrap())
    .collect::<Vec<_>>()
    .join("\n")
        + "\n";

    let mut out = Vec::new();
    serve_io(&client, 16384, Cursor::new(input.as_bytes()), &mut out).expect("serve_io");

    let received = server.join().expect("mock socket thread joined");
    assert_eq!(received.len(), 2);
    assert_eq!(received[0].method, "browser_emulate");
    assert_eq!(received[0].params["cpu_rate"], json!(8));
    assert_eq!(received[0].params["network"]["latency_ms"], json!(220));
    assert_eq!(received[0].params["device_memory"], json!(2));
    assert_eq!(received[1].method, "browser_emulate");
    assert_eq!(received[1].params["reset"], json!(true));

    let responses: Vec<Value> = String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(responses.len(), 3);
    let apply_payload: Value =
        serde_json::from_str(responses[1]["result"]["content"][0]["text"].as_str().unwrap())
            .unwrap();
    assert_eq!(apply_payload["emulation"]["active"], true);
    assert_eq!(apply_payload["emulation"]["portrait"]["cpuRate"], 8);

    let reset_payload: Value =
        serde_json::from_str(responses[2]["result"]["content"][0]["text"].as_str().unwrap())
            .unwrap();
    assert_eq!(reset_payload["emulation"]["active"], false);
}

#[test]
fn browser_health_returns_offline_logs_and_crash_dump_when_socket_unreachable() {
    let dir = tempdir().expect("tempdir");
    let missing_sock = dir.path().join("offline.sock");
    let log_dir = dir.path().join("logs");
    let crash_dir = dir.path().join("Crashpad").join("completed");
    std::fs::create_dir_all(&log_dir).unwrap();
    std::fs::create_dir_all(&crash_dir).unwrap();
    std::fs::write(
        log_dir.join("main.log"),
        "{\"event\":\"lifecycle.startup\"}\n{\"event\":\"process.uncaught_exception\"}\n",
    )
    .unwrap();
    let dmp_path = crash_dir.join("crash-1.dmp");
    std::fs::write(&dmp_path, b"MDMPfake").unwrap();

    let report = iron_browser_mcp::socket::collect_offline_health(&missing_sock, "conn refused", 10);
    assert_eq!(report["ok"], false);
    assert_eq!(report["socketReachable"], false);
    let logs = iron_browser_mcp::socket::tail_log_file(&log_dir.join("main.log"), 10);
    assert_eq!(logs.len(), 2);
    let dump = iron_browser_mcp::socket::scan_latest_crash_dump(&dir.path().join("Crashpad"));
    assert_eq!(dump["path"], dmp_path.display().to_string());
    assert_eq!(dump["totalDumps"], 1);
}
