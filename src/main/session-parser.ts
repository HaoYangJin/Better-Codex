import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename } from 'node:path'
import type {
  ContextBreakdown,
  LatencyMetrics,
  SessionSnapshot,
  SessionStatus,
  TokenUsage,
  ToolMetric,
  TurnMetrics
} from '../shared/contracts'
import {
  EMPTY_USAGE,
  addUsage,
  calculateTps,
  cacheHitRate,
  estimateContextBreakdown,
  normalizeStatus,
  normalizeUsage,
  tokenTotal,
  unionDuration,
  weightedAverage
} from '../shared/metrics'

interface ThreadMetadata {
  title: string
  cwd: string
  model: string
  provider: string
  source: string
  updatedAt: number
  toolDefinitionCharacters: number
}

export interface ParsedSession {
  snapshot: Omit<SessionSnapshot, 'pinned'>
  turns: TurnMetrics[]
}

interface MutableTurn {
  id: string
  startedAt: number
  completedAt: number | null
  status: SessionStatus
  usage: TokenUsage
  requests: number
  toolCalls: number
  modelIntervals: Array<[number, number]>
  toolIntervals: Array<[number, number]>
  tools: Map<string, MutableTool>
  ttftExactMs: number | null
  ttftApproxMs: number | null
}

interface MutableTool {
  name: string
  kind: string
  calls: number
  durationMs: number
  failures: number
}

interface ParseState {
  id: string
  title: string
  cwd: string
  model: string
  provider: string
  reasoningEffort: string
  isSubagent: boolean
  parentId: string | null
  startedAt: number
  updatedAt: number
  status: SessionStatus
  usage: TokenUsage
  latestContextUsage: TokenUsage
  contextWindow: number | null
  turns: Map<string, MutableTurn>
  requestUsageRecords: number
  tokenCountRecords: number
  exactTtftSamples: number[]
  approximateTtftSamples: number[]
  modelIntervals: Array<[number, number]>
  toolIntervals: Array<[number, number]>
  compactions: number
  contextWeights: {
    system: number
    tools: number
    conversation: number
  }
  seenMessageIds: Set<string>
  currentTurnId: string | null
}

type JsonObject = Record<string, unknown>

export async function parseSessionFile(
  filePath: string,
  metadata?: ThreadMetadata
): Promise<ParsedSession> {
  const fallbackId = extractSessionId(filePath)
  const state = createState(filePath, fallbackId, metadata)
  const input = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })

  for await (const line of lines) {
    if (!line.trim()) continue
    let entry: JsonObject
    try {
      entry = JSON.parse(line) as JsonObject
    } catch {
      continue
    }
    consumeEntry(state, entry)
  }

  return finalize(state, metadata)
}

function createState(
  filePath: string,
  fallbackId: string,
  metadata?: ThreadMetadata
): ParseState {
  return {
    id: fallbackId,
    title: cleanTitle(metadata?.title) || '未命名会话',
    cwd: metadata?.cwd ?? '',
    model: metadata?.model ?? '',
    provider: metadata?.provider ?? '',
    reasoningEffort: '',
    isSubagent: isSubagentSource(metadata?.source ?? ''),
    parentId: extractParentId(metadata?.source ?? ''),
    startedAt: 0,
    updatedAt: metadata?.updatedAt ?? 0,
    status: 'unknown',
    usage: { ...EMPTY_USAGE },
    latestContextUsage: { ...EMPTY_USAGE },
    contextWindow: null,
    turns: new Map(),
    requestUsageRecords: 0,
    tokenCountRecords: 0,
    exactTtftSamples: [],
    approximateTtftSamples: [],
    modelIntervals: [],
    toolIntervals: [],
    compactions: 0,
    contextWeights: {
      system: 0,
      tools: metadata?.toolDefinitionCharacters ?? 0,
      conversation: 0
    },
    seenMessageIds: new Set(),
    currentTurnId: null
  }
}

