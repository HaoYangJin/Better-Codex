import type {
  ContextBreakdown,
  LatencyMetrics,
  SessionStatus,
  TokenUsage
} from './contracts'

export const EMPTY_USAGE: TokenUsage = {
  input: 0,
  cachedInput: 0,
  cacheWriteInput: 0,
  uncachedInput: 0,
  output: 0,
  reasoningOutput: 0,
  total: 0
}

type UnknownRecord = Record<string, unknown>

const numberValue = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0

export function normalizeUsage(value: unknown): TokenUsage {
  const source = value && typeof value === 'object' ? (value as UnknownRecord) : {}
  const input = numberValue(source.input_tokens ?? source.inputTokens)
  const cachedInput = Math.min(input, numberValue(source.cached_input_tokens ?? source.cachedInputTokens))
  const cacheWriteInput = numberValue(
    source.cache_write_input_tokens ?? source.cacheWriteInputTokens
  )
  const output = numberValue(source.output_tokens ?? source.outputTokens)
  const reasoningOutput = Math.min(
    output,
    numberValue(source.reasoning_output_tokens ?? source.reasoningOutputTokens)
  )
  const explicitTotal = numberValue(source.total_tokens ?? source.totalTokens)

  return {
    input,
    cachedInput,
    cacheWriteInput,
    uncachedInput: Math.max(0, input - cachedInput),
    output,
    reasoningOutput,
    total: explicitTotal || input + output
  }
}

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const result = {
    input: left.input + right.input,
    cachedInput: left.cachedInput + right.cachedInput,
    cacheWriteInput: left.cacheWriteInput + right.cacheWriteInput,
    uncachedInput: 0,
    output: left.output + right.output,
    reasoningOutput: left.reasoningOutput + right.reasoningOutput,
    total: left.total + right.total
  }
  result.uncachedInput = Math.max(0, result.input - result.cachedInput)
  return result
}

export function cacheHitRate(usage: TokenUsage): number | null {
  if (usage.input <= 0) return null
  return Math.max(0, Math.min(1, usage.cachedInput / usage.input))
}

export function unionDuration(intervals: ReadonlyArray<readonly [number, number]>): number {
  const valid = intervals
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start)
    .sort((left, right) => left[0] - right[0])

  let total = 0
  let currentStart: number | null = null
  let currentEnd: number | null = null

  for (const [start, end] of valid) {
    if (currentStart == null || currentEnd == null) {
      currentStart = start
      currentEnd = end
      continue
    }
    if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end)
    } else {
      total += currentEnd - currentStart
      currentStart = start
      currentEnd = end
    }
  }

  if (currentStart != null && currentEnd != null) total += currentEnd - currentStart
  return total
}

export function calculateTps(outputTokens: number, modelDurationMs: number): number | null {
  if (outputTokens <= 0 || modelDurationMs <= 0) return null
  return outputTokens / (modelDurationMs / 1000)
}

export function weightedAverage(
  values: ReadonlyArray<{ value: number | null; weight: number }>
): number | null {
  let numerator = 0
  let denominator = 0
  for (const item of values) {
    if (item.value == null || item.weight <= 0) continue
    numerator += item.value * item.weight
    denominator += item.weight
  }
  return denominator > 0 ? numerator / denominator : null
}

export function estimateContextBreakdown(
  usedTokens: number,
  weights: { system: number; tools: number; conversation: number }
): ContextBreakdown {
  const system = Math.max(0, weights.system)
  const tools = Math.max(0, weights.tools)
  const conversation = Math.max(0, weights.conversation)
  const weightTotal = system + tools + conversation

  if (usedTokens <= 0 || weightTotal <= 0) {
    return {
      system: 0,
      tools: 0,
      conversation: 0,
      other: Math.max(0, usedTokens),
      estimated: true
    }
  }

  const systemTokens = Math.round((system / weightTotal) * usedTokens)
  const toolTokens = Math.round((tools / weightTotal) * usedTokens)
  const conversationTokens = Math.max(0, usedTokens - systemTokens - toolTokens)

  return {
    system: systemTokens,
    tools: toolTokens,
    conversation: conversationTokens,
    other: 0,
    estimated: true
  }
}

export function emptyLatency(): LatencyMetrics {
  return {
    modelMs: 0,
    toolMs: 0,
    totalMs: 0,
    averageTtftMs: null,
    tps: null,
    longestTool: null
  }
}

export function normalizeStatus(value: unknown): SessionStatus {
  switch (String(value ?? '').toLowerCase()) {
    case 'completed':
    case 'complete':
    case 'success':
      return 'completed'
    case 'running':
    case 'inprogress':
    case 'in_progress':
    case 'in-progress':
      return 'running'
    case 'interrupted':
    case 'aborted':
      return 'interrupted'
    case 'failed':
    case 'error':
      return 'failed'
    default:
      return 'unknown'
  }
}

export function tokenTotal(usage: TokenUsage): number {
  return usage.total || usage.input + usage.output
}
