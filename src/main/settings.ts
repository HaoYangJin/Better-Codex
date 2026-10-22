import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AppSettings } from '../shared/contracts'

const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  onboardingComplete: false,
  notificationsEnabled: true,
  contextWarningPercent: 80,
  contextCriticalPercent: 95,
  dailyTokenBudget: null,
  monthlyTokenBudget: null,
  cacheHitMinimum: null,
  includeSubagents: true,
  dock: 'bottom-center',
  theme: 'system',
  opacity: 0.96,
  launchAtLogin: false,
  notificationCooldownMinutes: 30,
  pinnedSessionId: null
}

export class SettingsStore {
  readonly filePath: string
  private settings: AppSettings = { ...DEFAULT_SETTINGS }

  constructor(filePath = join(app.getPath('userData'), 'settings.json')) {
    this.filePath = filePath
  }

  async load(): Promise<AppSettings> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<AppSettings>
      this.settings = sanitizeSettings({ ...DEFAULT_SETTINGS, ...parsed })
    } catch {
      this.settings = { ...DEFAULT_SETTINGS }
    }
    return this.get()
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = sanitizeSettings({ ...this.settings, ...patch, version: 1 })
    await this.persist()
    return this.get()
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(this.settings, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.filePath)
  }
}

function sanitizeSettings(input: AppSettings): AppSettings {
  return {
    ...input,
    version: 1,
    contextWarningPercent: clamp(input.contextWarningPercent, 1, 99),
    contextCriticalPercent: clamp(input.contextCriticalPercent, 2, 100),
    dailyTokenBudget: nullablePositive(input.dailyTokenBudget),
    monthlyTokenBudget: nullablePositive(input.monthlyTokenBudget),
    cacheHitMinimum:
      input.cacheHitMinimum == null ? null : clamp(input.cacheHitMinimum, 0, 100),
    opacity: clamp(input.opacity, 0.6, 1),
    notificationCooldownMinutes: clamp(input.notificationCooldownMinutes, 1, 1_440)
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, value))
}

function nullablePositive(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null
  return Math.round(value)
}

export { DEFAULT_SETTINGS }
