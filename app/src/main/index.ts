import { app, BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SessionMode, ThemeMode, ViewMode, ViewportRole } from '../shared/types';
import { type PersistedWindowBounds } from '../shared/session-store';
import { normalizeUrl } from '../shared/url';
import { ControlSocketServer } from './ctl-socket';
import { loadPersistedSession, savePersistedSession } from './session-file';
import { TabManager } from './tab-manager';

const userDataOverride = process.env.IRON_BROWSER_USER_DATA?.trim();
if (userDataOverride) {
  app.setPath('userData', path.resolve(userDataOverride));
}

// Wayland Ozone auto-detection + lean Chromium switches.
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');

let mainWindow: BrowserWindow | null = null;
let tabManager: TabManager | null = null;
let ctlServer: ControlSocketServer | null = null;
let sessionFilePath: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let lastNormalBounds: PersistedWindowBounds | undefined;
let sessionRestored = false;
let sessionFlushed = false;

function captureWindowBounds(win: BrowserWindow | null): PersistedWindowBounds | undefined {
  if (!win || win.isDestroyed()) return lastNormalBounds;
  const maximized = win.isMaximized();
  const bounds = maximized ? win.getNormalBounds() : win.getBounds();
  if (bounds.width >= 760 && bounds.height >= 520) {
    lastNormalBounds = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized,
    };
  } else if (lastNormalBounds) {
    lastNormalBounds = { ...lastNormalBounds, maximized };
  }
  return lastNormalBounds;
}

function flushSessionNow(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!sessionFilePath || !tabManager || !sessionRestored || sessionFlushed) return;
  try {
    const snapshot = tabManager.exportPersistedSession(captureWindowBounds(mainWindow));
    savePersistedSession(sessionFilePath, snapshot);
  } catch (err) {
    process.stderr.write(`IronBrowser session save error: ${String(err)}\n`);
  }
}

function scheduleSessionSave(): void {
  if (!sessionFilePath || !sessionRestored || sessionFlushed) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushSessionNow();
  }, 400);
}

function isBoundsVisibleOnAnyDisplay(bounds: PersistedWindowBounds): boolean {
  if (bounds.x === undefined || bounds.y === undefined) return false;
  const displays = screen.getAllDisplays();
  for (const display of displays) {
    const wa = display.workArea;
    const overlapX = Math.min(bounds.x + bounds.width, wa.x + wa.width) - Math.max(bounds.x, wa.x);
    const overlapY = Math.min(bounds.y + bounds.height, wa.y + wa.height) - Math.max(bounds.y, wa.y);
    if (overlapX >= 120 && overlapY >= 80) {
      return true;
    }
  }
  return false;
}

function parseInitialUrlFromArgv(): string | undefined {
  for (const arg of process.argv.slice(1)) {
    if (arg.startsWith('--') || arg === '.' || arg.endsWith('.js')) continue;
    if (/^(https?:|localhost|127\.0\.0\.1)/i.test(arg)) {
      try {
        return normalizeUrl(arg);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function assertShellSender(ev: IpcMainInvokeEvent, win: BrowserWindow): void {
  if (
    win.isDestroyed() ||
    win.webContents.isDestroyed() ||
    !ev?.sender ||
    !ev.senderFrame ||
    !win.webContents.mainFrame ||
    ev.sender.id !== win.webContents.id ||
    ev.senderFrame !== win.webContents.mainFrame
  ) {
    throw new Error('Unauthorized IPC sender for shell channel');
  }
}

function asObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Expected object IPC payload');
  }
  return raw as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid IPC field '${field}': expected non-empty string`);
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid IPC field '${field}': expected boolean`);
  }
  return value;
}

function asFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid IPC field '${field}': expected finite number`);
  }
  return value;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Invalid IPC field '${field}': expected one of ${allowed.join('|')}`);
  }
  return value as T;
}

export interface ShortcutTarget {
  tabManager: Pick<
    TabManager,
    | 'getShellState'
    | 'setRailCollapsed'
    | 'toggleDualMode'
    | 'toggleMirror'
    | 'createTab'
    | 'reopenClosedTab'
    | 'getActiveTab'
    | 'closeTab'
    | 'setDockOpen'
    | 'reload'
  > | null;
  mainWindow: Pick<BrowserWindow, 'webContents'> | null;
}

