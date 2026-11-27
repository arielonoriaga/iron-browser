# IronBrowser — Desktop Completion & Verification Report (Wave 4 + Phase 3 Backlog P1–P5 + App Launcher)

**Date:** 2026-11-26  
**Host:** `desktop` (`exo`, Linux x86_64, Hyprland/Wayland + XWayland, Bun `1.4.2`, Electron `35.7.5`, Rust `cargo`)  
**Workspace:** `/home/exo/Projects/iron-browser` (uncommitted per instruction — ready for inspection / `rsync`)  
**Verified Source Snapshot (`SHA-256`):** `snapshot:b705f410f1c5f8e1534f8586d73577a1ae9c76a8cb11ab0c59d7a0e8a3330383`  
**Independent Adversarial Review Verdict:** `PASS` (`0 CRITICAL`, `0 HIGH`, `0 MEDIUM`, `0 LOW` across 6 review passes; final sign-off on `snapshot:b705f410f1c5f8e1534f8586d73577a1ae9c76a8cb11ab0c59d7a0e8a3330383`)

---

## 1. Acceptance Matrix (`user_global` Rule 6)

> Note: `/home/exo/Projects/iron-browser` has `## No commits yet on main` (`git status --short --branch`), so every row pins the exact SHA-256 manifest over `bin/iron-browser`, `packaging/{iron-browser.desktop,install-desktop.sh}`, `app/package.json`, `app/src/{shared,main,preload}/*.ts`, and `crates/iron-browser-mcp/{src,tests}/*.rs` (`snapshot:b705f410f1c5f8e1534f8586d73577a1ae9c76a8cb11ab0c59d7a0e8a3330383`).

