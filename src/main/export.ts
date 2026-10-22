import type {
  AnalyticsOverview,
  ExportDocumentV1,
  HistoryFilter,
  SeriesPoint,
  SessionSummary,
  TurnMetrics
} from '../shared/contracts'

interface ExportSource {
  overview: AnalyticsOverview
  sessions: SessionSummary[]
  series: SeriesPoint[]
  turns: Array<TurnMetrics & { sessionId: string }>
}

export function createExportDocument(
  source: ExportSource,
  filter: HistoryFilter,
  applicationVersion: string
): ExportDocumentV1 {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    applicationVersion,
    filter,
    overview: source.overview,
    sessions: source.sessions,
    turns: source.turns
  }
}

export function serializeCsv(source: ExportSource): string {
  const headers = [
    'session_id',
    'session_title',
    'project',
    'model',
    'turn_id',
    'started_at',
    'duration_ms',
    'ttft_ms',
    'tps',
    'requests',
    'tool_calls',
    'input_tokens',
    'cached_input',
    'cache_write_input',
    'output_tokens',
    'reasoning_output',
    'total_tokens',
    'cache_hit_rate',
    'model_ms',
    'tool_ms'
  ]
  const sessions = new Map(source.sessions.map((session) => [session.id, session]))
  const lines = [headers.join(',')]
  for (const turn of source.turns) {
    const session = sessions.get(turn.sessionId)
    lines.push(
      [
        turn.sessionId,
        session?.title ?? '',
        session?.projectName ?? '',
        session?.model ?? '',
        turn.id,
        new Date(turn.startedAt).toISOString(),
        turn.durationMs,
        turn.ttftMs,
        turn.tps,
        turn.requests,
        turn.toolCalls,
        turn.usage.input,
        turn.usage.cachedInput,
        turn.usage.cacheWriteInput,
        turn.usage.output,
        turn.usage.reasoningOutput,
        turn.usage.total,
        turn.cacheHitRate,
        turn.modelMs,
        turn.toolMs
      ]
        .map(csvCell)
        .join(',')
    )
  }
  return `\ufeff${lines.join('\r\n')}\r\n`
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
