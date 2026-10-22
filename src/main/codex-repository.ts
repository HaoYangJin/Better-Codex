import Database from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type {
  AnalyticsOverview,
  AnalyticsPayload,
  HistoryFilter,
  SeriesPoint,
  SessionSnapshot,
  SessionSummary,
  TurnMetrics
} from '../shared/contracts'
import { EMPTY_USAGE, calculateTps, cacheHitRate } from '../shared/metrics'
import { listSessionFiles, type CodexPaths } from './codex-paths'
import { parseSessionFile, type ThreadMetadata } from './session-parser'

const PARSER_VERSION = 1

interface FileRecord {
  path: string
  file_size: number
  file_mtime: number
  parser_version: number
}

interface ThreadRow {
  id: string
  title: string
  cwd: string
  model: string | null
  model_provider: string
  source: string
  updated_at_ms: number
}

interface StoredSessionRow {
  id: string
  snapshot_json: string
}

export class CodexRepository extends EventEmitter {
  private readonly codexPaths: CodexPaths
  private readonly database: Database.Database
  private watchers: FSWatcher[] = []
  private scanTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private scanning = false
  private settingsGetter: () => import('../shared/contracts').AppSettings
  private warnings = new Set<string>()
  private indexedAt = 0
  private closed = false

  constructor(
    codexPaths: CodexPaths,
    databasePath: string,
    settingsGetter: () => import('../shared/contracts').AppSettings
  ) {
    super()
    this.codexPaths = codexPaths
    this.settingsGetter = settingsGetter
    this.database = new Database(databasePath)
    this.database.pragma('journal_mode = WAL')
    this.database.pragma('synchronous = NORMAL')
    this.initialize()
  }

  async start(): Promise<void> {
    await this.scan()
    for (const directory of this.codexPaths.sessionDirectories) {
      try {
        const watcher = watch(directory, { recursive: true }, () => {
          if (this.scanTimer) clearTimeout(this.scanTimer)
          this.scanTimer = setTimeout(() => void this.scan(), 250)
        })
        this.watchers.push(watcher)
      } catch {
        this.warnings.add(`无法监听会话目录：${directory}`)
      }
    }
    this.pollTimer = setInterval(() => void this.scan(), 4_000)
    this.pollTimer.unref()
  }

