import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  screen,
  session,
  WebContentsView,
  type Session,
  type WebContents,
} from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { clamp, computeFitScale, computeLayout } from '../shared/layout';
import { truncateUtf8 } from '../shared/frame';
import {
  mapNormalizedPoint,
  parseHttpOrigin,
  redactMirrorDebugPayload,
  redactMirrorFingerprint,
  redactMirrorUrl,
  sanitizeMirrorMissLabel,
} from '../shared/mirror-core';
import { normalizeUrl } from '../shared/url';
import {
  DEFAULT_LANDSCAPE_PRESET_ID,
  DEFAULT_PORTRAIT_PRESET_ID,
  DEVICE_PRESETS,
  getPresetOrDefault,
} from '../shared/presets';
import type {
  ElementFingerprint,
  HistoryEntry,
  LayoutResult,
  MirrorMissInfo,
  ScreenshotStageError,
  SessionMode,
  ShellState,
  TabSnapshot,
  TelemetrySnapshot,
  ThemeMode,
  ViewMode,
  ViewportDimensions,
  ViewportRole,
  ViewportSizingSummary,
} from '../shared/types';
import {
  buildViewportSizingReport,
  readPngDimensions,
} from '../shared/viewport-report';
import { composeFilmstripPng, type FilmstripRowInput } from '../shared/png-filmstrip';
import {
  buildSceneStepScript,
  validateClipRegionInput,
  validateReproRecipe,
  validateViewportSizeInput,
  type CanvasRegion,
  type ReproRecipe,
  type SceneStepSpec,
  type SceneStepViewportOutcome,
} from '../shared/repro-recipe';
import {
  deleteReproRecipeFile,
  listReproRecipesInDir,
  loadReproRecipeFile,
  saveReproRecipeFile,
} from './repro-recipe-file';
import {
  buildGpuTelemetrySeparation,
  MAX_TRACE_DURATION_MS,
  MAX_TRACE_FRAMES,
  segmentFramesAroundMarks,
  summarizeFrameWindow,
  type ViewportTraceReport,
} from '../shared/perf-trace';
import {
  capPersistedTabs,
  formatHistorySubtitle,
  isPersistableHttpUrl,
  isPlaceholderTitle,
  MAX_PERSISTED_TABS,
  recordHistoryEntry,
  removeHistoryEntry,
  truncatePersistedTitle,
  updateHistoryTitle,
  type PersistedSession,
  type PersistedTab,
  type PersistedWindowBounds,
} from '../shared/session-store';
import { DebuggerCoordinator } from './debugger-coordinator';
import { MirrorRelay, type MirrorViewportLookup } from './mirror-relay';
import { RequestDedupMiddleware, type DedupViewportContext } from './request-dedup';
import { TelemetryService } from './telemetry';
import {
  cleanupEmptyReservedDownload,
  reserveSafeDownloadPath,
  TabEventBus,
  type QueryBusFilter,
  type QueryBusResult,
} from './tab-event-bus';
import { WsSseMux, type WsMuxViewportContext } from './ws-sse-mux';

interface LaunchRedirectConvergence {
  epoch: number;
  requestedUrl: string;
  landscapeStarted: boolean;
  portraitStarted: boolean;
  landscapeFinalUrl: string | null;
  converged: boolean;
}

interface ManagedTab {
  id: string;
  title: string;
  titleUrl: string;
  url: string;
  mode: ViewMode;
  mirror: boolean;
  dedup: boolean;
  dedupCount: number;
  session: SessionMode;
  sleeping: boolean;
  portraitPresetId: string;
  landscapePresetId: string;
  portraitSize: ViewportDimensions;
  landscapeSize: ViewportDimensions;
  portraitScale: number;
  landscapeScale: number;
  devtoolsTarget: ViewportRole;
  audioSource: ViewportRole | 'muted';
  navSuppressUntil: { portrait: number; landscape: number };
  launchConvergence: LaunchRedirectConvergence | null;
  lastActiveAt: number;
  skipNextRestoreHistoryCommit: boolean;
  landscapeView: WebContentsView | null;
  portraitView: WebContentsView | null;
}

export interface CreateTabOptions {
  url?: string;
  title?: string;
  mode?: ViewMode;
  mirror?: boolean;
  dedup?: boolean;
  session?: SessionMode;
  sleeping?: boolean;
  portraitPresetId?: string;
  landscapePresetId?: string;
  portraitSize?: { width: number; height: number; dpr?: number };
  landscapeSize?: { width: number; height: number; dpr?: number };
  devtoolsTarget?: ViewportRole;
  audioSource?: ViewportRole | 'muted';
  activate?: boolean;
  recordHistory?: boolean;
  lazy?: boolean;
}

export interface TabManagerOptions {
  autoSleepAfterMs?: number;
  autoSleepCheckMs?: number;
  inspectTimeoutMs?: number;
}

const NAV_MIRROR_SUPPRESS_MS = 3500;
const MAX_CLOSED_TABS = 10;
const DEFAULT_AUTO_SLEEP_AFTER_MS = 10 * 60 * 1000;
const DEFAULT_AUTO_SLEEP_CHECK_MS = 60 * 1000;
const DEFAULT_INSPECT_TIMEOUT_MS = 1500;

export function computeEffectiveDpr(
  presetDpr: number,
  fitScale: number,
  hostScaleFactor: number,
  ecoMode: boolean,
): number {
  const safePresetDpr = Number.isFinite(presetDpr) && presetDpr >= 1 ? presetDpr : 1;
  if (!ecoMode) return safePresetDpr;
  const safeScale = Number.isFinite(fitScale) && fitScale > 0 ? fitScale : 1;
  const safeHostScale =
    Number.isFinite(hostScaleFactor) && hostScaleFactor > 0 ? hostScaleFactor : 1;
  return clamp(Math.min(safePresetDpr, safeScale * safeHostScale), 1, safePresetDpr);
}

export function sanitizeMenuLabel(raw: string, maxLen: number): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const truncated =
    cleaned.length > maxLen ? `${cleaned.slice(0, Math.max(1, maxLen - 1))}…` : cleaned;
  return truncated.replace(/&/g, '&&');
}

export function getDefaultWelcomeUrl(): string {
  return pathToFileURL(path.join(app.getAppPath(), 'dist', 'renderer', 'welcome.html')).toString();
}

export { reserveSafeDownloadPath };

export class TabManager implements MirrorViewportLookup {
  private readonly tabs: ManagedTab[] = [];
  private activeTabId: string | null = null;
  private railCollapsed = false;
  private dockOpen = false;
  private dockHeight = 290;
  private splitRatio = 0.34;
  private theme: ThemeMode = 'dark';
  private ecoMode = true;
  private autoSleep = false;
  private nextTabSeq = 1;
  private history: HistoryEntry[] = [];
  private readonly closedTabs: PersistedTab[] = [];
  private suppressDirty = false;

  private devtoolsView: WebContentsView | null = null;
  private attachedDevToolsWcId: number | null = null;
  private lastLayout: LayoutResult | null = null;
  private latestTelemetry: TelemetrySnapshot | null = null;
  private disposed = false;
  private readonly mirrorMissByTab = new Map<string, MirrorMissInfo>();
  private readonly pendingEmulations = new Map<number, Promise<void>>();
  private readonly primedWcIds = new Set<number>();
  private readonly pendingSurfacePrimes = new Map<number, Promise<void>>();
  private readonly muxOrDedupTouchedWcIds = new Set<number>();
  private readonly wcLoadStates = new Map<
    number,
    {
      promise: Promise<boolean>;
      superseded: boolean;
      attachedMidLoad: boolean;
      armedForStop: boolean;
      primingAboutBlank: boolean;
      settle: (ok: boolean, superseded?: boolean) => void;
    }
  >();
  private readonly pendingReloads = new Map<string, Promise<void>>();
  private readonly beforeReloadHooks = new Set<(tabId: string) => void>();
  private readonly observedViewports = new Map<
    number,
    {
      width: number;
      height: number;
      dpr: number;
      capturedPixels: { width: number; height: number } | null;
    }
  >();
  private readonly activeTracesByTab = new Map<
    string,
    { traceId: string; startedAtMs: number; roles: ViewportRole[] }
  >();
  private readonly downloadHookedSessions = new Map<
    Session,
    (event: Electron.Event, item: Electron.DownloadItem, webContents: WebContents) => void
  >();
  private nextLaunchConvergenceEpoch = 1;
  private readonly autoSleepAfterMs: number;
  private readonly autoSleepCheckMs: number;
  private readonly inspectTimeoutMs: number;
  private autoSleepTimer: ReturnType<typeof setInterval> | null = null;

  public readonly tabEventBus: TabEventBus;
  public readonly debuggerCoordinator: DebuggerCoordinator;
  public readonly mirrorRelay: MirrorRelay;
  public readonly requestDedup: RequestDedupMiddleware<WebContents>;
  public readonly wsSseMux: WsSseMux;
  public readonly telemetry: TelemetryService;

  constructor(
    private readonly win: BrowserWindow,
    private readonly mirrorPreloadPath: string,
    private readonly onShortcut: (input: Electron.Input) => boolean,
    private readonly onStateDirty?: () => void,
    opts: TabManagerOptions = {},
  ) {
    this.autoSleepAfterMs = opts.autoSleepAfterMs ?? DEFAULT_AUTO_SLEEP_AFTER_MS;
    this.autoSleepCheckMs = opts.autoSleepCheckMs ?? DEFAULT_AUTO_SLEEP_CHECK_MS;
    this.inspectTimeoutMs = opts.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;

    this.tabEventBus = new TabEventBus();
    this.debuggerCoordinator = new DebuggerCoordinator();
    this.mirrorRelay = new MirrorRelay(this);
    this.requestDedup = new RequestDedupMiddleware(this.debuggerCoordinator, {
      resolveViewportContext: (wcId) => this.resolveDedupContext(wcId),
      onDedupIncrement: (wcId, countDelta) => {
        const hit = this.findTabAndRoleByWcId(wcId);
        if (!hit) return;
        hit.tab.dedupCount += countDelta;
        this.tabEventBus.publish({
          tabId: hit.tab.id,
          viewport: hit.role,
          domain: 'http_dedup',
          kind: 'replayed',
          summary: `HTTP idempotent request replayed (+${countDelta})`,
        });
        // Dedup counter increments are live-only and must never trigger session-state.json writes.
        this.emitState(false);
      },
    });
    this.wsSseMux = new WsSseMux(
      this.debuggerCoordinator,
      (wcId) => this.resolveWsMuxContext(wcId),
      {
        eventBus: this.tabEventBus,
        onDedupIncrement: (wcId, countDelta) => {
          const hit = this.findTabAndRoleByWcId(wcId);
          if (!hit) return;
          hit.tab.dedupCount += countDelta;
          this.emitState(false);
        },
      },
    );
    this.registerBeforeReloadHook((tabId) => {
      this.requestDedup.clearTabSlots(tabId);
    });
    this.telemetry = new TelemetryService(
      () => {
        const active = this.getActiveTab();
        if (!active || active.sleeping) return null;
        return {
          tabId: active.id,
          portraitWc:
            active.mode === 'dual' &&
            active.portraitView &&
            !active.portraitView.webContents.isDestroyed()
              ? active.portraitView.webContents
              : null,
          landscapeWc:
            active.landscapeView && !active.landscapeView.webContents.isDestroyed()
              ? active.landscapeView.webContents
              : null,
        };
      },
      (wcId) => this.findWebContentsById(wcId) !== null,
      (snapshot) => {
        const active = this.getActiveTab();
        snapshot.mirrorMiss = active ? (this.mirrorMissByTab.get(active.id) ?? null) : null;
        this.latestTelemetry = snapshot;
        if (!this.win.isDestroyed()) {
          this.win.webContents.send('shell:telemetry', snapshot);
        }
      },
      this.debuggerCoordinator,
      {
        onBusEvent: (ev) => {
          this.tabEventBus.publish({
            tabId: ev.tabId,
            viewport: ev.viewport,
            domain: ev.domain,
            kind: ev.kind,
            summary: ev.summary,
            tsMs: ev.tsMs,
          });
        },
      },
    );

    this.win.on('resize', () => this.applyLayout());
    this.win.on('blur', () => this.telemetry.setThrottled(true));
    this.win.on('focus', () => this.telemetry.setThrottled(false));
    this.win.on('hide', () => this.telemetry.setPaused(true));
    this.win.on('minimize', () => this.telemetry.setPaused(true));
    this.win.on('show', () => this.telemetry.setPaused(false));
    this.win.on('restore', () => this.telemetry.setPaused(false));
  }

  getDebuggerCoordinator(): DebuggerCoordinator {
    return this.debuggerCoordinator;
  }

  registerBeforeReloadHook(hook: (tabId: string) => void): () => void {
    this.beforeReloadHooks.add(hook);
    return () => {
      this.beforeReloadHooks.delete(hook);
    };
  }

  private getHostScaleFactor(): number {
    try {
      if (!this.win.isDestroyed()) {
        const display = screen.getDisplayMatching(this.win.getBounds());
        if (display && Number.isFinite(display.scaleFactor) && display.scaleFactor > 0) {
          return display.scaleFactor;
        }
      }
    } catch {
      // Fallback to 1 in headless or mocked environments.
    }
    return 1;
  }