| Criterion | Command or Surface | Observed | Source State | Status |
|---|---|---|---|---|
| **Wave 4.1 — Bun 1.4.2 `node:vm` GlobalProxy migration & unit suite** | `cd app && bun run typecheck && bun run build && bun test` (`test/ws-sse-mux.test.ts:493-511`) | `tsc --noEmit` exit `0`; `dist/{main,preload,renderer}` built (`0.43 MB` / `71.12 KB` / `29.45 KB`); `133 pass, 0 fail, 1427 expect() calls` across `11` files (`4.40s`), including all `26/26` `ws-sse-mux.test.ts` tests (`3/3` repeat runs) | `snapshot:b705f410...` | **confirmed** |
| **Wave 4.2 — Phase 1B Live Smoke & Tier 1 + Tier 2 E2E** | `bun run test/e2e/smoke.e2e.ts` & `bun run test/e2e/runner.ts --tier=all` (`T1-*`, `T2-*`) | `Smoke Summary: 3/3 passed, 0 failed`; Tier 1 `60/60 passed`; Tier 2 `60/60 passed` | `snapshot:b705f410...` | **confirmed** |
| **Wave 4.3 — Phase 1C Pairwise Tier 3 & Phase 1D Workflow Tier 4 E2E** | `bun run test/e2e/runner.ts --tier=all` (`T3-P01..T3-P18`, `T4-S01..T4-S08`, `SMOKE-A..C`) | Tier 3 `18/18 passed`; Tier 4 `8/8 passed`; combined `E2E Summary: 149/149 passed, 0 failed (144589ms)` | `snapshot:b705f410...` | **confirmed** |
| **Wave 4.4 — Phase 2 Adversarial Hardening (`R1`–`R5` + Cache-Clearing Reload)** | Independent adversarial review (`Pass 1`–`Pass 6`) over `src/main/{tab-manager.ts,request-dedup.ts,ws-sse-mux.ts,mirror-relay.ts,telemetry.ts,debugger-coordinator.ts,session-file.ts}` | `R1`–`R5` & `F12` verified + `F-06` (`ws-sse-mux.ts:352-360` same-viewport multi-socket bypass) & bounded CDP sync (`tab-manager.ts:724-780,1204-1219,1358-1376`) hardened; `0` open findings (`PASS`) | `snapshot:b705f410...` | **confirmed** |
| **Backlog Fixed — PATH Symlink Launcher Smoke Test (`bin/iron-browser`)** | `test/backlog-p1-p5.test.ts` (`20/20` runs) & `BL-00` in `test/e2e/backlog-p1-p5.e2e.ts` (`3/3` runs) via external temp symlink | `[PASS] BL-00 [604ms] (Electron exit=0 & iron-browser-mcp 0.1.0)` across `3/3` E2E runs and `20/20` unit runs | `snapshot:b705f410...` | **confirmed** |
| **Backlog P1 — Effective Viewport Reporting & `exact_size: true` Capture** | `src/shared/viewport-report.ts:1-106`, `src/main/tab-manager.ts:2415-2858`, `BL-P1` in `test/e2e/backlog-p1-p5.e2e.ts` (`3/3` runs) | Reports `{ requestedSize, effectiveCssSize, dpr, capturedPixels, sizeMismatch }` on `browser_open` / `browser_tabs` / `browser_screenshot`; `[PASS] BL-P1 [305ms] (narrow=548x424 (sizeMismatch=true) -> exact=1050x660 -> restored=548px)` | `snapshot:b705f410...` | **confirmed** |
| **Backlog P2 — Saved Repro Recipes, Scene-Driver Stepping & Labelled Filmstrip PNG** | `src/shared/{repro-recipe.ts,png-filmstrip.ts}`, `src/main/repro-recipe-file.ts`, `src/main/tab-manager.ts:2978-3438`, `BL-P2` (`3/3` runs) | Atomic `0600`/`O_NOFOLLOW` recipes, paired `window.__ironSceneDriver` stepping, canvas crop, 5×7 metadata stamp; `[PASS] BL-P2 [647–803ms] (filmstrip=672x692px, steps=60(forest)->120(sea)->180(sea) @ 1.94x)` via Rust MCP | `snapshot:b705f410...` | **confirmed** |
| **Backlog P3 — Cross-Pane Diagnostic Incident Grouping (`browser_incidents`)** | `src/shared/incident-grouping.ts:1-342`, `src/main/telemetry.ts:525-545`, `BL-P3` (`3/3` runs) | Observational grouping separate from R2 dedup (`srv.getHistoryHitCount() === 2`), token redaction in URLs & console text; `[PASS] BL-P3 [369–383ms] (1 cross-pane 401 incident (2 reqs + 4 console errs) + 1 distinct portrait JS exception)` | `snapshot:b705f410...` | **confirmed** |
| **Backlog P4 — Partial Dual Screenshots, Stage Errors & Clipped-Element Details/Overlay** | `src/preload/mirror-preload.ts:942-1122`, `src/main/tab-manager.ts:2415-2858`, `BL-P4` (`3/3` runs) | Per-element `{ selector, tag, text, bounds, overflowPx }` with password/editable redaction, `highlight_clipped: true` temporary overlay, bounded partial dual capture; `[PASS] BL-P4 [2635ms] (clippedItems=2 ([data-testid="offscreen-cta"] +120px), partial recovery verified)` | `snapshot:b705f410...` | **confirmed** |
| **Backlog P5 — Short MCP Perf Traces Around App Marks & GPU Metric Separation** | `src/shared/perf-trace.ts:1-216`, `src/preload/mirror-preload.ts:1124-1266`, `src/main/telemetry.ts:448-503`, `BL-P5` (`3/3` runs) | Rolling `rAF`/fallback buffer, `before`/`during`/`after` windows around `biome_crossing`, `gpuProcessCpuPercent` labeled separately from `gpuExecutionTimeMs`; `[PASS] BL-P5 [1670–1724ms] (portrait=120f, landscape=100f, gpuProcessCpu=0.1% (gpuExecMs=null))` | `snapshot:b705f410...` | **confirmed** |
| **Rust MCP Sidecar (`crates/iron-browser-mcp` — 14 tools)** | `CARGO_TARGET_DIR="$HOME/.cache/cargo-targets/main" cargo test --workspace --no-fail-fast` & `cargo build --release -p iron-browser-mcp` | `5 passed` (`src/lib.rs`) + `3 passed` (`tests/mcp_socket_e2e.rs` exercising all `14` tools over framed Unix socket); `target/release/iron-browser-mcp` built cleanly | `snapshot:b705f410...` | **confirmed** |
| **Desktop App Launcher Installation (`fuzzel` / Wayland / XDG)** | `packaging/install-desktop.sh` & `desktop-file-validate packaging/iron-browser.desktop ~/.local/share/applications/iron-browser.desktop` | Installed `/home/exo/.local/bin/{iron-browser,iron-browser-mcp}`, `/home/exo/.local/share/applications/iron-browser.desktop`, and Hicolor `svg` + `256x256` `png` icons; `DESKTOP_FILE_VALIDATE=0_WARNINGS_0_HINTS` | `snapshot:b705f410...` | **confirmed** |
| **Git / Scope Constraints** | `git status --short --branch` | No commits or pushes made (`## No commits yet on main`) | `snapshot:b705f410...` | **confirmed** |

