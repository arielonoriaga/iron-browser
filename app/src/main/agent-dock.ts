import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type {
  BrowserWindow as BrowserWindowType,
  IpcMain,
  IpcMainInvokeEvent,
  WebContentsView as WebContentsViewType,
} from 'electron';

function loadElectronRuntime(): {
  ipcMain?: IpcMain;
  WebContentsView?: typeof WebContentsViewType;
} {
  try {
    const mod =
      typeof require === 'function'
        ? require('electron')
        : createRequire(path.join(__dirname, 'index.js'))('electron');
    if (mod && typeof mod === 'object') {
      return mod as { ipcMain?: IpcMain; WebContentsView?: typeof WebContentsViewType };
    }
  } catch {
    // Running outside Electron runtime (e.g. unit test VM).
  }
  return {};
}
import { DEFAULT_AGENT_DOCK_WIDTH } from '../shared/layout';
import type {
  AgentCliPreset,
  AgentDockMode,
  AgentDockState,
  AgentSessionSnapshot,
  Rect,
  RunningAgentInstance,
} from '../shared/types';
import { loadNativePtyBinding, type NativePtyBinding } from './tab-event-bus';

const execFileAsync = promisify(execFile);

const MAX_TRANSCRIPT_CHARS = 180_000;
const PANE_TARGET_RE = /^[A-Za-z0-9_.-]+:[0-9]+\.[0-9]+$/;
const AGENT_CMDS = new Set([
  'agy',
  'claude',
  'codex',
  'opencode',
  'iron',
  'iron-term',
  'bun',
  'node',
]);

export interface AgentDockCallbacks {
  getSocketPath(): string;
  getActiveTabId(): string | null;
  getBrowserContextSnippet(): string;
  onLayoutChanged(): void;
}

export function assertAgentSender(
  ev: IpcMainInvokeEvent,
  agentView: Pick<WebContentsViewType, 'webContents'> | null,
  expectedUrl?: string,
): void {
  if (
    !agentView ||
    agentView.webContents.isDestroyed() ||
    !ev?.sender ||
    !ev.senderFrame ||
    !agentView.webContents.mainFrame ||
    ev.sender.id !== agentView.webContents.id ||
    ev.senderFrame !== agentView.webContents.mainFrame ||
    (expectedUrl &&
      typeof ev.senderFrame.url === 'string' &&
      ev.senderFrame.url.length > 0 &&
      ev.senderFrame.url !== expectedUrl)
  ) {
    throw new Error('Unauthorized IPC sender for agent dock channel');
  }
}

export function parseTmuxListPanesOutput(stdout: string): RunningAgentInstance[] {
  const out: RunningAgentInstance[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const [target = '', windowName = '', command = '', cwd = '', pidRaw = '0'] = line.split('\t');
    if (!PANE_TARGET_RE.test(target)) continue;
    const pid = Number.parseInt(pidRaw, 10) || 0;
    const cmdLower = command.toLowerCase();
    const winLower = windowName.toLowerCase();
    const isAgentLike =
      AGENT_CMDS.has(cmdLower) ||
      winLower.includes('claude') ||
      winLower.includes('agy') ||
      winLower.includes('codex') ||
      winLower.includes('opencode') ||
      winLower.includes('perf') ||
      winLower.includes('iron');
    out.push({
      target,
      windowName: windowName || target,
      command: command || 'shell',
      cwd: cwd || '',
      pid,
      isAgentLike,
    });
  }
  out.sort((a, b) => {
    if (a.isAgentLike !== b.isAgentLike) return a.isAgentLike ? -1 : 1;
    return a.target.localeCompare(b.target);
  });
  return out;
}

export function resolveMcpBinaryPath(): string {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'iron-browser-mcp'),
    path.resolve(__dirname, '../../../target/release/iron-browser-mcp'),
    path.resolve(process.cwd(), '../target/release/iron-browser-mcp'),
    path.resolve(process.cwd(), 'target/release/iron-browser-mcp'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Try next.
    }
  }
  return 'iron-browser-mcp';
}