function consumeEntry(state: ParseState, entry: JsonObject): void {
  const type = stringValue(entry.type)
  const payload = objectValue(entry.payload)
  const eventTime = toEpochMs(entry.timestamp)

  if (type === 'session_meta') {
    const meta = payload ?? entry
    state.id = stringValue(meta.id) || stringValue(meta.session_id) || state.id
    state.cwd = stringValue(meta.cwd) || state.cwd
    state.provider = stringValue(meta.model_provider) || state.provider
    state.startedAt = state.startedAt || toEpochMs(meta.timestamp) || eventTime || Date.now()
    state.contextWeights.system += deepTextLength(meta.base_instructions)
    const source = meta.source
    state.isSubagent ||= isSubagentSource(source)
    state.parentId ??= extractParentId(source)
    return
  }

  if (type === 'turn_context') {
    const context = payload ?? entry
    state.model = stringValue(context.model) || state.model
    state.cwd = stringValue(context.cwd) || state.cwd
    state.reasoningEffort = stringValue(context.effort) || state.reasoningEffort
    state.contextWindow =
      numericValue(context.model_context_window) ??
      numericValue(context.context_window) ??
      state.contextWindow
    return
  }

  if (type === 'token_usage_record' && payload) {
    state.requestUsageRecords += 1
    const usage = normalizeUsage(payload.usage)
    state.latestContextUsage = usage
    const turnId =
      stringValue(payload.turn_id) || stringValue(payload.root_turn_id) || state.currentTurnId
    if (turnId) {
      const turn = getOrCreateTurn(state, turnId, eventTime)
      turn.usage = addUsage(turn.usage, usage)
      turn.requests += 1
      state.currentTurnId = turnId
    }
    const threadUsage = objectValue(payload.thread_token_usage)
    if (threadUsage) state.usage = normalizeUsage(threadUsage)
    return
  }

  if (type === 'event_msg' && payload) {
    consumeEvent(state, payload, eventTime)
    return
  }

  if (type === 'response_item' && payload) {
    consumeResponseItem(state, payload)
  }
}

function consumeEvent(state: ParseState, payload: JsonObject, eventTime: number): void {
  const eventType = stringValue(payload.type)
  state.updatedAt = Math.max(state.updatedAt, eventTime)

  if (eventType === 'task_started') {
    const turnId = stringValue(payload.root_turn_id) || stringValue(payload.turn_id)
    if (!turnId) return
    state.currentTurnId = turnId
    const startedAt =
      toEpochMs(payload.started_at) || eventTime || Math.max(state.updatedAt, Date.now())
    const turn = getOrCreateTurn(state, turnId, startedAt)
    turn.startedAt = Math.min(turn.startedAt || startedAt, startedAt)
    turn.status = 'running'
    state.status = 'running'
    state.contextWindow =
      numericValue(payload.model_context_window) ?? state.contextWindow
    return
  }

  if (eventType === 'task_complete') {
    const turnId = stringValue(payload.root_turn_id) || stringValue(payload.turn_id)
    if (!turnId) return
    const turn = getOrCreateTurn(state, turnId, toEpochMs(payload.started_at) || eventTime)
    const startedAt = toEpochMs(payload.started_at) || turn.startedAt
    const completedAt = toEpochMs(payload.completed_at) || eventTime
    const duration = numericValue(payload.duration_ms)
    turn.startedAt = startedAt
    turn.completedAt = completedAt || startedAt + (duration ?? 0)
    turn.status = 'completed'
    const ttft = numericValue(payload.time_to_first_token_ms)
    if (ttft != null) {
      turn.ttftExactMs = ttft
      state.exactTtftSamples.push(ttft)
    }
    state.status = 'completed'
    return
  }

  if (eventType === 'turn_aborted') {
    const turnId = stringValue(payload.root_turn_id) || stringValue(payload.turn_id)
    if (!turnId) return
    const turn = getOrCreateTurn(state, turnId, eventTime)
    turn.status = 'interrupted'
    turn.completedAt = eventTime || turn.completedAt
    state.status = 'interrupted'
    return
  }

  if (eventType === 'token_count') {
    const info = objectValue(payload.info)
    if (!info) return
    const total = objectValue(info.total_token_usage)
    const last = objectValue(info.last_token_usage)
    if (total) state.usage = normalizeUsage(total)
    if (last) state.latestContextUsage = normalizeUsage(last)
    state.contextWindow = numericValue(info.model_context_window) ?? state.contextWindow
    state.tokenCountRecords += 1
    return
  }

  if (eventType === 'item_completed') {
    consumeCompletedItem(state, payload, eventTime)
    return
  }

  if (eventType.includes('compact')) {
    state.compactions += 1
  }
}

