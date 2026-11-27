import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { encodeFrame, FrameDecoder } from '../shared/frame';
import type { CtlRpcRequest, CtlRpcResponse, SessionMode, ViewMode, ViewportRole } from '../shared/types';
import {
  validateClipRegionInput,
  validateViewportSizeInput,
} from '../shared/repro-recipe';
import { normalizeUrl } from '../shared/url';
import type { TabManager } from './tab-manager';

/**
 * Exact path parity with `crates/iron-browser-mcp/src/socket.rs`:
 * 1. `IRON_BROWSER_SOCKET` override
 * 2. `$XDG_RUNTIME_DIR/iron-browser/ctl.sock`
 * 3. `<os.tmpdir()>/iron-browser-<uid>/ctl.sock`
 */
export function resolveControlSocketPath(): string {
  const override = process.env.IRON_BROWSER_SOCKET;
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir && runtimeDir.trim().length > 0) {
    return path.join(runtimeDir.trim(), 'iron-browser', 'ctl.sock');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), `iron-browser-${uid}`, 'ctl.sock');
}

function ensureSecureSocketDir(dir: string): void {
  // Only enforce strict 0700 ownership when creating our dedicated socket directory (not shared /tmp).
  const isSharedTmp = path.resolve(dir) === path.resolve(os.tmpdir());
  if (isSharedTmp) {
    return;
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing to use non-directory or symlink socket dir: ${dir}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(
      `refusing to use socket dir not owned by current user (uid=${stat.uid}): ${dir}`,
    );
  }
  fs.chmodSync(dir, 0o700);
}

async function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      probe.destroy();
      resolve(false);
    }, 300);

    probe.once('connect', () => {
      clearTimeout(timer);
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => {
      clearTimeout(timer);
      probe.destroy();
      resolve(false);
    });
  });
}

export class ControlSocketServer {
  private server: net.Server | null = null;
  private boundBySelf = false;
  public readonly socketPath: string;

  constructor(private readonly tabManager: TabManager, socketPath?: string) {
    this.socketPath = socketPath ?? resolveControlSocketPath();
  }