export function writePerWindowMcpConfig(socketPath: string): string | null {
  try {
    const dir = path.dirname(socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    const cfgPath = path.join(dir, `mcp-${process.pid}.json`);
    try {
      if (fs.existsSync(cfgPath) && fs.lstatSync(cfgPath).isSymbolicLink()) {
        return null;
      }
    } catch {
      return null;
    }
    const payload = JSON.stringify(
      {
        mcpServers: {
          'iron-browser': {
            type: 'stdio',
            command: resolveMcpBinaryPath(),
            args: ['--socket', socketPath],
          },
        },
      },
      null,
      2,
    );
    fs.writeFileSync(cfgPath, payload, { encoding: 'utf8', mode: 0o600 });
    return cfgPath;
  } catch {
    return null;
  }
}

export class AgentDockManager {
  private view: WebContentsViewType | null = null;
  private mode: AgentDockMode;
  private width = DEFAULT_AGENT_DOCK_WIDTH;
  private floatBounds: Rect = { x: 1040, y: 56, width: 400, height: 540 };
  private readonly ptyBinding: NativePtyBinding | null;

  private activePtyId: number | null = null;
  private activePtyDecoder = new TextDecoder('utf-8');
  private ptyPollTimer: ReturnType<typeof setInterval> | null = null;
  private pendingPtyWriteChunks: Buffer[] = [];
  private pendingPtyWriteBytes = 0;
  private ptyWriteFlushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly expectedAgentUrl: string;

  private attachedPane: string | null = null;
  private lastTmuxCapture = '';
  private tmuxPollTimer: ReturnType<typeof setInterval> | null = null;

  private sessionMeta: AgentSessionSnapshot;
  private transcript = '';
  private disposed = false;
  private ipcRegistered = false;

  constructor(
    private readonly win: BrowserWindowType,
    private readonly agentPreloadPath: string,
    private readonly agentHtmlPath: string,
    private readonly callbacks: AgentDockCallbacks,
    options: { initialMode?: AgentDockMode; ptyBinding?: NativePtyBinding | null } = {},
  ) {
    this.mode = options.initialMode ?? 'minimized';
    this.expectedAgentUrl = this.agentHtmlPath
      ? pathToFileURL(path.resolve(this.agentHtmlPath)).toString()
      : '';
    this.ptyBinding =
      options.ptyBinding !== undefined ? options.ptyBinding : loadNativePtyBinding();
    this.sessionMeta = {
      active: false,
      kind: 'none',
      label: 'Idle',
      socketPath: this.callbacks.getSocketPath(),
    };
  }

  getState(): AgentDockState {
    return {
      mode: this.mode,
      width: this.width,
      floatBounds: { ...this.floatBounds },
      session: {
        ...this.sessionMeta,
        socketPath: this.callbacks.getSocketPath(),
      },
    };
  }

  getView(): WebContentsViewType | null {
    return this.view;
  }

  ensureViewCreated(): WebContentsViewType | null {
    if (this.disposed || this.win.isDestroyed()) return null;
    if (this.view && !this.view.webContents.isDestroyed()) {
      return this.view;
    }
    const WebContentsViewCtor = loadElectronRuntime().WebContentsView;
    if (typeof WebContentsViewCtor !== 'function') return null;

    const view = new WebContentsViewCtor({
      webPreferences: {
        preload: this.agentPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    view.setVisible(false);
    this.win.contentView.addChildView(view);
    this.view = view;

    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event, targetUrl) => {
      if (this.expectedAgentUrl && targetUrl !== this.expectedAgentUrl) {
        event.preventDefault();
      }
    });
    view.webContents.on('will-redirect', (event, targetUrl) => {
      if (this.expectedAgentUrl && targetUrl !== this.expectedAgentUrl) {
        event.preventDefault();
      }
    });
    view.webContents.on('before-input-event', (event, input) => {
      if (
        input.type === 'keyDown' &&
        (input.control || input.meta) &&
        !input.shift &&
        !input.alt &&
        (input.key === '`' || input.code === 'Backquote')
      ) {
        event.preventDefault();
        this.toggle();
      }
    });
    if (fs.existsSync(this.agentHtmlPath)) {
      void view.webContents.loadFile(this.agentHtmlPath).catch(() => {});
    }
    return view;
  }

  ensureTopMost(): void {
    if (!this.view || this.view.webContents.isDestroyed() || this.win.isDestroyed()) return;
    try {
      this.win.contentView.addChildView(this.view);
    } catch {
      // Ignore in stubbed unit test windows.
    }
  }

  applyBounds(rect: Rect | null): void {
    if (this.disposed || this.win.isDestroyed()) return;
    if (!rect || this.mode === 'minimized') {
      if (this.view && !this.view.webContents.isDestroyed()) {
        this.view.setVisible(false);
      }
      return;
    }
    const view = this.ensureViewCreated();
    if (!view || view.webContents.isDestroyed()) return;
    this.ensureTopMost();
    view.setBounds(rect);
    view.setVisible(true);
  }

  setMode(mode: AgentDockMode): AgentDockState {
    this.mode = mode;
    this.callbacks.onLayoutChanged();
    this.pushStateToView();
    return this.getState();
  }

  toggle(): AgentDockState {
    return this.setMode(this.mode === 'minimized' ? 'docked' : 'minimized');
  }

  setWidth(width: number): AgentDockState {
    if (Number.isFinite(width)) {
      this.width = Math.max(280, Math.min(680, Math.round(width)));
      this.callbacks.onLayoutChanged();
    }
    return this.getState();
  }

  setFloatBounds(partial: Partial<Rect>): AgentDockState {
    this.floatBounds = {
      x: Number.isFinite(partial.x) ? Math.round(partial.x!) : this.floatBounds.x,
      y: Number.isFinite(partial.y) ? Math.round(partial.y!) : this.floatBounds.y,
      width: Number.isFinite(partial.width) ? Math.round(partial.width!) : this.floatBounds.width,
      height: Number.isFinite(partial.height)
        ? Math.round(partial.height!)
        : this.floatBounds.height,
    };
    if (this.mode === 'floating') {
      this.callbacks.onLayoutChanged();
    }
    return this.getState();
  }

  async listRunningInstances(): Promise<RunningAgentInstance[]> {
    try {
      const { stdout } = await execFileAsync(
        'tmux',
        [
          'list-panes',
          '-a',
          '-F',
          '#{session_name}:#{window_index}.#{pane_index}\t#{window_name}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}',
        ],
        { timeout: 1500, maxBuffer: 512 * 1024 },
      );
      return parseTmuxListPanesOutput(stdout);
    } catch {
      return [];
    }
  }

  private appendTranscript(chunk: string, replace = false): void {
    if (replace) {
      this.transcript = chunk.slice(-MAX_TRANSCRIPT_CHARS);
    } else {
      this.transcript = (this.transcript + chunk).slice(-MAX_TRANSCRIPT_CHARS);
    }
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.send('agent:output', {
        chunk,
        replace,
      });
    }
  }

  private pushStateToView(): void {
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.send('agent:state', this.getState());
    }
  }

  private clearPtyWriteQueue(): void {
    if (this.ptyWriteFlushTimer) {
      clearInterval(this.ptyWriteFlushTimer);
      this.ptyWriteFlushTimer = null;
    }
    this.pendingPtyWriteChunks = [];
    this.pendingPtyWriteBytes = 0;
  }

  private flushPendingPtyWrites(): void {
    if (this.activePtyId === null || !this.ptyBinding || this.disposed) {
      this.clearPtyWriteQueue();
      return;
    }
    while (this.pendingPtyWriteChunks.length > 0) {
      const head = this.pendingPtyWriteChunks[0]!;
      const res = JSON.parse(
        this.ptyBinding.ptyWrite(this.activePtyId, head.toString('base64')),
      ) as { ok: boolean; bytesWritten?: number };
      if (!res.ok) {
        this.clearPtyWriteQueue();
        return;
      }
      const written = Math.max(0, Math.min(head.length, res.bytesWritten ?? 0));
      if (written >= head.length) {
        this.pendingPtyWriteChunks.shift();
        this.pendingPtyWriteBytes = Math.max(0, this.pendingPtyWriteBytes - head.length);
      } else {
        if (written > 0) {
          this.pendingPtyWriteChunks[0] = head.subarray(written);
          this.pendingPtyWriteBytes = Math.max(0, this.pendingPtyWriteBytes - written);
        }
        return;
      }
    }
    if (this.pendingPtyWriteChunks.length === 0 && this.ptyWriteFlushTimer) {
      clearInterval(this.ptyWriteFlushTimer);
      this.ptyWriteFlushTimer = null;
    }
  }

  stopSession(): AgentDockState {
    if (this.ptyPollTimer) {
      clearInterval(this.ptyPollTimer);
      this.ptyPollTimer = null;
    }
    this.clearPtyWriteQueue();
    if (this.tmuxPollTimer) {
      clearInterval(this.tmuxPollTimer);
      this.tmuxPollTimer = null;
    }
    if (this.activePtyId !== null && this.ptyBinding) {
      try {
        this.ptyBinding.ptyKill(this.activePtyId);
      } catch {
        // Ignore teardown errors.
      }
      this.activePtyId = null;
    }
    this.attachedPane = null;
    this.lastTmuxCapture = '';
    this.sessionMeta = {
      active: false,
      kind: 'none',
      label: 'Idle',
      socketPath: this.callbacks.getSocketPath(),
    };
    this.callbacks.onLayoutChanged();
    this.pushStateToView();
    return this.getState();
  }

  async attachRunningInstance(targetPane: string): Promise<AgentDockState> {
    const cleanTarget = targetPane.trim();
    if (!PANE_TARGET_RE.test(cleanTarget)) {
      throw new Error(`Invalid tmux pane target: ${cleanTarget}`);
    }
    this.stopSession();
    this.attachedPane = cleanTarget;
    this.sessionMeta = {
      active: true,
      kind: 'tmux',
      label: `tmux ${cleanTarget}`,
      targetPane: cleanTarget,
      socketPath: this.callbacks.getSocketPath(),
    };
    this.transcript = '';
    await this.captureAttachedPaneOnce(true);

    this.tmuxPollTimer = setInterval(() => {
      void this.captureAttachedPaneOnce(false);
    }, 400);
    this.tmuxPollTimer.unref?.();

    this.callbacks.onLayoutChanged();
    this.pushStateToView();
    return this.getState();
  }

  private async captureAttachedPaneOnce(force: boolean): Promise<void> {
    const pane = this.attachedPane;
    if (!pane || this.disposed) return;
    try {
      const { stdout } = await execFileAsync(
        'tmux',
        ['capture-pane', '-p', '-J', '-t', pane, '-S', '-160'],
        { timeout: 1200, maxBuffer: 1024 * 1024 },
      );
      if (this.attachedPane !== pane) return;
      if (force || stdout !== this.lastTmuxCapture) {
        this.lastTmuxCapture = stdout;
        this.appendTranscript(stdout, true);
      }
    } catch (err) {
      if (this.attachedPane !== pane) return;
      this.appendTranscript(
        `\n[IronBrowser: tmux pane ${pane} ended or became unreachable: ${String(err)}]\n`,
        false,
      );
      this.stopSession();
    }
  }

  startCliAgent(input: {
    preset: AgentCliPreset;
    customCommand?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
  }): AgentDockState {
    if (!this.ptyBinding) {
      throw new Error('Native Rust PTY binding is unavailable (run `bun run build:native`)');
    }
    this.stopSession();

    const socketPath = this.callbacks.getSocketPath();
    const mcpCfgPath = writePerWindowMcpConfig(socketPath);
    const resolvedCwd = (() => {
      const raw = input.cwd?.trim();
      if (raw && fs.existsSync(raw)) {
        try {
          if (fs.statSync(raw).isDirectory()) return raw;
        } catch {
          // Fallback below.
        }
      }
      return process.cwd();
    })();

    const userShell = process.env.SHELL?.trim() || '/bin/bash';
    let program = userShell;
    let args: string[] = [];
    let label: string = input.preset;

    switch (input.preset) {
      case 'agy':
        program = 'agy';
        args = [];
        label = 'agy';
        break;
      case 'claude':
        program = 'claude';
        args = mcpCfgPath ? ['--mcp-config', mcpCfgPath] : [];
        label = 'claude';
        break;
      case 'codex':
        program = 'codex';
        args = [];
        label = 'codex';
        break;
      case 'opencode':
        program = 'opencode';
        args = [];
        label = 'opencode';
        break;
      case 'shell':
        program = userShell;
        args = ['-i'];
        label = path.basename(userShell);
        break;
      case 'custom': {
        const cmd = (input.customCommand ?? '').trim();
        if (!cmd || cmd.length > 512) {
          throw new Error('Custom CLI command must be 1..512 characters');
        }
        program = userShell;
        args = ['-lc', cmd];
        label = cmd.split(/\s+/)[0]?.slice(0, 24) || 'custom';
        break;
      }
    }

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string' && k !== 'ELECTRON_RUN_AS_NODE') {
        env[k] = v;
      }
    }
    env.IRON_BROWSER_SOCKET = socketPath;
    const activeTabId = this.callbacks.getActiveTabId();
    if (activeTabId) env.IRON_BROWSER_DEFAULT_TAB = activeTabId;
    if (mcpCfgPath) env.IRON_BROWSER_MCP_CONFIG = mcpCfgPath;

    const rawSpawn = this.ptyBinding.ptySpawn(
      JSON.stringify({
        program,
        args,
        cwd: resolvedCwd,
        env,
        cols: Math.max(30, Math.min(300, Math.trunc(input.cols ?? 92))),
        rows: Math.max(10, Math.min(160, Math.trunc(input.rows ?? 30))),
      }),
    );
    const parsed = JSON.parse(rawSpawn) as {
      ok: boolean;
      id?: number;
      pid?: number;
      error?: string;
    };
    if (!parsed.ok || typeof parsed.id !== 'number') {
      throw new Error(parsed.error ?? `Failed to launch '${label}'`);
    }

    this.activePtyId = parsed.id;
    this.activePtyDecoder = new TextDecoder('utf-8');
    this.transcript = '';
    this.appendTranscript(
      `[IronBrowser Agent PTY · ${label} (pid ${parsed.pid ?? '?'}) · IRON_BROWSER_SOCKET=${socketPath}]\r\n`,
      true,
    );

    this.sessionMeta = {
      active: true,
      kind: 'pty',
      label,
      preset: input.preset,
      cwd: resolvedCwd,
      pid: parsed.pid ?? null,
      exited: false,
      exitCode: null,
      socketPath,
    };

    this.ptyPollTimer = setInterval(() => {
      this.pollPtyOnce();
    }, 35);
    this.ptyPollTimer.unref?.();

    this.callbacks.onLayoutChanged();
    this.pushStateToView();
    return this.getState();
  }

  private pollPtyOnce(): void {
    if (this.activePtyId === null || !this.ptyBinding || this.disposed) return;
    try {
      const raw = this.ptyBinding.ptyPoll(this.activePtyId);
      const polled = JSON.parse(raw) as {
        ok: boolean;
        dataB64: string;
        exited: boolean;
        exitCode: number | null;
      };
      if (!polled.ok) return;
      if (polled.dataB64) {
        const bytes = Buffer.from(polled.dataB64, 'base64');
        const text = this.activePtyDecoder.decode(bytes, { stream: !polled.exited });
        if (text) this.appendTranscript(text, false);
      }
      if (polled.exited && !this.sessionMeta.exited) {
        const finishedId = this.activePtyId;
        this.activePtyId = null;
        this.clearPtyWriteQueue();
        try {
          this.ptyBinding.ptyKill(finishedId);
        } catch {
          // Ignore teardown errors.
        }
        this.sessionMeta.exited = true;
        this.sessionMeta.exitCode = polled.exitCode;
        this.sessionMeta.active = false;
        this.appendTranscript(
          `\r\n[Process '${this.sessionMeta.label}' exited with code ${polled.exitCode ?? 0}]\r\n`,
          false,
        );
        if (this.ptyPollTimer) {
          clearInterval(this.ptyPollTimer);
          this.ptyPollTimer = null;
        }
        this.callbacks.onLayoutChanged();
        this.pushStateToView();
      }
    } catch {
      // Ignore transient poll parse errors.
    }
  }

  async writeInput(data: string, submitEnter = false): Promise<boolean> {
    if (!data && !submitEnter) return false;
    if (this.sessionMeta.kind === 'pty' && this.activePtyId !== null && this.ptyBinding) {
      const payload = Buffer.from(submitEnter ? `${data}\r` : data, 'utf8');
      if (this.pendingPtyWriteBytes + payload.length > 256 * 1024) {
        return false;
      }
      if (this.pendingPtyWriteChunks.length > 0) {
        this.pendingPtyWriteChunks.push(payload);
        this.pendingPtyWriteBytes += payload.length;
        this.flushPendingPtyWrites();
        return true;
      }
      const res = JSON.parse(
        this.ptyBinding.ptyWrite(this.activePtyId, payload.toString('base64')),
      ) as { ok: boolean; bytesWritten?: number };
      if (!res.ok) return false;
      const written = Math.max(0, Math.min(payload.length, res.bytesWritten ?? payload.length));
      if (written < payload.length) {
        const rem = payload.subarray(written);
        this.pendingPtyWriteChunks.push(rem);
        this.pendingPtyWriteBytes += rem.length;
        if (!this.ptyWriteFlushTimer) {
          this.ptyWriteFlushTimer = setInterval(() => this.flushPendingPtyWrites(), 15);
          this.ptyWriteFlushTimer.unref?.();
        }
      }
      return true;
    }

    if (this.sessionMeta.kind === 'tmux' && this.attachedPane) {
      const pane = this.attachedPane;
      try {
        if (data.length > 0) {
          await execFileAsync('tmux', ['send-keys', '-t', pane, '-l', data], { timeout: 1500 });
        }
        if (submitEnter) {
          await new Promise((r) => setTimeout(r, 60));
          await execFileAsync('tmux', ['send-keys', '-t', pane, 'C-m'], { timeout: 1500 });
        }
        setTimeout(() => void this.captureAttachedPaneOnce(false), 120);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  async sendSpecialKey(key: string): Promise<boolean> {
    const allowedTmuxKeys: Record<string, string> = {
      Enter: 'C-m',
      Escape: 'Escape',
      Interrupt: 'C-c',
      Up: 'Up',
      Down: 'Down',
      Tab: 'Tab',
      '1': '1',
      '2': '2',
      '3': '3',
    };
    const ptyMap: Record<string, string> = {
      Enter: '\r',
      Escape: '\x1b',
      Interrupt: '\x03',
      Up: '\x1b[A',
      Down: '\x1b[B',
      Tab: '\t',
      '1': '1',
      '2': '2',
      '3': '3',
    };

    if (this.sessionMeta.kind === 'pty' && ptyMap[key]) {
      return this.writeInput(ptyMap[key]!, false);
    }
    if (this.sessionMeta.kind === 'tmux' && this.attachedPane && allowedTmuxKeys[key]) {
      try {
        await execFileAsync('tmux', ['send-keys', '-t', this.attachedPane, allowedTmuxKeys[key]!], {
          timeout: 1500,
        });
        setTimeout(() => void this.captureAttachedPaneOnce(false), 120);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  resizePty(cols: number, rows: number): boolean {
    if (this.activePtyId === null || !this.ptyBinding) return false;
    return this.ptyBinding.ptyResize(
      this.activePtyId,
      Math.max(20, Math.min(400, Math.trunc(cols))),
      Math.max(8, Math.min(200, Math.trunc(rows))),
    );
  }

  injectBrowserContextToView(): boolean {
    const snippet = this.callbacks.getBrowserContextSnippet();
    if (this.mode === 'minimized') {
      this.setMode('docked');
    }
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.send('agent:inject-context', snippet);
      return true;
    }
    return false;
  }

  registerIpcHandlers(ipc?: Pick<IpcMain, 'handle'>): void {
    const targetIpc = ipc ?? loadElectronRuntime().ipcMain;
    if (!targetIpc || typeof targetIpc.handle !== 'function') return;
    if (this.ipcRegistered) return;
    this.ipcRegistered = true;

    const handleAgent = (channel: string, fn: (raw: unknown) => unknown): void => {
      targetIpc.handle(channel, (ev, raw: unknown) => {
        assertAgentSender(ev, this.view, this.expectedAgentUrl);
        return fn(raw);
      });
    };

    handleAgent('agent:get-initial', async () => ({
      state: this.getState(),
      transcript: this.transcript,
      instances: await this.listRunningInstances(),
      defaultCwd: process.cwd(),
      contextSnippet: this.callbacks.getBrowserContextSnippet(),
    }));

    handleAgent('agent:list-instances', () => this.listRunningInstances());

    handleAgent('agent:start-cli', (raw) => {
      const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const preset = String(obj.preset ?? 'agy') as AgentCliPreset;
      const allowed: AgentCliPreset[] = ['agy', 'claude', 'codex', 'opencode', 'shell', 'custom'];
      if (!allowed.includes(preset)) {
        throw new Error(`Unsupported CLI preset: ${preset}`);
      }
      return this.startCliAgent({
        preset,
        customCommand: typeof obj.customCommand === 'string' ? obj.customCommand : undefined,
        cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
        cols: typeof obj.cols === 'number' ? obj.cols : undefined,
        rows: typeof obj.rows === 'number' ? obj.rows : undefined,
      });
    });

    handleAgent('agent:attach-instance', (raw) => {
      const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      return this.attachRunningInstance(String(obj.target ?? ''));
    });

    handleAgent('agent:stop', () => this.stopSession());

    handleAgent('agent:write', (raw) => {
      const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const data = typeof obj.data === 'string' ? obj.data : '';
      const submitEnter = Boolean(obj.submitEnter);
      return this.writeInput(data, submitEnter);
    });

    handleAgent('agent:special-key', (raw) => {
      const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      return this.sendSpecialKey(String(obj.key ?? ''));
    });

    handleAgent('agent:resize', (raw) => {
      const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      return this.resizePty(Number(obj.cols ?? 90), Number(obj.rows ?? 28));
    });

    handleAgent('agent:set-mode', (raw) => {
      const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const m = String(obj.mode ?? 'docked') as AgentDockMode;
      if (m !== 'docked' && m !== 'floating' && m !== 'minimized') {
        throw new Error(`Invalid agent dock mode: ${m}`);
      }
      return this.setMode(m);
    });

    handleAgent('agent:set-float-bounds', (raw) => {
      const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      return this.setFloatBounds({
        x: typeof obj.x === 'number' ? obj.x : undefined,
        y: typeof obj.y === 'number' ? obj.y : undefined,
        width: typeof obj.width === 'number' ? obj.width : undefined,
        height: typeof obj.height === 'number' ? obj.height : undefined,
      });
    });

    handleAgent('agent:get-context', () => this.callbacks.getBrowserContextSnippet());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSession();
    if (this.view) {
      const v = this.view;
      this.view = null;
      try {
        this.win.contentView.removeChildView(v);
      } catch {
        // Ignore.
      }
      try {
        if (!v.webContents.isDestroyed()) {
          v.webContents.close({ waitForBeforeUnload: false });
        }
      } catch {
        // Ignore.
      }
    }
  }
}
