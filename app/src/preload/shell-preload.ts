import { contextBridge, ipcRenderer } from 'electron';
import type {
  IronShellApi,
  ShellState,
  TelemetrySnapshot,
} from '../shared/types';

export type { IronShellApi } from '../shared/types';

const api: IronShellApi = {
  getInitialState: () => ipcRenderer.invoke('shell:get-initial-state'),
  newTab: (url, mode) => ipcRenderer.invoke('shell:new-tab', { url, mode }),
  closeTab: (tabId) => ipcRenderer.invoke('shell:close-tab', { tabId }),
  selectTab: (tabId) => ipcRenderer.invoke('shell:select-tab', { tabId }),
  sleepTab: (tabId) => ipcRenderer.invoke('shell:sleep-tab', { tabId }),
  navigate: (url) => ipcRenderer.invoke('shell:navigate', { url }),
  goBack: () => ipcRenderer.invoke('shell:go-back'),
  goForward: () => ipcRenderer.invoke('shell:go-forward'),
  reload: () => ipcRenderer.invoke('shell:reload'),
  toggleDualMode: () => ipcRenderer.invoke('shell:toggle-dual-mode'),
  toggleMirror: () => ipcRenderer.invoke('shell:toggle-mirror'),
  toggleDedup: (tabId) =>
    ipcRenderer.invoke('shell:toggle-dedup', tabId !== undefined ? { tabId } : undefined),
  toggleSessionMode: () => ipcRenderer.invoke('shell:toggle-session-mode'),
  setSessionMode: (mode) => ipcRenderer.invoke('shell:set-session-mode', { mode }),
  setPreset: (role, presetId) => ipcRenderer.invoke('shell:set-preset', { role, presetId }),
  setRailCollapsed: (collapsed) => ipcRenderer.invoke('shell:set-rail-collapsed', { collapsed }),
  setDockOpen: (open) => ipcRenderer.invoke('shell:set-dock-open', { open }),
  setDockHeight: (height) => ipcRenderer.invoke('shell:set-dock-height', { height }),
  setSplitRatio: (ratio) => ipcRenderer.invoke('shell:set-split-ratio', { ratio }),
  setDevToolsTarget: (role) => ipcRenderer.invoke('shell:set-devtools-target', { role }),
  toggleAudio: (role) => ipcRenderer.invoke('shell:toggle-audio', { role }),
  setTheme: (theme) => ipcRenderer.invoke('shell:set-theme', { theme }),
  toggleEcoMode: () => ipcRenderer.invoke('shell:toggle-eco-mode'),
  setAutoSleep: (enabled) => ipcRenderer.invoke('shell:set-auto-sleep', { enabled }),
  copyMirrorMissDebug: () => ipcRenderer.invoke('shell:copy-mirror-miss-debug'),
  focusAnomaly: (kind) => ipcRenderer.invoke('shell:focus-anomaly', { kind }),
  openHistoryMenu: (x, y) => ipcRenderer.invoke('shell:open-history-menu', { x, y }),
  removeHistoryItem: (url) => ipcRenderer.invoke('shell:remove-history-item', { url }),
  clearHistory: () => ipcRenderer.invoke('shell:clear-history'),
  reopenClosedTab: () => ipcRenderer.invoke('shell:reopen-closed-tab'),
  onStateUpdate: (cb) => {
    const listener = (_ev: Electron.IpcRendererEvent, state: ShellState) => cb(state);
    ipcRenderer.on('shell:state', listener);
    return () => ipcRenderer.removeListener('shell:state', listener);
  },
  onTelemetry: (cb) => {
    const listener = (_ev: Electron.IpcRendererEvent, snap: TelemetrySnapshot) => cb(snap);
    ipcRenderer.on('shell:telemetry', listener);
    return () => ipcRenderer.removeListener('shell:telemetry', listener);
  },
  onFocusUrlBar: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('shell:focus-url-bar', listener);
    return () => ipcRenderer.removeListener('shell:focus-url-bar', listener);
  },
};

contextBridge.exposeInMainWorld('ironShell', api);