  close(): void {
    this.closed = true
    for (const watcher of this.watchers) void watcher.close()
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.scanTimer) clearTimeout(this.scanTimer)
    this.database.close()
  }

  isScanning(): boolean {
    return this.scanning
  }

  getIndexedAt(): number {
    return this.indexedAt
  }

  getWarnings(): string[] {
    return [...this.warnings]
  }

  getSnapshot(sessionId?: string): SessionSnapshot | null {
    if (this.closed) return null
    const settings = this.settingsGetter()
    const requestedId = sessionId ?? settings.pinnedSessionId
    let row: StoredSessionRow | undefined

    if (requestedId) {
      row = this.database
        .prepare('select id, snapshot_json from sessions where id = ?')
        .get(requestedId) as StoredSessionRow | undefined
    }
    if (!row && !sessionId) {
      row =
        (this.database
          .prepare(
            'select id, snapshot_json from sessions where is_subagent = 0 order by updated_at desc limit 1'
          )
          .get() as StoredSessionRow | undefined) ??
        (this.database
          .prepare(
            'select id, snapshot_json from sessions order by updated_at desc limit 1'
          )
          .get() as StoredSessionRow | undefined)
    }

    if (!row) return null
    const snapshot = JSON.parse(row.snapshot_json) as Omit<SessionSnapshot, 'pinned'>
    return {
      ...snapshot,
      pinned: settings.pinnedSessionId === snapshot.id
    }
  }

  getHistory(filter: HistoryFilter): AnalyticsPayload {
    if (this.closed) {
      return { overview: emptyOverview(), series: [], sessions: [] }
    }
    const sessions = this.querySessions(filter)
    const turns = this.queryTurnsForSessions(sessions.map((session) => session.id))
    return {
      overview: aggregateOverview(sessions, turns),
      series: aggregateSeries(sessions, turns),
      sessions
    }
  }

  getTurns(sessionId: string): TurnMetrics[] {
    if (this.closed) return []
    return this.database
      .prepare('select data_json from turns where session_id = ? order by started_at asc')
      .all(sessionId)
      .map((row) => JSON.parse((row as { data_json: string }).data_json) as TurnMetrics)
  }

  getSessionsForExport(filter: HistoryFilter): {
    sessions: SessionSummary[]
    turns: Array<TurnMetrics & { sessionId: string }>
    overview: AnalyticsOverview
    series: SeriesPoint[]
  } {
    if (this.closed) {
      return {
        sessions: [],
        turns: [],
        overview: emptyOverview(),
        series: []
      }
    }
    const analytics = this.getHistory(filter)
    const turns = this.queryTurnsForSessions(
      analytics.sessions.map((session) => session.id)
    ).map((turn) => ({ ...turn, sessionId: turn.sessionId }))
    return { ...analytics, turns }
  }

  private initialize(): void {
    this.database.exec(`
      create table if not exists sessions (
        id text primary key,
        path text not null,
        file_size integer not null,
        file_mtime integer not null,
        parser_version integer not null,
        title text not null,
        cwd text not null,
        project_name text not null,
        model text not null,
        provider text not null,
        reasoning_effort text not null,
        status text not null,
        started_at integer not null,
        updated_at integer not null,
        rounds integer not null,
        steps integer not null,
        tool_calls integer not null,
        compactions integer not null,
        input_tokens integer not null,
        cached_input integer not null,
        cache_write_input integer not null,
        output_tokens integer not null,
        reasoning_output integer not null,
        total_tokens integer not null,
        cache_hit_rate real,
        parent_id text,
        is_subagent integer not null,
        context_used integer not null,
        context_window integer,
        context_percent real,
        model_ms integer not null,
        tool_ms integer not null,
        total_ms integer not null,
        avg_ttft_ms real,
        tps real,
        longest_tool_json text,
        snapshot_json text not null
      );
      create index if not exists sessions_updated_idx on sessions(updated_at desc);
      create index if not exists sessions_project_idx on sessions(project_name);
      create index if not exists sessions_model_idx on sessions(model);
      create index if not exists sessions_subagent_idx on sessions(is_subagent);
      create table if not exists turns (
        session_id text not null,
        id text not null,
        started_at integer not null,
        completed_at integer,
        duration_ms integer not null,
        ttft_ms real,
        status text not null,
        requests integer not null,
        tool_calls integer not null,
        input_tokens integer not null,
        cached_input integer not null,
        cache_write_input integer not null,
        output_tokens integer not null,
        reasoning_output integer not null,
        total_tokens integer not null,
        cache_hit_rate real,
        model_ms integer not null,
        tool_ms integer not null,
        tps real,
        data_json text not null,
        primary key(session_id, id)
      );
      create index if not exists turns_started_idx on turns(started_at desc);
      create table if not exists app_meta (
        key text primary key,
        value text not null
      );
    `)
  }

  private async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    this.emit('indexing', true)
    try {
      const files = await listSessionFiles(this.codexPaths)
      const existing = new Map(
        (
          this.database
            .prepare('select path, file_size, file_mtime, parser_version from sessions')
            .all() as FileRecord[]
        ).map((row) => [row.path, row])
      )
      const threadMetadata = await this.readThreadMetadata()

      for (const [index, filePath] of files.entries()) {
        let fileInfo
        try {
          fileInfo = await stat(filePath)
        } catch {
          continue
        }
        const previous = existing.get(filePath)
        if (
          previous &&
          previous.parser_version === PARSER_VERSION &&
          previous.file_size === fileInfo.size &&
          Math.abs(previous.file_mtime - fileInfo.mtimeMs) < 1
        ) {
          continue
        }
        try {
          const parsed = await parseSessionFile(
            filePath,
            threadMetadata.get(parsedSessionIdFromFilename(filePath))
          )
          this.storeParsedSession(
            filePath,
            fileInfo.size,
            fileInfo.mtimeMs,
            parsed.snapshot,
            parsed.turns
          )
          if (index % 5 === 0) await new Promise((resolve) => setImmediate(resolve))
        } catch (error) {
          this.warnings.add(
            `无法解析 ${basename(filePath)}：${error instanceof Error ? error.message : String(error)}`
          )
        }
      }

      const knownPaths = new Set(files)
      for (const path of existing.keys()) {
        if (!knownPaths.has(path)) {
          this.database.prepare('delete from turns where session_id in (select id from sessions where path = ?)').run(path)
          this.database.prepare('delete from sessions where path = ?').run(path)
        }
      }
      this.indexedAt = Date.now()
      this.emit('updated', this.getSnapshot())
    } finally {
      this.scanning = false
      this.emit('indexing', false)
    }
  }

  private storeParsedSession(
    filePath: string,
    fileSize: number,
    fileMtime: number,
    snapshot: Omit<SessionSnapshot, 'pinned'>,
    turns: TurnMetrics[]
  ): void {
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `insert into sessions (
            id, path, file_size, file_mtime, parser_version, title, cwd, project_name,
            model, provider, reasoning_effort, status, started_at, updated_at, rounds,
            steps, tool_calls, compactions, input_tokens, cached_input, cache_write_input,
            output_tokens, reasoning_output, total_tokens, cache_hit_rate, parent_id,
            is_subagent, context_used, context_window, context_percent, model_ms, tool_ms,
            total_ms, avg_ttft_ms, tps, longest_tool_json, snapshot_json
          ) values (
            @id, @path, @fileSize, @fileMtime, @parserVersion, @title, @cwd, @projectName,
            @model, @provider, @reasoningEffort, @status, @startedAt, @updatedAt, @rounds,
            @steps, @toolCalls, @compactions, @input, @cachedInput, @cacheWriteInput,
            @output, @reasoningOutput, @total, @cacheHitRate, @parentId, @isSubagent,
            @contextUsed, @contextWindow, @contextPercent, @modelMs, @toolMs, @totalMs,
            @averageTtftMs, @tps, @longestToolJson, @snapshotJson
          )
          on conflict(id) do update set
            path=excluded.path,
            file_size=excluded.file_size,
            file_mtime=excluded.file_mtime,
            parser_version=excluded.parser_version,
            title=excluded.title,
            cwd=excluded.cwd,
            project_name=excluded.project_name,
            model=excluded.model,
            provider=excluded.provider,
            reasoning_effort=excluded.reasoning_effort,
            status=excluded.status,
            started_at=excluded.started_at,
            updated_at=excluded.updated_at,
            rounds=excluded.rounds,
            steps=excluded.steps,
            tool_calls=excluded.tool_calls,
            compactions=excluded.compactions,
            input_tokens=excluded.input_tokens,
            cached_input=excluded.cached_input,
            cache_write_input=excluded.cache_write_input,
            output_tokens=excluded.output_tokens,
            reasoning_output=excluded.reasoning_output,
            total_tokens=excluded.total_tokens,
            cache_hit_rate=excluded.cache_hit_rate,
            parent_id=excluded.parent_id,
            is_subagent=excluded.is_subagent,
            context_used=excluded.context_used,
            context_window=excluded.context_window,
            context_percent=excluded.context_percent,
            model_ms=excluded.model_ms,
            tool_ms=excluded.tool_ms,
            total_ms=excluded.total_ms,
            avg_ttft_ms=excluded.avg_ttft_ms,
            tps=excluded.tps,
            longest_tool_json=excluded.longest_tool_json,
            snapshot_json=excluded.snapshot_json`
        )
        .run({
          id: snapshot.id,
          path: filePath,
          fileSize,
          fileMtime,
          parserVersion: PARSER_VERSION,
          title: snapshot.title,
          cwd: snapshot.cwd,
          projectName: snapshot.projectName,
          model: snapshot.model,
          provider: snapshot.provider,
          reasoningEffort: snapshot.reasoningEffort,
          status: snapshot.status,
          startedAt: snapshot.startedAt,
          updatedAt: snapshot.updatedAt,
          rounds: snapshot.rounds,
          steps: snapshot.steps,
          toolCalls: snapshot.toolCalls,
          compactions: snapshot.compactions,
          input: snapshot.usage.input,
          cachedInput: snapshot.usage.cachedInput,
          cacheWriteInput: snapshot.usage.cacheWriteInput,
          output: snapshot.usage.output,
          reasoningOutput: snapshot.usage.reasoningOutput,
          total: snapshot.usage.total,
          cacheHitRate: snapshot.cacheHitRate,
          parentId: snapshot.parentId,
          isSubagent: snapshot.isSubagent ? 1 : 0,
          contextUsed: snapshot.contextUsed,
          contextWindow: snapshot.contextWindow,
          contextPercent: snapshot.contextPercent,
          modelMs: snapshot.latency.modelMs,
          toolMs: snapshot.latency.toolMs,
          totalMs: snapshot.latency.totalMs,
          averageTtftMs: snapshot.latency.averageTtftMs,
          tps: snapshot.latency.tps,
          longestToolJson: snapshot.latency.longestTool
            ? JSON.stringify(snapshot.latency.longestTool)
            : null,
          snapshotJson: JSON.stringify(snapshot)
        })

      this.database.prepare('delete from turns where session_id = ?').run(snapshot.id)
      const insertTurn = this.database.prepare(`
        insert into turns (
          session_id, id, started_at, completed_at, duration_ms, ttft_ms, status,
          requests, tool_calls, input_tokens, cached_input, cache_write_input,
          output_tokens, reasoning_output, total_tokens, cache_hit_rate, model_ms,
          tool_ms, tps, data_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const turn of turns) {
        insertTurn.run(
          snapshot.id,
          turn.id,
          turn.startedAt,
          turn.completedAt,
          turn.durationMs,
          turn.ttftMs,
          turn.status,
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
          turn.toolMs,
          turn.tps,
          JSON.stringify(turn)
        )
      }
    })
    transaction()
  }

  private querySessions(filter: HistoryFilter): SessionSummary[] {
    if (this.closed) return []
    const clauses = ['1 = 1']
    const params: Array<string | number> = []
    if (filter.sessionKind === 'main' || (filter.sessionKind !== 'subagent' && !filter.includeSubagents)) {
      clauses.push('is_subagent = 0')
    } else if (filter.sessionKind === 'subagent') {
      clauses.push('is_subagent = 1')
    }
    if (filter.from != null) {
      clauses.push('updated_at >= ?')
      params.push(filter.from)
    }
    if (filter.to != null) {
      clauses.push('updated_at <= ?')
      params.push(filter.to)
    }
    if (filter.project) {
      clauses.push('project_name = ?')
      params.push(filter.project)
    }
    if (filter.model) {
      clauses.push('model = ?')
      params.push(filter.model)
    }
    if (filter.reasoningEffort) {
      clauses.push('reasoning_effort = ?')
      params.push(filter.reasoningEffort)
    }
    if (filter.search) {
      clauses.push('(title like ? or project_name like ? or model like ?)')
      const search = `%${filter.search}%`
      params.push(search, search, search)
    }

    const limit = Math.min(10_000, Math.max(1, filter.limit ?? 2_000))
    const rows = this.database
      .prepare(
        `select snapshot_json from sessions where ${clauses.join(' and ')} order by updated_at desc limit ?`
      )
      .all(...params, limit)
    return rows.map((row) => {
      const snapshot = JSON.parse((row as { snapshot_json: string }).snapshot_json) as SessionSnapshot
      return withoutSnapshotFields(snapshot)
    })
  }

  private queryTurnsForSessions(
    sessionIds: string[]
  ): Array<TurnMetrics & { sessionId: string }> {
    if (sessionIds.length === 0) return []
    const output: Array<TurnMetrics & { sessionId: string }> = []
    const chunkSize = 500
    for (let index = 0; index < sessionIds.length; index += chunkSize) {
      const ids = sessionIds.slice(index, index + chunkSize)
      const placeholders = ids.map(() => '?').join(',')
      const rows = this.database
        .prepare(
          `select session_id, data_json from turns where session_id in (${placeholders}) order by started_at asc`
        )
        .all(...ids)
      for (const row of rows) {
        const typed = row as { session_id: string; data_json: string }
        output.push({
          ...(JSON.parse(typed.data_json) as TurnMetrics),
          sessionId: typed.session_id
        })
      }
    }
    return output
  }

  private async readThreadMetadata(): Promise<Map<string, ThreadMetadata>> {
    const result = new Map<string, ThreadMetadata>()
    if (!this.codexPaths.stateDatabase) return result
    let source: Database.Database | null = null
    try {
      source = new Database(this.codexPaths.stateDatabase, {
        readonly: true,
        fileMustExist: true
      })
      source.pragma('busy_timeout = 250')
      const hasThreads = source
        .prepare("select name from sqlite_master where type = 'table' and name = 'threads'")
        .get()
      if (!hasThreads) return result
      const rows = source
        .prepare(
          `select id, title, cwd, model, model_provider, source, updated_at_ms
           from threads`
        )
        .all() as ThreadRow[]
      const hasToolTable = source
        .prepare(
          "select name from sqlite_master where type = 'table' and name = 'thread_dynamic_tools'"
        )
        .get()
      const toolRows = hasToolTable
        ? (source
            .prepare(
              `select thread_id, coalesce(sum(length(name) + length(description) + length(input_schema)), 0) as chars
               from thread_dynamic_tools group by thread_id`
            )
            .all() as Array<{ thread_id: string; chars: number }>)
        : []
      const toolCharacters = new Map(
        toolRows.map((row) => [row.thread_id, Number(row.chars) || 0])
      )
      for (const row of rows) {
        result.set(row.id, {
          title: row.title,
          cwd: normalizeWindowsPath(row.cwd),
          model: row.model ?? '',
          provider: row.model_provider,
          source: row.source,
          updatedAt: row.updated_at_ms,
          toolDefinitionCharacters: toolCharacters.get(row.id) ?? 0
        })
      }
    } catch (error) {
      this.warnings.add(
        `无法读取 Codex 状态数据库：${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      source?.close()
    }
    return result
  }

}