**Open Gaps:** None.

---

## 2. Root-Cause Fixes & Adversarial Review Resolutions

### Wave 4 Migration & E2E Root-Cause Fixes
1. **Bun `1.4.2` `node:vm` `GlobalProxy` mismatch (`app/test/ws-sse-mux.test.ts:493-511, 560-605`):**
   - *Cause:* Bun `1.4.2` separates `vm.createContext(sandbox)`'s outer `GlobalProxy` (`vm.runInContext('globalThis', context)`) from the raw `sandbox` object, so the shim's `if (ev.source !== globalObj) return;` check rejected test messages posted with `source: h.sandbox`.
   - *Fix:* Captured `windowProxy = vm.runInContext('globalThis', context)` in `createVmBrowserHarness` and passed `source: h.windowProxy` for same-window handshake messages while keeping cross-window spoofing assertions intact.
2. **Electron `35.7.5` binary installation (`app/node_modules/electron/dist`):**
   - *Cause:* `bun install` on desktop had skipped `electron/install.js` extraction (`path.txt` missing).
   - *Fix:* Extracted `electron-v35.7.5-linux-x64.zip` into `app/node_modules/electron/dist` with `path.txt`.
3. **Tier 3 `T3-P11` & `T3-P18` / Tier 4 `T4-S08` (`app/test/e2e/tiers/tier3-pairwise.ts:1164-1168, 1702-1710` & `tier4-scenarios.ts:1278-1286`):**
   - *Cause:* `T3-P11` awaited `15` `requestAnimationFrame` ticks inside a `smoke: true` (`show: false`) window where Chromium pauses `rAF`; `execFetch` serialized the entire `2.3 MB` `/large` body into `evalJs`, hitting `evalJs`'s `16,384`-byte UTF-8 truncation cap (`JSON Parse error: Unterminated string`).
   - *Fix:* Ran `T3-P11` with `smoke: false, extraArgs: visibleLaunchArgs()` (matching `T1-F2-01` and `T2-F2-01`), and bounded `execFetch`'s `bodyText` preview to `4096` chars while returning exact `bodyLength`.
4. **Bounded CDP setup in `TabManager.loadViewportUrl` & `applyViewportEmulation` (`app/src/main/tab-manager.ts:724-780, 1204-1219, 1358-1376`):**
   - *Cause:* Unbounded `Promise.all([wsSseMux.syncViewport, requestDedup.setViewportEnabled])` or `pendingEmulations` could stall `wc.loadURL(url)` or `ensureTabMaterializedAndLoaded` if a debugger command hung during rapid multi-tab churn (`T4-S08`).
   - *Fix:* Added explicit `Promise.race` timeouts (`2500ms` on pre-load sync, `1200ms` on viewport emulation) with `clearTimeout` cleanup.
5. **Hidden-window (`--smoke` / `show: false`) compositor surface availability (`app/src/main/tab-manager.ts:2499-2508, 2605-2789`):**
   - *Cause:* On unmapped X11/Aura `WebContentsView`s (`show: false`), `wc.capturePage()` throws `"Current display surface not available for capture"` before Viz allocates a display surface, while `Page.captureScreenshot({ fromSurface: true })` initiates `RenderWidgetHostImpl::ForceRedraw` without resolving directly.
   - *Fix:* Kept `wc.capturePage()` primary (warming Viz hit-testing surfaces when available), and when `!pngBuf` on an unmapped window, triggered `ForceRedraw` (`Page.captureScreenshot` bounded to `60ms` + 1px Aura `setBounds` nudge/restore) followed by bounded `[45, 90, 160]ms` `capturePage()` retries — cutting hidden-window screenshot latency from `~5000ms` to `~50–390ms` across all suites.

