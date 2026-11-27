# IronBrowser — Laptop Session Handoff (`Wave 4 + Backlog P1–P5 Complete → iron-design UI + Agent CLI Dock`)

Migrated back from `desktop` (`exo`) to `laptop` (`ariel`) on **2026-11-26** with all code, tests, builds, launcher files, and the `iron-design` 3-Proposal UX Lab + Agent CLI Terminal Plan synced and verified.

---

## 1. Completed & Verified in Shipping Repo (`~/Projects/iron-browser`)
- **Wave 4 Complete (`100%` Green):**
  - Bun `1.4.2` `node:vm` GlobalProxy fix (`app/test/ws-sse-mux.test.ts`), bounded CDP sync (`app/src/main/tab-manager.ts`), hidden-window `ForceRedraw` + Aura bounds-nudge capture (`~50–390ms`).
  - `133/133` unit tests, `3/3` `smoke.e2e.ts`, `149/149` `runner.ts --tier=all` (`60` T1 + `60` T2 + `18` T3 + `8` T4 + `3` Smoke).
- **Phase 3 (`BACKLOG.md` P1–P5 + Launcher + 14-Tool Rust MCP) Complete (`100%` Green):**
  - **BL-00:** Symlink launcher resolution (`bin/iron-browser`) + portable XDG desktop installer (`packaging/install-desktop.sh`).
  - **P1:** `{ requestedSize, effectiveCssSize, dpr, capturedPixels, sizeMismatch }` + `exact_size: true` capture & restore.
  - **P2:** Saved repro recipes (`0600` atomic `O_NOFOLLOW`), paired `window.__ironSceneDriver` frame stepping, canvas-only crop, and 5×7 metadata-stamped filmstrip PNG export (`browser_repro`, `browser_filmstrip`).
  - **P3:** Observational cross-pane diagnostic incident grouping (`browser_incidents`) with query/token redaction, keeping single-pane JS exceptions distinct and separate from R2 HTTP dedup.
  - **P4:** Per-pane bounded partial dual screenshots + `{ stage, viewport, error }`, `layoutAudit.clippedItems` (`selector`, `bounds`, `overflowPx` with password redaction), and `highlight_clipped: true` visual overlay.
  - **P5:** `browser_trace_start` / `browser_trace_stop` rolling frame-time buffer, `before`/`during`/`after` windows around app `performance.mark`/`measure` (`biome_crossing`), and `gpuProcessCpuPercent` labeled separately from `gpuExecutionTimeMs`.
  - **Independent Adversarial Review (`Pass 1`–`Pass 6`):** All `9` findings (`F-01`–`F-09`) resolved; `PASS` (`0` open findings). Full evidence in `DESKTOP_COMPLETION_REPORT.md`.
  - Working tree left **uncommitted** as requested.

---

## 2. `iron-design` Full Browser UI Redesign + Embedded Agent CLI Terminal Plan

Per `iron-design` (`V13`: zero shipping-repo UI edits before owner selects a direction), all briefs, plans, and the live interactive 3-proposal UX Lab live in **`~/.cache/iron-browser-ux-lab/`** on both `laptop` and `desktop`:

- **UX Audit & Brief:** `~/.cache/iron-browser-ux-lab/UX.md`
- **Celestial Design Tokens:** `~/.cache/iron-browser-ux-lab/DESIGN.md`
- **Embedded Agent CLI Architecture (`Docked Left` + `Minimizable` + `Floatable/Draggable`):** `~/.cache/iron-browser-ux-lab/AGENT_TERMINAL_PLAN.md`
- **Interactive 3-Proposal UX Lab:** `~/.cache/iron-browser-ux-lab/lab/` (served via `~/.claude/coordinator/runq serve ~/.cache/iron-browser-ux-lab/lab --project iron-browser`)

### Next Step on Laptop
1. Test the 3 proposals (`A · Studio Workbench`, `B · Canvas HUD + Float PiP`, `C · Forensic Time-Travel` — or request a Gen-2 hybrid like `60% A + 40% B/C`) in the live UX Lab.
2. Run `/irondev` against `~/.cache/iron-browser-ux-lab/{UX.md,DESIGN.md,AGENT_TERMINAL_PLAN.md}` to implement `UI-M1` (Shell Redesign), `UI-M2` (`node-pty` + `@xterm/xterm` inside top-most `agentView: WebContentsView` supporting `Docked Left`, `Minimized`, and `Floatable/Draggable`), and `UI-M3` (Direct `Pick Element` / `@incident` / `@clipped` / live MCP tool-call bridge).