export function dispatchGlobalShortcut(
  input: Electron.Input,
  deps: ShortcutTarget,
): boolean {
  const { tabManager: mgr, mainWindow: win } = deps;
  if (!mgr || !win) return false;
  const ctrl = input.control || input.meta;
  const key = input.key.toLowerCase();

  if (ctrl && !input.shift && key === '\\') {
    const state = mgr.getShellState();
    mgr.setRailCollapsed(!state.railCollapsed);
    return true;
  }
  if (ctrl && !input.shift && key === 'l') {
    win.webContents.focus();
    win.webContents.send('shell:focus-url-bar');
    return true;
  }
  if (ctrl && input.shift && key === 'd') {
    mgr.toggleDualMode();
    return true;
  }
  if (ctrl && !input.shift && key === 'm') {
    mgr.toggleMirror();
    return true;
  }
  if (ctrl && !input.shift && key === 't') {
    mgr.createTab({ mode: 'dual' });
    return true;
  }
  if (ctrl && input.shift && key === 't') {
    mgr.reopenClosedTab();
    return true;
  }
  if (ctrl && !input.shift && key === 'w') {
    const active = mgr.getActiveTab();
    if (active) mgr.closeTab(active.id);
    return true;
  }
  if ((ctrl && !input.alt && key === 'r') || (!input.alt && key === 'f5')) {
    void mgr.reload();
    return true;
  }
  if (key === 'f12' || (ctrl && input.shift && key === 'i')) {
    const state = mgr.getShellState();
    mgr.setDockOpen(!state.dockOpen);
    return true;
  }
  return false;
}

function handleGlobalShortcut(input: Electron.Input): boolean {
  return dispatchGlobalShortcut(input, { tabManager, mainWindow });
}

