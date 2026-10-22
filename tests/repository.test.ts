import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSettings } from '../src/shared/contracts'
import { CodexRepository } from '../src/main/codex-repository'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Codex repository time filtering', () => {
  it('aggregates only turns inside the requested range for a long-lived session', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'better-codex-repository-'))
    cleanup.push(sandbox)
    const codexHome = join(sandbox, 'codex')
    const sessions = join(codexHome, 'sessions', '2026', '10', '22')
    await mkdir(sessions, { recursive: true })
    const sessionId = '01a30000-0000-7000-8000-000000000001'
    const dayOne = Date.parse('2026-10-21T10:00:00.000Z')
    const dayTwo = Date.parse('2026-10-22T10:00:00.000Z')
    await writeFile(
      join(sessions, `rollout-2026-10-21T10-00-00-${sessionId}.jsonl`),
      [
        sessionMeta(sessionId, dayOne),
        turnContext('turn-1', dayOne),
        taskStarted('turn-1', dayOne),
        item('reasoning-1', 'turn-1', dayOne + 100, dayOne + 400),
        usageRecord(sessionId, 'turn-1', dayOne + 1_000, 1_200, 1_200),
        tokenCount(dayOne + 1_001, 1_200, 1_200),
        taskComplete('turn-1', dayOne, dayOne + 2_000),
        turnContext('turn-2', dayTwo),
        taskStarted('turn-2', dayTwo),
        item('reasoning-2', 'turn-2', dayTwo + 100, dayTwo + 400),
        usageRecord(sessionId, 'turn-2', dayTwo + 1_000, 1_200, 2_400),
        tokenCount(dayTwo + 1_001, 1_200, 2_400),
        taskComplete('turn-2', dayTwo, dayTwo + 2_000)
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')
    )

    const repository = new CodexRepository(
      {
        home: codexHome,
        sessionDirectories: [join(codexHome, 'sessions')],
        stateDatabase: null,
        historyDatabase: null,
        globalState: join(codexHome, '.codex-global-state.json')
      },
      join(sandbox, 'metrics.sqlite3'),
      () => settings()
    )
    await repository.start()

    const filtered = repository.getHistory({
      from: Date.parse('2026-10-22T00:00:00.000Z'),
      to: Date.parse('2026-10-23T00:00:00.000Z'),
      includeSubagents: true
    })
    expect(filtered.sessions).toHaveLength(1)
    expect(filtered.overview.rounds).toBe(1)
    expect(filtered.overview.steps).toBe(1)
    expect(filtered.overview.totalTokens).toBe(1_200)
    expect(filtered.series).toHaveLength(1)
    expect(filtered.series[0]?.date).toBe('2026-10-22')

    const lifetime = repository.getHistory({ includeSubagents: true })
    expect(lifetime.overview.totalTokens).toBe(2_400)
    expect(lifetime.overview.rounds).toBe(2)
    repository.close()
  })
})

function sessionMeta(id: string, at: number): Record<string, unknown> {
  return {
    timestamp: new Date(at).toISOString(),
    type: 'session_meta',
    payload: {
      id,
      session_id: id,
      timestamp: new Date(at).toISOString(),
      cwd: '/tmp/demo',
      model_provider: 'openai'
    }
  }
}

function turnContext(turnId: string, at: number): Record<string, unknown> {
  return {
    timestamp: new Date(at).toISOString(),
    type: 'turn_context',
    payload: { turn_id: turnId, model: 'gpt-test', effort: 'high', cwd: '/tmp/demo' }
  }
}

function taskStarted(turnId: string, at: number): Record<string, unknown> {
  return {
    timestamp: new Date(at).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'task_started',
      turn_id: turnId,
      root_turn_id: turnId,
      started_at: new Date(at).toISOString(),
      model_context_window: 10_000
    }
  }
}

function item(
  id: string,
  turnId: string,
  startedAt: number,
  completedAt: number
): Record<string, unknown> {
  return {
    timestamp: new Date(completedAt).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: '01a30000-0000-7000-8000-000000000001',
      turn_id: turnId,
      started_at_ms: startedAt,
      completed_at_ms: completedAt,
      item: { id, type: 'Reasoning' }
    }
  }
}

function usageRecord(
  sessionId: string,
  turnId: string,
  at: number,
  perTurn: number,
  cumulative: number
): Record<string, unknown> {
  return {
    timestamp: new Date(at).toISOString(),
    type: 'token_usage_record',
    payload: {
      thread_id: sessionId,
      turn_id: turnId,
      root_turn_id: turnId,
      response_id: `response-${turnId}`,
      usage: usage(perTurn),
      turn_token_usage: usage(perTurn),
      thread_token_usage: usage(cumulative)
    }
  }
}

function tokenCount(at: number, lastTotal: number, cumulativeTotal: number): Record<string, unknown> {
  return {
    timestamp: new Date(at).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: usage(cumulativeTotal),
        last_token_usage: usage(lastTotal),
        model_context_window: 10_000
      }
    }
  }
}

function taskComplete(turnId: string, startedAt: number, completedAt: number): Record<string, unknown> {
  return {
    timestamp: new Date(completedAt).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: turnId,
      root_turn_id: turnId,
      started_at: new Date(startedAt).toISOString(),
      completed_at: new Date(completedAt).toISOString(),
      duration_ms: completedAt - startedAt,
      time_to_first_token_ms: 200
    }
  }
}

function usage(total: number): Record<string, number> {
  return {
    input_tokens: total - 200,
    cached_input_tokens: Math.floor((total - 200) * 0.5),
    cache_write_input_tokens: 0,
    output_tokens: 200,
    reasoning_output_tokens: 50,
    total_tokens: total
  }
}

function settings(): AppSettings {
  return {
    version: 1,
    onboardingComplete: true,
    notificationsEnabled: false,
    contextWarningPercent: 80,
    contextCriticalPercent: 95,
    dailyTokenBudget: null,
    monthlyTokenBudget: null,
    cacheHitMinimum: null,
    includeSubagents: true,
    dock: 'bottom-center',
    theme: 'dark',
    opacity: 0.96,
    launchAtLogin: false,
    notificationCooldownMinutes: 30,
    pinnedSessionId: null
  }
}
