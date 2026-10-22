import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseSessionFile } from '../src/main/session-parser'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('session parser', () => {
  it('extracts token, latency, tool, context and completion metrics', async () => {
    const turnStart = Date.parse('2026-10-22T08:00:01.000Z')
    const path = await fixture([
      {
        timestamp: '2026-10-22T08:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: '01a20000-0000-7000-8000-000000000001',
          session_id: '01a20000-0000-7000-8000-000000000001',
          timestamp: '2026-10-22T08:00:00.000Z',
          cwd: 'D:\\Code\\Demo',
          model_provider: 'openai',
          base_instructions: { text: 'system instruction' }
        }
      },
      {
        timestamp: '2026-10-22T08:00:01.000Z',
        type: 'turn_context',
        payload: {
          turn_id: 'turn-1',
          model: 'gpt-test',
          effort: 'high',
          cwd: 'D:\\Code\\Demo'
        }
      },
      {
        timestamp: '2026-10-22T08:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-1',
          root_turn_id: 'turn-1',
          started_at: '2026-10-22T08:00:01.000Z',
          model_context_window: 10_000
        }
      },
      {
        timestamp: '2026-10-22T08:00:01.010Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'developer-1',
          role: 'developer',
          content: [{ type: 'text', text: 'developer context' }]
        }
      },
      {
        timestamp: '2026-10-22T08:00:01.020Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'user-1',
          role: 'user',
          content: [{ type: 'text', text: 'Please inspect this project.' }]
        }
      },
      itemCompleted('reasoning-1', 'Reasoning', turnStart + 100, turnStart + 400),
      itemCompleted('answer-1', 'AgentMessage', turnStart + 400, turnStart + 1_000),
      itemCompleted('tool-1', 'CommandExecution', turnStart + 1_000, turnStart + 1_800, {
        status: 'completed',
        exit_code: 0
      }),
      {
        timestamp: '2026-10-22T08:00:03.000Z',
        type: 'token_usage_record',
        payload: {
          thread_id: '01a20000-0000-7000-8000-000000000001',
          turn_id: 'turn-1',
          root_turn_id: 'turn-1',
          response_id: 'response-1',
          usage: usage(),
          thread_token_usage: usage()
        }
      },
      {
        timestamp: '2026-10-22T08:00:03.001Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: usage(),
            last_token_usage: usage(),
            model_context_window: 10_000
          }
        }
      },
      {
        timestamp: '2026-10-22T08:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-1',
          root_turn_id: 'turn-1',
          started_at: '2026-10-22T08:00:01.000Z',
          completed_at: '2026-10-22T08:00:04.000Z',
          duration_ms: 3_000,
          time_to_first_token_ms: 350
        }
      }
    ])

    const result = await parseSessionFile(path, {
      title: 'Parser fixture',
      cwd: 'D:\\Code\\Demo',
      model: 'gpt-test',
      provider: 'openai',
      source: 'vscode',
      updatedAt: Date.parse('2026-10-22T08:00:04.000Z'),
      toolDefinitionCharacters: 100
    })

    expect(result.snapshot.title).toBe('Parser fixture')
    expect(result.snapshot.rounds).toBe(1)
    expect(result.snapshot.steps).toBe(1)
    expect(result.snapshot.toolCalls).toBe(1)
    expect(result.snapshot.usage.total).toBe(1_200)
    expect(result.snapshot.usage.uncachedInput).toBe(250)
    expect(result.snapshot.cacheHitRate).toBe(0.75)
    expect(result.snapshot.contextUsed).toBe(1_200)
    expect(result.snapshot.contextWindow).toBe(10_000)
    expect(result.snapshot.contextPercent).toBe(0.12)
    expect(result.snapshot.latency.modelMs).toBe(900)
    expect(result.snapshot.latency.toolMs).toBe(800)
    expect(result.snapshot.latency.averageTtftMs).toBe(350)
    expect(result.snapshot.latency.tps).toBeCloseTo(222.22, 1)
    expect(result.snapshot.latency.longestTool?.name).toBe('Shell')
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]?.status).toBe('completed')
  })

  it('ignores malformed lines and duplicate response items', async () => {
    const path = await fixture([
      {
        timestamp: '2026-10-22T09:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: '01a20000-0000-7000-8000-000000000002',
          session_id: '01a20000-0000-7000-8000-000000000002',
          timestamp: '2026-10-22T09:00:00.000Z',
          cwd: '/tmp/demo'
        }
      },
      '{not-json',
      {
        timestamp: '2026-10-22T09:00:00.010Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'same-id',
          role: 'user',
          content: [{ type: 'text', text: 'duplicate' }]
        }
      },
      {
        timestamp: '2026-10-22T09:00:00.020Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'same-id',
          role: 'user',
          content: [{ type: 'text', text: 'duplicate' }]
        }
      },
      {
        timestamp: '2026-10-22T09:00:00.030Z',
        type: 'unexpected_future_event',
        payload: { arbitrary: true }
      }
    ])

    const result = await parseSessionFile(path)
    expect(result.snapshot.title).toBe('未命名会话')
    expect(result.snapshot.id).toBe('01a20000-0000-7000-8000-000000000002')
    expect(result.snapshot.rounds).toBe(0)
    expect(result.snapshot.usage.total).toBe(0)
  })
})

function itemCompleted(
  id: string,
  type: string,
  startedAtMs: number,
  completedAtMs: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    timestamp: new Date(completedAtMs).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: '01a20000-0000-7000-8000-000000000001',
      turn_id: 'turn-1',
      started_at_ms: startedAtMs,
      completed_at_ms: completedAtMs,
      item: {
        id,
        type,
        ...extra
      }
    }
  }
}

function usage(): Record<string, number> {
  return {
    input_tokens: 1_000,
    cached_input_tokens: 750,
    cache_write_input_tokens: 0,
    output_tokens: 200,
    reasoning_output_tokens: 80,
    total_tokens: 1_200
  }
}

async function fixture(entries: unknown[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'better-codex-info-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'rollout-2026-10-22T08-00-00-fixture.jsonl')
  await writeFile(path, `${entries.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n')}\n`)
  return path
}