  private ensureDevToolsView(): WebContentsView {
    if (this.devtoolsView && !this.devtoolsView.webContents.isDestroyed()) {
      return this.devtoolsView;
    }
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
      },
    });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.setVisible(false);
    this.win.contentView.addChildView(view);
    this.devtoolsView = view;
    return view;
  }

  private destroyDevToolsView(): void {
    if (this.attachedDevToolsWcId !== null) {
      const prevWc = this.findWebContentsById(this.attachedDevToolsWcId);
      this.attachedDevToolsWcId = null;
      if (prevWc && !prevWc.isDestroyed()) {
        try {
          prevWc.closeDevTools();
        } catch {
          // Ignore closeDevTools errors during teardown.
        }
        if (!this.disposed && !this.debuggerCoordinator.isAttached(prevWc)) {
          void this.debuggerCoordinator.reattachAndRestore(prevWc);
        }
      }
    }

    if (this.devtoolsView) {
      const dv = this.devtoolsView;
      this.devtoolsView = null;
      try {
        this.win.contentView.removeChildView(dv);
      } catch {
        // Ignore if already removed.
      }
      try {
        if (!dv.webContents.isDestroyed()) {
          dv.webContents.close({ waitForBeforeUnload: false });
        }
      } catch {
        // Ignore close errors during teardown.
      }
    }
  }

  private async inspectElementAt(
    wc: WebContents,
    role: ViewportRole,
    x: number,
    y: number,
  ): Promise<void> {
    if (wc.isDestroyed()) return;
    const alreadyOpen =
      this.dockOpen &&
      this.attachedDevToolsWcId === wc.id &&
      typeof wc.isDevToolsOpened === 'function' &&
      wc.isDevToolsOpened();

    let opened = alreadyOpen;
    if (!alreadyOpen) {
      const waitForOpened = new Promise<boolean>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (didOpen: boolean) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          try {
            if (typeof wc.off === 'function') {
              wc.off('devtools-opened', onOpened);
              wc.off('destroyed', onDestroyed);
            } else if (typeof wc.removeListener === 'function') {
              wc.removeListener('devtools-opened', onOpened);
              wc.removeListener('destroyed', onDestroyed);
            }
          } catch {
            // Ignore listener cleanup errors.
          }
          resolve(didOpen);
        };
        const onOpened = () => finish(true);
        const onDestroyed = () => finish(false);

        wc.on('devtools-opened', onOpened);
        wc.on('destroyed', onDestroyed);
        timer = setTimeout(() => finish(false), this.inspectTimeoutMs);
      });

      this.setDevToolsTarget(role);
      opened = await waitForOpened;
    }

    const isOpened =
      typeof wc.isDevToolsOpened === 'function' ? wc.isDevToolsOpened() : false;
    if (
      !wc.isDestroyed() &&
      this.dockOpen &&
      this.attachedDevToolsWcId === wc.id &&
      (opened || isOpened)
    ) {
      wc.inspectElement(x, y);
    }
  }

  getPresets() {
    return DEVICE_PRESETS;
  }

  private clearIsolatedPartition(tabId: string): void {
    try {
      const part = session.fromPartition(`iron-iso-${tabId}`);
      void part.clearStorageData().catch(() => {});
    } catch {
      // Ignore partition cleanup errors on shutdown.
    }
  }

  private ensureSessionDownloadHandler(sess: Session | undefined | null): void {
    if (!sess || typeof sess.on !== 'function' || this.downloadHookedSessions.has(sess)) {
      return;
    }
    const listener = (
      event: Electron.Event,
      item: Electron.DownloadItem,
      webContents: WebContents,
    ) => {
      if (this.disposed || !webContents || webContents.isDestroyed()) return;
      const hit = this.findTabAndRoleByWcId(webContents.id);
      if (!hit) return;

      const rawUrl = typeof item.getURL === 'function' ? item.getURL() : '';
      const filename = typeof item.getFilename === 'function' ? item.getFilename() : 'download';

      if (this.isTabDedupActive(hit.tab)) {
        const claim = this.tabEventBus.claimEffect(
          hit.tab.id,
          hit.role,
          'download',
          `${rawUrl}|${filename}`,
          NAV_MIRROR_SUPPRESS_MS,
        );
        if (!claim.allowed) {
          event.preventDefault();
          hit.tab.dedupCount += 1;
          this.emitState(false);
          return;
        }
      } else {
        this.tabEventBus.publish({
          tabId: hit.tab.id,
          viewport: hit.role,
          domain: 'download',
          kind: 'started',
          summary: `download started (${filename})`,
        });
      }

      let reservedPath: string | null = null;
      if (typeof item.setSavePath === 'function') {
        try {
          const envDir = process.env.IRON_BROWSER_DOWNLOAD_DIR?.trim();
          const isWinVisible =
            typeof this.win.isVisible === 'function' ? this.win.isVisible() : true;
          const targetDir =
            envDir ||
            (!isWinVisible
              ? path.join(app.getPath('userData'), 'downloads')
              : app.getPath('downloads'));
          if (targetDir) {
            const safePath = reserveSafeDownloadPath(targetDir, filename);
            if (safePath) {
              reservedPath = safePath;
              item.setSavePath(safePath);
            }
          }
        } catch {
          // Ignore path lookup errors in mocked unit test environments.
        }
      }

      if (typeof item.once === 'function') {
        item.once('done', (_doneEv, state) => {
          if (state !== 'completed') {
            cleanupEmptyReservedDownload(reservedPath);
          }
          this.tabEventBus.publish({
            tabId: hit.tab.id,
            viewport: hit.role,
            domain: 'download',
            kind: state === 'completed' ? 'completed' : 'failed',
            summary: `download ${state} (${filename})`,
          });
        });
      }
    };
    sess.on('will-download', listener);
    this.downloadHookedSessions.set(sess, listener);
  }

  private createViewportView(
    tabId: string,
    role: ViewportRole,
    sessionMode: SessionMode,
  ): WebContentsView {
    const partition =
      role === 'portrait' && sessionMode === 'isolated'
        ? `iron-iso-${tabId}`
        : undefined;

    const view = new WebContentsView({
      webPreferences: {
        preload: this.mirrorPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        ...(partition ? { partition } : {}),
      },
    });

    const wc = view.webContents;
    this.ensureSessionDownloadHandler((wc as { session?: Session }).session);
    view.setVisible(false);
    this.win.contentView.addChildView(view);

    // Block unmanaged Electron popup windows; route valid http/https popups into managed tabs.
    wc.setWindowOpenHandler(({ url }) => {
      try {
        const safeUrl = normalizeUrl(url);
        if (safeUrl.startsWith('http://') || safeUrl.startsWith('https://')) {
          const parentTab = this.getTab(tabId);
          if (parentTab && this.isTabDedupActive(parentTab)) {
            const claim = this.tabEventBus.claimEffect(
              tabId,
              role,
              'popup',
              safeUrl,
              NAV_MIRROR_SUPPRESS_MS,
            );
            if (!claim.allowed) {
              parentTab.dedupCount += 1;
              this.emitState(false);
              return { action: 'deny' };
            }
          } else {
            this.tabEventBus.publish({
              tabId,
              viewport: role,
              domain: 'popup',
              kind: 'opened',
              summary: safeUrl,
            });
          }
          this.createTab({ url: safeUrl, mode: 'dual' });
        }
      } catch {
        // Deny unsafe schemes silently.
      }
      return { action: 'deny' };
    });

    wc.on('preload-error', (_ev, preloadPath, err) => {
      process.stderr.write(`IronBrowser preload error (${preloadPath}): ${err.stack ?? err.message}\n`);
    });

    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && this.onShortcut(input)) {
        event.preventDefault();
      }
    });

    // Native right-click developer context menu: Inspect Element + Copy Selector / OuterHTML / Mirror Debug Info
    wc.on('context-menu', (_ev, params) => {
      const tab = this.getTab(tabId);
      if (!tab) return;
      const scale =
        role === 'portrait'
          ? tab.portraitScale
          : tab.landscapeScale * (wc.isDestroyed() ? 1 : wc.getZoomFactor());
      const cssX = Math.round(params.x / Math.max(scale, 0.1));
      const cssY = Math.round(params.y / Math.max(scale, 0.1));

      const menu = Menu.buildFromTemplate([
        {
          label: `Inspect Element (${role})`,
          click: () => {
            void this.inspectElementAt(wc, role, params.x, params.y);
          },
        },
        { type: 'separator' },
        {
          label: 'Copy CSS Selector',
          click: () => {
            void this.mirrorRelay
              .queryDom(wc, 'inspectAtPoint', { x: cssX, y: cssY })
              .then((res) => {
                if (res.found && res.selector) clipboard.writeText(res.selector);
              });
          },
        },
        {
          label: 'Copy OuterHTML (for AI)',
          click: () => {
            void this.mirrorRelay
              .queryDom(wc, 'inspectAtPoint', { x: cssX, y: cssY })
              .then((res) => {
                if (res.found) {
                  const snippet = [
                    `<!-- IronBrowser ${role} | selector: ${res.selector ?? ''} -->`,
                    res.outerHtml ?? '',
                  ].join('\n');
                  clipboard.writeText(snippet);
                }
              });
          },
        },
        {
          label: 'Copy Mirror Debug Info (JSON)',
          click: () => {
            void (async () => {
              const info = await this.mirrorRelay.queryDom(wc, 'inspectAtPoint', {
                x: cssX,
                y: cssY,
              });
              const pairedWc =
                role === 'portrait'
                  ? tab.landscapeView && !tab.landscapeView.webContents.isDestroyed()
                    ? tab.landscapeView.webContents
                    : null
                  : tab.portraitView && !tab.portraitView.webContents.isDestroyed()
                    ? tab.portraitView.webContents
                    : null;
              const pairedMatch =
                info.found && info.fingerprint && pairedWc && !pairedWc.isDestroyed()
                  ? await this.mirrorRelay.queryDom(pairedWc, 'resolveTarget', {
                      fingerprint: info.fingerprint,
                    })
                  : null;
              const safeUrl = redactMirrorUrl(wc.isDestroyed() ? tab.url : wc.getURL());
              const redactedPayload = redactMirrorDebugPayload({
                sourceViewport: role,
                url: safeUrl,
                selector: info.selector,
                fingerprint: info.fingerprint
                  ? redactMirrorFingerprint(info.fingerprint as ElementFingerprint)
                  : undefined,
                pairedMatch,
                outerHtml: info.outerHtml,
              });
              clipboard.writeText(JSON.stringify(redactedPayload, null, 2));
            })();
          },
        },
        { type: 'separator' },
        {
          label: tab.audioSource === role ? `Mute ${role}` : `Switch Audio to ${role}`,
          click: () => this.toggleAudio(role),
        },
        {
          label: 'Reload',
          click: () => {
            void this.reload();
          },
        },
      ]);
      menu.popup({ window: this.win });
    });

    wc.on('devtools-closed', () => {
      if (!this.disposed && !wc.isDestroyed() && !this.debuggerCoordinator.isAttached(wc)) {
        void this.debuggerCoordinator.reattachAndRestore(wc);
      }
    });

    wc.on('page-title-updated', (_ev, title) => {
      const tab = this.getTab(tabId);
      if (!tab) return;
      if (isPlaceholderTitle(title)) return;
      const currentWcUrl = !wc.isDestroyed() ? wc.getURL() : '';
      if (currentWcUrl && tab.url && currentWcUrl !== tab.url) return;
      if (role === 'landscape' || tab.mode === 'single' || isPlaceholderTitle(tab.title, tab.url)) {
        tab.title = truncatePersistedTitle(title, tab.url);
        tab.titleUrl = currentWcUrl || tab.url;
        this.history = updateHistoryTitle(this.history, tab.url, tab.title);
        this.emitState();
      }
    });

    wc.on('did-start-loading', () => {
      this.emitState(false);
    });

    wc.on('did-finish-load', () => {
      this.primedWcIds.delete(wc.id);
      const tab = this.getTab(tabId);
      if (!tab) return;
      void this.applyViewportEmulation(tab, role);
    });

    wc.once('destroyed', () => {
      this.primedWcIds.delete(wc.id);
      this.pendingSurfacePrimes.delete(wc.id);
    });

    wc.on('did-stop-loading', () => {
      const tab = this.getTab(tabId);
      if (!tab) return;
      const isTabActive = this.getActiveTab()?.id === tab.id && !tab.sleeping;
      const visibleNow = role === 'landscape' ? isTabActive : isTabActive && tab.mode === 'dual';
      if (!wc.isDestroyed()) {
        wc.setBackgroundThrottling(!visibleNow);
      }
      void this.applyViewportEmulation(tab, role);
      this.emitState(false);
    });

    const handleNavSync = (navUrl: string, isInPage: boolean) => {
      if (this.wcLoadStates.get(wc.id)?.primingAboutBlank) return;
      const tab = this.getTab(tabId);
      if (!tab) return;
      if (role === 'landscape' || tab.mode === 'single') {
        const urlChanged = navUrl !== tab.url;
        tab.url = navUrl;
        if (urlChanged) {
          tab.titleUrl = '';
          tab.title = isPersistableHttpUrl(navUrl) ? formatHistorySubtitle(navUrl) : 'IronBrowser';
          if (!isInPage) {
            this.clearTabMirrorMiss(tab.id);
          }
        }
        const skipRestore = !isInPage && tab.skipNextRestoreHistoryCommit;
        if (skipRestore) {
          tab.skipNextRestoreHistoryCommit = false;
        } else if (isPersistableHttpUrl(navUrl)) {
          const commitTitle =
            tab.titleUrl === navUrl && !isPlaceholderTitle(tab.title, navUrl)
              ? tab.title
              : undefined;
          this.history = recordHistoryEntry(this.history, navUrl, commitTitle);
        }
      }
      this.emitState();

      if (tab.mode !== 'dual' || !tab.mirror) return;
      const now = Date.now();
      const isHttpNav = navUrl.startsWith('http://') || navUrl.startsWith('https://');

      // One-shot launch redirect convergence: when a programmatic dual navigation 302-redirects
      // on landscape (e.g. demo launcher -> ?user=...&token=...), converge portrait onto landscape's
      // final URL at most ONCE per programmatic navigation so mobile U_L -> U_P redirects never ping-pong.
      if (now < tab.navSuppressUntil[role]) {
        const lc = tab.launchConvergence;
        if (!isInPage && lc && !lc.converged && tab.session === 'shared' && isHttpNav) {
          if (role === 'landscape' && lc.landscapeStarted) {
            if (navUrl === lc.requestedUrl) {
              tab.launchConvergence = null;
            } else {
              lc.landscapeFinalUrl = navUrl;
              lc.converged = true;
              const pView = tab.portraitView;
              if (pView && !pView.webContents.isDestroyed() && pView.webContents.getURL() !== navUrl) {
                tab.navSuppressUntil.portrait = now + NAV_MIRROR_SUPPRESS_MS;
                this.tabEventBus.publish({
                  tabId: tab.id,
                  viewport: 'portrait',
                  domain: 'navigation',
                  kind: 'redirect_converged',
                  summary: navUrl,
                });
                this.loadViewportUrl(pView.webContents, navUrl);
              }
            }
          } else if (
            role === 'portrait' &&
            lc.portraitStarted &&
            lc.landscapeFinalUrl !== null &&
            lc.landscapeFinalUrl !== navUrl
          ) {
            lc.converged = true;
            tab.navSuppressUntil.portrait = now + NAV_MIRROR_SUPPRESS_MS;
            this.tabEventBus.publish({
              tabId: tab.id,
              viewport: 'portrait',
              domain: 'navigation',
              kind: 'redirect_converged',
              summary: lc.landscapeFinalUrl,
            });
            this.loadViewportUrl(wc, lc.landscapeFinalUrl);
          }
        }
        return;
      }

      const pairedRole: ViewportRole = role === 'portrait' ? 'landscape' : 'portrait';
      const pairedView = pairedRole === 'portrait' ? tab.portraitView : tab.landscapeView;
      if (!pairedView || pairedView.webContents.isDestroyed()) return;
      if (pairedView.webContents.getURL() === navUrl) return;

      // Only mirror http/https navigations across viewports.
      if (!isHttpNav) return;

      tab.navSuppressUntil[pairedRole] = now + NAV_MIRROR_SUPPRESS_MS;
      this.loadViewportUrl(pairedView.webContents, navUrl);
    };

    wc.on('did-navigate', (_ev, navUrl) => handleNavSync(navUrl, false));
    wc.on('did-navigate-in-page', (_ev, navUrl) => handleNavSync(navUrl, true));

    this.telemetry.attachViewportCollectors(tabId, role, wc);
    return view;
  }

  private applyViewportEmulation(tab: ManagedTab, role: ViewportRole): Promise<void> {
    const view = role === 'portrait' ? tab.portraitView : tab.landscapeView;
    if (!view || view.webContents.isDestroyed()) return Promise.resolve();
    const wc = view.webContents;

    const prev = this.pendingEmulations.get(wc.id) ?? Promise.resolve();
    const run = prev
      .catch(() => {})
      .then(async () => {
        if (wc.isDestroyed() || this.disposed) return;
        const attached = await this.debuggerCoordinator.ensureAttached(wc);
        if (!attached || wc.isDestroyed() || this.disposed) return;

        const size = role === 'portrait' ? tab.portraitSize : tab.landscapeSize;
        const isPortrait = role === 'portrait';
        const bounds = view.getBounds();
        const scale =
          bounds.width > 0 && bounds.height > 0
            ? computeFitScale(bounds.width, bounds.height, size.width, size.height)
            : 1;

        let emuTimer: ReturnType<typeof setTimeout> | null = null;
        try {
          await Promise.race([
            (async () => {
              await this.debuggerCoordinator.sendCommand(
                wc,
                'Emulation.setTouchEmulationEnabled',
                isPortrait ? { enabled: true, maxTouchPoints: 5 } : { enabled: false },
              );

              if (isPortrait) {
                tab.portraitScale = scale;
                const effectiveDpr = computeEffectiveDpr(
                  size.dpr,
                  scale,
                  this.getHostScaleFactor(),
                  this.ecoMode,
                );
                wc.setZoomFactor(1);
                await this.debuggerCoordinator.sendCommand(wc, 'Emulation.setDeviceMetricsOverride', {
                  width: size.width,
                  height: size.height,
                  deviceScaleFactor: effectiveDpr,
                  mobile: true,
                  scale,
                  screenWidth: size.width,
                  screenHeight: size.height,
                });
              } else if (tab.mode === 'dual') {
                // Keep zoomFactor at 1 so Chromium never divides CSS innerWidth/dpr by zoomFactor
                // (e.g. 1440 / 0.577 = 2495), while DeviceMetricsOverride sets exact preset geometry & DPR.
                tab.landscapeScale = 1;
                wc.setZoomFactor(1);
                await this.debuggerCoordinator.sendCommand(wc, 'Emulation.setDeviceMetricsOverride', {
                  width: size.width,
                  height: size.height,
                  deviceScaleFactor: size.dpr,
                  mobile: false,
                  scale: 1,
                  screenWidth: size.width,
                  screenHeight: size.height,
                });
              } else {
                tab.landscapeScale = 1;
                wc.setZoomFactor(1);
                await this.debuggerCoordinator.sendCommand(wc, 'Emulation.clearDeviceMetricsOverride');
              }
            })(),
            new Promise<void>((resolve) => {
              emuTimer = setTimeout(resolve, 1200);
            }),
          ]);
        } catch {
          // Ignore transient emulation errors during page transitions.
        } finally {
          if (emuTimer) clearTimeout(emuTimer);
        }
      })
      .finally(() => {
        if (this.pendingEmulations.get(wc.id) === run) {
          this.pendingEmulations.delete(wc.id);
        }
      });

    this.pendingEmulations.set(wc.id, run);
    return run;
  }

  private isTabDedupActive(tab: ManagedTab): boolean {
    return (
      !this.disposed &&
      !tab.sleeping &&
      tab.mode === 'dual' &&
      tab.session === 'shared' &&
      tab.mirror === true &&
      tab.dedup === true
    );
  }

  private findTabAndRoleByWcId(
    wcId: number,
  ): { tab: ManagedTab; role: ViewportRole; wc: WebContents; pairedWc: WebContents | null } | null {
    for (const tab of this.tabs) {
      if (
        tab.landscapeView &&
        !tab.landscapeView.webContents.isDestroyed() &&
        tab.landscapeView.webContents.id === wcId
      ) {
        const pairedWc =
          tab.portraitView && !tab.portraitView.webContents.isDestroyed()
            ? tab.portraitView.webContents
            : null;
        return { tab, role: 'landscape', wc: tab.landscapeView.webContents, pairedWc };
      }
      if (
        tab.portraitView &&
        !tab.portraitView.webContents.isDestroyed() &&
        tab.portraitView.webContents.id === wcId
      ) {
        const pairedWc =
          tab.landscapeView && !tab.landscapeView.webContents.isDestroyed()
            ? tab.landscapeView.webContents
            : null;
        return { tab, role: 'portrait', wc: tab.portraitView.webContents, pairedWc };
      }
    }
    return null;
  }

  private resolveDedupContext(wcId: number): DedupViewportContext<WebContents> | null {
    const hit = this.findTabAndRoleByWcId(wcId);
    if (!hit) return null;
    return {
      tabId: hit.tab.id,
      active: this.isTabDedupActive(hit.tab),
      pairedWc: hit.pairedWc,
      getOrigin: (wc) => this.getOrigin(wc),
    };
  }

  private resolveWsMuxContext(wcId: number): WsMuxViewportContext | null {
    const hit = this.findTabAndRoleByWcId(wcId);
    if (!hit) return null;
    return {
      tabId: hit.tab.id,
      role: hit.role,
      active: this.isTabDedupActive(hit.tab),
      wc: hit.wc,
      pairedWc: hit.pairedWc,
      getOrigin: (wc) => this.getOrigin(wc as WebContents),
    };
  }

  private syncTabDedupAndMux(tab: ManagedTab): void {
    const active = this.isTabDedupActive(tab);
    if (!active) {
      this.tabEventBus.sessionStorageClearTab(tab.id);
    }
    const lWc =
      tab.landscapeView && !tab.landscapeView.webContents.isDestroyed()
        ? tab.landscapeView.webContents
        : null;
    const pWc =
      tab.portraitView && !tab.portraitView.webContents.isDestroyed()
        ? tab.portraitView.webContents
        : null;
    if (lWc) {
      if (active) this.muxOrDedupTouchedWcIds.add(lWc.id);
      void this.requestDedup.setViewportEnabled(lWc, active);
      void this.wsSseMux.syncViewport(lWc, active);
    }
    if (pWc) {
      if (active) this.muxOrDedupTouchedWcIds.add(pWc.id);
      void this.requestDedup.setViewportEnabled(pWc, active);
      void this.wsSseMux.syncViewport(pWc, active);
    }
  }

  async beforeMouseDispatch(wc: WebContents): Promise<void> {
    if (this.disposed || wc.isDestroyed()) return;
    const isWinVisible = typeof this.win.isVisible === 'function' ? this.win.isVisible() : true;
    if (isWinVisible || this.primedWcIds.has(wc.id)) return;
    if (!this.debuggerCoordinator.isAttached(wc)) return;

    const existing = this.pendingSurfacePrimes.get(wc.id);
    if (existing) {
      await existing;
      return;
    }

    const wcId = wc.id;
    let primePromise!: Promise<void>;
    primePromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          this.debuggerCoordinator
            .sendCommand(wc, 'Page.captureScreenshot', {
              format: 'png',
              fromSurface: true,
            })
            .catch(() => {}),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 1000);
          }),
        ]);
      } finally {
        if (timer !== null) clearTimeout(timer);
        if (!this.disposed && !wc.isDestroyed()) {
          this.primedWcIds.add(wcId);
        }
        if (this.pendingSurfacePrimes.get(wcId) === primePromise) {
          this.pendingSurfacePrimes.delete(wcId);
        }
      }
    })();

    this.pendingSurfacePrimes.set(wcId, primePromise);
    await primePromise;
  }

  getOrigin(wc: WebContents): string | null {
    if (!wc || wc.isDestroyed()) return null;
    const mf = (wc as unknown as { mainFrame?: { origin?: unknown } | null }).mainFrame;
    if (mf && typeof mf.origin === 'string') {
      if (mf.origin === 'null') return null;
      const frameOrigin = parseHttpOrigin(mf.origin);
      if (!frameOrigin) return null;
      const rawUrl = wc.getURL();
      if (rawUrl) {
        const urlOrigin = parseHttpOrigin(rawUrl);
        if (urlOrigin && urlOrigin !== frameOrigin) return null;
      }
      return frameOrigin;
    }
    return parseHttpOrigin(wc.getURL());
  }

  isMainFrame(wc: WebContents, frame: unknown): boolean {
    if (!wc || wc.isDestroyed()) return false;
    const mf = (wc as unknown as { mainFrame?: unknown }).mainFrame;
    return mf != null && frame === mf;
  }

  private clearTabMirrorMiss(tabId: string): void {
    if (this.mirrorMissByTab.delete(tabId)) {
      if (this.latestTelemetry && this.getActiveTab()?.id === tabId) {
        this.latestTelemetry = { ...this.latestTelemetry, mirrorMiss: null };
      }
    }
  }

  onGesture(tabId: string, role: ViewportRole, action: string): void {
    this.tabEventBus.beginGesture(tabId, role, action);
  }

  onMirrorMiss(tabId: string, info: MirrorMissInfo): void {
    const tab = this.getTab(tabId);
    if (!tab) return;
    this.mirrorMissByTab.set(tabId, info);
    this.tabEventBus.publish({
      tabId,
      viewport: 'both',
      domain: 'mirror',
      kind: 'miss',
      summary: `${info.reason}: ${sanitizeMirrorMissLabel(info.targetLabel, 48)}`,
    });
    this.emitState(false);
    if (this.latestTelemetry && this.getActiveTab()?.id === tabId) {
      this.latestTelemetry = { ...this.latestTelemetry, mirrorMiss: info };
      if (!this.win.isDestroyed()) {
        this.win.webContents.send('shell:telemetry', this.latestTelemetry);
      }
    }
  }

  getTelemetrySnapshot(): TelemetrySnapshot | null {
    const base = this.latestTelemetry ?? this.telemetry.getLatestSnapshot();
    const active = this.getActiveTab();
    base.mirrorMiss = active ? (this.mirrorMissByTab.get(active.id) ?? null) : null;
    return base;
  }

  copyMirrorMissDebug(): boolean {
    const active = this.getActiveTab();
    if (!active) return false;
    const miss = this.mirrorMissByTab.get(active.id) ?? null;
    if (!miss) return false;

    const safeUrl = redactMirrorUrl(miss.url ?? active.url);
    let origin: string | undefined;
    let pathname: string | undefined;
    if (safeUrl) {
      try {
        const parsed = new URL(safeUrl);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          origin = parsed.origin;
          pathname = parsed.pathname;
        }
      } catch {
        // Ignore malformed URL after redaction.
      }
    }

    // Redact passwords, input values, and query/fragment tokens before writing clipboard JSON.
    const redacted = redactMirrorDebugPayload({
      tabId: active.id,
      reason: miss.reason,
      targetLabel: sanitizeMirrorMissLabel(miss.targetLabel, 32),
      timestamp: miss.timestamp,
      url: safeUrl,
      origin,
      pathname,
    });
    clipboard.writeText(JSON.stringify(redacted, null, 2));
    return true;
  }

  findByWebContentsId(webContentsId: number): {
    tabId: string;
    role: ViewportRole;
    mirrorEnabled: boolean;
    pairedWebContents: WebContents | null;
    pairedScale: number;
  } | null {
    for (const tab of this.tabs) {
      if (
        tab.landscapeView &&
        !tab.landscapeView.webContents.isDestroyed() &&
        tab.landscapeView.webContents.id === webContentsId
      ) {
        const portraitWc =
          tab.portraitView && !tab.portraitView.webContents.isDestroyed()
            ? tab.portraitView.webContents
            : null;
        return {
          tabId: tab.id,
          role: 'landscape',
          mirrorEnabled: tab.mode === 'dual' && tab.mirror && !tab.sleeping,
          pairedWebContents: portraitWc,
          pairedScale: tab.portraitScale,
        };
      }
      if (
        tab.portraitView &&
        !tab.portraitView.webContents.isDestroyed() &&
        tab.portraitView.webContents.id === webContentsId
      ) {
        const landscapeWc =
          tab.landscapeView && !tab.landscapeView.webContents.isDestroyed()
            ? tab.landscapeView.webContents
            : null;
        return {
          tabId: tab.id,
          role: 'portrait',
          mirrorEnabled: tab.mode === 'dual' && tab.mirror && !tab.sleeping,
          pairedWebContents: landscapeWc,
          pairedScale: tab.landscapeScale,
        };
      }
    }
    return null;
  }

  getTab(tabId: string): ManagedTab | undefined {
    return this.tabs.find((t) => t.id === tabId);
  }

  getActiveTab(): ManagedTab | undefined {
    if (!this.activeTabId) return this.tabs[0];
    return this.getTab(this.activeTabId) ?? this.tabs[0];
  }

  private beginViewportLoad(
    wc: WebContents,
    opts: { attachedMidLoad?: boolean; armedForStop?: boolean } = {},
  ): Promise<boolean> {
    if (wc.isDestroyed()) return Promise.resolve(false);
    const prev = this.wcLoadStates.get(wc.id);
    if (prev) {
      prev.settle(false, true);
    }

    let settled = false;
    let resolveFn!: (ok: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      resolveFn = resolve;
    });

    const cleanup = () => {
      try {
        if (typeof wc.off === 'function') {
          wc.off('did-finish-load', onLoad);
          wc.off('did-stop-loading', onStopLoading);
          wc.off('did-fail-load', onFail);
          wc.off('render-process-gone', onRenderGone);
          wc.off('destroyed', onDestroyed);
        } else if (typeof wc.removeListener === 'function') {
          wc.removeListener('did-finish-load', onLoad);
          wc.removeListener('did-stop-loading', onStopLoading);
          wc.removeListener('did-fail-load', onFail);
          wc.removeListener('render-process-gone', onRenderGone);
          wc.removeListener('destroyed', onDestroyed);
        }
      } catch {
        // Ignore listener cleanup errors.
      }
    };

    const entry = {
      promise,
      superseded: false,
      attachedMidLoad: Boolean(opts.attachedMidLoad),
      armedForStop: Boolean(opts.armedForStop),
      primingAboutBlank: false,
      settle: (ok: boolean, superseded = false) => {
        if (settled) return;
        settled = true;
        entry.superseded = superseded;
        if (this.wcLoadStates.get(wc.id) === entry) {
          this.wcLoadStates.delete(wc.id);
        }
        cleanup();
        resolveFn(ok);
      },
    };

    const onLoad = () => {
      if (entry.primingAboutBlank) return;
      entry.settle(true);
    };
    const onStopLoading = () => {
      if (entry.primingAboutBlank) return;
      if (entry.armedForStop && !wc.isDestroyed() && !wc.isLoading()) {
        entry.settle(true);
      }
    };
    const onFail = (
      _ev?: unknown,
      errorCode?: number,
      _desc?: string,
      _url?: string,
      isMainFrame?: boolean,
    ) => {
      if (isMainFrame === false) {
        return;
      }
      // ERR_ABORTED (-3) occurs when an older navigation is superseded by a new loadURL().
      if (errorCode === -3 && !wc.isDestroyed() && wc.isLoading()) {
        return;
      }
      entry.settle(false);
    };
    const onRenderGone = () => entry.settle(false);
    const onDestroyed = () => entry.settle(false);

    this.wcLoadStates.set(wc.id, entry);
    wc.on('did-finish-load', onLoad);
    wc.on('did-stop-loading', onStopLoading);
    wc.on('did-fail-load', onFail);
    wc.on('render-process-gone', onRenderGone);
    wc.on('destroyed', onDestroyed);
    return promise;
  }

  private loadViewportUrl(wc: WebContents, url: string, launchEpoch?: number): void {
    const loadPromise = this.beginViewportLoad(wc);
    const entryRef = this.wcLoadStates.get(wc.id);
    const hit = this.findTabAndRoleByWcId(wc.id);
    const active = hit ? this.isTabDedupActive(hit.tab) : false;
    const needsRendererPrime = wc.getURL() === '';

    const markLaunchEpochStarted = () => {
      if (
        launchEpoch !== undefined &&
        hit &&
        hit.tab.launchConvergence &&
        hit.tab.launchConvergence.epoch === launchEpoch
      ) {
        if (hit.role === 'landscape') {
          hit.tab.launchConvergence.landscapeStarted = true;
        } else {
          hit.tab.launchConvergence.portraitStarted = true;
        }
      }
    };

    if (!needsRendererPrime && !active && !this.muxOrDedupTouchedWcIds.has(wc.id)) {
      void this.wsSseMux.syncViewport(wc, false);
      void this.requestDedup.setViewportEnabled(wc, false);
      if (this.disposed || wc.isDestroyed() || entryRef?.superseded) {
        return;
      }
      if (entryRef && this.wcLoadStates.get(wc.id) === entryRef) {
        entryRef.armedForStop = true;
      }
      markLaunchEpochStarted();
      void Promise.resolve(wc.loadURL(url)).catch(() => {
        const current = this.wcLoadStates.get(wc.id);
        if (current && current.promise === loadPromise) {
          current.settle(false);
        }
      });
      return;
    }

    if (active) {
      this.muxOrDedupTouchedWcIds.add(wc.id);
    }
    void (async () => {
      try {
        if (needsRendererPrime) {
          if (url === 'about:blank') {
            if (entryRef && this.wcLoadStates.get(wc.id) === entryRef) {
              entryRef.armedForStop = true;
            }
            await wc.loadURL('about:blank');
            if (!this.disposed && !wc.isDestroyed() && !entryRef?.superseded) {
              await Promise.all([
                this.wsSseMux.syncViewport(wc, active),
                this.requestDedup.setViewportEnabled(wc, active),
              ]);
            }
            return;
          }
          // Electron 35 WebContentsView has no RenderFrameHost until an initial navigation starts;
          // prime about:blank so CDP Page.addScriptToEvaluateOnNewDocument & Fetch.enable never hang.
          if (entryRef && this.wcLoadStates.get(wc.id) === entryRef) {
            entryRef.primingAboutBlank = true;
          }
          try {
            await wc.loadURL('about:blank');
          } finally {
            if (entryRef && this.wcLoadStates.get(wc.id) === entryRef) {
              entryRef.primingAboutBlank = false;
            }
          }
          if (this.disposed || wc.isDestroyed() || entryRef?.superseded) {
            return;
          }
        }

        let syncTimer: ReturnType<typeof setTimeout> | null = null;
        try {
          await Promise.race([
            Promise.all([
              this.wsSseMux.syncViewport(wc, active),
              this.requestDedup.setViewportEnabled(wc, active),
            ]),
            new Promise<void>((resolve) => {
              syncTimer = setTimeout(resolve, 2500);
            }),
          ]);
        } finally {
          if (syncTimer) clearTimeout(syncTimer);
        }
        if (this.disposed || wc.isDestroyed() || entryRef?.superseded) {
          return;
        }
        if (entryRef && this.wcLoadStates.get(wc.id) === entryRef) {
          entryRef.armedForStop = true;
        }
        markLaunchEpochStarted();
        await wc.loadURL(url);
      } catch {
        const current = this.wcLoadStates.get(wc.id);
        if (current && current.promise === loadPromise) {
          current.settle(false);
        }
      }
    })();
  }

  private materializeTabViews(tab: ManagedTab, overrideUrl?: string): void {
    const targetUrl = overrideUrl ?? tab.url;
    const now = Date.now();
    const isHttpTarget = targetUrl.startsWith('http://') || targetUrl.startsWith('https://');
    let launchEpoch: number | undefined;
    if (
      tab.mode === 'dual' &&
      tab.mirror &&
      tab.session === 'shared' &&
      isHttpTarget &&
      (!tab.landscapeView || tab.landscapeView.webContents.isDestroyed())
    ) {
      launchEpoch = this.nextLaunchConvergenceEpoch++;
      tab.launchConvergence = {
        epoch: launchEpoch,
        requestedUrl: targetUrl,
        landscapeStarted: false,
        portraitStarted: false,
        landscapeFinalUrl: null,
        converged: false,
      };
    } else if (!tab.landscapeView || tab.landscapeView.webContents.isDestroyed()) {
      tab.launchConvergence = null;
    }
    if (!tab.landscapeView || tab.landscapeView.webContents.isDestroyed()) {
      tab.landscapeView = this.createViewportView(tab.id, 'landscape', tab.session);
      tab.navSuppressUntil.landscape = now + NAV_MIRROR_SUPPRESS_MS;
      this.loadViewportUrl(tab.landscapeView.webContents, targetUrl, launchEpoch);
    }
    if (tab.mode === 'dual' && (!tab.portraitView || tab.portraitView.webContents.isDestroyed())) {
      tab.portraitView = this.createViewportView(tab.id, 'portrait', tab.session);
      tab.navSuppressUntil.portrait = now + NAV_MIRROR_SUPPRESS_MS;
      this.loadViewportUrl(tab.portraitView.webContents, targetUrl, launchEpoch);
    }
  }

  private async ensureTabMaterializedAndLoaded(
    tab: ManagedTab,
    timeoutMs = 8000,
  ): Promise<boolean> {
    const deadline = Date.now() + Math.max(1, timeoutMs);

    while (true) {
      if (tab.sleeping) {
        throw new Error(`tab '${tab.id}' is sleeping`);
      }
      if (this.disposed || this.win.isDestroyed() || !this.tabs.includes(tab)) {
        return false;
      }

      const pendingReload = this.pendingReloads.get(tab.id);
      if (pendingReload) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          return false;
        }
        let timer: ReturnType<typeof setTimeout> | null = null;
        const reloadOutcome = await Promise.race([
          pendingReload.then(
            () => ({ timedOut: false as const }),
            () => ({ timedOut: false as const }),
          ),
          new Promise<{ timedOut: true }>((resolve) => {
            timer = setTimeout(() => resolve({ timedOut: true }), remainingMs);
          }),
        ]);
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (reloadOutcome.timedOut) {
          return false;
        }
        continue;
      }

      const needsLandscape = !tab.landscapeView || tab.landscapeView.webContents.isDestroyed();
      const needsPortrait =
        tab.mode === 'dual' && (!tab.portraitView || tab.portraitView.webContents.isDestroyed());
      if (needsLandscape || needsPortrait) {
        this.materializeTabViews(tab);
        this.syncVisibilityAndLayout();
      }

      const activeWcs: WebContents[] = [];
      if (tab.landscapeView && !tab.landscapeView.webContents.isDestroyed()) {
        activeWcs.push(tab.landscapeView.webContents);
      }
      if (
        tab.mode === 'dual' &&
        tab.portraitView &&
        !tab.portraitView.webContents.isDestroyed()
      ) {
        activeWcs.push(tab.portraitView.webContents);
      }

      const tracked: Array<{
        wc: WebContents;
        entry: {
          promise: Promise<boolean>;
          superseded: boolean;
          attachedMidLoad: boolean;
          settle: (ok: boolean, superseded?: boolean) => void;
        };
        promise: Promise<boolean>;
      }> = [];
      for (const wc of activeWcs) {
        let entry = this.wcLoadStates.get(wc.id);
        if (entry && entry.attachedMidLoad && !wc.isLoading()) {
          entry.settle(true);
          entry = undefined;
        }
        if (!entry && wc.isLoading()) {
          const promise = this.beginViewportLoad(wc, {
            attachedMidLoad: true,
            armedForStop: true,
          });
          entry = this.wcLoadStates.get(wc.id);
          if (!entry) {
            tracked.push({
              wc,
              entry: { promise, superseded: false, attachedMidLoad: true, settle: () => {} },
              promise,
            });
            continue;
          }
        }
        if (entry) {
          tracked.push({ wc, entry, promise: entry.promise });
        }
      }

      if (tracked.length === 0) {
        const emulations: Promise<void>[] = [];
        for (const wc of activeWcs) {
          const pending = this.pendingEmulations.get(wc.id);
          if (pending) emulations.push(pending);
        }
        if (emulations.length > 0) {
          let emuWaitTimer: ReturnType<typeof setTimeout> | null = null;
          const emuCapMs = Math.min(1200, Math.max(50, deadline - Date.now()));
          try {
            await Promise.race([
              Promise.all(emulations).catch(() => {}),
              new Promise<void>((resolve) => {
                emuWaitTimer = setTimeout(resolve, emuCapMs);
              }),
            ]);
          } finally {
            if (emuWaitTimer) clearTimeout(emuWaitTimer);
          }
        }
        return (
          !this.disposed &&
          !this.win.isDestroyed() &&
          !tab.sleeping &&
          this.tabs.includes(tab) &&
          Boolean(tab.landscapeView && !tab.landscapeView.webContents.isDestroyed()) &&
          (tab.mode !== 'dual' ||
            Boolean(tab.portraitView && !tab.portraitView.webContents.isDestroyed()))
        );
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        for (const item of tracked) {
          if (item.entry.attachedMidLoad || item.wc.isDestroyed() || !item.wc.isLoading()) {
            item.entry.settle(false);
          }
        }
        return false;
      }

      let timer: ReturnType<typeof setTimeout> | null = null;
      const raceOutcome = await Promise.race([
        Promise.all(tracked.map((t) => t.promise)).then((results) => ({
          timedOut: false as const,
          results,
        })),
        new Promise<{ timedOut: true }>((resolve) => {
          timer = setTimeout(() => resolve({ timedOut: true }), remainingMs);
        }),
      ]);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      if (tab.sleeping) {
        throw new Error(`tab '${tab.id}' is sleeping`);
      }
      if (this.disposed || this.win.isDestroyed() || !this.tabs.includes(tab)) {
        return false;
      }
      if (raceOutcome.timedOut) {
        for (const item of tracked) {
          if (item.entry.attachedMidLoad || item.wc.isDestroyed() || !item.wc.isLoading()) {
            item.entry.settle(false);
          }
        }
        return false;
      }

      for (let i = 0; i < tracked.length; i += 1) {
        const item = tracked[i]!;
        const ok = raceOutcome.results[i];
        const stillExpected =
          item.wc === tab.landscapeView?.webContents ||
          (tab.mode === 'dual' && item.wc === tab.portraitView?.webContents);
        if (!ok && stillExpected && !item.entry.superseded) {
          return false;
        }
      }
    }
  }

  private destroyTabViews(tab: ManagedTab): void {
    this.destroyView(tab.portraitView);
    this.destroyView(tab.landscapeView);
    tab.portraitView = null;
    tab.landscapeView = null;
  }

  private isTabAudible(tab: ManagedTab): boolean {
    const landscapeAudible =
      tab.landscapeView &&
      !tab.landscapeView.webContents.isDestroyed() &&
      tab.landscapeView.webContents.isCurrentlyAudible();
    const portraitAudible =
      tab.portraitView &&
      !tab.portraitView.webContents.isDestroyed() &&
      tab.portraitView.webContents.isCurrentlyAudible();
    return Boolean(landscapeAudible || portraitAudible);
  }

  private syncAutoSleepTimer(): void {
    if (this.autoSleepTimer) {
      clearInterval(this.autoSleepTimer);
      this.autoSleepTimer = null;
    }
    if (this.autoSleep) {
      this.autoSleepTimer = setInterval(() => {
        this.sweepAutoSleep();
      }, this.autoSleepCheckMs);
    }
  }

  sweepAutoSleep(nowMs = Date.now(), idleMs = this.autoSleepAfterMs): string[] {
    if (!this.autoSleep) return [];
    const sleptIds: string[] = [];
    for (const tab of this.tabs) {
      if (tab.id === this.activeTabId) continue;
      if (tab.sleeping) continue;
      if (!tab.landscapeView || tab.landscapeView.webContents.isDestroyed()) continue;
      if (this.isTabAudible(tab)) continue;
      if (nowMs - tab.lastActiveAt >= idleMs) {
        tab.sleeping = true;
        this.destroyTabViews(tab);
        this.mirrorRelay.clearTab(tab.id);
        this.requestDedup.clearTabSlots(tab.id);
        this.wsSseMux.clearTab(tab.id);
        this.tabEventBus.sessionStorageClearTab(tab.id);
        this.activeTracesByTab.delete(tab.id);
        sleptIds.push(tab.id);
      }
    }
    if (sleptIds.length > 0) {
      this.syncVisibilityAndLayout();
      this.emitState();
    }
    return sleptIds;
  }

  toggleEcoMode(): ShellState {
    this.ecoMode = !this.ecoMode;
    const active = this.getActiveTab();
    if (active && !active.sleeping) {
      void this.applyViewportEmulation(active, 'landscape');
      if (active.mode === 'dual' && active.portraitView) {
        void this.applyViewportEmulation(active, 'portrait');
      }
    }
    return this.emitState();
  }

  setAutoSleep(enabled: boolean): ShellState {
    this.autoSleep = Boolean(enabled);
    this.syncAutoSleepTimer();
    return this.emitState();
  }

  createTab(opts: CreateTabOptions = {}): ShellState {
    const id = `tab-${this.nextTabSeq++}`;
    const url = opts.url ? normalizeUrl(opts.url) : getDefaultWelcomeUrl();
    const mode: ViewMode = opts.mode ?? 'dual';
    const sessionMode: SessionMode = opts.session ?? 'shared';

    const portraitPreset = getPresetOrDefault(
      opts.portraitPresetId ?? DEFAULT_PORTRAIT_PRESET_ID,
      DEFAULT_PORTRAIT_PRESET_ID,
    );
    const landscapePreset = getPresetOrDefault(
      opts.landscapePresetId ?? DEFAULT_LANDSCAPE_PRESET_ID,
      DEFAULT_LANDSCAPE_PRESET_ID,
    );

    const validatedPortraitSize = validateViewportSizeInput(
      opts.portraitSize,
      'portraitSize',
      portraitPreset.dpr,
    );
    const portraitSize: ViewportDimensions = validatedPortraitSize ?? {
      width: portraitPreset.width,
      height: portraitPreset.height,
      dpr: portraitPreset.dpr,
    };

    const validatedLandscapeSize = validateViewportSizeInput(
      opts.landscapeSize,
      'landscapeSize',
      landscapePreset.dpr,
    );
    const landscapeSize: ViewportDimensions = validatedLandscapeSize ?? {
      width: landscapePreset.width,
      height: landscapePreset.height,
      dpr: landscapePreset.dpr,
    };

    const now = Date.now();
    const initialTitle = opts.title ?? (opts.url ? url : 'IronBrowser');
    const shouldSpawnViews = !opts.lazy && !opts.sleeping;

    const tab: ManagedTab = {
      id,
      title: initialTitle,
      titleUrl: opts.title && !isPlaceholderTitle(opts.title, url) ? url : '',
      url,
      mode,
      mirror: opts.mirror ?? true,
      dedup: opts.dedup ?? true,
      dedupCount: 0,
      session: sessionMode,
      sleeping: opts.sleeping ?? false,
      portraitPresetId: portraitPreset.id,
      landscapePresetId: landscapePreset.id,
      portraitSize,
      landscapeSize,
      portraitScale: 1,
      landscapeScale: 1,
      devtoolsTarget: opts.devtoolsTarget ?? (mode === 'dual' ? 'portrait' : 'landscape'),
      audioSource: opts.audioSource ?? 'landscape',
      navSuppressUntil: {
        portrait: now + NAV_MIRROR_SUPPRESS_MS,
        landscape: now + NAV_MIRROR_SUPPRESS_MS,
      },
      launchConvergence: null,
      lastActiveAt: now,
      skipNextRestoreHistoryCommit: opts.recordHistory === false,
      landscapeView: null,
      portraitView: null,
    };

    if (opts.recordHistory !== false && isPersistableHttpUrl(url)) {
      this.history = recordHistoryEntry(this.history, url, tab.title);
    }

    this.tabs.push(tab);
    if (opts.activate !== false || this.activeTabId === null) {
      this.activeTabId = id;
    }
    this.tabEventBus.publish({
      tabId: id,
      viewport: 'both',
      domain: 'lifecycle',
      kind: 'tab_created',
      summary: `${mode}/${sessionMode}: ${url}`,
    });

    if (shouldSpawnViews) {
      this.materializeTabViews(tab, url);
    }

    this.syncVisibilityAndLayout();
    this.syncDevToolsAttachment();
    return this.emitState();
  }

  closeTab(tabId: string): ShellState {
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return this.getShellState();
    const [tab] = this.tabs.splice(idx, 1);
    if (tab) {
      if (isPersistableHttpUrl(tab.url)) {
        this.closedTabs.unshift({
          url: tab.url,
          title: truncatePersistedTitle(tab.title, formatHistorySubtitle(tab.url)),
          mode: tab.mode,
          mirror: tab.mirror,
          dedup: tab.dedup,
          session: tab.session,
          sleeping: false,
          portraitPresetId: tab.portraitPresetId,
          landscapePresetId: tab.landscapePresetId,
          devtoolsTarget: tab.devtoolsTarget,
          audioSource: tab.audioSource,
        });
        if (this.closedTabs.length > MAX_CLOSED_TABS) {
          this.closedTabs.length = MAX_CLOSED_TABS;
        }
      }
      this.destroyTabViews(tab);
      if (tab.session === 'isolated') {
        this.clearIsolatedPartition(tab.id);
      }
      this.requestDedup.clearTab(tab.id);
      this.wsSseMux.clearTab(tab.id);
      this.activeTracesByTab.delete(tab.id);
      this.clearTabMirrorMiss(tab.id);
      this.mirrorRelay.clearTab(tab.id);
      this.telemetry.clearTabEntries(tab.id);
      this.tabEventBus.clearTab(tab.id);
    }

    if (this.tabs.length === 0) {
      this.activeTabId = null;
      return this.createTab({ mode: 'dual' });
    }

    if (this.activeTabId === tabId) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)]!;
      this.activeTabId = next.id;
      next.sleeping = false;
      next.lastActiveAt = Date.now();
      this.materializeTabViews(next);
    }

    this.syncVisibilityAndLayout();
    this.syncDevToolsAttachment();
    return this.emitState();
  }

  reopenClosedTab(): ShellState {
    const closed = this.closedTabs.shift();
    if (!closed) return this.getShellState();
    return this.createTab({
      url: closed.url,
      title: closed.title,
      mode: closed.mode,
      mirror: closed.mirror,
      dedup: closed.dedup,
      session: closed.session,
      sleeping: false,
      portraitPresetId: closed.portraitPresetId,
      landscapePresetId: closed.landscapePresetId,
      devtoolsTarget: closed.devtoolsTarget,
      audioSource: closed.audioSource,
      activate: true,
    });
  }

  selectTab(tabId: string): ShellState {
    const tab = this.getTab(tabId);
    if (!tab) return this.getShellState();
    this.activeTabId = tab.id;
    tab.sleeping = false;
    tab.lastActiveAt = Date.now();
    this.materializeTabViews(tab);
    this.syncVisibilityAndLayout();
    this.syncDevToolsAttachment();
    return this.emitState();
  }

  sleepTab(tabId: string): ShellState {
    const tab = this.getTab(tabId);
    if (!tab) return this.getShellState();
    tab.sleeping = !tab.sleeping;
    if (tab.sleeping) {
      this.destroyTabViews(tab);
      this.mirrorRelay.clearTab(tab.id);
      this.requestDedup.clearTabSlots(tab.id);
      this.wsSseMux.clearTab(tab.id);
      this.tabEventBus.sessionStorageClearTab(tab.id);
      this.activeTracesByTab.delete(tab.id);
      if (tab.id === this.activeTabId) {
        const awakeOther = this.tabs.find((t) => t.id !== tab.id && !t.sleeping);
        if (awakeOther) {
          this.activeTabId = awakeOther.id;
          awakeOther.lastActiveAt = Date.now();
          this.materializeTabViews(awakeOther);
        }
      }
    } else {
      tab.lastActiveAt = Date.now();
      if (tab.id === this.activeTabId) {
        this.materializeTabViews(tab);
      }
    }

    this.syncVisibilityAndLayout();
    this.syncDevToolsAttachment();
    return this.emitState();
  }

  navigate(rawUrl: string, tabId?: string): ShellState {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    if (!tab) return this.getShellState();
    const url = normalizeUrl(rawUrl);
    tab.skipNextRestoreHistoryCommit = false;
    tab.url = url;
    tab.titleUrl = '';
    tab.title = isPersistableHttpUrl(url) ? formatHistorySubtitle(url) : 'IronBrowser';
    tab.sleeping = false;
    tab.lastActiveAt = Date.now();
    this.clearTabMirrorMiss(tab.id);
    if (isPersistableHttpUrl(url)) {
      this.history = recordHistoryEntry(this.history, url);
    }

    const now = Date.now();
    const isHttpTarget = url.startsWith('http://') || url.startsWith('https://');
    this.tabEventBus.publish({
      tabId: tab.id,
      viewport: 'both',
      domain: 'navigation',
      kind: 'navigate',
      summary: url,
      tsMs: now,
    });
    tab.navSuppressUntil.landscape = now + NAV_MIRROR_SUPPRESS_MS;
    tab.navSuppressUntil.portrait = now + NAV_MIRROR_SUPPRESS_MS;

    if (!tab.landscapeView || tab.landscapeView.webContents.isDestroyed()) {
      this.materializeTabViews(tab, url);
      this.syncVisibilityAndLayout();
      this.syncDevToolsAttachment();
    } else {
      let launchEpoch: number | undefined;
      if (tab.mode === 'dual' && tab.mirror && tab.session === 'shared' && isHttpTarget) {
        launchEpoch = this.nextLaunchConvergenceEpoch++;
        tab.launchConvergence = {
          epoch: launchEpoch,
          requestedUrl: url,
          landscapeStarted: false,
          portraitStarted: false,
          landscapeFinalUrl: null,
          converged: false,
        };
      } else {
        tab.launchConvergence = null;
      }
      this.loadViewportUrl(tab.landscapeView.webContents, url, launchEpoch);
      if (tab.portraitView && !tab.portraitView.webContents.isDestroyed()) {
        this.loadViewportUrl(tab.portraitView.webContents, url, launchEpoch);
      }
    }
    return this.emitState();
  }

  goBack(): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    tab.skipNextRestoreHistoryCommit = false;
    tab.launchConvergence = null;
    tab.lastActiveAt = Date.now();
    if (!tab.landscapeView || tab.landscapeView.webContents.isDestroyed()) return;
    const now = Date.now();
    if (tab.landscapeView.webContents.navigationHistory.canGoBack()) {
      tab.titleUrl = '';
      tab.navSuppressUntil.landscape = now + NAV_MIRROR_SUPPRESS_MS;
      tab.landscapeView.webContents.navigationHistory.goBack();
    }
    if (
      tab.mode === 'dual' &&
      tab.mirror &&
      tab.portraitView &&
      !tab.portraitView.webContents.isDestroyed() &&
      tab.portraitView.webContents.navigationHistory.canGoBack()
    ) {
      tab.navSuppressUntil.portrait = now + NAV_MIRROR_SUPPRESS_MS;
      tab.portraitView.webContents.navigationHistory.goBack();
    }
  }

  goForward(): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    tab.skipNextRestoreHistoryCommit = false;
    tab.launchConvergence = null;
    tab.lastActiveAt = Date.now();
    if (!tab.landscapeView || tab.landscapeView.webContents.isDestroyed()) return;
    const now = Date.now();
    if (tab.landscapeView.webContents.navigationHistory.canGoForward()) {
      tab.titleUrl = '';
      tab.navSuppressUntil.landscape = now + NAV_MIRROR_SUPPRESS_MS;
      tab.landscapeView.webContents.navigationHistory.goForward();
    }
    if (
      tab.mode === 'dual' &&
      tab.mirror &&
      tab.portraitView &&
      !tab.portraitView.webContents.isDestroyed() &&
      tab.portraitView.webContents.navigationHistory.canGoForward()
    ) {
      tab.navSuppressUntil.portrait = now + NAV_MIRROR_SUPPRESS_MS;
      tab.portraitView.webContents.navigationHistory.goForward();
    }
  }

  async reload(): Promise<void> {
    if (this.disposed || this.win.isDestroyed()) return;
    const tab = this.getActiveTab();
    if (!tab) return;

    const run = (async () => {
      const wasSleeping = tab.sleeping;
      tab.lastActiveAt = Date.now();

      for (const hook of this.beforeReloadHooks) {
        try {
          hook(tab.id);
        } catch {
          // Isolate reload hooks so cache clear and reload still run.
        }
      }

      const sessions = new Set<Session>();
      if (tab.landscapeView && !tab.landscapeView.webContents.isDestroyed()) {
        sessions.add(tab.landscapeView.webContents.session);
      }
      if (tab.portraitView && !tab.portraitView.webContents.isDestroyed()) {
        sessions.add(tab.portraitView.webContents.session);
      }
      if (sessions.size === 0) {
        try {
          if (session.defaultSession) sessions.add(session.defaultSession);
          if (tab.session === 'isolated') {
            sessions.add(session.fromPartition(`iron-iso-${tab.id}`));
          }
        } catch {
          // Ignore session lookup fallback failures.
        }
      }

      await Promise.all(
        Array.from(sessions).map((sess) => Promise.resolve(sess.clearCache()).catch(() => {})),
      );

      if (
        this.disposed ||
        this.win.isDestroyed() ||
        !this.tabs.includes(tab) ||
        (!wasSleeping && tab.sleeping)
      ) {
        return;
      }

      const now = Date.now();
      tab.launchConvergence = null;
      tab.navSuppressUntil.landscape = now + NAV_MIRROR_SUPPRESS_MS;
      tab.navSuppressUntil.portrait = now + NAV_MIRROR_SUPPRESS_MS;

      if (!tab.landscapeView || tab.landscapeView.webContents.isDestroyed()) {
        tab.sleeping = false;
        this.clearTabMirrorMiss(tab.id);
        this.materializeTabViews(tab);
        this.syncVisibilityAndLayout();
        this.syncDevToolsAttachment();
        this.emitState();
        return;
      }

      this.clearTabMirrorMiss(tab.id);
      const lWc = tab.landscapeView.webContents;
      const pWc =
        tab.mode === 'dual' && tab.portraitView && !tab.portraitView.webContents.isDestroyed()
          ? tab.portraitView.webContents
          : null;

      this.wsSseMux.handleViewportTeardown(lWc.id, 'reload');
      const lLoad = this.beginViewportLoad(lWc);
      const lEntry = this.wcLoadStates.get(lWc.id);

      let pLoad: Promise<boolean> | null = null;
      let pEntry: ReturnType<typeof this.wcLoadStates.get> | undefined;
      if (pWc) {
        this.wsSseMux.handleViewportTeardown(pWc.id, 'reload');
        pLoad = this.beginViewportLoad(pWc);
        pEntry = this.wcLoadStates.get(pWc.id);
      }

      const active = this.isTabDedupActive(tab);
      await Promise.all([
        this.wsSseMux.syncViewport(lWc, active),
        this.requestDedup.setViewportEnabled(lWc, active),
        ...(pWc
          ? [
              this.wsSseMux.syncViewport(pWc, active),
              this.requestDedup.setViewportEnabled(pWc, active),
            ]
          : []),
      ]);

      if (
        this.disposed ||
        this.win.isDestroyed() ||
        !this.tabs.includes(tab) ||
        (!wasSleeping && tab.sleeping)
      ) {
        return;
      }

      if (!lWc.isDestroyed() && this.wcLoadStates.get(lWc.id)?.promise === lLoad) {
        if (lEntry) lEntry.armedForStop = true;
        lWc.reloadIgnoringCache();
      }
      if (pWc && !pWc.isDestroyed() && pLoad && this.wcLoadStates.get(pWc.id)?.promise === pLoad) {
        if (pEntry) pEntry.armedForStop = true;
        pWc.reloadIgnoringCache();
      }
    })();

    this.pendingReloads.set(tab.id, run);
    try {
      await run;
    } finally {
      if (this.pendingReloads.get(tab.id) === run) {
        this.pendingReloads.delete(tab.id);
      }
    }
  }

  toggleDualMode(tabId?: string): ShellState {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    if (!tab) return this.getShellState();
    tab.launchConvergence = null;

    if (tab.mode === 'dual') {
      tab.mode = 'single';
      tab.devtoolsTarget = 'landscape';
      if (tab.audioSource === 'portrait') {
        tab.audioSource = 'landscape';
      }
      // Destroy portraitView cleanly on Dual -> Single to free RAM/CPU/audio and stop phantom telemetry.
      if (tab.portraitView) {
        this.destroyView(tab.portraitView);
        tab.portraitView = null;
      }
      this.telemetry.clearTabViewportEntries(tab.id, 'portrait');
      this.syncTabDedupAndMux(tab);
    } else {
      tab.mode = 'dual';
      this.syncTabDedupAndMux(tab);
      if (tab.landscapeView && !tab.landscapeView.webContents.isDestroyed() && !tab.portraitView) {
        tab.portraitView = this.createViewportView(tab.id, 'portrait', tab.session);
        tab.navSuppressUntil.portrait = Date.now() + NAV_MIRROR_SUPPRESS_MS;
        this.loadViewportUrl(tab.portraitView.webContents, tab.url);
      }
    }

    this.syncVisibilityAndLayout();
    this.syncDevToolsAttachment();
    return this.emitState();
  }

  toggleMirror(tabId?: string): ShellState {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    if (!tab) return this.getShellState();
    tab.launchConvergence = null;
    tab.mirror = !tab.mirror;
    this.syncTabDedupAndMux(tab);
    return this.emitState();
  }

  toggleDedup(tabId?: string): ShellState {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    if (!tab) return this.getShellState();
    tab.dedup = !tab.dedup;
    this.syncTabDedupAndMux(tab);
    return this.emitState();
  }

  setSessionMode(mode: SessionMode, tabId?: string): ShellState {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    if (!tab || tab.session === mode) return this.getShellState();
    tab.launchConvergence = null;
    const prevMode = tab.session;
    tab.session = mode;
    this.tabEventBus.sessionStorageClearTab(tab.id);

    if (tab.portraitView) {
      const wasInspectingPortrait = tab.devtoolsTarget === 'portrait';
      this.destroyView(tab.portraitView);
      if (prevMode === 'isolated' && mode === 'shared') {
        this.clearIsolatedPartition(tab.id);
      }
      tab.portraitView = this.createViewportView(tab.id, 'portrait', mode);
      tab.navSuppressUntil.portrait = Date.now() + NAV_MIRROR_SUPPRESS_MS;
      this.loadViewportUrl(tab.portraitView.webContents, tab.url);
      if (wasInspectingPortrait) {
        this.attachedDevToolsWcId = null;
      }
    } else if (prevMode === 'isolated' && mode === 'shared') {
      this.clearIsolatedPartition(tab.id);
    }

    this.syncTabDedupAndMux(tab);
    this.syncVisibilityAndLayout();
    this.syncDevToolsAttachment();
    return this.emitState();
  }

  toggleSessionMode(tabId?: string): ShellState {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    if (!tab) return this.getShellState();
    return this.setSessionMode(tab.session === 'shared' ? 'isolated' : 'shared', tab.id);
  }

  setPreset(role: ViewportRole, presetId: string, tabId?: string): ShellState {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    if (!tab) return this.getShellState();
    const preset = getPresetOrDefault(
      presetId,
      role === 'portrait' ? DEFAULT_PORTRAIT_PRESET_ID : DEFAULT_LANDSCAPE_PRESET_ID,
    );
    if (role === 'portrait') {
      tab.portraitPresetId = preset.id;
      tab.portraitSize = { width: preset.width, height: preset.height, dpr: preset.dpr };
    } else {
      tab.landscapePresetId = preset.id;
      tab.landscapeSize = { width: preset.width, height: preset.height, dpr: preset.dpr };
    }
    void this.applyViewportEmulation(tab, role);
    return this.emitState();
  }

  setRailCollapsed(collapsed: boolean): ShellState {
    this.railCollapsed = collapsed;
    this.applyLayout();
    return this.emitState();
  }

  setDockOpen(open: boolean): ShellState {
    this.dockOpen = open;
    this.syncVisibilityAndLayout();
    this.syncDevToolsAttachment();
    return this.emitState();
  }

  setDockHeight(height: number): ShellState {
    this.dockHeight = height;
    this.applyLayout();
    return this.emitState();
  }

  setSplitRatio(ratio: number): ShellState {
    this.splitRatio = ratio;
    this.applyLayout();
    return this.emitState();
  }

  setDevToolsTarget(role: ViewportRole): ShellState {
    const tab = this.getActiveTab();
    if (!tab) return this.getShellState();
    tab.devtoolsTarget = tab.mode === 'single' ? 'landscape' : role;
    if (!this.dockOpen) {
      this.dockOpen = true;
      this.syncVisibilityAndLayout();
    }
    this.syncDevToolsAttachment();
    return this.emitState();
  }

  focusAnomaly(kind: 'console' | 'network'): ShellState {
    const tab = this.getActiveTab();
    if (!tab) return this.getShellState();
    const culprit = this.telemetry.findLatestErrorViewport(tab.id, kind);
    if (culprit && (tab.mode === 'dual' || culprit === 'landscape')) {
      tab.devtoolsTarget = culprit;
    }
    this.dockOpen = true;
    this.syncVisibilityAndLayout();
    this.syncDevToolsAttachment();
    return this.emitState();
  }

  setTheme(theme: ThemeMode): ShellState {
    this.theme = theme;
    return this.emitState();
  }

  private destroyView(view: WebContentsView | null): void {
    if (!view) return;
    const wc = view.webContents;
    this.wcLoadStates.get(wc.id)?.settle(false);
    this.wcLoadStates.delete(wc.id);
    this.pendingEmulations.delete(wc.id);
    this.observedViewports.delete(wc.id);
    this.muxOrDedupTouchedWcIds.delete(wc.id);
    if (this.attachedDevToolsWcId === wc.id) {
      this.destroyDevToolsView();
    }
    this.wsSseMux.disposeWebContents(wc.id);
    this.requestDedup.disposeWebContents(wc.id);
    this.debuggerCoordinator.detach(wc);
    try {
      this.win.contentView.removeChildView(view);
    } catch {
      // Ignore if already removed.
    }
    try {
      if (!wc.isDestroyed()) {
        wc.close({ waitForBeforeUnload: false });
      }
    } catch {
      // Ignore.
    }
  }

  private syncVisibilityAndLayout(): void {
    const active = this.getActiveTab();
    for (const tab of this.tabs) {
      const isActive = active?.id === tab.id && !tab.sleeping;
      if (tab.landscapeView && !tab.landscapeView.webContents.isDestroyed()) {
        const lWc = tab.landscapeView.webContents;
        tab.landscapeView.setVisible(isActive);
        const lLoading = this.wcLoadStates.has(lWc.id) || lWc.isLoading();
        lWc.setBackgroundThrottling(!isActive && !lLoading);
        // Enforce single audio owner: Portrait is muted by default in Dual Mode so sound never duplicates.
        const landscapeMuted = !isActive || tab.audioSource !== 'landscape';
        lWc.setAudioMuted(landscapeMuted);
      }

      if (tab.portraitView && !tab.portraitView.webContents.isDestroyed()) {
        const showPortrait = isActive && tab.mode === 'dual';
        const pWc = tab.portraitView.webContents;
        tab.portraitView.setVisible(showPortrait);
        const pLoading = this.wcLoadStates.has(pWc.id) || pWc.isLoading();
        pWc.setBackgroundThrottling(!showPortrait && !pLoading);
        const portraitMuted = !showPortrait || tab.audioSource !== 'portrait';
        pWc.setAudioMuted(portraitMuted);
      }
    }
    if (this.devtoolsView && !this.devtoolsView.webContents.isDestroyed()) {
      this.devtoolsView.setVisible(this.dockOpen);
    }
    this.applyLayout();
  }

  applyLayout(): void {
    if (this.win.isDestroyed()) return;
    const [windowWidth = 1480, windowHeight = 920] = this.win.getContentSize();
    const active = this.getActiveTab();
    const mode: ViewMode = active?.mode ?? 'single';

    const layout = computeLayout({
      windowWidth,
      windowHeight,
      mode,
      railCollapsed: this.railCollapsed,
      dockOpen: this.dockOpen,
      dockHeight: this.dockHeight,
      splitRatio: this.splitRatio,
    });
    this.lastLayout = layout;
    this.splitRatio = layout.clampedSplitRatio;
    if (this.dockOpen) {
      this.dockHeight = layout.clampedDockHeight;
    }

    if (
      active &&
      !active.sleeping &&
      active.landscapeView &&
      !active.landscapeView.webContents.isDestroyed()
    ) {
      active.landscapeView.setBounds(layout.landscapeView);
      void this.applyViewportEmulation(active, 'landscape');
      if (
        active.portraitView &&
        !active.portraitView.webContents.isDestroyed() &&
        layout.portraitView
      ) {
        active.portraitView.setBounds(layout.portraitView);
        void this.applyViewportEmulation(active, 'portrait');
      }
    }

    for (const tab of this.tabs) {
      if (tab.id === active?.id || tab.sleeping) continue;
      const tabLayout = computeLayout({
        windowWidth,
        windowHeight,
        mode: tab.mode,
        railCollapsed: this.railCollapsed,
        dockOpen: this.dockOpen,
        dockHeight: this.dockHeight,
        splitRatio: this.splitRatio,
      });
      if (tab.landscapeView && !tab.landscapeView.webContents.isDestroyed()) {
        tab.landscapeView.setBounds(tabLayout.landscapeView);
      }
      if (
        tab.mode === 'dual' &&
        tab.portraitView &&
        !tab.portraitView.webContents.isDestroyed() &&
        tabLayout.portraitView
      ) {
        tab.portraitView.setBounds(tabLayout.portraitView);
      }
    }

    if (
      layout.devtoolsView &&
      this.dockOpen &&
      this.devtoolsView &&
      !this.devtoolsView.webContents.isDestroyed()
    ) {
      this.devtoolsView.setBounds(layout.devtoolsView);
    }
  }

  private syncDevToolsAttachment(): void {
    const active = this.getActiveTab();
    if (
      !this.dockOpen ||
      !active ||
      active.sleeping ||
      !active.landscapeView ||
      active.landscapeView.webContents.isDestroyed()
    ) {
      this.destroyDevToolsView();
      return;
    }

    const targetView =
      active.devtoolsTarget === 'portrait' &&
      active.mode === 'dual' &&
      active.portraitView &&
      !active.portraitView.webContents.isDestroyed()
        ? active.portraitView
        : active.landscapeView;
    const targetWc = targetView.webContents;
    if (targetWc.isDestroyed()) {
      this.destroyDevToolsView();
      return;
    }
    if (
      this.attachedDevToolsWcId === targetWc.id &&
      this.devtoolsView &&
      !this.devtoolsView.webContents.isDestroyed()
    ) {
      return;
    }

    // Always close prevWc DevTools and destroy old devtoolsView before creating a fresh one.
    this.destroyDevToolsView();
    const dv = this.ensureDevToolsView();
    if (this.lastLayout?.devtoolsView) {
      dv.setBounds(this.lastLayout.devtoolsView);
    }
    dv.setVisible(true);

    try {
      targetWc.setDevToolsWebContents(dv.webContents);
      targetWc.openDevTools({ mode: 'detach', activate: false });
      this.attachedDevToolsWcId = targetWc.id;
    } catch {
      // Ignore if DevTools cannot attach (e.g. headless mode without GPU).
    }
  }

  private findWebContentsById(wcId: number): WebContents | null {
    for (const tab of this.tabs) {
      if (
        tab.landscapeView &&
        !tab.landscapeView.webContents.isDestroyed() &&
        tab.landscapeView.webContents.id === wcId
      ) {
        return tab.landscapeView.webContents;
      }
      if (
        tab.portraitView &&
        !tab.portraitView.webContents.isDestroyed() &&
        tab.portraitView.webContents.id === wcId
      ) {
        return tab.portraitView.webContents;
      }
    }
    return null;
  }

  getViewportWebContents(tabId: string | undefined, role: ViewportRole): WebContents | null {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    if (!tab) return null;
    if (role === 'portrait') {
      return tab.portraitView && !tab.portraitView.webContents.isDestroyed()
        ? tab.portraitView.webContents
        : null;
    }
    return tab.landscapeView && !tab.landscapeView.webContents.isDestroyed()
      ? tab.landscapeView.webContents
      : null;
  }

  private computeFallbackEffectiveSize(
    tab: ManagedTab,
    role: ViewportRole,
  ): { css: { width: number; height: number } | null; dpr: number | null } {
    if (tab.sleeping) return { css: null, dpr: null };
    const view = role === 'portrait' ? tab.portraitView : tab.landscapeView;
    if (!view || view.webContents.isDestroyed()) {
      return { css: null, dpr: null };
    }
    const wc = view.webContents;
    const obs = this.observedViewports.get(wc.id);
    if (obs) {
      return { css: { width: obs.width, height: obs.height }, dpr: obs.dpr };
    }

    const bounds = view.getBounds();
    if (role === 'portrait') {
      const fitScale =
        bounds.width > 0 && bounds.height > 0
          ? computeFitScale(bounds.width, bounds.height, tab.portraitSize.width, tab.portraitSize.height)
          : 1;
      const effDpr = computeEffectiveDpr(
        tab.portraitSize.dpr,
        fitScale,
        this.getHostScaleFactor(),
        this.ecoMode,
      );
      return {
        css: { width: tab.portraitSize.width, height: tab.portraitSize.height },
        dpr: effDpr,
      };
    }

    if (tab.mode === 'dual') {
      if (this.debuggerCoordinator.isAttached(wc)) {
        return {
          css: { width: tab.landscapeSize.width, height: tab.landscapeSize.height },
          dpr: tab.landscapeSize.dpr,
        };
      }
      if (bounds.width > 0 && bounds.height > 0) {
        return {
          css: { width: bounds.width, height: bounds.height },
          dpr: this.getHostScaleFactor(),
        };
      }
      return { css: null, dpr: null };
    }

    // Single mode clears DeviceMetricsOverride so CSS viewport follows raw WebContentsView bounds.
    if (bounds.width > 0 && bounds.height > 0) {
      return {
        css: { width: bounds.width, height: bounds.height },
        dpr: this.getHostScaleFactor(),
      };
    }
    return { css: null, dpr: null };
  }

  buildTabViewportReport(tab: ManagedTab): Partial<Record<ViewportRole, ViewportSizingSummary>> {
    const out: Partial<Record<ViewportRole, ViewportSizingSummary>> = {};
    const roles: ViewportRole[] = tab.mode === 'dual' ? ['portrait', 'landscape'] : ['landscape'];

    for (const role of roles) {
      const reqSize = role === 'portrait' ? tab.portraitSize : tab.landscapeSize;
      const wc =
        role === 'portrait' ? tab.portraitView?.webContents : tab.landscapeView?.webContents;
      const obs = wc && !wc.isDestroyed() ? this.observedViewports.get(wc.id) : undefined;
      const fallback = this.computeFallbackEffectiveSize(tab, role);
      out[role] = buildViewportSizingReport({
        role,
        requestedSize: reqSize,
        effectiveCssSize: fallback.css,
        dpr: fallback.dpr,
        capturedPixels: obs?.capturedPixels ?? null,
      });
    }
    return out;
  }

  async refreshTabViewportReport(
    tabId?: string,
    timeoutMs = 350,
  ): Promise<Partial<Record<ViewportRole, ViewportSizingSummary>>> {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    if (!tab) return {};
    if (tab.sleeping) return this.buildTabViewportReport(tab);

    const roles: ViewportRole[] = tab.mode === 'dual' ? ['portrait', 'landscape'] : ['landscape'];
    await Promise.all(
      roles.map(async (role) => {
        const wc =
          role === 'portrait' ? tab.portraitView?.webContents : tab.landscapeView?.webContents;
        if (!wc || wc.isDestroyed() || wc.isLoading()) return;
        const pendingEmu = this.pendingEmulations.get(wc.id);
        if (pendingEmu) {
          let emuTimer: ReturnType<typeof setTimeout> | null = null;
          await Promise.race([
            pendingEmu.catch(() => {}),
            new Promise<void>((r) => {
              emuTimer = setTimeout(r, Math.max(50, Math.floor(timeoutMs / 2)));
            }),
          ]);
          if (emuTimer) clearTimeout(emuTimer);
        }
        if (wc.isDestroyed()) return;
        const audit = await this.mirrorRelay.queryDom(wc, 'layoutAudit', {}, timeoutMs);
        if (
          typeof audit.viewportWidth === 'number' &&
          audit.viewportWidth > 0 &&
          typeof audit.viewportHeight === 'number' &&
          audit.viewportHeight > 0
        ) {
          const prev = this.observedViewports.get(wc.id);
          this.observedViewports.set(wc.id, {
            width: audit.viewportWidth,
            height: audit.viewportHeight,
            dpr: typeof audit.dpr === 'number' && audit.dpr > 0 ? audit.dpr : 1,
            capturedPixels: prev?.capturedPixels ?? null,
          });
        }
      }),
    );

    return this.buildTabViewportReport(tab);
  }

  async captureScreenshots(
    tabId: string | undefined,
    target: 'portrait' | 'landscape' | 'both',
    opts: {
      exactSize?: boolean;
      highlightClipped?: boolean;
      clip?: CanvasRegion;
      perPaneTimeoutMs?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    if (!tab) throw new Error('no active tab');
    if (tab.sleeping) throw new Error(`tab '${tab.id}' is sleeping`);

    const loadBudgetMs = Math.min(Math.max(opts.perPaneTimeoutMs ?? 4500, 300), 6000);
    const ready = await this.ensureTabMaterializedAndLoaded(tab, loadBudgetMs);
    if (!this.tabs.includes(tab)) {
      throw new Error(`tab '${tab.id}' was closed`);
    }

    const roles: ViewportRole[] =
      target === 'both'
        ? tab.mode === 'dual'
          ? ['portrait', 'landscape']
          : ['landscape']
        : [target];

    // Monotonic per-pane budget capped <= 5000ms so loadBudgetMs + paneBudgetMs + cleanup always stays < 15s MCP socket timeout.
    const paneBudgetMs = Math.min(Math.max(opts.perPaneTimeoutMs ?? 4000, 150), 5000);
    const validatedClip = opts.clip ? validateClipRegionInput(opts.clip, 'clip') : undefined;
    const isWinVisible = typeof this.win.isVisible === 'function' ? this.win.isVisible() : true;
    const captures: Record<string, unknown> = {};
    const errors: ScreenshotStageError[] = [];
    const viewportReport: Partial<Record<ViewportRole, ViewportSizingSummary>> = {};

    const withBoundedCleanup = async (op: () => Promise<unknown>, limitMs = 600): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          op().catch(() => {}),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, limitMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    await Promise.all(
      roles.map(async (role) => {
        const view = role === 'portrait' ? tab.portraitView : tab.landscapeView;
        const wc = view?.webContents;
        if (!view || !wc || wc.isDestroyed()) {
          errors.push({
            stage: 'view_lookup',
            viewport: role,
            error: `viewport '${role}' is unavailable or destroyed`,
          });
          return;
        }

        if (!ready && (this.wcLoadStates.has(wc.id) || wc.isLoading())) {
          errors.push({
            stage: 'load',
            viewport: role,
            error: `viewport '${role}' timed out finishing page load`,
          });
          return;
        }

        const paneDeadline = Date.now() + paneBudgetMs;
        const remMs = (stageCap: number) =>
          Math.max(60, Math.min(stageCap, paneDeadline - Date.now()));
        const isDeadlineExpired = () => Date.now() >= paneDeadline;

        const reqSize = role === 'portrait' ? tab.portraitSize : tab.landscapeSize;
        const origBounds = view.getBounds();
        let appliedExactOverride = false;
        let resizedOffscreenView = false;
        let usedCapturePageFallback = false;
        let highlighted = false;

        try {
          if (opts.exactSize) {
            if (!isWinVisible && !wc.isDestroyed()) {
              view.setBounds({
                x: origBounds.x,
                y: origBounds.y,
                width: reqSize.width,
                height: reqSize.height,
              });
              resizedOffscreenView = true;
            }
            let emuTimer: ReturnType<typeof setTimeout> | null = null;
            try {
              const attached = await this.debuggerCoordinator.ensureAttached(wc);
              if (attached && !wc.isDestroyed()) {
                const emuTimeout = remMs(1500);
                const emuRes = await Promise.race([
                  this.debuggerCoordinator
                    .sendCommand(wc, 'Emulation.setDeviceMetricsOverride', {
                      width: reqSize.width,
                      height: reqSize.height,
                      deviceScaleFactor: reqSize.dpr,
                      mobile: role === 'portrait',
                      scale: 1,
                      screenWidth: reqSize.width,
                      screenHeight: reqSize.height,
                    })
                    .then(() => 'ok' as const),
                  new Promise<'timeout'>((resolve) => {
                    emuTimer = setTimeout(() => resolve('timeout'), emuTimeout);
                  }),
                ]);
                if (emuRes === 'timeout') {
                  errors.push({
                    stage: 'exact_emulation',
                    viewport: role,
                    error: 'Emulation.setDeviceMetricsOverride timed out',
                  });
                  return;
                }
                appliedExactOverride = true;
              }
            } catch (err) {
              errors.push({
                stage: 'exact_emulation',
                viewport: role,
                error: err instanceof Error ? err.message : String(err),
              });
            } finally {
              if (emuTimer) clearTimeout(emuTimer);
            }
          }

          if (isDeadlineExpired()) {
            errors.push({
              stage: 'layout_audit',
              viewport: role,
              error: `per-pane capture budget (${paneBudgetMs}ms) exhausted before layoutAudit`,
            });
            return;
          }

          const auditTimeoutMs = remMs(1500);
          const audit = await this.mirrorRelay.queryDom(wc, 'layoutAudit', {}, auditTimeoutMs);
          const auditFailed = audit.ok === false && typeof audit.error === 'string';
          if (auditFailed) {
            errors.push({
              stage: 'layout_audit',
              viewport: role,
              error: audit.error ?? 'layoutAudit failed',
            });
            if (audit.error === 'dom query timeout' || isDeadlineExpired()) {
              // Renderer main thread is unresponsive; skip capture stages so sibling pane returns fast.
              return;
            }
          }

          if (
            opts.highlightClipped &&
            !auditFailed &&
            !isDeadlineExpired() &&
            Array.isArray(audit.clippedItems) &&
            audit.clippedItems.length > 0
          ) {
            const hlRes = await this.mirrorRelay.queryDom(
              wc,
              'setClippedHighlight',
              { items: audit.clippedItems },
              remMs(1000),
            );
            if (hlRes.ok) {
              highlighted = true;
            } else if (hlRes.error) {
              errors.push({
                stage: 'highlight_clipped',
                viewport: role,
                error: hlRes.error,
              });
            }
          }

          let pngBuf: Buffer | null = null;
          const useCdpPrimary =
            !isDeadlineExpired() &&
            this.debuggerCoordinator.isAttached(wc) &&
            (isWinVisible || Boolean(opts.exactSize) || Boolean(validatedClip));

          if (useCdpPrimary) {
            let cdpTimer: ReturnType<typeof setTimeout> | null = null;
            const cdpTimeoutMs = isWinVisible ? remMs(2200) : remMs(120);
            try {
              const cdpParams: Record<string, unknown> = {
                format: 'png',
                fromSurface: true,
              };
              if (validatedClip) {
                cdpParams.clip = {
                  x: validatedClip.x,
                  y: validatedClip.y,
                  width: validatedClip.width,
                  height: validatedClip.height,
                  scale: 1,
                };
                cdpParams.captureBeyondViewport = true;
              } else if (opts.exactSize) {
                cdpParams.clip = {
                  x: 0,
                  y: 0,
                  width: reqSize.width,
                  height: reqSize.height,
                  scale: 1,
                };
                cdpParams.captureBeyondViewport = true;
              }

              const cdpShot = (await Promise.race([
                this.debuggerCoordinator.sendCommand<{ data?: string }>(
                  wc,
                  'Page.captureScreenshot',
                  cdpParams,
                ),
                new Promise<{ timedOut: true }>((resolve) => {
                  cdpTimer = setTimeout(() => resolve({ timedOut: true }), cdpTimeoutMs);
                }),
              ])) as { data?: string; timedOut?: boolean };

              if (cdpShot.data) {
                pngBuf = Buffer.from(cdpShot.data, 'base64');
              } else if (cdpShot.timedOut && isWinVisible) {
                errors.push({
                  stage: 'cdp_capture',
                  viewport: role,
                  error: `Page.captureScreenshot timed out after ${cdpTimeoutMs}ms`,
                });
              }
            } catch (err) {
              if (isWinVisible) {
                errors.push({
                  stage: 'cdp_capture',
                  viewport: role,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            } finally {
              if (cdpTimer) clearTimeout(cdpTimer);
            }
          }

          if (!pngBuf) {
            if (isDeadlineExpired()) {
              errors.push({
                stage: 'capture_page',
                viewport: role,
                error: `per-pane capture budget (${paneBudgetMs}ms) exhausted before capturePage`,
              });
              return;
            }
            const rectArg = validatedClip
              ? {
                  x: Math.round(validatedClip.x),
                  y: Math.round(validatedClip.y),
                  width: Math.round(validatedClip.width),
                  height: Math.round(validatedClip.height),
                }
              : undefined;

            const tryCapturePageOnce = async (): Promise<{
              png: Buffer | null;
              failureMsg: string | null;
            }> => {
              let capTimer: ReturnType<typeof setTimeout> | null = null;
              const capTimeoutMs = remMs(2500);
              try {
                const capRes = await Promise.race([
                  (rectArg ? wc.capturePage(rectArg) : wc.capturePage()).then((image) => ({
                    timedOut: false as const,
                    image,
                  })),
                  new Promise<{ timedOut: true }>((resolve) => {
                    capTimer = setTimeout(() => resolve({ timedOut: true }), capTimeoutMs);
                  }),
                ]);
                if (capRes.timedOut) {
                  return {
                    png: null,
                    failureMsg: `WebContents.capturePage timed out after ${capTimeoutMs}ms`,
                  };
                }
                const png = capRes.image.toPNG();
                if (png.length === 0) {
                  return {
                    png: null,
                    failureMsg: 'WebContents.capturePage returned an empty image',
                  };
                }
                return { png, failureMsg: null };
              } catch (err) {
                return {
                  png: null,
                  failureMsg: err instanceof Error ? err.message : String(err),
                };
              } finally {
                if (capTimer) clearTimeout(capTimer);
              }
            };

            const firstTry = await tryCapturePageOnce();
            let capturePageFailureMsg = firstTry.failureMsg;
            if (firstTry.png) {
              pngBuf = firstTry.png;
              usedCapturePageFallback = true;
            }

            // On hidden/unmapped windows before Viz allocates a display surface, capturePage fails
            // with "Current display surface not available for capture" (or empty PNG). Trigger a
            // Chromium ForceRedraw via Page.captureScreenshot + 1px Aura bounds nudge, then retry
            // capturePage within the remaining per-pane budget.
            if (!pngBuf && !isDeadlineExpired() && !wc.isDestroyed()) {
              let redrawTimer: ReturnType<typeof setTimeout> | null = null;
              try {
                await withBoundedCleanup(
                  () => this.debuggerCoordinator.ensureAttached(wc),
                  remMs(300),
                );
                const curBounds = view.getBounds();
                if (curBounds.width > 0 && curBounds.height > 0 && !wc.isDestroyed()) {
                  view.setBounds({
                    x: curBounds.x,
                    y: curBounds.y,
                    width: curBounds.width + 1,
                    height: curBounds.height,
                  });
                  view.setBounds(curBounds);
                }
                if (!isDeadlineExpired() && this.debuggerCoordinator.isAttached(wc)) {
                  const redrawShot = (await Promise.race([
                    this.debuggerCoordinator
                      .sendCommand<{ data?: string }>(wc, 'Page.captureScreenshot', {
                        format: 'png',
                        fromSurface: true,
                      })
                      .catch(() => ({})),
                    new Promise<{ timedOut: true }>((resolve) => {
                      redrawTimer = setTimeout(() => resolve({ timedOut: true }), remMs(60));
                    }),
                  ])) as { data?: string };
                  if (redrawShot.data) {
                    pngBuf = Buffer.from(redrawShot.data, 'base64');
                  }
                }
              } finally {
                if (redrawTimer) clearTimeout(redrawTimer);
              }

              for (const waitMs of [45, 90, 160]) {
                if (pngBuf || isDeadlineExpired() || wc.isDestroyed()) break;
                const sleepMs = Math.min(waitMs, Math.max(0, paneDeadline - Date.now()));
                if (sleepMs > 0) {
                  await new Promise((r) => setTimeout(r, sleepMs));
                }
                if (isDeadlineExpired() || wc.isDestroyed()) break;
                const retry = await tryCapturePageOnce();
                if (retry.png) {
                  pngBuf = retry.png;
                  usedCapturePageFallback = true;
                  break;
                }
                if (retry.failureMsg) {
                  capturePageFailureMsg = retry.failureMsg;
                }
              }
            }

            if (!pngBuf) {
              errors.push({
                stage: 'capture_page',
                viewport: role,
                error: capturePageFailureMsg ?? 'WebContents.capturePage failed',
              });
              return;
            }
          }

          const decodedDims = readPngDimensions(pngBuf);
          const width =
            decodedDims?.width ??
            audit.viewportWidth ??
            (role === 'portrait' ? tab.portraitSize.width : tab.landscapeSize.width);
          const height =
            decodedDims?.height ??
            audit.viewportHeight ??
            (role === 'portrait' ? tab.portraitSize.height : tab.landscapeSize.height);

          const effectiveCss =
            typeof audit.viewportWidth === 'number' &&
            audit.viewportWidth > 0 &&
            typeof audit.viewportHeight === 'number' &&
            audit.viewportHeight > 0
              ? { width: audit.viewportWidth, height: audit.viewportHeight }
              : null;
          const effectiveDpr =
            typeof audit.dpr === 'number' && audit.dpr > 0 ? audit.dpr : reqSize.dpr;

          if (effectiveCss && !opts.exactSize && !validatedClip && !wc.isDestroyed()) {
            this.observedViewports.set(wc.id, {
              width: effectiveCss.width,
              height: effectiveCss.height,
              dpr: effectiveDpr,
              capturedPixels: { width, height },
            });
          }

          const captureDpr = usedCapturePageFallback ? this.getHostScaleFactor() : effectiveDpr;
          const baseExpectedW = validatedClip ? validatedClip.width : reqSize.width;
          const baseExpectedH = validatedClip ? validatedClip.height : reqSize.height;
          const expectedCapturePixels = {
            width: Math.round(baseExpectedW * captureDpr),
            height: Math.round(baseExpectedH * captureDpr),
          };

          const exactSizeApplied = Boolean(opts.exactSize) && (appliedExactOverride || resizedOffscreenView);
          const sizingReport = buildViewportSizingReport({
            role,
            requestedSize: reqSize,
            effectiveCssSize: effectiveCss,
            dpr: effectiveDpr,
            capturedPixels: { width, height },
            expectedCapturePixels,
            ...(opts.exactSize !== undefined ? { exactSizeApplied } : {}),
          });
          viewportReport[role] = sizingReport;

          captures[role] = {
            mimeType: 'image/png',
            width,
            height,
            bytes: pngBuf.length,
            pngBase64: pngBuf.toString('base64'),
            layoutAudit: audit,
            viewportReport: sizingReport,
          };
        } finally {
          if (highlighted && !wc.isDestroyed()) {
            await withBoundedCleanup(
              () => this.mirrorRelay.queryDom(wc, 'clearClippedHighlight', {}, 500),
              600,
            );
          }
          if ((appliedExactOverride || resizedOffscreenView) && !wc.isDestroyed() && !this.disposed) {
            if (resizedOffscreenView) {
              try {
                view.setBounds(origBounds);
              } catch {
                // Ignore teardown races.
              }
            }
            await withBoundedCleanup(() => this.applyViewportEmulation(tab, role), 600);
            this.applyLayout();
            if (
              resizedOffscreenView &&
              !isWinVisible &&
              tab.mode === 'single' &&
              origBounds.width > 0 &&
              origBounds.height > 0 &&
              this.debuggerCoordinator.isAttached(wc)
            ) {
              await withBoundedCleanup(
                () =>
                  this.debuggerCoordinator.sendCommand(wc, 'Emulation.setDeviceMetricsOverride', {
                    width: origBounds.width,
                    height: origBounds.height,
                    deviceScaleFactor: this.getHostScaleFactor(),
                    mobile: false,
                    scale: 1,
                    screenWidth: origBounds.width,
                    screenHeight: origBounds.height,
                  }),
                600,
              );
            }
          }
        }
      }),
    );

    // Remove transient CDP warning if fallback capture_page succeeded for that same viewport.
    const survivingErrors = errors.filter(
      (e) => !(e.stage === 'cdp_capture' && captures[e.viewport] !== undefined),
    );
    const capturedCount = Object.keys(captures).length;

    if (capturedCount === 0) {
      if (!ready) {
        throw new Error(
          !this.tabs.includes(tab)
            ? `tab '${tab.id}' was closed`
            : `tab '${tab.id}' failed to finish loading`,
        );
      }
      throw new Error(
        `screenshot capture failed for all requested viewports: ${JSON.stringify(survivingErrors)}`,
      );
    }

    return {
      tabId: tab.id,
      url: tab.url,
      mode: tab.mode,
      partial: survivingErrors.length > 0,
      captures,
      viewportReport,
      ...(survivingErrors.length > 0 ? { errors: survivingErrors } : {}),
    };
  }

  async interact(params: {
    tabId?: string;
    viewport?: ViewportRole;
    action: 'click' | 'type' | 'scroll' | 'key' | 'hover';
    selector?: string;
    text?: string;
    key?: string;
    x?: number;
    y?: number;
    ratioY?: number;
    mirror?: boolean;
  }): Promise<Record<string, unknown>> {
    const tab = params.tabId ? this.getTab(params.tabId) : this.getActiveTab();
    if (!tab) throw new Error('no active tab');
    if (tab.sleeping) throw new Error(`tab '${tab.id}' is sleeping`);
    const ready = await this.ensureTabMaterializedAndLoaded(tab);
    if (!ready) {
      throw new Error(
        !this.tabs.includes(tab)
          ? `tab '${tab.id}' was closed`
          : `tab '${tab.id}' failed to finish loading`,
      );
    }

    const primaryRole: ViewportRole =
      params.viewport ?? (tab.mode === 'dual' ? 'portrait' : 'landscape');
    const shouldMirror =
      params.mirror !== undefined ? params.mirror : tab.mode === 'dual' && tab.mirror;
    const targets: ViewportRole[] =
      shouldMirror && tab.mode === 'dual'
        ? [primaryRole, primaryRole === 'portrait' ? 'landscape' : 'portrait']
        : [primaryRole];

    await Promise.all(
      targets.map((role) => {
        const wc =
          role === 'portrait' ? tab.portraitView?.webContents : tab.landscapeView?.webContents;
        return wc && !wc.isDestroyed() ? this.beforeMouseDispatch(wc) : Promise.resolve();
      }),
    );

    const guard = this.mirrorRelay.getGuard(tab.id);
    const outcomes: Record<string, unknown> = {};
    this.tabEventBus.beginGesture(tab.id, primaryRole, params.action);

    await Promise.all(
      targets.map(async (role) => {
        const wc =
          role === 'portrait' ? tab.portraitView?.webContents : tab.landscapeView?.webContents;
        if (!wc || wc.isDestroyed()) return;

        if (params.action === 'scroll') {
          guard.beginReplaying(role);
          try {
            const res = await this.mirrorRelay.queryDom(wc, 'applyScroll', {
              ratioX: 0,
              ratioY: params.ratioY ?? 0.5,
            });
            outcomes[role] = res;
          } finally {
            guard.endReplaying(role);
          }
          return;
        }

        if (params.action === 'key') {
          guard.beginReplaying(role);
          try {
            await this.mirrorRelay.dispatchTrustedKey(wc, params.key ?? 'Enter');
          } finally {
            guard.endReplaying(role);
          }
          outcomes[role] = { ok: true, key: params.key ?? 'Enter' };
          return;
        }

        let x = params.x;
        let y = params.y;
        let resolvedTier = 3;

        if (params.selector) {
          const resolved = await this.mirrorRelay.queryDom(wc, 'resolveTarget', {
            selector: params.selector,
          });
          if (resolved.found && resolved.x !== undefined && resolved.y !== undefined) {
            x = resolved.x;
            y = resolved.y;
            resolvedTier = resolved.tier ?? 2;
          }
        } else if (x !== undefined && y !== undefined && x >= 0 && x <= 1 && y >= 0 && y <= 1) {
          const audit = await this.mirrorRelay.queryDom(wc, 'layoutAudit', {});
          const mapped = mapNormalizedPoint(x, y, {
            x: 0,
            y: 0,
            width: audit.viewportWidth ?? 390,
            height: audit.viewportHeight ?? 844,
          });
          if (mapped) {
            x = mapped.x;
            y = mapped.y;
          }
        }

        const inputScale = role === 'portrait' ? tab.portraitScale : tab.landscapeScale;

        if (params.action === 'click') {
          if (x === undefined || y === undefined) {
            outcomes[role] = { ok: false, error: 'target not found' };
            return;
          }
          // Scale CSS coords by inputScale to widget DIP coords for CDP Input.dispatchMouseEvent and sendInputEvent.
          guard.beginReplaying(role);
          try {
            await this.mirrorRelay.dispatchTrustedClick(wc, x, y, 'left', 1, [], inputScale);
          } finally {
            guard.endReplaying(role);
          }
          outcomes[role] = { ok: true, tier: resolvedTier, x: Math.round(x), y: Math.round(y) };
        } else if (params.action === 'hover') {
          if (x === undefined || y === undefined) {
            outcomes[role] = { ok: false, error: 'target not found' };
            return;
          }
          guard.beginReplaying(role);
          try {
            await this.mirrorRelay.dispatchTrustedHover(wc, x, y, inputScale);
          } finally {
            guard.endReplaying(role);
          }
          outcomes[role] = { ok: true, tier: resolvedTier, x: Math.round(x), y: Math.round(y) };
        } else if (params.action === 'type') {
          guard.beginReplaying(role);
          try {
            if (x !== undefined && y !== undefined) {
              await this.mirrorRelay.dispatchTrustedClick(wc, x, y, 'left', 1, [], inputScale);
              guard.markReplaying(role);
            }
            await this.mirrorRelay.dispatchTrustedText(wc, params.text ?? '');
          } finally {
            guard.endReplaying(role);
          }
          outcomes[role] = { ok: true, typedLength: (params.text ?? '').length };
        }
      }),
    );

    return {
      tabId: tab.id,
      action: params.action,
      mirrored: targets.length > 1,
      outcomes,
    };
  }

  async evalJs(params: {
    tabId?: string;
    viewport?: ViewportRole;
    expression: string;
    maxBytes?: number;
  }): Promise<Record<string, unknown>> {
    const tab = params.tabId ? this.getTab(params.tabId) : this.getActiveTab();
    if (!tab) throw new Error('no active tab');
    if (tab.sleeping) throw new Error(`tab '${tab.id}' is sleeping`);
    const ready = await this.ensureTabMaterializedAndLoaded(tab);
    if (!ready) {
      throw new Error(
        !this.tabs.includes(tab)
          ? `tab '${tab.id}' was closed`
          : `tab '${tab.id}' failed to finish loading`,
      );
    }
    const role: ViewportRole =
      params.viewport ?? (tab.mode === 'dual' ? 'portrait' : 'landscape');
    const wc = role === 'portrait' ? tab.portraitView?.webContents : tab.landscapeView?.webContents;
    if (!wc || wc.isDestroyed()) {
      throw new Error(`viewport '${role}' is not active in tab '${tab.id}'`);
    }

    const maxBytes = Math.min(Math.max(params.maxBytes ?? 16384, 256), 262144);
    const rawValue: unknown = await wc.executeJavaScript(params.expression, true);
    const serialized =
      typeof rawValue === 'string'
        ? rawValue
        : JSON.stringify(rawValue === undefined ? null : rawValue);
    const bounded = truncateUtf8(serialized, maxBytes);

    return {
      tabId: tab.id,
      viewport: role,
      value: bounded.text,
      truncated: bounded.truncated,
      originalBytes: bounded.originalBytes,
      maxBytes,
    };
  }

  toggleAudio(role: ViewportRole): ShellState {
    const tab = this.getActiveTab();
    if (!tab) return this.getShellState();
    const effectiveRole: ViewportRole = tab.mode === 'dual' ? role : 'landscape';
    tab.audioSource = tab.audioSource === effectiveRole ? 'muted' : effectiveRole;
    this.syncVisibilityAndLayout();
    return this.emitState();
  }

  removeHistoryItem(url: string): ShellState {
    this.history = removeHistoryEntry(this.history, url);
    return this.emitState();
  }

  clearHistory(): ShellState {
    this.history = [];
    return this.emitState();
  }

  openHistoryMenu(x?: number, y?: number): void {
    const items: Electron.MenuItemConstructorOptions[] = [];

    if (this.closedTabs.length > 0) {
      const latest = this.closedTabs[0]!;
      const label = sanitizeMenuLabel(latest.title || formatHistorySubtitle(latest.url), 46);
      items.push({
        label: `Reopen Closed Tab: ${label}`,
        accelerator: 'CmdOrCtrl+Shift+T',
        click: () => {
          this.reopenClosedTab();
        },
      });
      items.push({ type: 'separator' });
    }

    if (this.history.length === 0) {
      items.push({ label: 'No recent history yet', enabled: false });
    } else {
      items.push({ label: 'Recent History', enabled: false });
      for (const entry of this.history.slice(0, 15)) {
        const sub = formatHistorySubtitle(entry.url);
        const title = entry.title && entry.title !== sub ? `${entry.title} — ${sub}` : sub;
        items.push({
          label: sanitizeMenuLabel(title, 72),
          click: () => {
            this.navigate(entry.url);
          },
        });
      }
      items.push({ type: 'separator' });
      items.push({
        label: 'Clear Recent History',
        click: () => {
          this.clearHistory();
        },
      });
    }

    const menu = Menu.buildFromTemplate(items);
    const popupOpts: Electron.PopupOptions = { window: this.win };
    if (typeof x === 'number' && Number.isFinite(x)) popupOpts.x = Math.round(x);
    if (typeof y === 'number' && Number.isFinite(y)) popupOpts.y = Math.round(y);
    menu.popup(popupOpts);
  }

  restoreSession(saved: PersistedSession | null, cliUrl?: string): ShellState {
    this.suppressDirty = true;
    try {
      if (saved) {
        this.railCollapsed = saved.railCollapsed;
        this.dockOpen = saved.dockOpen;
        this.dockHeight = saved.dockHeight;
        this.splitRatio = saved.splitRatio;
        this.theme = saved.theme;
        this.ecoMode = saved.ecoMode ?? true;
        this.autoSleep = saved.autoSleep ?? false;
        this.syncAutoSleepTimer();
        this.history = [...saved.history];

        if (saved.tabs.length > 0) {
          saved.tabs.forEach((savedTab, idx) => {
            const isActive = idx === saved.activeTabIndex;
            this.createTab({
              url: savedTab.url,
              title: savedTab.title,
              mode: savedTab.mode,
              mirror: savedTab.mirror,
              dedup: savedTab.dedup,
              session: savedTab.session,
              sleeping: isActive ? false : savedTab.sleeping,
              portraitPresetId: savedTab.portraitPresetId,
              landscapePresetId: savedTab.landscapePresetId,
              devtoolsTarget: savedTab.devtoolsTarget,
              audioSource: savedTab.audioSource,
              activate: isActive,
              recordHistory: false,
              lazy: !isActive,
            });
          });
        }
      }

      if (cliUrl) {
        const normalized = normalizeUrl(cliUrl);
        const existing = this.tabs.find((t) => t.url === normalized);
        if (existing) {
          this.selectTab(existing.id);
        } else {
          this.createTab({ url: normalized, mode: 'dual', activate: true });
        }
      } else if (this.tabs.length === 0) {
        this.createTab({ mode: 'dual', activate: true });
      }
    } finally {
      this.suppressDirty = false;
    }

    this.syncVisibilityAndLayout();
    this.syncDevToolsAttachment();
    return this.emitState();
  }

  exportPersistedSession(windowBounds?: PersistedWindowBounds): PersistedSession {
    const rawPersistedTabs: PersistedTab[] = [];
    let rawActiveTabIndex = 0;

    for (const tab of this.tabs) {
      if (!isPersistableHttpUrl(tab.url)) continue;
      if (tab.id === this.activeTabId) {
        rawActiveTabIndex = rawPersistedTabs.length;
      }
      rawPersistedTabs.push({
        url: tab.url,
        title: truncatePersistedTitle(tab.title, formatHistorySubtitle(tab.url)),
        mode: tab.mode,
        mirror: tab.mirror,
        dedup: tab.dedup,
        session: tab.session,
        sleeping: tab.sleeping,
        portraitPresetId: tab.portraitPresetId,
        landscapePresetId: tab.landscapePresetId,
        devtoolsTarget: tab.devtoolsTarget,
        audioSource: tab.audioSource,
      });
    }

    const { tabs, activeTabIndex } = capPersistedTabs(
      rawPersistedTabs,
      rawActiveTabIndex,
      MAX_PERSISTED_TABS,
    );

    return {
      version: 1,
      savedAt: Date.now(),
      window: windowBounds,
      railCollapsed: this.railCollapsed,
      dockOpen: this.dockOpen,
      dockHeight: this.dockHeight,
      splitRatio: this.splitRatio,
      theme: this.theme,
      ecoMode: this.ecoMode,
      autoSleep: this.autoSleep,
      activeTabIndex,
      tabs,
      history: [...this.history],
    };
  }

  getRecipesDir(): string {
    return path.join(app.getPath('userData'), 'recipes');
  }

  saveReproRecipe(raw: Record<string, unknown>): ReproRecipe {
    const active = this.getActiveTab();
    const merged: Record<string, unknown> = {
      url: raw.url ?? active?.url ?? '',
      mode: raw.mode ?? active?.mode ?? 'dual',
      session: raw.session ?? active?.session ?? 'shared',
      portraitPresetId: raw.portraitPresetId ?? raw.portrait_preset ?? active?.portraitPresetId,
      landscapePresetId: raw.landscapePresetId ?? raw.landscape_preset ?? active?.landscapePresetId,
      portraitSize: raw.portraitSize ?? raw.portrait_size ?? active?.portraitSize,
      landscapeSize: raw.landscapeSize ?? raw.landscape_size ?? active?.landscapeSize,
      ...raw,
    };
    const recipe = validateReproRecipe(merged);
    saveReproRecipeFile(this.getRecipesDir(), recipe);
    return recipe;
  }

  loadReproRecipe(name: string): ReproRecipe {
    return loadReproRecipeFile(this.getRecipesDir(), name);
  }

  listReproRecipes(): ReproRecipe[] {
    return listReproRecipesInDir(this.getRecipesDir());
  }

  deleteReproRecipe(name: string): boolean {
    return deleteReproRecipeFile(this.getRecipesDir(), name);
  }

  async stepPairedScene(params: {
    tabId?: string;
    seed?: string | number;
    phase?: string;
    frame?: number;
    deltaFrames?: number;
    multiplier?: number;
    timeMs?: number;
    fps?: number;
    canvasSelector?: string;
  }): Promise<{
    tabId: string;
    pairedMatch: boolean;
    viewports: Partial<Record<ViewportRole, SceneStepViewportOutcome>>;
  }> {
    const tab = params.tabId ? this.getTab(params.tabId) : this.getActiveTab();
    if (!tab) throw new Error('no active tab');
    if (tab.sleeping) throw new Error(`tab '${tab.id}' is sleeping`);
    const ready = await this.ensureTabMaterializedAndLoaded(tab);
    if (!ready) {
      throw new Error(`tab '${tab.id}' failed to finish loading`);
    }

    const roles: ViewportRole[] = tab.mode === 'dual' ? ['portrait', 'landscape'] : ['landscape'];
    const spec: SceneStepSpec = {
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
      ...(params.phase !== undefined ? { phase: params.phase } : {}),
      ...(params.frame !== undefined ? { frame: params.frame } : {}),
      ...(params.deltaFrames !== undefined ? { deltaFrames: params.deltaFrames } : {}),
      ...(params.multiplier !== undefined ? { multiplier: params.multiplier } : {}),
      ...(params.timeMs !== undefined ? { timeMs: params.timeMs } : {}),
      ...(params.fps !== undefined ? { fps: params.fps } : {}),
      ...(params.canvasSelector !== undefined ? { canvasSelector: params.canvasSelector } : {}),
    };
    const script = buildSceneStepScript(spec);
    const viewports: Partial<Record<ViewportRole, SceneStepViewportOutcome>> = {};

    await Promise.all(
      roles.map(async (role) => {
        const wc =
          role === 'portrait' ? tab.portraitView?.webContents : tab.landscapeView?.webContents;
        if (!wc || wc.isDestroyed()) return;
        const rawJson = (await wc.executeJavaScript(script, true)) as string;
        const parsed = JSON.parse(rawJson) as SceneStepViewportOutcome;
        viewports[role] = parsed;
      }),
    );

    const p = viewports.portrait;
    const l = viewports.landscape;
    const pairedMatch =
      tab.mode !== 'dual'
        ? Boolean(l)
        : Boolean(
            p &&
              l &&
              p.frame === l.frame &&
              p.seed === l.seed &&
              p.phase === l.phase &&
              p.multiplier === l.multiplier,
          );

    return {
      tabId: tab.id,
      pairedMatch,
      viewports,
    };
  }

  async openReproRecipe(
    nameOrInline: string | Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const recipe =
      typeof nameOrInline === 'string'
        ? this.loadReproRecipe(nameOrInline)
        : validateReproRecipe(nameOrInline);

    const state = this.createTab({
      url: recipe.url,
      mode: recipe.mode,
      session: recipe.session,
      portraitPresetId: recipe.portraitPresetId,
      landscapePresetId: recipe.landscapePresetId,
      portraitSize: recipe.portraitSize,
      landscapeSize: recipe.landscapeSize,
    });
    const tabId = state.activeTabId;
    const tab = tabId ? this.getTab(tabId) : undefined;
    if (!tab) {
      throw new Error('Failed to create tab for reproduction recipe');
    }

    await this.ensureTabMaterializedAndLoaded(tab);
    let stepResult: Awaited<ReturnType<TabManager['stepPairedScene']>> | null = null;
    if (
      recipe.seed !== undefined ||
      recipe.phase !== undefined ||
      recipe.frame !== undefined ||
      recipe.multiplier !== undefined ||
      recipe.timeMs !== undefined
    ) {
      stepResult = await this.stepPairedScene({
        tabId: tab.id,
        seed: recipe.seed,
        phase: recipe.phase,
        frame: recipe.frame,
        multiplier: recipe.multiplier,
        timeMs: recipe.timeMs,
        fps: recipe.fps,
        canvasSelector: recipe.canvasSelector,
      });
    }

    const viewportReport = await this.refreshTabViewportReport(tab.id, 500);
    return {
      activeTabId: tab.id,
      recipe,
      tab: this.getShellState().tabs.find((t) => t.id === tab.id) ?? null,
      viewportReport,
      stepResult,
    };
  }

  async exportLabelledFilmstrip(params: {
    tabId?: string;
    recipeName?: string;
    seed?: string | number;
    phase?: string;
    multiplier?: number;
    fps?: number;
    frames?: number[];
    startFrame?: number;
    endFrame?: number;
    frameStep?: number;
    exactSize?: boolean;
    canvasOnly?: boolean;
    canvasSelector?: string;
    clipRegion?: CanvasRegion;
    maxTileWidth?: number;
  }): Promise<Record<string, unknown>> {
    let recipe: ReproRecipe | null = null;
    let targetTabId = params.tabId;

    if (params.recipeName) {
      recipe = this.loadReproRecipe(params.recipeName);
      const opened = await this.openReproRecipe(recipe.name);
      targetTabId = typeof opened.activeTabId === 'string' ? opened.activeTabId : targetTabId;
    }

    const tab = targetTabId ? this.getTab(targetTabId) : this.getActiveTab();
    if (!tab) throw new Error('no active tab');
    if (tab.sleeping) throw new Error(`tab '${tab.id}' is sleeping`);
    const ready = await this.ensureTabMaterializedAndLoaded(tab);
    if (!ready) {
      throw new Error(`tab '${tab.id}' failed to finish loading`);
    }

    const fps = params.fps ?? recipe?.fps ?? 60;
    const seed = params.seed ?? recipe?.seed;
    const basePhase = params.phase ?? recipe?.phase;
    const baseMultiplier = params.multiplier ?? recipe?.multiplier;
    const rawClip = params.clipRegion ?? recipe?.clipRegion;
    const clipRegion = rawClip ? validateClipRegionInput(rawClip, 'clipRegion') : undefined;
    const canvasSelector = params.canvasSelector ?? recipe?.canvasSelector;
    const exactSize = params.exactSize ?? true;

    let targetFrames: number[] = [];
    if (Array.isArray(params.frames) && params.frames.length > 0) {
      targetFrames = params.frames
        .map((n) => Math.round(Number(n)))
        .filter((n) => Number.isFinite(n) && n >= 0)
        .slice(0, 24);
    } else if (
      typeof params.startFrame === 'number' &&
      typeof params.endFrame === 'number' &&
      Number.isFinite(params.startFrame) &&
      Number.isFinite(params.endFrame)
    ) {
      const start = Math.max(0, Math.round(params.startFrame));
      const end = Math.max(start, Math.round(params.endFrame));
      const step = Math.max(1, Math.round(params.frameStep ?? Math.max(1, Math.round(fps / 4))));
      for (let f = start; f <= end && targetFrames.length < 24; f += step) {
        targetFrames.push(f);
      }
      if (targetFrames[targetFrames.length - 1] !== end && targetFrames.length < 24) {
        targetFrames.push(end);
      }
    } else {
      const center = recipe?.frame ?? 0;
      targetFrames = [center];
    }

    const rows: FilmstripRowInput[] = [];
    const stepRecords: Array<Record<string, unknown>> = [];
    const roles: ViewportRole[] = tab.mode === 'dual' ? ['portrait', 'landscape'] : ['landscape'];

    for (let idx = 0; idx < targetFrames.length; idx += 1) {
      const frame = targetFrames[idx]!;
      const stepPhase =
        params.phase !== undefined
          ? params.phase
          : recipe && recipe.frame === frame
            ? recipe.phase
            : undefined;
      const stepped = await this.stepPairedScene({
        tabId: tab.id,
        seed,
        phase: stepPhase,
        frame,
        multiplier: baseMultiplier,
        fps,
        canvasSelector,
      });

      const shot = await this.captureScreenshots(tab.id, 'both', {
        exactSize,
        clip: clipRegion,
      });
      const captures = (shot.captures ?? {}) as Record<
        string,
        { pngBase64?: string; width?: number; height?: number }
      >;

      const rowTiles: FilmstripRowInput['tiles'] = [];
      const viewportStepMeta: Record<string, unknown> = {};

      for (const role of roles) {
        const cap = captures[role];
        const meta = stepped.viewports[role];
        if (!cap?.pngBase64) continue;
        const pngBuffer = Buffer.from(cap.pngBase64, 'base64');

        let crop: CanvasRegion | null = null;
        if (!clipRegion && params.canvasOnly && meta?.canvasBounds) {
          const dprScale =
            meta.viewportWidth > 0 && cap.width
              ? cap.width / meta.viewportWidth
              : meta.dpr || 1;
          crop = {
            x: Math.round(meta.canvasBounds.x * dprScale),
            y: Math.round(meta.canvasBounds.y * dprScale),
            width: Math.round(meta.canvasBounds.width * dprScale),
            height: Math.round(meta.canvasBounds.height * dprScale),
          };
        }

        const fVal = meta?.frame ?? frame;
        const sVal = meta?.seed ?? seed ?? 'none';
        const mVal = meta?.multiplier ?? baseMultiplier;
        const pVal = meta?.phase ?? basePhase;
        const line1 = `${role.toUpperCase()} ${meta?.viewportWidth ?? cap.width ?? 0}X${meta?.viewportHeight ?? cap.height ?? 0} | F:${fVal} | SEED:${String(sVal)}`;
        const line2Parts: string[] = [];
        if (mVal !== null && mVal !== undefined) line2Parts.push(`MULT:${mVal}X`);
        if (pVal) line2Parts.push(`PHASE:${pVal}`);
        line2Parts.push(`T:${Math.round(meta?.timeMs ?? (fVal / fps) * 1000)}MS`);

        rowTiles.push({
          labelLines: [line1, line2Parts.join(' | ')],
          pngBuffer,
          crop,
        });
        viewportStepMeta[role] = {
          frame: fVal,
          seed: sVal,
          phase: pVal ?? null,
          multiplier: mVal ?? null,
          timeMs: meta?.timeMs ?? Math.round((fVal / fps) * 1000),
          capturedWidth: cap.width ?? null,
          capturedHeight: cap.height ?? null,
        };
      }

      if (rowTiles.length > 0) {
        rows.push({ tiles: rowTiles });
      }
      stepRecords.push({
        stepIndex: idx,
        frame,
        seed: seed ?? stepped.viewports.portrait?.seed ?? stepped.viewports.landscape?.seed ?? null,
        phase:
          stepped.viewports.portrait?.phase ??
          stepped.viewports.landscape?.phase ??
          basePhase ??
          null,
        multiplier:
          stepped.viewports.portrait?.multiplier ??
          stepped.viewports.landscape?.multiplier ??
          baseMultiplier ??
          null,
        pairedMatch: stepped.pairedMatch,
        viewports: viewportStepMeta,
      });
    }

    if (rows.length === 0) {
      throw new Error('No viewport images captured for filmstrip');
    }

    const safeMaxTileW =
      typeof params.maxTileWidth === 'number' && Number.isFinite(params.maxTileWidth)
        ? Math.min(Math.max(Math.round(params.maxTileWidth), 120), 1920)
        : 480;
    const composed = composeFilmstripPng(rows, {
      maxTileWidth: safeMaxTileW,
    });

    return {
      tabId: tab.id,
      url: tab.url,
      recipeName: recipe?.name ?? null,
      mimeType: 'image/png',
      width: composed.width,
      height: composed.height,
      rows: composed.rows,
      columns: composed.columns,
      bytes: composed.pngBuffer.length,
      filmstripPngBase64: composed.pngBuffer.toString('base64'),
      steps: stepRecords,
    };
  }

  async startPerfTrace(params: {
    tabId?: string;
    maxDurationMs?: number;
    maxFrames?: number;
  } = {}): Promise<Record<string, unknown>> {
    const tab = params.tabId ? this.getTab(params.tabId) : this.getActiveTab();
    if (!tab) throw new Error('no active tab');
    if (tab.sleeping) throw new Error(`tab '${tab.id}' is sleeping`);
    const ready = await this.ensureTabMaterializedAndLoaded(tab);
    if (!ready) {
      throw new Error(`tab '${tab.id}' failed to finish loading`);
    }

    const traceId = `trace-${tab.id}-${Date.now()}`;
    const maxDurationMs = Math.min(
      Math.max(params.maxDurationMs ?? 15_000, 100),
      MAX_TRACE_DURATION_MS,
    );
    const maxFrames = Math.min(Math.max(params.maxFrames ?? MAX_TRACE_FRAMES, 60), 3600);
    const roles: ViewportRole[] = tab.mode === 'dual' ? ['portrait', 'landscape'] : ['landscape'];
    const startedViewports: Record<string, unknown> = {};

    await Promise.all(
      roles.map(async (role) => {
        const wc =
          role === 'portrait' ? tab.portraitView?.webContents : tab.landscapeView?.webContents;
        if (!wc || wc.isDestroyed()) return;
        const res = await this.mirrorRelay.queryDom(
          wc,
          'traceStart',
          { traceId, maxDurationMs, maxFrames },
          1500,
        );
        startedViewports[role] = res;
      }),
    );

    const startedAtMs = Date.now();
    this.activeTracesByTab.set(tab.id, { traceId, startedAtMs, roles });
    this.tabEventBus.publish({
      tabId: tab.id,
      viewport: 'both',
      domain: 'trace',
      kind: 'start',
      summary: `trace ${traceId} started`,
      tsMs: startedAtMs,
    });

    return {
      ok: true,
      traceId,
      tabId: tab.id,
      startedAtMs,
      maxDurationMs,
      maxFrames,
      viewports: startedViewports,
    };
  }

  async stopPerfTrace(params: { tabId?: string } = {}): Promise<Record<string, unknown>> {
    const tab = params.tabId ? this.getTab(params.tabId) : this.getActiveTab();
    if (!tab) throw new Error('no active tab');
    if (tab.sleeping) throw new Error(`tab '${tab.id}' is sleeping`);

    const activeMeta = this.activeTracesByTab.get(tab.id);
    if (!activeMeta) {
      throw new Error(`no active performance trace on tab '${tab.id}'`);
    }
    this.activeTracesByTab.delete(tab.id);

    const roles: ViewportRole[] = activeMeta.roles;
    const viewports: Partial<
      Record<ViewportRole, ViewportTraceReport & { samplingMode?: string; error?: string }>
    > = {};

    await Promise.all(
      roles.map(async (role) => {
        const wc =
          role === 'portrait' ? tab.portraitView?.webContents : tab.landscapeView?.webContents;
        if (!wc || wc.isDestroyed()) return;
        const raw = await this.mirrorRelay.queryDom(wc, 'traceStop', {}, 2000);
        const frames = Array.isArray(raw.frames) ? raw.frames : [];
        const marks = Array.isArray(raw.marks) ? raw.marks : [];
        const measures = Array.isArray(raw.measures) ? raw.measures : [];
        const durationMs =
          typeof raw.durationMs === 'number'
            ? raw.durationMs
            : Math.max(0, Date.now() - activeMeta.startedAtMs);

        viewports[role] = {
          visibilityState: raw.visibilityState ?? 'unknown',
          samplingMode: raw.samplingMode ?? 'raf',
          summary: summarizeFrameWindow(frames, durationMs),
          marks,
          measures,
          markWindows: segmentFramesAroundMarks(frames, marks, measures, durationMs),
          frames: frames.slice(-300),
          ...(raw.ok === false && raw.error ? { error: raw.error } : {}),
        };
      }),
    );

    const snap = await this.telemetry.sampleOnce();
    const gpu = buildGpuTelemetrySeparation(snap.gpuCpuPercent, snap.gpuMemoryMb, null);
    const totalDurationMs = Math.max(0, Date.now() - activeMeta.startedAtMs);
    this.tabEventBus.publish({
      tabId: tab.id,
      viewport: 'both',
      domain: 'trace',
      kind: 'stop',
      summary: `trace ${activeMeta.traceId} stopped (${totalDurationMs}ms)`,
    });

    return {
      ok: true,
      traceId: activeMeta.traceId,
      tabId: tab.id,
      durationMs: totalDurationMs,
      gpu,
      viewports,
    };
  }

  getShellState(): ShellState {
    const tabs: TabSnapshot[] = this.tabs.map((tab) => {
      const landscapeWc =
        tab.landscapeView && !tab.landscapeView.webContents.isDestroyed()
          ? tab.landscapeView.webContents
          : null;
      const portraitWc =
        tab.portraitView && !tab.portraitView.webContents.isDestroyed()
          ? tab.portraitView.webContents
          : null;
      return {
        id: tab.id,
        title: tab.title,
        url: tab.url,
        mode: tab.mode,
        mirror: tab.mirror,
        dedup: tab.dedup,
        session: tab.session,
        sleeping: tab.sleeping,
        portraitPresetId: tab.portraitPresetId,
        landscapePresetId: tab.landscapePresetId,
        portraitSize: tab.portraitSize,
        landscapeSize: tab.landscapeSize,
        canGoBack: landscapeWc ? landscapeWc.navigationHistory.canGoBack() : false,
        canGoForward: landscapeWc ? landscapeWc.navigationHistory.canGoForward() : false,
        loading:
          (landscapeWc ? landscapeWc.isLoading() : false) ||
          (portraitWc ? portraitWc.isLoading() : false),
        devtoolsTarget: tab.devtoolsTarget,
        audioSource: tab.audioSource,
        dedupCount: tab.dedupCount,
        viewportReport: this.buildTabViewportReport(tab),
      };
    });

    const activeTab = this.getActiveTab();
    return {
      tabs,
      activeTabId: this.activeTabId,
      railCollapsed: this.railCollapsed,
      dockOpen: this.dockOpen,
      dockHeight: this.dockHeight,
      splitRatio: this.splitRatio,
      theme: this.theme,
      ecoMode: this.ecoMode,
      autoSleep: this.autoSleep,
      mirrorMiss: activeTab ? (this.mirrorMissByTab.get(activeTab.id) ?? null) : null,
      history: [...this.history],
      closedTabCount: this.closedTabs.length,
    };
  }

  private emitState(markDirty = true): ShellState {
    const state = this.getShellState();
    if (!this.win.isDestroyed()) {
      this.win.webContents.send('shell:state', state);
    }
    if (!this.suppressDirty && markDirty) {
      this.onStateDirty?.();
    }
    return state;
  }

  getLastLayout(): LayoutResult | null {
    return this.lastLayout;
  }

  getMirrorPreloadPath(): string {
    return path.resolve(this.mirrorPreloadPath);
  }

  queryTabEvents(filter: QueryBusFilter = {}): QueryBusResult {
    return this.tabEventBus.query(filter);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of Array.from(this.wcLoadStates.values())) {
      entry.settle(false);
    }
    this.wcLoadStates.clear();
    this.pendingReloads.clear();
    this.pendingEmulations.clear();
    this.observedViewports.clear();
    this.activeTracesByTab.clear();
    this.mirrorMissByTab.clear();
    for (const [sess, listener] of Array.from(this.downloadHookedSessions.entries())) {
      try {
        if (typeof sess.off === 'function') {
          sess.off('will-download', listener);
        } else if (typeof sess.removeListener === 'function') {
          sess.removeListener('will-download', listener);
        }
      } catch {
        // Ignore session listener cleanup errors during shutdown.
      }
    }
    this.downloadHookedSessions.clear();
    if (this.autoSleepTimer) {
      clearInterval(this.autoSleepTimer);
      this.autoSleepTimer = null;
    }
    this.destroyDevToolsView();
    this.telemetry.dispose();
    this.requestDedup.dispose();
    this.wsSseMux.dispose();
    this.mirrorRelay.dispose();
    this.tabEventBus.dispose();
    for (const tab of [...this.tabs]) {
      this.destroyTabViews(tab);
      if (tab.session === 'isolated') {
        this.clearIsolatedPartition(tab.id);
      }
    }
    this.tabs.length = 0;
  }
}
