import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  Tray,
  dialog,
  ipcMain
} from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AppSettings,
  BootstrapPayload,
  DataWarning,
  ExportRequest,
  HistoryFilter,
  OverlaySurface,
  SessionSnapshot
} from '../shared/contracts'
import { discoverCodexPaths } from './codex-paths'
import { CodexRepository } from './codex-repository'
import { createExportDocument, serializeCsv } from './export'
import { OverlayWindow } from './overlay-window'
import { SettingsStore } from './settings'

const customUserDataDirectory = process.env.BETTER_CODEX_INFO_DATA_DIR?.trim()
if (customUserDataDirectory) app.setPath('userData', customUserDataDirectory)

const settingsStore = new SettingsStore()
let repository: CodexRepository | null = null
let overlay: OverlayWindow | null = null
let tray: Tray | null = null
let codexHome = ''
let warnings: DataWarning[] = []
let indexing = true
let quitting = false
const lastNotificationAt = new Map<string, number>()

const defaultFilter = (settings: AppSettings): HistoryFilter => ({
  includeSubagents: settings.includeSubagents,
  limit: 2_000
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    setOverlaySurface('collapsed')
  })

  app.whenReady().then(bootstrap).catch((error) => {
    console.error(error)
    app.quit()
  })
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId('io.github.better-codex-info')
  if (process.platform === 'darwin') app.dock?.hide()

  const settings = await settingsStore.load()
  applySettings(settings)
  const paths = await discoverCodexPaths()
  codexHome = paths.home
  warnings = [
    ...(paths.sessionDirectories.length === 0
      ? [{ code: 'sessions-missing', message: `未找到 Codex 会话目录：${paths.home}` }]
      : [])
  ]

  const databaseDirectory = app.getPath('userData')
  await mkdir(databaseDirectory, { recursive: true })
  repository = new CodexRepository(
    paths,
    join(databaseDirectory, 'metrics.sqlite3'),
    () => settingsStore.get()
  )
  repository.on('updated', (snapshot: SessionSnapshot | null) => {
    overlay?.getWindow()?.webContents.send('info:snapshot-updated', snapshot)
    void checkNotifications(snapshot)
  })
  repository.on('indexing', (value: boolean) => {
    indexing = value
    overlay?.getWindow()?.webContents.send('info:index-state', value)
  })

  overlay = new OverlayWindow(() => settingsStore.get())
  overlay.create()
  applySettings(settings)
  createTray()
  registerIpc()

  void repository.start().then(() => {
    const repositoryWarnings =
      repository
        ?.getWarnings()
        .filter((warning) => !warnings.some((entry) => entry.message === warning))
        .map((message): DataWarning => ({ code: 'repository-warning', message })) ?? []
    warnings.push(...repositoryWarnings)
    broadcastSnapshot()
  })
}

