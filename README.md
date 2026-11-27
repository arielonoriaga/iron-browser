# IronBrowser

Site-agnostic, Zen-inspired dual-viewport Chromium developer browser built for **The Iron Stack** (`iron-suite`, `iron-term`).

## Highlights

- **Ultra-Lean Zero-Framework Shell (`app/src/renderer/`):** Pure TypeScript + CSS Zen chrome (collapsible vertical tab rail, single-row 40px top bar with `Dual`, `Mirror`, `Shared`/`Isolated`, `Dedup`, `Eco`/`HiDPI`, and `Auto-Sleep` controls, Celestial Dark/Light tokens, zero virtual DOM overhead).
- **Simultaneous Portrait + Landscape Viewports:** Native multi-`WebContentsView` Chromium compositor (`390×844` iPhone 15 + `1280×720` Desktop HD defaults, custom presets & sizes), Wayland Ozone auto-detection (`--ozone-platform-hint=auto`), CDP touch & DPR emulation (`Eco` cap vs full `HiDPI`), lazy inactive tab restoration, opt-in idle `Auto-Sleep`, single audio owner (`Landscape` unmuted, `Portrait` muted in Dual mode), and lazy docked Chrome DevTools with 1-click `[Inspect: Portrait | Landscape]` switching.
- **Native Rust Node-API `TabEventBus` (`crates/iron-browser-bus` → `app/dist/native/iron_browser_bus.node`, `~878 ns/op`):**
  - Per-tab bounded ring buffer (`2048` events/tab) across 13 domains (`gesture`, `navigation`, `http_dedup`, `ws_mux`, `storage`, `download`, `popup`, `callback`, `console`, `network`, `trace`, `mirror`, `lifecycle`) with automatic URL query/hash token redaction.
  - **Causal `gestureSeq` tracking:** Links every downstream HTTP replay, WS/SFS2X frame, `sessionStorage` mutation, download, popup, and SPA route sync within `1000ms` back to the originating user/`ctl` gesture.
  - **Atomic consume-once effect claims (`claimEffect`):** Deduplicates mirrored `will-download` file saves (`reserveSafeDownloadPath` traversal/dotfile/symlink-hardened) and `setWindowOpenHandler` popups across panes.
  - **Live cross-viewport `sessionStorage` replication & reload hydration:** Pre-script `Proxy` shim syncs `setItem`/`removeItem`/`clear` across Shared Dual viewports (`512 KB`/origin cap, strict `http`/`https` origin isolation, zero leak into `Isolated` `iron-iso-<tabId>` tabs).
- **Full-Stack Cross-Viewport Deduplication & Synchronization (`Dual + Mirror + Shared + Dedup`):**
  1. **3-Tier Mirrored Input (`MirrorRelay`):** Proportional scroll (`Tier 1`), deterministic semantic DOM selectors (`data-testid` → `#id` → `aria-label` → `name` → `role+text` → CSS path, `Tier 2`) with State-Aware Toggle Guard & Enter/Space synthetic-click suppression, and normalized `<canvas>` coordinates (`Tier 3`) with `EchoLoopGuard`.
  2. **HTTP Mutation Dedup (`RequestDedupMiddleware`):** CDP `Fetch` interception deduplicating concurrent identical `POST`/`PUT`/`PATCH`/`DELETE` XHR/Fetch calls across panes (12 volatile correlation keys stripped for matching and remapped per-pane on replay; gzip/br/deflate decompression; fail-open on 3xx/4xx/5xx/streaming).
  3. **Symmetric WebSocket, SSE & SFS2X Binary Multiplexer (`WsSseMux`):** Shares one upstream `WebSocket` / `EventSource` per `(tab, origin, url, protocols)`, deduplicates outbound frames within `1500ms`, parses **SmartFoxServer 2X (`SFS2X`)** uncompressed & zlib-compressed binary packets (synthesizing per-follower Handshake/Login responses, deduplicating binary `Bet`/`Cashout` ExtensionRequests, and promoting slow owners across numbered cluster shards like `eu-central-1-game5` ↔ `game8`), and fails over cleanly on `1012` owner teardown.
  4. **302 Launch Redirect Convergence, In-Page SPA Sync & Auth/Route Reconciliation (`handleNavSync` / `onMirrorMiss`):** Converges initial 302 session-token redirects (`?user=...&token=...`) once without mobile/desktop ping-pong, guards subframe `pushState`, transitions same-origin SPA `pushState`/`replaceState` routes (`spa_sync`) in-page across both delegated anchor routers (SvelteKit) and `popstate` routers (React/Next/Vue) without tearing down live WebSockets, and reconciles diverged routes (`spa_auth_reconcile` / `miss_reconcile`) when one viewport unlocks via `sessionStorage` auth or hits an interactive `target-not-found` miss on a stale route.
