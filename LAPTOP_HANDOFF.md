# IronBrowser — Laptop & `iron-term` Synchronization Handoff (`2026-11-27`)

Synced between `desktop` (`/home/exo/Projects/iron-browser`) and `laptop` (`/home/ariel/Projects/iron-browser`) on `main` (`origin/main`).

---

## 1. What Shipped & Verified Across `536f79f` → `6d1bc86` → `f5f8f36`

1. **Dual-Viewport Runtime, Dedup Stack & SFS2X Binary Multiplexing (`536f79f`):**
   - Simultaneous `390×844` Portrait + `1280×720` Landscape `WebContentsView` compositor, 3-Tier semantic/canvas `MirrorRelay` (with State-Aware Toggle Guard, synthetic-click suppression, and redacted Mirror-Miss telemetry), `Eco` DPR cap, lazy restored tabs, opt-in `Auto-Sleep`, and cache-clearing reload.
   - `RequestDedupMiddleware` (idempotent cross-pane `POST`/`PUT`/`PATCH`/`DELETE` replay with JSON correlation-ID remapping and gzip/br/deflate support).
   - `WsSseMux` symmetric `WebSocket` + `EventSource` multiplexer + **SmartFoxServer 2X (`SFS2X`)** binary codec (`app/src/shared/sfs-codec.ts`) handling numbered cluster shard failover (`game5` ↔ `game8`), late-joining follower Handshake/Login staging, outbound binary `Bet`/`Cashout` deduplication, and one-shot 302 launch redirect convergence (verified on Spribe Aviator).
   - `--smoke` invisible offscreen launch (`--class=iron-browser-e2e`) with compositor `ForceRedraw` + Aura bounds-nudge capture (`~50–390ms`) so background E2Es never pop onto active monitors.
   - Backlog **P1–P5**: `viewportReport` (`sizeMismatch` + `exact_size`), `browser_repro` + `browser_filmstrip` (`window.__ironSceneDriver` lockstep stepping + 5×7 stamped PNG strip), `browser_incidents` (cross-pane failure grouping), `highlight_clipped` + partial dual screenshots, and `browser_trace_start`/`stop` (`before`/`during`/`after` mark windows + `gpuProcessCpuPercent` separated from `gpuExecutionTimeMs`).

2. **Native Rust Node-API `TabEventBus` + `sessionStorage` Sync + Effect Dedup + 15th MCP Tool (`6d1bc86`):**
   - Built zero-dependency Rust `cdylib` (`crates/iron-browser-bus/src/{lib.rs,napi.rs}` → `app/dist/native/iron_browser_bus.node`, `~877.7 ns/op` round-trip) with TypeScript wrapper (`app/src/main/tab-event-bus.ts`).
   - **Causal `gestureSeq` (`1000ms` window):** Links mirrored clicks/keys/scrolls to downstream `http_dedup`, `ws_mux`, `storage`, `download`, `popup`, and `navigation` events.
   - **Consume-once `claimEffect`:** Deduplicates mirrored `will-download` file saves (with path-traversal/dotfile/symlink-safe `reserveSafeDownloadPath`) and `window.open` popups across Portrait + Landscape.
   - **Cross-viewport `sessionStorage` replication & reload hydration:** Pre-script `Proxy` shim syncs `sessionStorage` live across Shared Dual panes (`512 KB`/origin cap, strict `http`/`https` origin isolation, isolated from `iron-iso-<tabId>` tabs).
   - **15th MCP tool `browser_events`:** Added to `ControlSocketServer` (`app/src/main/ctl-socket.ts`) and `crates/iron-browser-mcp` (`filter` by `tab_id`, `domain`, `viewport`, `since_seq`, `gesture_seq`, `limit`).
   - **Runtime evaluation (`Bun.WebView`):** Evaluated Bun's `Bun.WebView` (`WKWebView` / CDP subprocess) — lacks multi-subview `WebContentsView` embedding inside one window, partitioned `session` per viewport, `Fetch.fulfillRequest` response-body replay with per-pane header/correlation remapping, and `will-download` interception; keeping Electron multi-`WebContentsView` + Rust N-API `TabEventBus` gives sub-microsecond bus performance without losing Chromium compositor & CDP primitives.

3. **SPA In-Page `spa_sync` Without Reload, Subframe Guard & Live `stake.com` Verification (`f5f8f36`):**
   - Guarded `did-navigate-in-page` against `isMainFrame === false` subframe `pushState`.
   - Replaced cold `wc.loadURL` reload on main-frame `did-navigate-in-page` with a coalesced `260ms` in-page `spa_sync` supporting both delegated anchor routers (SvelteKit on `stake.com`, including `>180ms` async route loads) and `popstate` routers (React/Next/Vue), with `spaSyncInFlight` echo suppression and a 2-hop `spaSyncChain` canonicalizer bound (reset on user/`ctl` gestures and programmatic navigations).
   - Aligned `getShellState().loading` and `shouldSuppress` with `wcLoadStates` (fixing Chromium's transient `wc.isLoading() === true` during `did-navigate-in-page`).
   - Verified live on `https://stake.com` (`dedupCount: 11`: `8` GraphQL/feature-flag POST replays + `3` WS/SSE muxes, `sessionStorage` & `15/15` `localStorage` parity, synchronized live player counters, zero WebSocket teardown across SPA route transitions).

---

## 2. How `iron-term` & Embedded Agent Dock Connect to This Version

- **MCP Sidecar (`~/.local/bin/iron-browser-mcp` / `iron-browser mcp`):** Exposes all **15** tools (`browser_events` is tool #15). Accepts `--socket <ctl.sock>` (defaults to `$IRON_BROWSER_SOCKET` or `$XDG_RUNTIME_DIR/iron-browser/ctl.sock`) and `--max-bytes <256..262144>`.
- **Live Causal Bus Polling for `iron-term` & `AGENT_TERMINAL_PLAN.md`:**
  - `iron-term` agents or IronBrowser's planned `AgentPtyService` (`~/.cache/iron-browser-ux-lab/AGENT_TERMINAL_PLAN.md`) can tail `browser_events(since_seq: lastSeq)` or inspect a specific interaction via `browser_events(gesture_seq: N)` to trace `gesture → spa_sync / http_dedup / ws_mux / storage / download / popup / console / network` in one deterministic call.
  - All URL summaries on the bus automatically redact sensitive query and hash-route tokens (`token`, `jwt`, `code`, `secret`, `session`, etc.).