### Independent Adversarial Review Findings Resolved (`F-01`–`F-09`)
- **`F-01` (HIGH):** Monotonic per-pane `paneDeadline` (`remMs`, `isDeadlineExpired`) + `withBoundedCleanup(..., 600)` in `captureScreenshots` `finally` so wedged renderers never exceed the 15s MCP socket timeout (`app/src/main/tab-manager.ts:2429-2462, 2486-2490, 2860-2899`).
- **`F-02` (HIGH):** Total 0-pane screenshot failure throws an RPC error (`app/src/main/tab-manager.ts:2909-2920`) and sets `isError: true` in Rust MCP (`crates/iron-browser-mcp/src/mcp.rs:647-662`) while preserving 1-pane partial success.
- **`F-03` (HIGH):** Pure `app/src/shared/repro-recipe.ts` (`zero node:*` imports; atomic `O_NOFOLLOW`/`wx`/`0600` file I/O in `app/src/main/repro-recipe-file.ts`) and hardened PNG parser (`IHDR >= 13`, `<= 8192px` / `16.77M` pixels, `<= 64 MiB` inflate cap, `[120, 1920]` tile width clamp in `app/src/shared/png-filmstrip.ts:52-77, 196-205, 344`).
- **`F-04` (MEDIUM):** Redacted query/fragment/credential secrets embedded inside free-form `ConsoleEntry.text` via `redactUrlsInText` (`app/src/shared/incident-grouping.ts:68-105`), bounded `ConsoleEntry` text (`<= 4096` UTF-8 bytes) & `data:[redacted]` URLs (`app/src/main/telemetry.ts:563-595`), and validated recipe/CTL URLs (`<= 4096` chars, no credentials) & viewport/clip dimensions (`app/src/main/ctl-socket.ts:230-293, 355-465`).
- **`F-05` (MEDIUM):** Added `expectedCapturePixels` to `buildViewportSizingReport` (`app/src/shared/viewport-report.ts:41-89`) so clipped `exact_size: true` captures (`clip` + `exact_size`) and `capturePage` host-DPR fallbacks never report false `sizeMismatch`.
- **`F-06` (LOW):** Bypassed `WsSseMux` when the *same* `WebContents` opens a second concurrent socket to the same channel key (`app/src/main/ws-sse-mux.ts:352-360`).
- **`F-07` (LOW):** Rejected `stopPerfTrace` when no trace is active (`app/src/main/tab-manager.ts:3466-3469`), cleared `mirrorRelay` + `activeTracesByTab` in `sleepTab`/`sweepAutoSleep` (`:1926-1927, 2248-2249`), and preserved canonical paired `<name>:start`/`<name>:end` and unclosed `:start` mark windows (`app/src/shared/perf-trace.ts:127-177`).
- **`F-08` (LOW):** Scoped `exactSizeApplied` strictly to `Boolean(opts.exactSize) && (appliedExactOverride || resizedOffscreenView)` (`app/src/main/tab-manager.ts:2838-2847`) so non-`exact_size` hidden-window rescues never misreport `exactSizeApplied: true`.
- **`F-09` (LOW):** Kept `packaging/iron-browser.desktop` portable (`TryExec=iron-browser`, `Exec=iron-browser %U`, `Categories=Network;WebBrowser;`) while `packaging/install-desktop.sh` expands `$LOCAL_BIN/iron-browser` into `~/.local/share/applications/iron-browser.desktop`.

---

## 3. Exact Observed Final Verification Outputs (`snapshot:b705f410...`)

### 3.1 TypeScript Typecheck, Unit Suite (`133/133`), & Rule 10 Repeat Runs (`20/20` & `3/3`)
```text
=== SNAPSHOT_HASH_START ===
b705f410f1c5f8e1534f8586d73577a1ae9c76a8cb11ab0c59d7a0e8a3330383  -
=== DESKTOP_LAUNCHER_VALIDATION ===
DESKTOP_FILE_VALIDATE=0_WARNINGS_0_HINTS
=== UNIT_TYPECHECK_AND_TEST ===
$ tsc --noEmit
bun test v1.4.2 (744846f84)
 133 pass
 0 fail
 1427 expect() calls
Ran 133 tests across 11 files. [4.40s]
=== RULE10_UNIT_REPEATS ===
RULE10_BACKLOG_UNIT_20X=20/20_PASS
RULE10_MODIFIED_SUITES_3X=3/3_PASS
```