function withoutSnapshotFields(snapshot: SessionSnapshot): SessionSummary {
  const {
    contextUsed: _contextUsed,
    contextWindow: _contextWindow,
    contextPercent: _contextPercent,
    contextBreakdown: _contextBreakdown,
    latency: _latency,
    pinned: _pinned,
    approximateTiming: _approximateTiming,
    ...summary
  } = snapshot
  return summary
}

function aggregateOverview(
  sessions: SessionSummary[],
  turns: Array<TurnMetrics & { sessionId: string }>
): AnalyticsOverview {
  const usage = sessions.reduce(
    (total, session) => ({
      input: total.input + session.usage.input,
      cached: total.cached + session.usage.cachedInput,
      output: total.output + session.usage.output,
      reasoning: total.reasoning + session.usage.reasoningOutput,
      total: total.total + session.usage.total
    }),
    { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 }
  )
  const weightedTtft = turns.filter(
    (turn): turn is TurnMetrics & { sessionId: string; ttftMs: number } => turn.ttftMs != null
  )
  const modelMs = turns.reduce((total, turn) => total + turn.modelMs, 0)
  const toolMs = turns.reduce((total, turn) => total + turn.toolMs, 0)
  const activeDays = new Set(turns.map((turn) => localDay(turn.startedAt))).size
  const ttftWeight = weightedTtft.reduce((total, turn) => total + Math.max(1, turn.requests), 0)
  const ttftSum = weightedTtft.reduce(
    (total, turn) => total + turn.ttftMs * Math.max(1, turn.requests),
    0
  )

  return {
    sessions: sessions.length,
    rounds: sessions.reduce((total, session) => total + session.rounds, 0),
    steps: sessions.reduce((total, session) => total + session.steps, 0),
    toolCalls: sessions.reduce((total, session) => total + session.toolCalls, 0),
    totalTokens: usage.total,
    inputTokens: usage.input,
    cachedInput: usage.cached,
    outputTokens: usage.output,
    reasoningOutput: usage.reasoning,
    cacheHitRate: usage.input > 0 ? usage.cached / usage.input : null,
    averageTtftMs: ttftWeight > 0 ? ttftSum / ttftWeight : null,
    tps: calculateTps(usage.output, modelMs),
    modelMs,
    toolMs,
    activeDays
  }
}

