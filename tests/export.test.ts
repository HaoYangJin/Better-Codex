import { describe, expect, it } from 'vitest'
import { serializeCsv } from '../src/main/export'
import { EMPTY_USAGE } from '../src/shared/metrics'
import type { SessionSummary, TurnMetrics } from '../src/shared/contracts'

describe('CSV export', () => {
  it('neutralizes spreadsheet formulas in session and project labels', () => {
    const session: SessionSummary = {
      id: 'session-1',
      title: '=HYPERLINK("https://example.com","open")',
      cwd: 'D:\\Demo',
      projectName: ' +SUM(1,2)',
      model: 'gpt-test',
      provider: 'openai',
      reasoningEffort: 'high',
      status: 'completed',
      startedAt: 1,
      updatedAt: 2,
      rounds: 1,
      steps: 1,
      toolCalls: 0,
      compactions: 0,
      usage: { ...EMPTY_USAGE, input: 10, output: 2, total: 12 },
      cacheHitRate: 0,
      parentId: null,
      isSubagent: false
    }
    const turn: TurnMetrics & { sessionId: string } = {
      id: 'turn-1',
      sessionId: session.id,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1_000,
      ttftMs: 200,
      status: 'completed',
      requests: 1,
      toolCalls: 0,
      usage: session.usage,
      cacheHitRate: 0,
      modelMs: 500,
      toolMs: 0,
      tps: 4,
      tools: []
    }

    const csv = serializeCsv({
      overview: {
        sessions: 1,
        rounds: 1,
        steps: 1,
        toolCalls: 0,
        totalTokens: 12,
        inputTokens: 10,
        cachedInput: 0,
        outputTokens: 2,
        reasoningOutput: 0,
        cacheHitRate: 0,
        averageTtftMs: 200,
        tps: 4,
        modelMs: 500,
        toolMs: 0,
        activeDays: 1
      },
      sessions: [session],
      series: [],
      turns: [turn]
    })

    expect(csv).toContain(`\"'=HYPERLINK`)
    expect(csv).toContain(`\"' +SUM(1,2)\"`)
    expect(csv).not.toContain(`,=HYPERLINK`)
  })
})
