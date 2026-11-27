# IronBrowser — Desktop Migration Handoff (Resume Wave 4 Phase 1B → Done)

Migrated cleanly from laptop (`ariel`) to `desktop` (`exo`) on 2026-11-26.
All implementation milestones (`M1`–`M4B`) and E2E suites are already written and verified up through **Wave 4 Phase 1A**.

## Where We Stopped
- **Completed & Gate-PASSED:**
  - `M1` (R1 CPU/RAM optimizations, R5 Session Restore & Short History fixes, cache-clearing reloads + `Ctrl+R`/`F5`/`Ctrl+Shift+R`)
  - `M2` (R2 Browser-Side HTTP Request Deduplication Middleware)
  - `M3` (R3 Symmetric WebSocket & EventSource Frame Multiplexer)
  - `M4A` (R4 UI Replication Accuracy + Burst FPS Preload)
  - `M4B` (Shell UI controls + Main wiring + 3 E2E-surfaced M1 fixes)
  - `E2E-M1..M4` (Isolated Electron harness, local HTTP/WS/SSE servers, 146 Tier 1–4 tests + `smoke.e2e.ts`)
  - **Wave 4 Phase 1A PASSED Gate:** `119/119` unit tests, `3/3` live Electron `smoke.e2e.ts`, `60/60` Tier 1 E2E tests.
  - Also fixed `bin/iron-browser` PATH symlink resolution (`readlink -f`) and captured Origami Rush field feedback in `BACKLOG.md` (deferred to next sprint, do NOT mix into this run).

- **In Progress at Migration (Phase 1B — Tier 2 Boundaries):**
  - `teamwork_worker_p1b_r1` JUST applied all Phase 1B fixes (binary/Blob `hasPostData` fail-open in `src/main/request-dedup.ts`, `MirrorRelay.replayEvent` `beginReplaying`/`endReplaying` hardening in `src/main/mirror-relay.ts`, and `test/e2e/tiers/tier2-boundaries.ts` fixes) and was starting sequential verification when paused for migration.

## Remaining Work to Complete This Sprint (in `~/Projects/iron-browser/app`)
1. Run & verify **Phase 1B**:
   - `bun run typecheck && bun run build && bun test`
   - `bun run test/e2e/smoke.e2e.ts` (3/3 PASS)
   - `bun run test/e2e/runner.ts --tier=1` (60/60 PASS)
   - `bun run test/e2e/runner.ts --tier=2` (60/60 PASS — fix any remaining real failures)
2. Run & verify **Phase 1C**: `bun run test/e2e/runner.ts --tier=3` (18 pairwise tests — fix any failures)
3. Run & verify **Phase 1D**: `bun run test/e2e/runner.ts --tier=4` (8 full scenarios — fix any failures)
4. Run **Phase 2 — Adversarial Hardening**: probe any remaining edge cases (R1–R5 + cache-clearing reload), run full regression (`typecheck && build && bun test`, `smoke.e2e.ts`, Tiers 1–4), and do an independent final code/security/correctness audit.
5. **Constraints:**
   - Do NOT commit or push unless explicitly asked.
   - Keep `BACKLOG.md` items separate unless asked.
   - Write final verification summary to `~/Projects/iron-browser/DESKTOP_COMPLETION_REPORT.md` when finished so the user can inspect and `rsync` back to laptop easily.

## Reference Spec & Context (synced alongside this repo)
- `.teamwork-handoff/ORIGINAL_REQUEST.md` — full approved task prompt + cache-clearing reload requirement
- `.teamwork-handoff/PROJECT.md` — architecture & milestone contracts
- `.teamwork-handoff/TEST_INFRA.md` & `.teamwork-handoff/TEST_READY.md` — E2E harness & suite docs

## Desktop Environment Notes
- Live graphical session available on `desktop`: `XDG_RUNTIME_DIR=/run/user/1000`, `WAYLAND_DISPLAY=wayland-1`, `DISPLAY=:0`.
- Remember `test/e2e/` spawns isolated Electron windows using temp `--user-data-dir`, `IRON_BROWSER_STATE_FILE`, and `IRON_BROWSER_SOCKET`.

## Phase 3 — ALSO Complete Entire BACKLOG.md (User Requested Full Plan!)
After completing Steps 1–4 above (Wave 4 Phases 1B–2 + independent review), DO NOT STOP — continue immediately and implement + verify ALL 5 items from `~/Projects/iron-browser/BACKLOG.md` (Origami Rush field feedback, including symlink-launch smoke test):
- P1: Effective viewport reporting (`requestedSize`, `effectiveCssSize`, `dpr`, `capturedPixels`, `sizeMismatch`) + `exact_size: true` capture mode independent of shell width.
- P2: Saved reproduction recipes (`url`, `seed`, `phase`, `frame`, viewport sizes), optional dev-only scene driver hook, paired frame stepping, canvas region capture, and labelled filmstrip PNG export.
- P3: Cross-pane diagnostic incident grouping (`method + sanitizedPath + status` + linked console errors across viewports, expandable raw entries, single-pane JS exceptions kept distinct — separate from R2 HTTP dedup).
- P4: Partial dual screenshots with per-pane timeout stage diagnostics (`{ stage, viewport, error }`), enriched `layoutAudit` with per-element `{ selector, tag, text, bounds, overflowPx }`, and optional `highlight_clipped: true` capture overlay.
- P5: Short MCP performance traces (`browser_trace_start` / `browser_trace_stop`) with rolling frame-time buffer, app `performance.mark`/`measure` events side-by-side, and GPU-process CPU labeled separately from GPU execution time.
- Plus symlink-launch smoke test for `bin/iron-browser` and Rust MCP sidecar updates (`crates/iron-browser-mcp`) + `cargo test` & `cargo build --release` as needed.
- Run independent adversarial review over the Phase 3 additions too, and include full results for BOTH Wave 4 AND Backlog P1–P5 in `~/Projects/iron-browser/DESKTOP_COMPLETION_REPORT.md`. Still do NOT commit or push.