export function registerIpcHandlers(
  win: BrowserWindow,
  mgr: TabManager,
  ipc: Pick<Electron.IpcMain, 'handle'> = ipcMain,
): void {
  const handleShell = (
    channel: string,
    fn: (args: unknown) => unknown,
  ): void => {
    ipc.handle(channel, (ev, args: unknown) => {
      assertShellSender(ev, win);
      return fn(args);
    });
  };

  handleShell('shell:get-initial-state', () => ({
    state: mgr.getShellState(),
    presets: mgr.getPresets(),
  }));

  handleShell('shell:new-tab', (raw) => {
    if (raw === undefined || raw === null) {
      return mgr.createTab();
    }
    const obj = asObject(raw);
    const url = obj.url !== undefined ? asNonEmptyString(obj.url, 'url') : undefined;
    const mode =
      obj.mode !== undefined
        ? asEnum<ViewMode>(obj.mode, ['single', 'dual'], 'mode')
        : undefined;
    return mgr.createTab({ url, mode });
  });

  handleShell('shell:close-tab', (raw) => {
    const obj = asObject(raw);
    return mgr.closeTab(asNonEmptyString(obj.tabId, 'tabId'));
  });

  handleShell('shell:select-tab', (raw) => {
    const obj = asObject(raw);
    return mgr.selectTab(asNonEmptyString(obj.tabId, 'tabId'));
  });

  handleShell('shell:sleep-tab', (raw) => {
    const obj = asObject(raw);
    return mgr.sleepTab(asNonEmptyString(obj.tabId, 'tabId'));
  });

  handleShell('shell:navigate', (raw) => {
    const obj = asObject(raw);
    return mgr.navigate(asNonEmptyString(obj.url, 'url'));
  });

  handleShell('shell:go-back', () => mgr.goBack());
  handleShell('shell:go-forward', () => mgr.goForward());
  handleShell('shell:reload', () => mgr.reload());
  handleShell('shell:toggle-dual-mode', () => mgr.toggleDualMode());
  handleShell('shell:toggle-mirror', () => mgr.toggleMirror());
  handleShell('shell:toggle-dedup', (raw) => {
    if (raw === undefined || raw === null) {
      return mgr.toggleDedup();
    }
    const obj = asObject(raw);
    const tabId = obj.tabId !== undefined ? asNonEmptyString(obj.tabId, 'tabId') : undefined;
    return mgr.toggleDedup(tabId);
  });
  handleShell('shell:toggle-session-mode', () => mgr.toggleSessionMode());

  handleShell('shell:set-session-mode', (raw) => {
    const obj = asObject(raw);
    return mgr.setSessionMode(
      asEnum<SessionMode>(obj.mode, ['shared', 'isolated'], 'mode'),
    );
  });

  handleShell('shell:set-preset', (raw) => {
    const obj = asObject(raw);
    return mgr.setPreset(
      asEnum<ViewportRole>(obj.role, ['portrait', 'landscape'], 'role'),
      asNonEmptyString(obj.presetId, 'presetId'),
    );
  });

  handleShell('shell:set-rail-collapsed', (raw) => {
    const obj = asObject(raw);
    return mgr.setRailCollapsed(asBoolean(obj.collapsed, 'collapsed'));
  });

  handleShell('shell:set-dock-open', (raw) => {
    const obj = asObject(raw);
    return mgr.setDockOpen(asBoolean(obj.open, 'open'));
  });

  handleShell('shell:set-dock-height', (raw) => {
    const obj = asObject(raw);
    return mgr.setDockHeight(asFiniteNumber(obj.height, 'height'));
  });

  handleShell('shell:set-split-ratio', (raw) => {
    const obj = asObject(raw);
    return mgr.setSplitRatio(asFiniteNumber(obj.ratio, 'ratio'));
  });

  handleShell('shell:set-devtools-target', (raw) => {
    const obj = asObject(raw);
    return mgr.setDevToolsTarget(
      asEnum<ViewportRole>(obj.role, ['portrait', 'landscape'], 'role'),
    );
  });

  handleShell('shell:toggle-audio', (raw) => {
    const obj = asObject(raw);
    return mgr.toggleAudio(asEnum<ViewportRole>(obj.role, ['portrait', 'landscape'], 'role'));
  });

  handleShell('shell:set-theme', (raw) => {
    const obj = asObject(raw);
    return mgr.setTheme(asEnum<ThemeMode>(obj.theme, ['dark', 'light'], 'theme'));
  });

  handleShell('shell:focus-anomaly', (raw) => {
    const obj = asObject(raw);
    return mgr.focusAnomaly(
      asEnum<'console' | 'network'>(obj.kind, ['console', 'network'], 'kind'),
    );
  });

  handleShell('shell:open-history-menu', (raw) => {
    if (raw === undefined || raw === null) {
      mgr.openHistoryMenu();
      return;
    }
    const obj = asObject(raw);
    const x = obj.x !== undefined ? asFiniteNumber(obj.x, 'x') : undefined;
    const y = obj.y !== undefined ? asFiniteNumber(obj.y, 'y') : undefined;
    mgr.openHistoryMenu(x, y);
  });

  handleShell('shell:remove-history-item', (raw) => {
    const obj = asObject(raw);
    return mgr.removeHistoryItem(asNonEmptyString(obj.url, 'url'));
  });

  handleShell('shell:clear-history', () => mgr.clearHistory());
  handleShell('shell:reopen-closed-tab', () => mgr.reopenClosedTab());
  handleShell('shell:toggle-eco-mode', () => mgr.toggleEcoMode());
  handleShell('shell:set-auto-sleep', (raw) => {
    const obj = asObject(raw);
    return mgr.setAutoSleep(asBoolean(obj.enabled, 'enabled'));
  });
  handleShell('shell:copy-mirror-miss-debug', () => mgr.copyMirrorMissDebug());
}

