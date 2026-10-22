import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import Database from 'better-sqlite3'

test('renders live, token and analysis surfaces from local fixture data', async () => {
  const { sandbox, codexHome, dataDirectory } = await prepareFixture()

  const electronApp = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      BETTER_CODEX_INFO_DATA_DIR: dataDirectory,
      BETTER_CODEX_INFO_FORCE_VISIBLE: '1'
    }
  })

  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByLabel('Codex 会话统计').getByText('E2E session')).toBeVisible()
    await expect(page.getByLabel('打开会话统计')).toBeVisible()

    await page.getByLabel('打开会话统计').click()
    await expect(page.getByRole('heading', { name: '会话统计' })).toBeVisible()
    await expect(page.getByText('首 Token 平均（TTFT）')).toBeVisible()
    await page.screenshot({
      path: join(process.cwd(), 'test-results', 'session-popover.png'),
      animations: 'disabled'
    })

    await page.getByLabel('打开 Token 用量').click()
    await expect(page.getByText('缓存读取')).toBeVisible()
    await expect(page.getByText('未缓存输入')).toBeVisible()

    await page.getByLabel('打开上下文信息').click()
    await expect(page.getByText('系统与开发者指令')).toBeVisible()
    await expect(page.getByText('工具定义')).toBeVisible()

    await page.evaluate("window.betterCodexInfo.setSurface('analysis')")
    await expect(page.getByRole('heading', { name: 'Better Codex Info' })).toBeVisible()
    await expect(page.getByRole('button', { name: '历史' })).toBeVisible()
    await page.getByRole('button', { name: '速度', exact: true }).click()
    await expect(page.getByRole('heading', { name: '每日加权输出速度' })).toBeVisible()
    await page.screenshot({
      path: join(process.cwd(), 'test-results', 'overview.png'),
      animations: 'disabled'
    })
    await page.getByRole('button', { name: '历史' }).click()
    await expect(
      page.getByRole('region', { name: 'Better Codex Info 分析中心' }).getByText('E2E session')
    ).toBeVisible()

    await page.screenshot({
      path: join(process.cwd(), 'test-results', 'analysis-center.png'),
      animations: 'disabled'
    })
  } finally {
    await electronApp.close()
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('packaged Windows application starts with bundled native dependencies', async () => {
  const executablePath = join(
    process.cwd(),
    'release',
    'win-unpacked',
    'Better Codex Info.exe'
  )
  test.skip(!existsSync(executablePath), 'Windows package has not been built')

  const { sandbox, codexHome, dataDirectory } = await prepareFixture()
  const electronApp = await electron.launch({
    executablePath,
    args: [],
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      BETTER_CODEX_INFO_DATA_DIR: dataDirectory,
      BETTER_CODEX_INFO_FORCE_VISIBLE: '1'
    }
  })

  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByLabel('Codex 会话统计').getByText('E2E session')).toBeVisible()
    await expect(page.getByLabel('打开 Token 用量')).toBeVisible()
    await page.evaluate("window.betterCodexInfo.setSurface('analysis')")
    await expect(page.getByRole('heading', { name: 'Better Codex Info' })).toBeVisible()
  } finally {
    await electronApp.close()
    await rm(sandbox, { recursive: true, force: true })
  }
})

async function prepareFixture(): Promise<{
  sandbox: string
  codexHome: string
  dataDirectory: string
}> {
  const sandbox = await mkdtemp(join(tmpdir(), 'better-codex-info-e2e-'))
  const codexHome = join(sandbox, 'codex')
  const dataDirectory = join(sandbox, 'data')
  const sessionsDirectory = join(codexHome, 'sessions', '2026', '10', '22')
  await mkdir(sessionsDirectory, { recursive: true })
  await mkdir(dataDirectory, { recursive: true })
  await writeFile(
    join(dataDirectory, 'settings.json'),
    JSON.stringify(
      {
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
      },
      null,
      2
    )
  )
  await writeFile(
    join(
      sessionsDirectory,
      'rollout-2026-10-22T08-00-00-01a20000-0000-7000-8000-000000000010.jsonl'
    ),
    fixture()
  )
  const database = new Database(join(codexHome, 'state_5.sqlite'))
  database.exec(`
    create table threads (
      id text primary key,
      title text not null,
      cwd text not null,
      model text,
      model_provider text not null,
      source text not null,
      updated_at_ms integer not null
    );
    create table thread_dynamic_tools (
      thread_id text,
      name text,
      description text,
      input_schema text
    );
  `)
  database
    .prepare(
      'insert into threads (id, title, cwd, model, model_provider, source, updated_at_ms) values (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      '01a20000-0000-7000-8000-000000000010',
      'E2E session',
      'D:\\Code\\Demo',
      'gpt-test',
      'openai',
      'vscode',
      Date.parse('2026-10-22T08:00:04.000Z')
    )
  database.close()
  return { sandbox, codexHome, dataDirectory }
}

function fixture(): string {
  const start = Date.parse('2026-10-22T08:00:01.000Z')
  const records = [
    {
      timestamp: '2026-10-22T08:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: '01a20000-0000-7000-8000-000000000010',
        session_id: '01a20000-0000-7000-8000-000000000010',
        timestamp: '2026-10-22T08:00:00.000Z',
        cwd: 'D:\\Code\\Demo',
        model_provider: 'openai',
        base_instructions: { text: 'system instructions for the fixture' }
      }
    },
    {
      timestamp: '2026-10-22T08:00:01.000Z',
      type: 'turn_context',
      payload: {
        turn_id: 'turn-e2e',
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
        turn_id: 'turn-e2e',
        root_turn_id: 'turn-e2e',
        started_at: '2026-10-22T08:00:01.000Z',
        model_context_window: 10_000
      }
    },
    {
      timestamp: '2026-10-22T08:00:01.010Z',
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'developer-e2e',
        role: 'developer',
        content: [{ type: 'text', text: 'Use local data only.' }]
      }
    },
    {
      timestamp: '2026-10-22T08:00:01.020Z',
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'user-e2e',
        role: 'user',
        content: [{ type: 'text', text: 'Show a realistic session.' }]
      }
    },
    item('reasoning-e2e', 'Reasoning', start + 100, start + 400),
    item('answer-e2e', 'AgentMessage', start + 400, start + 1_000),
    item('tool-e2e', 'CommandExecution', start + 1_000, start + 1_800, {
      status: 'completed',
      exit_code: 0
    }),
    {
      timestamp: '2026-10-22T08:00:03.000Z',
      type: 'token_usage_record',
      payload: {
        thread_id: '01a20000-0000-7000-8000-000000000010',
        turn_id: 'turn-e2e',
        root_turn_id: 'turn-e2e',
        response_id: 'response-e2e',
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
        turn_id: 'turn-e2e',
        root_turn_id: 'turn-e2e',
        started_at: '2026-10-22T08:00:01.000Z',
        completed_at: '2026-10-22T08:00:04.000Z',
        duration_ms: 3_000,
        time_to_first_token_ms: 350
      }
    }
  ]
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

function item(
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
      thread_id: '01a20000-0000-7000-8000-000000000010',
      turn_id: 'turn-e2e',
      started_at_ms: startedAtMs,
      completed_at_ms: completedAtMs,
      item: { id, type, ...extra }
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