### 3.2 Rust MCP Sidecar (`cargo test --workspace --no-fail-fast`)
```text
running 5 tests
test frame::tests::rejects_zero_and_oversized_frame_headers ... ok
test frame::tests::roundtrips_framed_json_value ... ok
test frame::tests::truncate_utf8_never_splits_multibyte_chars ... ok
test mcp::tests::screenshot_formatting_handles_partial_success_vs_zero_capture_failure ... ok
test mcp::tests::all_tools_declare_four_boolean_annotations ... ok
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

running 3 tests
test socket_client_rejects_mismatched_rpc_response_id ... ok
test mcp_reports_clean_tool_error_when_browser_socket_is_offline ... ok
test mcp_end_to_end_exercises_all_fourteen_tools_over_framed_unix_socket ... ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

### 3.3 Phase 3 Backlog Live Electron + Symlink + Rust MCP E2E (`3/3` Consecutive Full Runs — `18/18` Cases)
```text
--- backlog-p1-p5.e2e.ts run 1/3 ---
[PASS] BL-00 — Launcher symlink smoke test (bin/iron-browser via external symlink for Electron --smoke and MCP) [604ms] (Electron exit=0 & iron-browser-mcp 0.1.0)
[PASS] BL-P1 — Effective viewport reporting (sizeMismatch on narrow window) + exact_size:true 1050x660 capture & restore [305ms] (narrow=548x424 (sizeMismatch=true) -> exact=1050x660 -> restored=548px)
[PASS] BL-P2 — Saved forest-to-sea 1.94x recipe reopen, paired scene-driver stepping & -1s..+1s labelled filmstrip PNG via Rust MCP [803ms] (filmstrip=672x692px, steps=60(forest)->120(sea)->180(sea) @ 1.94x)
[PASS] BL-P3 — Cross-pane 401 room-history grouped into 1 incident across 2 viewports; single-pane JS exception stays distinct [383ms] (1 cross-pane 401 incident (2 reqs + 4 console errs) + 1 distinct portrait JS exception)
[PASS] BL-P4 — Clipped element details ({selector, bounds, overflowPx}), highlight_clipped:true overlay, and partial dual capture when 1 pane stalls [2635ms] (clippedItems=2 ([data-testid="offscreen-cta"] +120px), partial recovery verified)
[PASS] BL-P5 — 2-second biome_crossing trace returns before/during/after frame times for both panes & separates GPU-process CPU% from GPU execution time [1723ms] (portrait=100f, landscape=100f, gpuProcessCpu=0.1% (gpuExecMs=null))
Backlog Phase 3 E2E Summary: 6/6 passed, 0 failed
--- backlog-p1-p5.e2e.ts run 2/3 ---
Backlog Phase 3 E2E Summary: 6/6 passed, 0 failed
--- backlog-p1-p5.e2e.ts run 3/3 ---
Backlog Phase 3 E2E Summary: 6/6 passed, 0 failed
BACKLOG_E2E_3X=3/3_PASS
```

### 3.4 Wave 4 Live Electron Smoke (`3/3`) & Full Tiers 1–4 Suite (`149/149`)
```text
=== WAVE4_SMOKE_E2E ===
[PASS] SMOKE-A (F6,F7,F11) — Live Electron mirrored POST + gzip dedup & state isolation [2153ms]
[PASS] SMOKE-B (F8,F11) — Live Electron symmetric WS + SSE multiplexer & 1012 owner failover [742ms]
[PASS] SMOKE-C (F4,F10,F11) — Live Electron 2-launch session restore, lazy tabs & history integrity [1865ms]
Smoke Summary: 3/3 passed, 0 failed

=== WAVE4_TIER_ALL_E2E ===
... (T1: 60/60, T2: 60/60, T3: 18/18, T4: 8/8, SMOKE: 3/3) ...
E2E Summary: 149/149 passed, 0 failed (144589ms)

=== FINAL_SNAPSHOT_AND_GIT_STATUS ===
b705f410f1c5f8e1534f8586d73577a1ae9c76a8cb11ab0c59d7a0e8a3330383  -
## No commits yet on main
ALL_FINAL_VERIFICATION_CHECKS=0_FAILURES
```
