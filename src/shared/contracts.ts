export type ThemeMode = 'system' | 'dark' | 'light'
export type DockPosition = 'bottom-center' | 'bottom-left' | 'bottom-right' | 'top-right'
export type ExportFormat = 'csv' | 'json'
export type SessionStatus = 'running' | 'completed' | 'interrupted' | 'failed' | 'unknown'
export type OverlaySurface =
  | 'collapsed'
  | 'stats'
  | 'tokens'
  | 'context'
  | 'analysis'
  | 'settings'

export interface TokenUsage {
  input: number
  cachedInput: number
  cacheWriteInput: number
  uncachedInput: number
  output: number
  reasoningOutput: number
  total: number
}

export interface ContextBreakdown {
  system: number
  tools: number
  conversation: number
  other: number
  estimated: true
}

export interface LatencyMetrics {
  modelMs: number
  toolMs: number
  totalMs: number
  averageTtftMs: number | null
  tps: number | null
  longestTool: {
    name: string
    durationMs: number
  } | null
}

export interface SessionSummary {
  id: string
  title: string
  cwd: string
  projectName: string
  model: string
  provider: string
  reasoningEffort: string
  status: SessionStatus
  startedAt: number
  updatedAt: number
  rounds: number
  steps: number
  toolCalls: number
  compactions: number
  usage: TokenUsage
  cacheHitRate: number | null
  parentId: string | null
  isSubagent: boolean
}

export interface SessionSnapshot extends SessionSummary {
  contextUsed: number
  contextWindow: number | null
  contextPercent: number | null
  contextBreakdown: ContextBreakdown
  latency: LatencyMetrics
  pinned: boolean
  approximateTiming: boolean
}

export interface ToolMetric {
  name: string
  kind: string
  calls: number
  durationMs: number
  failures: number
}

export interface TurnMetrics {
  id: string
  startedAt: number
  completedAt: number | null
  durationMs: number
  ttftMs: number | null
  status: SessionStatus
  requests: number
  toolCalls: number
  usage: TokenUsage
  cacheHitRate: number | null
  modelMs: number
  toolMs: number
  tps: number | null
  tools: ToolMetric[]
}

export interface SeriesPoint {
  date: string
  totalTokens: number
  cachedInput: number
  output: number
  cacheHitRate: number | null
  averageTtftMs: number | null
  tps: number | null
  toolMs: number
  sessions: number
}

export interface AnalyticsOverview {
  sessions: number
  rounds: number
  steps: number
  toolCalls: number
  totalTokens: number
  inputTokens: number
  cachedInput: number
  outputTokens: number
  reasoningOutput: number
  cacheHitRate: number | null
  averageTtftMs: number | null
  tps: number | null
  modelMs: number
  toolMs: number
  activeDays: number
}

export interface HistoryFilter {
  from?: number
  to?: number
  project?: string
  model?: string
  reasoningEffort?: string
  sessionKind?: 'all' | 'main' | 'subagent'
  includeSubagents: boolean
  search?: string
  limit?: number
}

export interface AlertRule {
  id: string
  kind: 'context' | 'daily-budget' | 'monthly-budget' | 'cache'
  threshold: number
  enabled: boolean
}

export interface AppSettings {
  version: 1
  onboardingComplete: boolean
  notificationsEnabled: boolean
  contextWarningPercent: number
  contextCriticalPercent: number
  dailyTokenBudget: number | null
  monthlyTokenBudget: number | null
  cacheHitMinimum: number | null
  includeSubagents: boolean
  dock: DockPosition
  theme: ThemeMode
  opacity: number
  launchAtLogin: boolean
  notificationCooldownMinutes: number
  pinnedSessionId: string | null
}

export interface DataWarning {
  code: string
  message: string
}

export interface BootstrapPayload {
  codexHome: string
  settings: AppSettings
  snapshot: SessionSnapshot | null
  overview: AnalyticsOverview
  series: SeriesPoint[]
  sessions: SessionSummary[]
  warnings: DataWarning[]
  indexing: boolean
  indexedAt: number
}

export interface AnalyticsPayload {
  overview: AnalyticsOverview
  series: SeriesPoint[]
  sessions: SessionSummary[]
}

export interface ExportRequest {
  filter: HistoryFilter
  format: ExportFormat
}

export interface ExportResult {
  canceled: boolean
  filePath?: string
}

export interface ExportDocumentV1 {
  schemaVersion: 1
  generatedAt: string
  applicationVersion: string
  filter: HistoryFilter
  overview: AnalyticsOverview
  sessions: SessionSummary[]
  turns: Array<TurnMetrics & { sessionId: string }>
}

export interface BetterCodexInfoApi {
  getBootstrap(): Promise<BootstrapPayload>
  querySnapshot(sessionId?: string): Promise<SessionSnapshot | null>
  queryHistory(filter: HistoryFilter): Promise<AnalyticsPayload>
  queryTurns(sessionId: string): Promise<TurnMetrics[]>
  querySeries(filter: HistoryFilter): Promise<SeriesPoint[]>
  pinSession(sessionId: string | null): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  exportData(request: ExportRequest): Promise<ExportResult>
  hideOverlay(): Promise<void>
  setSurface(surface: OverlaySurface): Promise<void>
  onSnapshot(listener: (snapshot: SessionSnapshot | null) => void): () => void
  onIndexState(listener: (indexing: boolean) => void): () => void
}