async function createMainWindow(): Promise<void> {
  const isSmoke = process.env.IRON_BROWSER_SMOKE === '1' || process.argv.includes('--smoke');
  const explicitStateFile = process.env.IRON_BROWSER_STATE_FILE?.trim();
  sessionFilePath = explicitStateFile
    ? explicitStateFile
    : isSmoke
      ? null
      : path.join(app.getPath('userData'), 'session-state.json');

  const savedSession = sessionFilePath ? loadPersistedSession(sessionFilePath) : null;
  const savedWin = savedSession?.window;
  const useSavedPos = savedWin ? isBoundsVisibleOnAnyDisplay(savedWin) : false;

  const distRoot = path.join(app.getAppPath(), 'dist');
  const shellPreloadPath = path.join(distRoot, 'preload', 'shell-preload.js');
  const mirrorPreloadPath = path.join(distRoot, 'preload', 'mirror-preload.js');
  const rendererHtmlPath = path.join(distRoot, 'renderer', 'index.html');
  const expectedRendererUrl = pathToFileURL(rendererHtmlPath).toString();

  const iconPath = path.join(app.getAppPath(), '..', 'packaging', 'iron-browser.png');
  const win = new BrowserWindow({
    width: savedWin?.width ?? 1480,
    height: savedWin?.height ?? 920,
    ...(useSavedPos && savedWin?.x !== undefined && savedWin?.y !== undefined
      ? { x: savedWin.x, y: savedWin.y }
      : {}),
    minWidth: 760,
    minHeight: 520,
    show: !isSmoke,
    title: 'IronBrowser',
    icon: iconPath,
    backgroundColor: savedSession?.theme === 'light' ? '#f5f7fb' : '#060b13',
    autoHideMenuBar: true,
    webPreferences: {
      preload: shellPreloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;
  if (!isSmoke && savedWin?.maximized) {
    win.maximize();
  }
  captureWindowBounds(win);

  win.on('resize', () => {
    captureWindowBounds(win);
    scheduleSessionSave();
  });
  win.on('move', () => {
    captureWindowBounds(win);
    scheduleSessionSave();
  });
  win.on('maximize', () => {
    captureWindowBounds(win);
    scheduleSessionSave();
  });
  win.on('unmaximize', () => {
    captureWindowBounds(win);
    scheduleSessionSave();
  });
  win.on('close', () => {
    flushSessionNow();
    sessionFlushed = true;
  });

  // Lock main shell window against external navigation or popup windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (ev, targetUrl) => {
    if (targetUrl !== expectedRendererUrl) {
      ev.preventDefault();
    }
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && handleGlobalShortcut(input)) {
      event.preventDefault();
    }
  });

  const mgr = new TabManager(win, mirrorPreloadPath, handleGlobalShortcut, scheduleSessionSave);
  tabManager = mgr;
  registerIpcHandlers(win, mgr);

  await win.loadFile(rendererHtmlPath);

  const initialUrl = parseInitialUrlFromArgv();
  mgr.restoreSession(savedSession, initialUrl);
  sessionRestored = true;
  mgr.telemetry.start();

  const ctl = new ControlSocketServer(mgr);
  ctlServer = ctl;
  const sockPath = await ctl.start();

  if (isSmoke) {
    process.stdout.write(`IRON_BROWSER_READY ${sockPath}\n`);
    const smokeExitArg = process.argv.find((a) => a.startsWith('--smoke-exit-ms='));
    if (smokeExitArg) {
      const ms = Number(smokeExitArg.split('=')[1] ?? 500);
      setTimeout(() => {
        app.quit();
      }, Number.isFinite(ms) ? Math.max(100, ms) : 500);
    }
  }
}

app.whenReady().then(() => {
  void createMainWindow().catch((err) => {
    process.stderr.write(`IronBrowser startup error: ${String(err)}\n`);
    app.exit(1);
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

let shuttingDown = false;

app.on('before-quit', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  flushSessionNow();
  sessionFlushed = true;
  ctlServer?.close();
  tabManager?.dispose();
});

function handleShutdownSignal(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  flushSessionNow();
  sessionFlushed = true;
  ctlServer?.close();
  tabManager?.dispose();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
  app.quit();
  setTimeout(() => {
    app.exit(0);
  }, 250).unref();
}

process.once('SIGTERM', handleShutdownSignal);
process.once('SIGINT', handleShutdownSignal);
