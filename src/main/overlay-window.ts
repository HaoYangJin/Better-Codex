import { BrowserWindow, screen } from 'electron'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { activeWindow, openWindows } from 'get-windows'
import type { AppSettings, DockPosition, OverlaySurface } from '../shared/contracts'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const SURFACE_SIZE: Record<OverlaySurface, { width: number; height: number }> = {
  collapsed: { width: 650, height: 62 },
  stats: { width: 650, height: 380 },
  tokens: { width: 650, height: 370 },
  context: { width: 650, height: 400 },
  analysis: { width: 960, height: 700 },
  settings: { width: 960, height: 700 }
}

export class OverlayWindow {
  private window: BrowserWindow | null = null
  private surface: OverlaySurface = 'collapsed'
  private codexBounds: Rect | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private polling = false
  private manuallyHidden = false
  private readonly settingsGetter: () => AppSettings

  constructor(settingsGetter: () => AppSettings) {
    this.settingsGetter = settingsGetter
  }

  create(): BrowserWindow {
    const window = new BrowserWindow({
      ...SURFACE_SIZE.collapsed,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      focusable: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })

    window.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'normal')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    window.setIgnoreMouseEvents(false)
    this.window = window

    if (process.env.ELECTRON_RENDERER_URL) {
      void window.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void window.loadFile(join(__dirname, '../renderer/index.html'))
    }

    window.once('ready-to-show', () => {
      this.manuallyHidden = false
      this.position()
    })

    window.on('closed', () => {
      this.window = null
    })

    void this.startTracking()
    return window
  }

  getWindow(): BrowserWindow | null {
    return this.window
  }

  setSurface(surface: OverlaySurface): void {
    this.surface = surface
    this.manuallyHidden = false
    this.position()
    this.window?.showInactive()
  }

  async hideTemporarily(): Promise<void> {
    this.manuallyHidden = true
    this.window?.hide()
  }

  async toggleVisibility(): Promise<void> {
    if (!this.window) return
    if (this.window.isVisible()) {
      this.manuallyHidden = true
      this.window.hide()
    } else {
      this.manuallyHidden = false
      this.position()
      this.window.showInactive()
    }
  }

  destroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.window?.destroy()
  }

  private async startTracking(): Promise<void> {
    await this.tick()
    this.pollTimer = setInterval(() => void this.tick(), 300)
  }

  private async tick(): Promise<void> {
    if (this.polling || !this.window) return
    this.polling = true
    try {
      const [foreground, windows] = await Promise.all([
        activeWindow({
          accessibilityPermission: false,
          screenRecordingPermission: false
        }).catch(() => undefined),
        openWindows({
          accessibilityPermission: false,
          screenRecordingPermission: false
        }).catch(() => [])
      ])
      const codexWindows = windows
        .filter(isCodexWindow)
        .filter((entry) => entry.bounds.width > 500 && entry.bounds.height > 350)
        .sort(
          (left, right) =>
            right.bounds.width * right.bounds.height - left.bounds.width * left.bounds.height
        )
      const codex = codexWindows[0]
      if (codex) this.codexBounds = codex.bounds
      else if (!this.codexBounds) this.codexBounds = await readPersistedBounds()

      const activeIsCodex = foreground ? isCodexWindow(foreground) : false
      const activeIsOverlay =
        foreground?.owner.processId === process.pid ||
        (foreground?.owner.name?.toLowerCase().includes('better codex info') ?? false)
      const shouldShow =
        process.env.BETTER_CODEX_INFO_FORCE_VISIBLE === '1' ||
        (!this.manuallyHidden &&
          (activeIsCodex || activeIsOverlay || !foreground) &&
          Boolean(this.codexBounds))

      if (shouldShow) {
        if (!this.window.isVisible()) {
          this.position()
          this.window.showInactive()
        } else {
          this.position()
        }
      } else if (this.window.isVisible()) {
        this.window.hide()
      }
    } finally {
      this.polling = false
    }
  }

  private position(): void {
    if (!this.window) return
    const display = screen.getDisplayNearestPoint(
      this.codexBounds
        ? { x: this.codexBounds.x + 20, y: this.codexBounds.y + 20 }
        : screen.getCursorScreenPoint()
    )
    const codex = this.codexBounds ?? display.workArea
    const size = SURFACE_SIZE[this.surface]
    const horizontalMargin = 16
    const width = Math.min(size.width, Math.max(520, codex.width - horizontalMargin * 2))
    const height = Math.min(size.height, Math.max(56, codex.height - horizontalMargin * 2))
    const dock = this.settingsGetter().dock
    const x = dockX(codex, width, dock)
    const y =
      dock === 'top-right'
        ? Math.round(codex.y + 14)
        : Math.round(
            this.surface === 'collapsed'
              ? codex.y + codex.height - height - 62
              : codex.y + codex.height - height - 46
          )
    this.window.setBounds(
      {
        x: Math.max(display.workArea.x, x),
        y: Math.max(display.workArea.y, y),
        width,
        height
      },
      false
    )
  }
}

function dockX(codex: Rect, width: number, dock: DockPosition): number {
  if (dock === 'bottom-left') return Math.round(codex.x + 16)
  if (dock === 'bottom-right' || dock === 'top-right') {
    return Math.round(codex.x + codex.width - width - 16)
  }
  return Math.round(codex.x + (codex.width - width) / 2)
}

async function readPersistedBounds(): Promise<Rect | null> {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  try {
    const state = JSON.parse(
      await readFile(join(codexHome, '.codex-global-state.json'), 'utf8')
    ) as Record<string, unknown>
    const bounds = state['electron-main-window-bounds']
    if (!bounds || typeof bounds !== 'object') return null
    const candidate = bounds as Record<string, unknown>
    const x = Number(candidate.x)
    const y = Number(candidate.y)
    const width = Number(candidate.width)
    const height = Number(candidate.height)
    if (![x, y, width, height].every(Number.isFinite) || width < 500 || height < 350) {
      return null
    }
    return { x, y, width, height }
  } catch {
    return null
  }
}

function isCodexWindow(window: {
  title: string
  owner: { name: string; path: string }
}): boolean {
  const name = window.owner.name.toLowerCase()
  const path = window.owner.path.toLowerCase()
  return (
    path.includes('openai.codex') ||
    path.includes('codex.app') ||
    (name === 'chatgpt' && path.includes('codex')) ||
    (name === 'codex' && window.title.toLowerCase().includes('codex'))
  )
}
