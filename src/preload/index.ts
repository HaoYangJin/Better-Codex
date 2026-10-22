import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  BetterCodexInfoApi,
  BootstrapPayload,
  ExportRequest,
  ExportResult,
  HistoryFilter,
  OverlaySurface,
  SeriesPoint,
  SessionSnapshot,
  TurnMetrics
} from '../shared/contracts'

const api: BetterCodexInfoApi = {
  getBootstrap: () => ipcRenderer.invoke('info:get-bootstrap') as Promise<BootstrapPayload>,
  querySnapshot: (sessionId?: string) =>
    ipcRenderer.invoke('info:query-snapshot', sessionId) as Promise<SessionSnapshot | null>,
  queryHistory: (filter: HistoryFilter) =>
    ipcRenderer.invoke('info:query-history', filter) as Promise<import('../shared/contracts').AnalyticsPayload>,
  queryTurns: (sessionId: string) =>
    ipcRenderer.invoke('info:query-turns', sessionId) as Promise<TurnMetrics[]>,
  querySeries: (filter: HistoryFilter) =>
    ipcRenderer.invoke('info:query-series', filter) as Promise<SeriesPoint[]>,
  pinSession: (sessionId: string | null) =>
    ipcRenderer.invoke('info:pin-session', sessionId) as Promise<AppSettings>,
  updateSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.invoke('info:update-settings', patch) as Promise<AppSettings>,
  exportData: (request: ExportRequest) =>
    ipcRenderer.invoke('info:export', request) as Promise<ExportResult>,
  hideOverlay: () => ipcRenderer.invoke('overlay:hide') as Promise<void>,
  setSurface: (surface: OverlaySurface) =>
    ipcRenderer.invoke('overlay:set-surface', surface) as Promise<void>,
  onSnapshot: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, snapshot: SessionSnapshot | null): void =>
      listener(snapshot)
    ipcRenderer.on('info:snapshot-updated', callback)
    return () => ipcRenderer.removeListener('info:snapshot-updated', callback)
  },
  onIndexState: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, indexing: boolean): void =>
      listener(indexing)
    ipcRenderer.on('info:index-state', callback)
    return () => ipcRenderer.removeListener('info:index-state', callback)
  },
  onSurface: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, surface: OverlaySurface): void =>
      listener(surface)
    ipcRenderer.on('overlay:surface-updated', callback)
    return () => ipcRenderer.removeListener('overlay:surface-updated', callback)
  }
}

contextBridge.exposeInMainWorld('betterCodexInfo', api)
