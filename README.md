# IronBrowser

Site-agnostic, Zen-inspired Chromium developer browser aligned with **The Iron Stack** (`iron-suite`, `iron-term`).

## Highlights

- **Ultra-Lean Zero-Framework Shell (`app/src/renderer/`):** Pure TypeScript + CSS Zen chrome (collapsible vertical tab rail, compact URL bar, Celestial Dark/Light tokens, zero virtual DOM overhead).
- **Simultaneous Portrait + Landscape Viewports (B1):** Native multi-`WebContentsView` Chromium compositor with Wayland Ozone auto-detection (`--ozone-platform-hint=auto`), CDP touch emulation on Portrait, device presets (`iPhone 15`, `iPhone SE`, `Pro Max`, `Tablet`, `HD`, `Desktop`), tab sleep/throttling, and **real docked Chrome DevTools** with 1-click `[Inspect: Portrait | Landscape]` switching.
- **Site-Agnostic 3-Tier Mirrored Interaction Engine (B2):**
  1. **Tier 1:** URL navigation, history back/forward, reload, and proportional scroll sync.
  2. **Tier 2:** Deterministic semantic DOM fingerprinting (`data-testid` → `#id` → `aria-label` → `name` → `role+text` → CSS path) replayed via trusted Chromium input events.
  3. **Tier 3:** Normalized `<canvas>` / coordinate fallback + anti-echo loop guard + `Shared` vs `Isolated` (`iron-iso-<tabId>`) session partition toggle.
- **Live Telemetry Strip (B3):** 1 Hz `app.getAppMetrics()` (GPU / Portrait / Landscape CPU% & RAM MB, paused when window hidden), CDP `Performance.getMetrics` (JS Heap, DOM Nodes), `rAF` FPS/p95/jank sparkline, and clickable `Console` / `Network` error pills.
- **Native Rust MCP Sidecar (B4):** Zero-bloat `crates/iron-browser-mcp` bridging `stdio` MCP (`2025-06-18` / `2024-11-05`) over a `0600` length-prefixed Unix socket (`$XDG_RUNTIME_DIR/iron-browser/ctl.sock`) with all 9 tools and hard UTF-8 `--max-bytes` ceilings.

## Quick Start

```bash
# Install & build Electron shell
cd app && bun install && bun run build

# Build native Rust MCP sidecar
cargo build --release -p iron-browser-mcp

# Launch IronBrowser
./bin/iron-browser http://127.0.0.1:3000

# Run native stdio MCP server
./bin/iron-browser mcp
```