function aggregateSeries(
  sessions: SessionSummary[],
  turns: Array<TurnMetrics & { sessionId: string }>
): SeriesPoint[] {
  const sessionById = new Map(sessions.map((session) => [session.id, session]))
  const days = new Map<
    string,
    {
      totalTokens: number
      cachedInput: number
      input: number
      output: number
      modelMs: number
      toolMs: number
      ttftSum: number
      ttftWeight: number
      sessions: Set<string>
    }
  >()

  for (const turn of turns) {
    const session = sessionById.get(turn.sessionId)
    if (!session) continue
    const day = localDay(turn.startedAt)
    const current = days.get(day) ?? {
      totalTokens: 0,
      cachedInput: 0,
      input: 0,
      output: 0,
      modelMs: 0,
      toolMs: 0,
      ttftSum: 0,
      ttftWeight: 0,
      sessions: new Set<string>()
    }
    current.totalTokens += turn.usage.total
    current.cachedInput += turn.usage.cachedInput
    current.input += turn.usage.input
    current.output += turn.usage.output
    current.modelMs += turn.modelMs
    current.toolMs += turn.toolMs
    if (turn.ttftMs != null) {
      current.ttftSum += turn.ttftMs
      current.ttftWeight += 1
    }
    current.sessions.add(turn.sessionId)
    days.set(day, current)
  }

  return [...days.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, day]) => ({
      date,
      totalTokens: day.totalTokens,
      cachedInput: day.cachedInput,
      output: day.output,
      cacheHitRate: day.input > 0 ? day.cachedInput / day.input : null,
      averageTtftMs: day.ttftWeight > 0 ? day.ttftSum / day.ttftWeight : null,
      tps: calculateTps(day.output, day.modelMs),
      toolMs: day.toolMs,
      sessions: day.sessions.size
    }))
}

function localDay(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parsedSessionIdFromFilename(filePath: string): string {
  const matches = basename(filePath).match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
  )
  return matches?.[0] ?? basename(filePath, '.jsonl')
}

function normalizeWindowsPath(path: string): string {
  return path.replace(/^\\\\\?\\/, '')
}

function emptyOverview(): AnalyticsOverview {
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