function consumeCompletedItem(
  state: ParseState,
  payload: JsonObject,
  eventTime: number
): void {
  const item = objectValue(payload.item)
  if (!item) return
  const itemType = stringValue(item.type)
  const turnId = stringValue(payload.turn_id) || state.currentTurnId
  const startedAt = numericValue(payload.started_at_ms) ?? eventTime
  const completedAt = numericValue(payload.completed_at_ms) ?? startedAt
  state.updatedAt = Math.max(state.updatedAt, completedAt, eventTime)

  if (itemType.toLowerCase().includes('compact')) {
    state.compactions += 1
  }

  if (itemType === 'Reasoning' || itemType === 'AgentMessage') {
    const interval: [number, number] = [startedAt, Math.max(startedAt, completedAt)]
    state.modelIntervals.push(interval)
    if (turnId) {
      const turn = getOrCreateTurn(state, turnId, startedAt)
      turn.modelIntervals.push(interval)
      if (turn.ttftApproxMs == null && turn.startedAt > 0) {
        turn.ttftApproxMs = Math.max(0, startedAt - turn.startedAt)
        state.approximateTtftSamples.push(turn.ttftApproxMs)
      }
    }
    return
  }

  if (isToolItem(itemType)) {
    const name = toolName(item)
    const kind = itemType
    const interval: [number, number] = [startedAt, Math.max(startedAt, completedAt)]
    const duration = interval[1] - interval[0]
    const failed = isFailedItem(item)
    state.toolIntervals.push(interval)
    if (turnId) {
      const turn = getOrCreateTurn(state, turnId, startedAt)
      turn.toolIntervals.push(interval)
      turn.toolCalls += 1
      const key = `${kind}:${name}`
      const tool = turn.tools.get(key) ?? {
        name,
        kind,
        calls: 0,
        durationMs: 0,
        failures: 0
      }
      tool.calls += 1
      tool.durationMs += duration
      if (failed) tool.failures += 1
      turn.tools.set(key, tool)
    }
  }
}

function consumeResponseItem(state: ParseState, item: JsonObject): void {
  const id = stringValue(item.id)
  if (id && state.seenMessageIds.has(id)) return
  if (id) state.seenMessageIds.add(id)

  const role = stringValue(item.role)
  const type = stringValue(item.type)
  const length = itemTextLength(item)
  if (role === 'developer' || role === 'system') {
    state.contextWeights.system += length
  } else {
    state.contextWeights.conversation += length
  }

  if (type === 'function_call' || type === 'custom_tool_call') {
    state.contextWeights.conversation += stringValue(item.arguments).length
  }
}

function getOrCreateTurn(state: ParseState, id: string, startedAt: number): MutableTurn {
  const existing = state.turns.get(id)
  if (existing) return existing
  const turn: MutableTurn = {
    id,
    startedAt: startedAt || state.updatedAt || Date.now(),
    completedAt: null,
    status: 'unknown',
    usage: { ...EMPTY_USAGE },
    requests: 0,
    toolCalls: 0,
    modelIntervals: [],
    toolIntervals: [],
    tools: new Map(),
    ttftExactMs: null,
    ttftApproxMs: null
  }
  state.turns.set(id, turn)
  return turn
}