- **Slow-Device & POS Hardware Emulation + Off-Thread V8 CPU Profiler (`SlowDeviceEmulationManager` / `CpuProfilerManager`):** Per-viewport CDP throttling surviving reloads, navigations, and DevTools detach/reattach — named profiles (`sunmi-v2-pro` at `360×720` DPR `2`, `6×` CPU, `slow-4g`, `deviceMemory: 2`, `hardwareConcurrency: 4`, Android 7.1 / Chrome 87 UA; `low-end-android`; and `none` full reset), custom `cpu_rate` (`1..20`), network presets (`none`, `fast-4g`, `slow-4g`, `3g`, `offline`, or custom latency/down/up), optional `prefers-reduced-motion` and `Save-Data` toggles, host-to-target JS benchmark `calibrate` action, Shell UI telemetry strip pill + preset-menu switcher, and non-blocking `browser_profile` (`Profiler.start`/`stop` with off-thread Worker summarization, size-capped `0600` `.cpuprofile` streaming write, and cross-navigation segment continuity alongside active CPU throttling).
- **Crash, Hang & Post-Mortem Diagnostics (`diagnostics.ts` / `browser_health` / `iron-browser doctor`):** Rotated `0600` JSONL log (`~/.local/state/iron-browser/main.log`) recording every RPC begin/end + duration, `uncaughtException`/`unhandledRejection`, app quit reasons, and per-viewport `render-process-gone`/`unresponsive` events; local Crashpad minidumps (`crashReporter.start({ uploadToServer: false })`); `SharedArrayBuffer` + `worker_threads` main-thread stall watchdog (with V8 `inspector.Session.connectToMainThread()` stack capture) + 5s `SIGKILL` shutdown watchdog; and `browser_health` / `iron-browser doctor` (with offline log + minidump fallback even when `ctl.sock` is unreachable).
- **Headless / Offscreen Smoke & Verification (`--smoke`):** Invisible offscreen launch (`--class=iron-browser-e2e`) with compositor `ForceRedraw` + Aura bounds-nudge screenshot capture so automated tests never steal monitor focus.
- **18-Tool Native Rust MCP Sidecar (`crates/iron-browser-mcp`):** Speaks `stdio` MCP (`2025-06-18` / `2025-03-26` / `2024-11-05`) over `$XDG_RUNTIME_DIR/iron-browser/ctl.sock` (`0600`) with hard UTF-8 serialized byte ceilings (`max_bytes`):
  `browser_tabs`, `browser_open`, `browser_navigate`, `browser_screenshot` (`exact_size`, `highlight_clipped`, `clip`, partial timeout recovery), `browser_metrics` (`gpuProcessCpuPercent` separated from `gpuExecutionTimeMs`, plus active `emulation`), `browser_interact`, `browser_console`, `browser_network`, `browser_eval`, `browser_incidents`, `browser_repro`, `browser_filmstrip`, `browser_trace_start`, `browser_trace_stop`, `browser_events`, `browser_emulate`, `browser_profile`, and `browser_health`.

## Known CDP Emulation Limits

Slow-device emulation (`browser_emulate`) applies real Chromium thread-level CPU duty-cycle throttling (`Emulation.setCPUThrottlingRate`), network latency/bandwidth shaping (`Network.emulateNetworkConditions`), viewport/touch metrics, User-Agent, `navigator.hardwareConcurrency`, and `navigator.deviceMemory` overrides. However, **CDP cannot cap real OS/V8 process RAM (it will not trigger Android low-memory OOM kills), emulate older Chromium/WebView JS or CSS engine feature gaps (e.g. missing Chrome 87 APIs), throttle GPU shader/fill-rate execution, or slow down flash/IndexedDB disk I/O**. Validate memory pressure, old-WebView syntax compatibility, and storage stalls separately when targeting legacy Android hardware such as the Sunmi V2 Pro.

## Quick Start

```bash
# Install & build native Rust bus addon + Electron bundles
cd app && bun install && bun run build

# Build native Rust MCP sidecar & install ~/.local/bin symlinks + .desktop launcher
cargo build --release -p iron-browser-mcp
./packaging/install-desktop.sh

# Launch IronBrowser (add --smoke for invisible headless/CI runs)
iron-browser http://127.0.0.1:3000

# Run native stdio MCP server (18 tools) or post-mortem health check
iron-browser mcp
iron-browser doctor
```