function registerIpc(): void {
  ipcMain.handle('info:get-bootstrap', async (): Promise<BootstrapPayload> => {
    const settings = settingsStore.get()
    const filter = defaultFilter(settings)
    const history = repository?.getHistory(filter)
    return {
      codexHome,
      settings,
      snapshot: repository?.getSnapshot() ?? null,
      overview:
        history?.overview ?? {
          sessions: 0,
          rounds: 0,
          steps: 0,
          toolCalls: 0,
          totalTokens: 0,
          inputTokens: 0,
          cachedInput: 0,
          outputTokens: 0,
          reasoningOutput: 0,
          cacheHitRate: null,
          averageTtftMs: null,
          tps: null,
          modelMs: 0,
          toolMs: 0,
          activeDays: 0
        },
      series: history?.series ?? [],
      sessions: history?.sessions ?? [],
      warnings,
      indexing,
      indexedAt: repository?.getIndexedAt() ?? 0
    }
  })

  ipcMain.handle('info:query-snapshot', (_event, sessionId?: string) => {
    return repository?.getSnapshot(sessionId) ?? null
  })

  ipcMain.handle('info:query-history', (_event, filter: HistoryFilter) => {
    return repository?.getHistory(filter) ?? { overview: emptyOverview(), series: [], sessions: [] }
  })

  ipcMain.handle('info:query-turns', (_event, sessionId: string) => {
    return repository?.getTurns(sessionId) ?? []
  })

  ipcMain.handle('info:query-series', (_event, filter: HistoryFilter) => {
    return repository?.getHistory(filter).series ?? []
  })

  ipcMain.handle('info:pin-session', async (_event, sessionId: string | null) => {
    const settings = await settingsStore.update({ pinnedSessionId: sessionId })
    broadcastSnapshot()
    rebuildTrayMenu()
    return settings
  })

  ipcMain.handle(
    'info:update-settings',
    async (_event, patch: Partial<AppSettings>): Promise<AppSettings> => {
      const settings = await settingsStore.update(patch)
      applySettings(settings)
      rebuildTrayMenu()
      broadcastSnapshot()
      return settings
    }
  )

  ipcMain.handle('info:export', async (_event, request: ExportRequest) => {
    if (!repository) return { canceled: true }
    const source = repository.getSessionsForExport(request.filter)
    const extension = request.format
    const result = await dialog.showSaveDialog({
      title: '导出 Codex 用量数据',
      defaultPath: join(app.getPath('documents'), `better-codex-info-${dateStamp()}.${extension}`),
      filters: [
        {
          name: extension === 'csv' ? 'CSV 表格' : 'JSON 数据',
          extensions: [extension]
        }
      ]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    const content =
      request.format === 'csv'
        ? serializeCsv(source)
        : `${JSON.stringify(createExportDocument(source, request.filter, app.getVersion()), null, 2)}\n`
    await writeFile(result.filePath, content, 'utf8')
    return { canceled: false, filePath: result.filePath }
  })

  ipcMain.handle('overlay:hide', async () => overlay?.hideTemporarily())
  ipcMain.handle('overlay:set-surface', async (_event, surface: OverlaySurface) => {
    setOverlaySurface(surface)
  })
}

function broadcastSnapshot(): void {
  overlay?.getWindow()?.webContents.send('info:snapshot-updated', repository?.getSnapshot() ?? null)
}

function setOverlaySurface(surface: OverlaySurface): void {
  overlay?.setSurface(surface)
  overlay?.getWindow()?.webContents.send('overlay:surface-updated', surface)
}

function applySettings(settings: AppSettings): void {
  nativeTheme.themeSource = settings.theme
  app.setLoginItemSettings({
    openAtLogin: settings.launchAtLogin
  })
  overlay?.getWindow()?.setOpacity(settings.opacity)
  rebuildTrayMenu()
}

function createTray(): void {
  tray = new Tray(createTrayIcon())
  tray.setToolTip('Better Codex Info')
  rebuildTrayMenu()
  tray.on('click', () => void overlay?.toggleVisibility())
}

function rebuildTrayMenu(): void {
  if (!tray) return
  const settings = settingsStore.get()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示 / 隐藏统计胶囊',
        click: () => void overlay?.toggleVisibility()
      },
      {
        label: '打开分析中心',
        click: () => setOverlaySurface('analysis')
      },
      { type: 'separator' },
      {
        label: '启用系统通知',
        type: 'checkbox',
        checked: settings.notificationsEnabled,
        click: async (item) => {
          const updated = await settingsStore.update({
            notificationsEnabled: item.checked,
            onboardingComplete: true
          })
          applySettings(updated)
          if (overlay?.getWindow()) {
            overlay.getWindow()?.webContents.send('info:snapshot-updated', repository?.getSnapshot() ?? null)
          }
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

async function checkNotifications(snapshot: SessionSnapshot | null): Promise<void> {
  const settings = settingsStore.get()
  if (!settings.notificationsEnabled || !repository || !snapshot) return
  const percent = (snapshot.contextPercent ?? 0) * 100
  for (const threshold of [settings.contextWarningPercent, settings.contextCriticalPercent]) {
    if (percent >= threshold) {
      notifyOnce(
        `context:${snapshot.id}:${threshold}`,
        '上下文空间不足',
        `${snapshot.title} 已使用 ${Math.round(percent)}% 上下文（阈值 ${threshold}%）。`,
        settings.notificationCooldownMinutes
      )
    }
  }
  if (
    settings.cacheHitMinimum != null &&
    snapshot.cacheHitRate != null &&
    snapshot.usage.input >= 20_000 &&
    snapshot.cacheHitRate * 100 < settings.cacheHitMinimum
  ) {
    notifyOnce(
      `cache:${snapshot.id}:${settings.cacheHitMinimum}`,
      '缓存命中率偏低',
      `${snapshot.title} 当前缓存命中率为 ${Math.round(snapshot.cacheHitRate * 100)}%。`,
      settings.notificationCooldownMinutes
    )
  }

  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const day = repository.getHistory({
    from: startOfDay,
    includeSubagents: settings.includeSubagents
  }).overview.totalTokens
  const month = repository.getHistory({
    from: startOfMonth,
    includeSubagents: settings.includeSubagents
  }).overview.totalTokens
  checkBudget('daily', day, settings.dailyTokenBudget, settings)
  checkBudget('monthly', month, settings.monthlyTokenBudget, settings)
}

function checkBudget(
  kind: 'daily' | 'monthly',
  usage: number,
  budget: number | null,
  settings: AppSettings
): void {
  if (budget == null || budget <= 0) return
  const ratio = usage / budget
  for (const threshold of [0.8, 1]) {
    if (ratio < threshold) continue
    const slot = kind === 'daily' ? dateStamp() : `${new Date().getFullYear()}-${new Date().getMonth() + 1}`
    notifyOnce(
      `${kind}:${slot}:${threshold}`,
      `${kind === 'daily' ? '今日' : '本月'} Token 预算提醒`,
      `已使用 ${Intl.NumberFormat('zh-CN').format(usage)} Token，达到预算的 ${Math.round(ratio * 100)}%。`,
      settings.notificationCooldownMinutes
    )
  }
}

function notifyOnce(key: string, title: string, body: string, cooldownMinutes: number): void {
  if (!Notification.isSupported()) return
  const now = Date.now()
  const previous = lastNotificationAt.get(key) ?? 0
  if (now - previous < cooldownMinutes * 60_000) return
  lastNotificationAt.set(key, now)
  new Notification({ title, body, silent: false }).show()
}

function createTrayIcon(): Electron.NativeImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="9" fill="#151515"/>
    <path d="M8 21V11h4.2c3 0 4.8 1.8 4.8 5s-1.8 5-4.8 5H8Zm3.2-2.5h.8c1.3 0 2-.9 2-2.5s-.7-2.5-2-2.5h-.8v5Zm8-7.5h3.4v10h-3.4V11Z" fill="#eee"/>
  </svg>`
  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  )
}

function dateStamp(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

function emptyOverview(): import('../shared/contracts').AnalyticsOverview {
  return {
    sessions: 0,
    rounds: 0,
    steps: 0,
    toolCalls: 0,
    totalTokens: 0,
    inputTokens: 0,
    cachedInput: 0,
    outputTokens: 0,
    reasoningOutput: 0,
    cacheHitRate: null,
    averageTtftMs: null,
    tps: null,
    modelMs: 0,
    toolMs: 0,
    activeDays: 0
  }
}

app.on('before-quit', () => {
  quitting = true
  repository?.close()
  overlay?.destroy()
})

app.on('window-all-closed', () => {
  // The tray and overlay keep the app alive until the user explicitly quits.
})