function finalize(state: ParseState, metadata?: ThreadMetadata): ParsedSession {
  const now = Date.now()
  const turns = [...state.turns.values()]
    .map((turn) => finalizeTurn(turn, now))
    .sort((left, right) => left.startedAt - right.startedAt)

  if (turns.length === 0 && state.latestContextUsage.total > 0) {
    const startedAt = state.startedAt || metadata?.updatedAt || now
    turns.push({
      id: `${state.id}:session`,
      startedAt,
      completedAt: state.status === 'running' ? null : state.updatedAt || startedAt,
      durationMs: Math.max(0, (state.updatedAt || startedAt) - startedAt),
      ttftMs: null,
      status: state.status,
      requests: Math.max(1, state.tokenCountRecords),
      toolCalls: 0,
      usage: state.latestContextUsage,
      cacheHitRate: cacheHitRate(state.latestContextUsage),
      modelMs: 0,
      toolMs: 0,
      tps: null,
      tools: []
    })
  }

  const totalRequests = state.requestUsageRecords || state.tokenCountRecords
  const usage = tokenTotal(state.usage) > 0
    ? state.usage
    : turns.reduce((total, turn) => addUsage(total, turn.usage), { ...EMPTY_USAGE })
  const modelMs = unionDuration(state.modelIntervals)
  const toolMs = unionDuration(state.toolIntervals)
  const totalMs = turns.reduce((total, turn) => total + turn.durationMs, 0)
  const ttfts = state.exactTtftSamples.length
    ? state.exactTtftSamples
    : state.approximateTtftSamples
  const averageTtftMs = ttfts.length
    ? ttfts.reduce((total, value) => total + value, 0) / ttfts.length
    : null
  const contextUsed = tokenTotal(state.latestContextUsage)
  const contextWindow = state.contextWindow && state.contextWindow > 0 ? state.contextWindow : null
  const contextPercent =
    contextWindow && contextUsed > 0 ? Math.min(1, contextUsed / contextWindow) : null
  const contextBreakdown = estimateContextBreakdown(
    tokenTotal(state.latestContextUsage),
    state.contextWeights
  )
  const allTools = turns.flatMap((turn) => turn.tools)
  const longestTool = allTools
    .filter((tool) => tool.durationMs > 0)
    .sort((left, right) => right.durationMs - left.durationMs)[0]

  const summaryUsage: TokenUsage = {
    ...usage,
    uncachedInput: Math.max(0, usage.input - usage.cachedInput)
  }
  const latency: LatencyMetrics = {
    modelMs,
    toolMs,
    totalMs,
    averageTtftMs,
    tps: calculateTps(usage.output, modelMs) ??
      calculateTps(usage.output, Math.max(0, totalMs - toolMs)),
    longestTool: longestTool
      ? { name: longestTool.name, durationMs: longestTool.durationMs }
      : null
  }

  const isSubagent =
    state.isSubagent ||
    isSubagentSource(metadata?.source ?? '') ||
    /\/subagents?\//i.test(metadata?.cwd ?? '')

  return {
    snapshot: {
      id: state.id,
      title: cleanTitle(metadata?.title) || state.title,
      cwd: state.cwd || metadata?.cwd || '',
      projectName: projectName(state.cwd || metadata?.cwd || ''),
      model: state.model || metadata?.model || '未知模型',
      provider: state.provider || metadata?.provider || '未知提供方',
      reasoningEffort: state.reasoningEffort,
      status: state.status,
      startedAt: state.startedAt || turns[0]?.startedAt || state.updatedAt || now,
      updatedAt: Math.max(state.updatedAt, metadata?.updatedAt ?? 0),
      rounds: turns.length,
      steps: totalRequests,
      toolCalls: turns.reduce((total, turn) => total + turn.toolCalls, 0),
      compactions: state.compactions,
      usage: summaryUsage,
      cacheHitRate: cacheHitRate(summaryUsage),
      parentId: state.parentId,
      isSubagent,
      contextUsed,
      contextWindow,
      contextPercent,
      contextBreakdown,
      latency,
      approximateTiming: state.exactTtftSamples.length === 0
    },
    turns
  }
}