  async start(): Promise<string> {
    const dir = path.dirname(this.socketPath);
    ensureSecureSocketDir(dir);

    let existingStat: fs.Stats | null = null;
    try {
      existingStat = fs.lstatSync(this.socketPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') throw err;
    }

    if (existingStat) {
      if (!existingStat.isSocket()) {
        throw new Error(`refusing to overwrite non-socket path: ${this.socketPath}`);
      }
      if (await isSocketAlive(this.socketPath)) {
        throw new Error(
          `another IronBrowser instance is already listening on ${this.socketPath}`,
        );
      }
      fs.unlinkSync(this.socketPath);
    }

    const server = net.createServer((socket) => {
      const decoder = new FrameDecoder();

      socket.on('data', (chunk) => {
        let messages: unknown[];
        try {
          messages = decoder.push(chunk);
        } catch (err) {
          const resp: CtlRpcResponse = {
            id: 0,
            ok: false,
            error: {
              code: -32600,
              message: err instanceof Error ? err.message : 'invalid frame',
            },
          };
          try {
            socket.write(encodeFrame(resp));
          } catch {
            // Ignore write errors on broken pipe.
          }
          socket.destroy();
          return;
        }

        for (const msg of messages) {
          void this.handleMessage(socket, msg as CtlRpcRequest);
        }
      });

      socket.on('error', () => {
        // Ignore transient client disconnects.
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });

    fs.chmodSync(this.socketPath, 0o600);
    this.server = server;
    this.boundBySelf = true;
    return this.socketPath;
  }

  private async handleMessage(socket: net.Socket, req: CtlRpcRequest): Promise<void> {
    const id = req?.id ?? 0;
    const method = typeof req?.method === 'string' ? req.method : '';
    const params =
      req?.params && typeof req.params === 'object' && !Array.isArray(req.params)
        ? (req.params as Record<string, unknown>)
        : {};

    const reply = (resp: CtlRpcResponse) => {
      if (socket.destroyed) return;
      let encoded: Buffer;
      try {
        encoded = encodeFrame(resp);
      } catch (err) {
        const fallback: CtlRpcResponse = {
          id,
          ok: false,
          error: {
            code: -32001,
            message: `RESPONSE_TOO_LARGE: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
        try {
          encoded = encodeFrame(fallback);
        } catch {
          socket.destroy();
          return;
        }
      }
      try {
        socket.write(encoded);
      } catch {
        // Ignore write failure on closed peer.
      }
    };

    try {
      const result = await this.dispatch(method, params);
      reply({ id, ok: true, result });
    } catch (err) {
      reply({
        id,
        ok: false,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'ping':
        return { pong: true, version: '0.1.0', socketPath: this.socketPath };

      case 'browser_tabs': {
        const activeId = this.tabManager.getActiveTab()?.id;
        if (activeId) {
          await this.tabManager.refreshTabViewportReport(activeId, 250).catch(() => {});
        }
        const state = this.tabManager.getShellState();
        const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? null;
        return {
          activeTabId: state.activeTabId,
          tabs: state.tabs,
          viewportReport: activeTab?.viewportReport ?? {},
        };
      }

      case 'browser_open': {
        const rawUrl = typeof params.url === 'string' ? params.url : '';
        if (!rawUrl.trim()) throw new Error('url is required');
        const validatedUrl = normalizeUrl(rawUrl);
        const state = this.tabManager.createTab({
          url: validatedUrl,
          mode: params.mode === 'single' || params.mode === 'dual' ? (params.mode as ViewMode) : 'dual',
          session:
            params.session === 'shared' || params.session === 'isolated'
              ? (params.session as SessionMode)
              : 'shared',
          portraitPresetId:
            typeof params.portrait_preset === 'string' ? params.portrait_preset : undefined,
          landscapePresetId:
            typeof params.landscape_preset === 'string' ? params.landscape_preset : undefined,
          portraitSize: validateViewportSizeInput(params.portrait_size, 'portrait_size'),
          landscapeSize: validateViewportSizeInput(params.landscape_size, 'landscape_size'),
        });
        const activeTabId = state.activeTabId;
        const viewportReport = activeTabId
          ? await this.tabManager.refreshTabViewportReport(activeTabId, 200).catch(() => ({}))
          : {};
        const refreshedState = this.tabManager.getShellState();
        return {
          activeTabId: refreshedState.activeTabId,
          tab: refreshedState.tabs.find((t) => t.id === refreshedState.activeTabId) ?? null,
          viewportReport,
        };
      }

      case 'browser_navigate': {
        const url = typeof params.url === 'string' ? params.url : '';
        if (!url.trim()) throw new Error('url is required');
        const validatedUrl = normalizeUrl(url);
        const tabId = typeof params.tab_id === 'string' ? params.tab_id : undefined;
        const state = this.tabManager.navigate(validatedUrl, tabId);
        const targetId = tabId ?? state.activeTabId ?? undefined;
        const viewportReport = targetId
          ? await this.tabManager.refreshTabViewportReport(targetId, 200).catch(() => ({}))
          : {};
        const refreshedState = this.tabManager.getShellState();
        return {
          activeTabId: refreshedState.activeTabId,
          tab: refreshedState.tabs.find((t) => t.id === (tabId ?? refreshedState.activeTabId)) ?? null,
          viewportReport,
        };
      }

      case 'browser_screenshot': {
        const tabId = typeof params.tab_id === 'string' ? params.tab_id : undefined;
        const target =
          params.target === 'portrait' || params.target === 'landscape' || params.target === 'both'
            ? params.target
            : 'both';
        const exactSize = params.exact_size === true;
        const highlightClipped = params.highlight_clipped === true;
        const clip = validateClipRegionInput(params.clip, 'clip');
        const perPaneTimeoutMs =
          typeof params.timeout_ms === 'number' && Number.isFinite(params.timeout_ms)
            ? params.timeout_ms
            : undefined;
        return await this.tabManager.captureScreenshots(tabId, target, {
          exactSize,
          highlightClipped,
          clip,
          perPaneTimeoutMs,
        });
      }

      case 'browser_metrics': {
        return await this.tabManager.telemetry.sampleOnce();
      }

      case 'browser_interact': {
        const action = params.action;
        if (
          action !== 'click' &&
          action !== 'type' &&
          action !== 'scroll' &&
          action !== 'key' &&
          action !== 'hover'
        ) {
          throw new Error('action must be one of click|type|scroll|key|hover');
        }
        return await this.tabManager.interact({
          tabId: typeof params.tab_id === 'string' ? params.tab_id : undefined,
          viewport:
            params.viewport === 'portrait' || params.viewport === 'landscape'
              ? (params.viewport as ViewportRole)
              : undefined,
          action,
          selector: typeof params.selector === 'string' ? params.selector : undefined,
          text: typeof params.text === 'string' ? params.text : undefined,
          key: typeof params.key === 'string' ? params.key : undefined,
          x: typeof params.x === 'number' ? params.x : undefined,
          y: typeof params.y === 'number' ? params.y : undefined,
          ratioY: typeof params.ratio_y === 'number' ? params.ratio_y : undefined,
          mirror: typeof params.mirror === 'boolean' ? params.mirror : undefined,
        });
      }

      case 'browser_console': {
        const tabId =
          typeof params.tab_id === 'string'
            ? params.tab_id
            : this.tabManager.getActiveTab()?.id;
        const viewport =
          params.viewport === 'portrait' ||
          params.viewport === 'landscape' ||
          params.viewport === 'both'
            ? params.viewport
            : 'both';
        const level = typeof params.level === 'string' ? params.level : 'all';
        const limit = typeof params.limit === 'number' ? params.limit : 50;
        const entries = this.tabManager.telemetry.getConsoleEntries({
          tabId,
          viewport,
          level,
          limit,
        });
        const includeIncidents = params.include_incidents === true;
        return {
          tabId,
          count: entries.length,
          entries,
          ...(includeIncidents
            ? {
                incidents: this.tabManager.telemetry.getDiagnosticIncidents({
                  tabId,
                  viewport,
                  limit,
                }),
              }
            : {}),
        };
      }

      case 'browser_network': {
        const tabId =
          typeof params.tab_id === 'string'
            ? params.tab_id
            : this.tabManager.getActiveTab()?.id;
        const viewport =
          params.viewport === 'portrait' ||
          params.viewport === 'landscape' ||
          params.viewport === 'both'
            ? params.viewport
            : 'both';
        const filter =
          params.filter === 'failed' ||
          params.filter === '4xx' ||
          params.filter === '5xx' ||
          params.filter === 'all'
            ? params.filter
            : 'all';
        const limit = typeof params.limit === 'number' ? params.limit : 50;
        const entries = this.tabManager.telemetry.getNetworkEntries({
          tabId,
          viewport,
          filter,
          limit,
        });
        const includeIncidents = params.include_incidents === true;
        return {
          tabId,
          count: entries.length,
          entries,
          ...(includeIncidents
            ? {
                incidents: this.tabManager.telemetry.getDiagnosticIncidents({
                  tabId,
                  viewport,
                  limit,
                }),
              }
            : {}),
        };
      }

      case 'browser_incidents': {
        const tabId =
          typeof params.tab_id === 'string'
            ? params.tab_id
            : this.tabManager.getActiveTab()?.id;
        const viewport =
          params.viewport === 'portrait' ||
          params.viewport === 'landscape' ||
          params.viewport === 'both'
            ? params.viewport
            : 'both';
        const limit = typeof params.limit === 'number' ? params.limit : 50;
        const windowMs = typeof params.window_ms === 'number' ? params.window_ms : undefined;
        const incidents = this.tabManager.telemetry.getDiagnosticIncidents({
          tabId,
          viewport,
          limit,
          windowMs,
        });
        return {
          tabId,
          count: incidents.length,
          incidents,
        };
      }

      case 'browser_repro': {
        const action = typeof params.action === 'string' ? params.action : '';
        switch (action) {
          case 'save': {
            const recipe = this.tabManager.saveReproRecipe(params);
            return { ok: true, recipe };
          }
          case 'load': {
            const name = typeof params.name === 'string' ? params.name : '';
            const recipe = this.tabManager.loadReproRecipe(name);
            return { ok: true, recipe };
          }
          case 'list': {
            const recipes = this.tabManager.listReproRecipes();
            return { ok: true, count: recipes.length, recipes };
          }
          case 'delete': {
            const name = typeof params.name === 'string' ? params.name : '';
            const deleted = this.tabManager.deleteReproRecipe(name);
            return { ok: true, deleted };
          }
          case 'open': {
            if (typeof params.name === 'string' && params.name.trim()) {
              return await this.tabManager.openReproRecipe(params.name);
            }
            return await this.tabManager.openReproRecipe(params);
          }
          case 'step': {
            return await this.tabManager.stepPairedScene({
              tabId: typeof params.tab_id === 'string' ? params.tab_id : undefined,
              seed:
                typeof params.seed === 'string' || typeof params.seed === 'number'
                  ? params.seed
                  : undefined,
              phase: typeof params.phase === 'string' ? params.phase : undefined,
              frame: typeof params.frame === 'number' ? params.frame : undefined,
              deltaFrames:
                typeof params.delta_frames === 'number' ? params.delta_frames : undefined,
              multiplier: typeof params.multiplier === 'number' ? params.multiplier : undefined,
              timeMs: typeof params.time_ms === 'number' ? params.time_ms : undefined,
              fps: typeof params.fps === 'number' ? params.fps : undefined,
              canvasSelector:
                typeof params.canvas_selector === 'string' ? params.canvas_selector : undefined,
            });
          }
          default:
            throw new Error(
              'browser_repro action must be one of save|load|list|delete|open|step',
            );
        }
      }

      case 'browser_filmstrip': {
        const clipRegion = validateClipRegionInput(params.clip_region, 'clip_region');
        const maxTileWidth =
          typeof params.max_tile_width === 'number' && Number.isFinite(params.max_tile_width)
            ? Math.min(Math.max(Math.round(params.max_tile_width), 120), 1920)
            : undefined;
        return await this.tabManager.exportLabelledFilmstrip({
          tabId: typeof params.tab_id === 'string' ? params.tab_id : undefined,
          recipeName: typeof params.recipe_name === 'string' ? params.recipe_name : undefined,
          seed:
            typeof params.seed === 'string' || typeof params.seed === 'number'
              ? params.seed
              : undefined,
          phase: typeof params.phase === 'string' ? params.phase : undefined,
          multiplier: typeof params.multiplier === 'number' ? params.multiplier : undefined,
          fps: typeof params.fps === 'number' ? params.fps : undefined,
          frames: Array.isArray(params.frames) ? (params.frames as number[]) : undefined,
          startFrame: typeof params.start_frame === 'number' ? params.start_frame : undefined,
          endFrame: typeof params.end_frame === 'number' ? params.end_frame : undefined,
          frameStep: typeof params.frame_step === 'number' ? params.frame_step : undefined,
          exactSize: typeof params.exact_size === 'boolean' ? params.exact_size : undefined,
          canvasOnly: typeof params.canvas_only === 'boolean' ? params.canvas_only : undefined,
          canvasSelector:
            typeof params.canvas_selector === 'string' ? params.canvas_selector : undefined,
          clipRegion,
          maxTileWidth,
        });
      }

      case 'browser_trace_start': {
        return await this.tabManager.startPerfTrace({
          tabId: typeof params.tab_id === 'string' ? params.tab_id : undefined,
          maxDurationMs:
            typeof params.max_duration_ms === 'number' ? params.max_duration_ms : undefined,
          maxFrames: typeof params.max_frames === 'number' ? params.max_frames : undefined,
        });
      }

      case 'browser_trace_stop': {
        return await this.tabManager.stopPerfTrace({
          tabId: typeof params.tab_id === 'string' ? params.tab_id : undefined,
        });
      }

      case 'browser_eval': {
        const expression = typeof params.expression === 'string' ? params.expression : '';
        if (!expression) throw new Error('expression is required');
        return await this.tabManager.evalJs({
          tabId: typeof params.tab_id === 'string' ? params.tab_id : undefined,
          viewport:
            params.viewport === 'portrait' || params.viewport === 'landscape'
              ? (params.viewport as ViewportRole)
              : undefined,
          expression,
          maxBytes: typeof params.max_bytes === 'number' ? params.max_bytes : undefined,
        });
      }

      default:
        throw new Error(`unknown RPC method: ${method}`);
    }
  }

  close(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (this.boundBySelf) {
      this.boundBySelf = false;
      try {
        const st = fs.lstatSync(this.socketPath);
        if (st.isSocket()) {
          fs.unlinkSync(this.socketPath);
        }
      } catch {
        // Ignore cleanup errors if already removed.
      }
    }
  }
}