function finalizeTurn(turn: MutableTurn, now: number): TurnMetrics {
  const modelMs = unionDuration(turn.modelIntervals)
  const toolMs = unionDuration(turn.toolIntervals)
  const completedAt = turn.completedAt
  const durationMs =
    completedAt != null
      ? Math.max(0, completedAt - turn.startedAt)
      : Math.max(0, now - turn.startedAt)
  const usage = {
    ...turn.usage,
    uncachedInput: Math.max(0, turn.usage.input - turn.usage.cachedInput)
  }
  const tools: ToolMetric[] = [...turn.tools.values()].sort(
    (left, right) => right.durationMs - left.durationMs
  )
  return {
    id: turn.id,
    startedAt: turn.startedAt,
    completedAt,
    durationMs,
    ttftMs: turn.ttftExactMs ?? turn.ttftApproxMs,
    status: normalizeStatus(turn.status),
    requests: turn.requests,
    toolCalls: turn.toolCalls,
    usage,
    cacheHitRate: cacheHitRate(usage),
    modelMs,
    toolMs,
    tps: calculateTps(usage.output, modelMs) ??
      calculateTps(usage.output, Math.max(0, durationMs - toolMs)),
    tools
  }
}

function isToolItem(type: string): boolean {
  return [
    'CommandExecution',
    'FileChange',
    'McpToolCall',
    'WebSearch',
    'CollabAgentToolCall'
  ].includes(type)
}

function toolName(item: JsonObject): string {
  const type = stringValue(item.type)
  if (type === 'CommandExecution') return 'Shell'
  if (type === 'FileChange') return '文件修改'
  if (type === 'WebSearch') return '网页搜索'
  if (type === 'CollabAgentToolCall') return '协作代理'
  if (type === 'McpToolCall') {
    const server = stringValue(item.server)
    const tool = stringValue(item.tool)
    return [server, tool].filter(Boolean).join(' · ') || 'MCP 工具'
  }
  return type || '工具'
}

function isFailedItem(item: JsonObject): boolean {
  const status = stringValue(item.status).toLowerCase()
  const exitCode = numericValue(item.exit_code)
  return status === 'failed' || status === 'error' || (exitCode != null && exitCode !== 0)
}

function isSubagentSource(source: unknown): boolean {
  if (typeof source === 'string') return /subagent|thread_spawn/i.test(source)
  if (!source || typeof source !== 'object') return false
  return /subagent|thread_spawn/i.test(JSON.stringify(source))
}

function extractParentId(source: unknown): string | null {
  if (!source || typeof source !== 'object') return null
  const serialized = JSON.stringify(source)
  const match = serialized.match(/"parent_thread_id"\s*:\s*"([^"]+)"/)
  return match?.[1] ?? null
}

function extractSessionId(filePath: string): string {
  const matches = basename(filePath).match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
  )
  return matches?.[0] ?? basename(filePath, '.jsonl')
}

function cleanTitle(value: string | undefined): string {
  if (!value) return ''
  const firstLine = value.replace(/\s+/g, ' ').trim()
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine
}

function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) ?? '未分配项目'
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numericValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function toEpochMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1_000 : value
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function deepTextLength(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.reduce((total, item) => total + deepTextLength(item), 0)
  if (!value || typeof value !== 'object') return 0
  return Object.entries(value).reduce((total, [key, item]) => {
    if (/encrypt|blob|binary/i.test(key)) return total
    return total + deepTextLength(item)
  }, 0)
}

function itemTextLength(item: JsonObject): number {
  let length = 0
  if (Array.isArray(item.content)) {
    for (const block of item.content) {
      const value = objectValue(block)
      if (value) length += deepTextLength(value.text)
    }
  }
  if (Array.isArray(item.summary)) length += deepTextLength(item.summary)
  if (Array.isArray(item.raw_content)) length += deepTextLength(item.raw_content)
  if (typeof item.output === 'string') length += item.output.length
  return length
}

export type { ThreadMetadata }
