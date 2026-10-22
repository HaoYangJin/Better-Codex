import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  BarChart3,
  Bell,
  Clock3,
  Database,
  Download,
  Pin,
  PinOff,
  Search,
  Settings2,
  SlidersHorizontal,
  Wrench,
  X,
  Zap
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type {
  AnalyticsOverview,
  AnalyticsPayload,
  AppSettings,
  ContextBreakdown,
  HistoryFilter,
  SessionSnapshot,
  SessionSummary,
  SeriesPoint,
  TurnMetrics
} from '@shared/contracts'
import {
  formatDuration,
  formatPercent,
  formatSpeed,
  formatTime,
  formatTokens
} from '@shared/format'

type Tab = 'overview' | 'current' | 'history' | 'settings'

interface AnalysisCenterProps {
  snapshot: SessionSnapshot | null
  settings: AppSettings
  overview: AnalyticsOverview
  series: SeriesPoint[]
  sessions: SessionSummary[]
  warnings: { code: string; message: string }[]
  indexing: boolean
  codexHome: string
  initialTab?: Tab
  onClose: () => void
  onSettings: (settings: AppSettings) => void
  onSnapshot: (snapshot: SessionSnapshot | null) => void
}

export function AnalysisCenter({
  snapshot,
  settings,
  overview: initialOverview,
  series: initialSeries,
  sessions: initialSessions,
  warnings,
  indexing,
  codexHome,
  initialTab = 'overview',
  onClose,
  onSettings,
  onSnapshot
}: AnalysisCenterProps) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [selectedId, setSelectedId] = useState(snapshot?.id ?? '')
  const [turns, setTurns] = useState<TurnMetrics[]>([])
  const [analytics, setAnalytics] = useState<AnalyticsPayload>({
    overview: initialOverview,
    series: initialSeries,
    sessions: initialSessions
  })
  const [rangeDays, setRangeDays] = useState(30)
  const [project, setProject] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [sessionKind, setSessionKind] = useState<'all' | 'main' | 'subagent'>('all')
  const [search, setSearch] = useState('')

  const projects = useMemo(
    () => unique(analytics.sessions.map((session) => session.projectName)),
    [analytics.sessions]
  )
  const models = useMemo(
    () => unique(analytics.sessions.map((session) => session.model)),
    [analytics.sessions]
  )
  const efforts = useMemo(
    () => unique(analytics.sessions.map((session) => session.reasoningEffort)),
    [analytics.sessions]
  )

  useEffect(() => {
    setTab(initialTab)
  }, [initialTab])

  useEffect(() => {
    if (snapshot?.id && !selectedId) setSelectedId(snapshot.id)
  }, [selectedId, snapshot?.id])

  useEffect(() => {
    const from =
      rangeDays > 0 ? Date.now() - rangeDays * 24 * 60 * 60 * 1_000 : undefined
    const filter: HistoryFilter = {
      from,
      project: project || undefined,
      model: model || undefined,
      reasoningEffort: effort || undefined,
      sessionKind,
      search: search.trim() || undefined,
      includeSubagents: settings.includeSubagents,
      limit: 2_000
    }
    let alive = true
    const timer = window.setTimeout(() => {
      void window.betterCodexInfo.queryHistory(filter).then((result) => {
        if (alive) setAnalytics(result)
      })
    }, 180)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [effort, indexing, model, project, rangeDays, search, sessionKind, settings.includeSubagents])

  useEffect(() => {
    const sessionId = selectedId || snapshot?.id
    if (!sessionId) {
      setTurns([])
      return
    }
    let alive = true
    void window.betterCodexInfo.queryTurns(sessionId).then((items) => {
      if (alive) setTurns(items)
    })
    return () => {
      alive = false
    }
  }, [selectedId, snapshot?.id, snapshot?.updatedAt])

  const selectedSession =
    analytics.sessions.find((session) => session.id === (selectedId || snapshot?.id)) ?? snapshot

  const pinSelected = async (): Promise<void> => {
    const target = selectedId || snapshot?.id
    if (!target) return
    const nextPinned = settings.pinnedSessionId === target ? null : target
    const next = await window.betterCodexInfo.pinSession(nextPinned)
    onSettings(next)
    if (nextPinned) {
      const updated = await window.betterCodexInfo.querySnapshot(target)
      onSnapshot(updated)
    } else {
      onSnapshot(await window.betterCodexInfo.querySnapshot())
    }
  }

  const exportData = async (format: 'csv' | 'json'): Promise<void> => {
    const from =
      rangeDays > 0 ? Date.now() - rangeDays * 24 * 60 * 60 * 1_000 : undefined
    await window.betterCodexInfo.exportData({
      format,
      filter: {
        from,
        project: project || undefined,
        model: model || undefined,
        reasoningEffort: effort || undefined,
        sessionKind,
        search: search.trim() || undefined,
        includeSubagents: settings.includeSubagents,
        limit: 10_000
      }
    })
  }

  return (
    <section className="analysis-shell" aria-label="Better Codex Info 分析中心">
      <header className="analysis-header">
        <div className="brand-lockup">
          <span className="brand-mark">
            <BarChart3 size={17} />
          </span>
          <div>
            <h1>Better Codex Info</h1>
            <p>本机会话洞察 · 不上传对话内容</p>
          </div>
        </div>
        <div className="analysis-header-actions">
          <span className={`sync-state ${indexing ? 'is-busy' : ''}`}>
            <i />
            {indexing ? '正在更新索引' : '数据已就绪'}
          </span>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭分析中心">
            <X size={17} />
          </button>
        </div>
      </header>

      <div className="analysis-toolbar">
        <nav className="tab-list" aria-label="分析页面">
          <TabButton active={tab === 'overview'} onClick={() => setTab('overview')} icon={<Activity size={14} />}>
            总览
          </TabButton>
          <TabButton active={tab === 'current'} onClick={() => setTab('current')} icon={<Zap size={14} />}>
            当前会话
          </TabButton>
          <TabButton active={tab === 'history'} onClick={() => setTab('history')} icon={<Clock3 size={14} />}>
            历史
          </TabButton>
          <TabButton active={tab === 'settings'} onClick={() => setTab('settings')} icon={<SlidersHorizontal size={14} />}>
            设置
          </TabButton>
        </nav>
        <div className="filter-bar">
          <label className="search-field">
            <Search size={14} />
            <input
              aria-label="搜索会话"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索会话"
            />
          </label>
          <select aria-label="时间范围" value={rangeDays} onChange={(event) => setRangeDays(Number(event.target.value))}>
            <option value={7}>近 7 天</option>
            <option value={30}>近 30 天</option>
            <option value={90}>近 90 天</option>
            <option value={0}>全部</option>
          </select>
          <select aria-label="项目筛选" value={project} onChange={(event) => setProject(event.target.value)}>
            <option value="">全部项目</option>
            {projects.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <select aria-label="模型筛选" value={model} onChange={(event) => setModel(event.target.value)}>
            <option value="">全部模型</option>
            {models.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <select aria-label="推理强度筛选" value={effort} onChange={(event) => setEffort(event.target.value)}>
            <option value="">全部强度</option>
            {efforts.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <select
            aria-label="会话类型筛选"
            value={sessionKind}
            onChange={(event) =>
              setSessionKind(event.target.value as 'all' | 'main' | 'subagent')
            }
          >
            <option value="all">全部会话</option>
            <option value="main">仅主会话</option>
            <option value="subagent">仅子代理</option>
          </select>
        </div>
      </div>

      <main className="analysis-content">
        {tab === 'overview' ? (
          <Overview
            overview={analytics.overview}
            series={analytics.series}
            sessions={analytics.sessions}
            onSelect={(sessionId) => {
              setSelectedId(sessionId)
              setTab('current')
            }}
          />
        ) : null}
        {tab === 'current' ? (
          <CurrentSession
            session={selectedSession}
            turns={turns}
            pinned={settings.pinnedSessionId === (selectedId || snapshot?.id)}
            onPin={pinSelected}
          />
        ) : null}
        {tab === 'history' ? (
          <HistoryTable
            sessions={analytics.sessions}
            selectedId={selectedId || snapshot?.id}
            onSelect={(sessionId) => {
              setSelectedId(sessionId)
              setTab('current')
            }}
            onExport={exportData}
          />
        ) : null}
        {tab === 'settings' ? (
          <SettingsPanel
            settings={settings}
            codexHome={codexHome}
            warnings={warnings}
            onSettings={onSettings}
            onExport={exportData}
          />
        ) : null}
      </main>
    </section>
  )
}

function Overview({
  overview,
  series,
  sessions,
  onSelect
}: {
  overview: AnalyticsOverview
  series: SeriesPoint[]
  sessions: SessionSummary[]
  onSelect: (sessionId: string) => void
}) {
  const [metric, setMetric] = useState<'tokens' | 'cache' | 'speed' | 'tools'>('tokens')
  const titles = {
    tokens: ['Token 趋势', '每日用量与缓存输入'],
    cache: ['缓存趋势', '每日缓存命中率'],
    speed: ['速度趋势', '每日加权输出速度'],
    tools: ['工具趋势', '每日工具调用耗时']
  } as const
  const chartData = useMemo(
    () =>
      series.map((point) => ({
        ...point,
        cacheHitPercent: point.cacheHitRate == null ? 0 : point.cacheHitRate * 100
      })),
    [series]
  )

  return (
    <div className="overview-grid">
      <section className="metric-cards">
        <Kpi label="累计 Token" value={formatTokens(overview.totalTokens)} detail={`${overview.sessions} 个会话`} />
        <Kpi label="缓存命中" value={formatPercent(overview.cacheHitRate, 1)} detail={`${formatTokens(overview.cachedInput)} 缓存读取`} />
        <Kpi label="平均 TTFT" value={formatDuration(overview.averageTtftMs)} detail="按模型请求加权" />
        <Kpi label="输出速度" value={formatSpeed(overview.tps)} detail={`${overview.steps} 次请求`} />
        <Kpi label="模型用时" value={formatDuration(overview.modelMs)} detail={`${overview.rounds} 轮`} />
        <Kpi label="工具用时" value={formatDuration(overview.toolMs)} detail={`${overview.toolCalls} 次调用`} />
      </section>

      <section className="chart-card">
        <div className="section-title">
          <div>
            <p className="eyebrow">{titles[metric][0]}</p>
            <h2>{titles[metric][1]}</h2>
          </div>
          <div className="chart-metric-tabs" aria-label="趋势指标">
            {(
              [
                ['tokens', 'Token'],
                ['cache', '缓存'],
                ['speed', '速度'],
                ['tools', '工具']
              ] as const
            ).map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={metric === value ? 'is-active' : ''}
                onClick={() => setMetric(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {series.length ? (
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 12, right: 10, left: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="totalFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#8fa9ff" stopOpacity={0.32} />
                    <stop offset="100%" stopColor="#8fa9ff" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,.06)" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: '#8d919a', fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fill: '#8d919a', fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  domain={metric === 'cache' ? [0, 100] : undefined}
                  tickFormatter={(value: number) => formatChartAxis(value, metric)}
                />
                <Tooltip
                  content={<ChartTooltip metric={metric} />}
                  cursor={{ stroke: 'rgba(255,255,255,.16)' }}
                />
                {metric === 'tokens' ? (
                  <>
                    <Area
                      type="monotone"
                      dataKey="totalTokens"
                      name="总 Token"
                      stroke="#8fa9ff"
                      strokeWidth={1.8}
                      fill="url(#totalFill)"
                    />
                    <Area
                      type="monotone"
                      dataKey="cachedInput"
                      name="缓存读取"
                      stroke="#5ac8a8"
                      strokeWidth={1.4}
                      fill="transparent"
                    />
                  </>
                ) : null}
                {metric === 'cache' ? (
                  <Area
                    type="monotone"
                    dataKey="cacheHitPercent"
                    name="缓存命中率"
                    stroke="#5ac8a8"
                    strokeWidth={1.8}
                    fill="url(#totalFill)"
                  />
                ) : null}
                {metric === 'speed' ? (
                  <Area
                    type="monotone"
                    dataKey="tps"
                    name="输出速度"
                    stroke="#d7a05c"
                    strokeWidth={1.8}
                    fill="url(#totalFill)"
                  />
                ) : null}
                {metric === 'tools' ? (
                  <Area
                    type="monotone"
                    dataKey="toolMs"
                    name="工具耗时"
                    stroke="#b58cdf"
                    strokeWidth={1.8}
                    fill="url(#totalFill)"
                  />
                ) : null}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <EmptyState text="还没有可绘制的历史数据" />
        )}
      </section>

      <section className="recent-card">
        <div className="section-title">
          <div>
            <p className="eyebrow">最近会话</p>
            <h2>继续查看明细</h2>
          </div>
        </div>
        <div className="compact-session-list">
          {sessions.slice(0, 5).map((session) => (
            <button type="button" key={session.id} onClick={() => onSelect(session.id)}>
              <span className="session-list-main">
                <strong>{session.title}</strong>
                <small>
                  {session.projectName} · {session.model}
                </small>
              </span>
              <span className="session-list-side">
                <strong>{formatTokens(session.usage.total)}</strong>
                <small>{formatTime(session.updatedAt)}</small>
              </span>
            </button>
          ))}
          {sessions.length === 0 ? <EmptyState text="未发现本地会话" compact /> : null}
        </div>
      </section>
    </div>
  )
}

function CurrentSession({
  session,
  turns,
  pinned,
  onPin
}: {
  session: SessionSnapshot | SessionSummary | null
  turns: TurnMetrics[]
  pinned: boolean
  onPin: () => void
}) {
  if (!session) return <EmptyState text="暂无可显示的会话" />
  const context =
    'contextBreakdown' in session ? session.contextBreakdown : null
  return (
    <div className="current-grid">
      <section className="session-hero">
        <div>
          <p className="eyebrow">{pinned ? '已固定会话' : '最近活动会话'}</p>
          <h2>{session.title}</h2>
          <p>
            {session.projectName} · {session.model} {session.reasoningEffort ? `· ${session.reasoningEffort}` : ''}
            {session.compactions > 0 ? ` · 已压缩 ${session.compactions} 次` : ''}
          </p>
        </div>
        <button type="button" className="secondary-button" onClick={onPin}>
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}
          {pinned ? '取消固定' : '固定会话'}
        </button>
      </section>

      <section className="metric-cards current-kpis">
        <Kpi label="累计 Token" value={formatTokens(session.usage.total)} detail={`输入 ${formatTokens(session.usage.input)}`} />
        <Kpi label="缓存命中" value={formatPercent(session.cacheHitRate, 1)} detail={`${formatTokens(session.usage.cachedInput)} 命中`} />
        <Kpi label="轮次 / 步骤" value={`${session.rounds} / ${session.steps}`} detail={`${session.toolCalls} 次工具`} />
        <Kpi label="上下文" value={formatPercent(
          'contextPercent' in session ? session.contextPercent : null,
          1
        )} detail={`${'contextUsed' in session ? formatTokens(session.contextUsed) : '—'} tok`} />
      </section>

      {context ? <ContextComposition breakdown={context} /> : null}
      <ToolDistribution turns={turns} />

      <section className="turn-card">
        <div className="section-title">
          <div>
            <p className="eyebrow">逐轮明细</p>
            <h2>速度、Token 与工具耗时</h2>
          </div>
          <span>{turns.length} 轮</span>
        </div>
        <div className="turn-table-wrap">
          <table>
            <thead>
              <tr>
                <th>开始时间</th>
                <th>状态</th>
                <th>TTFT</th>
                <th>TPS</th>
                <th>Token</th>
                <th>工具</th>
              </tr>
            </thead>
            <tbody>
              {turns
                .slice()
                .reverse()
                .map((turn) => (
                  <tr key={turn.id}>
                    <td>{formatTime(turn.startedAt)}</td>
                    <td>
                      <span className={`status-label status-${turn.status}`}>{turn.status === 'running' ? '进行中' : turn.status === 'completed' ? '已完成' : '已结束'}</span>
                    </td>
                    <td>{formatDuration(turn.ttftMs)}</td>
                    <td>{formatSpeed(turn.tps)}</td>
                    <td>{formatTokens(turn.usage.total)}</td>
                    <td>{turn.toolCalls} 次 · {formatDuration(turn.toolMs)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {turns.length === 0 ? <EmptyState text="该会话没有可用的逐轮统计" compact /> : null}
        </div>
      </section>
    </div>
  )
}

function HistoryTable({
  sessions,
  selectedId,
  onSelect,
  onExport
}: {
  sessions: SessionSummary[]
  selectedId?: string
  onSelect: (sessionId: string) => void
  onExport: (format: 'csv' | 'json') => Promise<void>
}) {
  return (
    <section className="history-card">
      <div className="section-title">
        <div>
          <p className="eyebrow">本地历史</p>
          <h2>{sessions.length} 个会话</h2>
        </div>
        <div className="button-group">
          <button type="button" className="secondary-button" onClick={() => void onExport('csv')}>
            <Download size={14} /> CSV
          </button>
          <button type="button" className="secondary-button" onClick={() => void onExport('json')}>
            <Download size={14} /> JSON
          </button>
        </div>
      </div>
      <div className="history-table-wrap">
        <table>
          <thead>
            <tr>
              <th>会话</th>
              <th>项目</th>
              <th>模型</th>
              <th>更新</th>
              <th>Token</th>
              <th>缓存</th>
              <th>步骤</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr
                key={session.id}
                className={session.id === selectedId ? 'is-selected' : ''}
                onClick={() => onSelect(session.id)}
              >
                <td>
                  <strong>{session.title}</strong>
                  {session.isSubagent ? <span className="mini-tag">子代理</span> : null}
                </td>
                <td>{session.projectName}</td>
                <td>{session.model}</td>
                <td>{formatTime(session.updatedAt)}</td>
                <td>{formatTokens(session.usage.total)}</td>
                <td>{formatPercent(session.cacheHitRate)}</td>
                <td>{session.steps}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {sessions.length === 0 ? <EmptyState text="筛选范围内没有会话" compact /> : null}
      </div>
    </section>
  )
}

function SettingsPanel({
  settings,
  codexHome,
  warnings,
  onSettings,
  onExport
}: {
  settings: AppSettings
  codexHome: string
  warnings: { code: string; message: string }[]
  onSettings: (settings: AppSettings) => void
  onExport: (format: 'csv' | 'json') => Promise<void>
}) {
  const [draft, setDraft] = useState(settings)
  const [saved, setSaved] = useState(false)

  useEffect(() => setDraft(settings), [settings])

  const save = async (): Promise<void> => {
    const next = await window.betterCodexInfo.updateSettings({
      ...draft,
      onboardingComplete: true
    })
    setDraft(next)
    onSettings(next)
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1_500)
  }

  return (
    <div className="settings-grid">
      {!settings.onboardingComplete ? (
        <section className="welcome-card">
          <Bell size={20} />
          <div>
            <h2>让统计只在需要时提醒你</h2>
            <p>系统通知仅在本机触发，不上传会话数据。你可以随时关闭。</p>
          </div>
        </section>
      ) : null}

      <section className="settings-card">
        <div className="section-title">
          <div>
            <p className="eyebrow">显示</p>
            <h2>悬浮层与主题</h2>
          </div>
          <Settings2 size={17} />
        </div>
        <Field label="停靠位置">
          <select value={draft.dock} onChange={(event) => setDraft({ ...draft, dock: event.target.value as AppSettings['dock'] })}>
            <option value="bottom-center">底部居中</option>
            <option value="bottom-left">底部左侧</option>
            <option value="bottom-right">底部右侧</option>
            <option value="top-right">右上角</option>
          </select>
        </Field>
        <Field label="主题">
          <select value={draft.theme} onChange={(event) => setDraft({ ...draft, theme: event.target.value as AppSettings['theme'] })}>
            <option value="system">跟随系统</option>
            <option value="dark">深色</option>
            <option value="light">浅色</option>
          </select>
        </Field>
        <Field label={`透明度 ${Math.round(draft.opacity * 100)}%`}>
          <input
            type="range"
            min="60"
            max="100"
            value={Math.round(draft.opacity * 100)}
            onChange={(event) => setDraft({ ...draft, opacity: Number(event.target.value) / 100 })}
          />
        </Field>
        <Toggle
          label="开机时启动 Better Codex Info"
          checked={draft.launchAtLogin}
          onChange={(checked) => setDraft({ ...draft, launchAtLogin: checked })}
        />
      </section>

      <section className="settings-card">
        <div className="section-title">
          <div>
            <p className="eyebrow">提醒</p>
            <h2>阈值与预算</h2>
          </div>
          <Bell size={17} />
        </div>
        <Toggle
          label="启用系统通知"
          checked={draft.notificationsEnabled}
          onChange={(checked) => setDraft({ ...draft, notificationsEnabled: checked })}
        />
        <Toggle
          label="历史分析包含子代理"
          checked={draft.includeSubagents}
          onChange={(checked) => setDraft({ ...draft, includeSubagents: checked })}
        />
        <Field label="上下文预警 / 严重阈值">
          <div className="pair-inputs">
            <NumberInput
              value={draft.contextWarningPercent}
              suffix="%"
              onChange={(value) => setDraft({ ...draft, contextWarningPercent: value })}
            />
            <NumberInput
              value={draft.contextCriticalPercent}
              suffix="%"
              onChange={(value) => setDraft({ ...draft, contextCriticalPercent: value })}
            />
          </div>
        </Field>
        <Field label="每日 / 每月 Token 预算">
          <div className="pair-inputs">
            <NumberInput
              value={draft.dailyTokenBudget ?? 0}
              suffix="每日"
              onChange={(value) => setDraft({ ...draft, dailyTokenBudget: value || null })}
            />
            <NumberInput
              value={draft.monthlyTokenBudget ?? 0}
              suffix="每月"
              onChange={(value) => setDraft({ ...draft, monthlyTokenBudget: value || null })}
            />
          </div>
        </Field>
        <Field label="缓存命中率低于">
          <NumberInput
            value={draft.cacheHitMinimum ?? 0}
            suffix="% · 0 为关闭"
            onChange={(value) => setDraft({ ...draft, cacheHitMinimum: value || null })}
          />
        </Field>
      </section>

      <section className="settings-card data-card">
        <div className="section-title">
          <div>
            <p className="eyebrow">本地数据</p>
            <h2>隐私与导出</h2>
          </div>
          <Database size={17} />
        </div>
        <p className="path-label">Codex 数据目录</p>
        <code>{codexHome || '未找到'}</code>
        <p className="muted">
          应用只保存指标、会话标题、项目路径和工具类别；不会保存消息正文、命令参数或工具输出。
        </p>
        <div className="button-group">
          <button type="button" className="secondary-button" onClick={() => void onExport('csv')}>
            <Download size={14} /> 导出 CSV
          </button>
          <button type="button" className="secondary-button" onClick={() => void onExport('json')}>
            <Download size={14} /> 导出 JSON
          </button>
        </div>
        {warnings.length ? (
          <div className="warning-list">
            {warnings.map((warning) => (
              <p key={warning.code}>{warning.message}</p>
            ))}
          </div>
        ) : null}
      </section>

      <footer className="settings-footer">
        <span className="muted">{saved ? '设置已保存' : '更改会保存在本机'}</span>
        <button type="button" className="primary-button" onClick={() => void save()}>
          保存设置
        </button>
      </footer>
    </div>
  )
}

function ContextComposition({ breakdown }: { breakdown: ContextBreakdown }) {
  const items = [
    ['系统指令', breakdown.system, '#b9bec9'],
    ['工具定义', breakdown.tools, '#a889ee'],
    ['对话消息', breakdown.conversation, '#74a8ee'],
    ['其他', breakdown.other, '#666b76']
  ] as const
  const total = Math.max(1, items.reduce((sum, item) => sum + item[1], 0))
  return (
    <section className="turn-card composition-card">
      <div className="section-title">
        <div>
          <p className="eyebrow">上下文构成 · 估算</p>
          <h2>{formatTokens(total)} Token</h2>
        </div>
        <Wrench size={17} />
      </div>
      <div className="segmented-bar">
        {items.map(([, value, color]) => (
          <span key={color} style={{ width: `${(value / total) * 100}%`, background: color }} />
        ))}
      </div>
      <div className="context-legend">
        {items.map(([label, value, color]) => (
          <div key={label}>
            <span className="token-label">
              <i style={{ background: color }} />
              {label}
            </span>
            <strong>{formatTokens(value)}</strong>
          </div>
        ))}
      </div>
    </section>
  )
}

function ToolDistribution({ turns }: { turns: TurnMetrics[] }) {
  const tools = new Map<
    string,
    { name: string; kind: string; calls: number; durationMs: number; failures: number }
  >()
  for (const turn of turns) {
    for (const tool of turn.tools) {
      const key = `${tool.kind}:${tool.name}`
      const current = tools.get(key) ?? {
        name: tool.name,
        kind: tool.kind,
        calls: 0,
        durationMs: 0,
        failures: 0
      }
      current.calls += tool.calls
      current.durationMs += tool.durationMs
      current.failures += tool.failures
      tools.set(key, current)
    }
  }
  const ranking = [...tools.values()]
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 7)
  const longest = Math.max(1, ...ranking.map((tool) => tool.durationMs))

  return (
    <section className="turn-card composition-card">
      <div className="section-title">
        <div>
          <p className="eyebrow">工具分布</p>
          <h2>{turns.reduce((total, turn) => total + turn.toolCalls, 0)} 次调用</h2>
        </div>
        <Wrench size={17} />
      </div>
      {ranking.length ? (
        <div className="tool-ranking">
          {ranking.map((tool) => (
            <div key={`${tool.kind}:${tool.name}`}>
              <span className="tool-rank-label">
                <strong>{tool.name}</strong>
                <small>
                  {tool.calls} 次 · {formatDuration(tool.durationMs)}
                  {tool.failures ? ` · ${tool.failures} 失败` : ''}
                </small>
              </span>
              <i>
                <b style={{ width: `${Math.max(3, (tool.durationMs / longest) * 100)}%` }} />
              </i>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState text="该会话没有工具调用" compact />
      )}
    </section>
  )
}

function Kpi({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="kpi">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  children
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button type="button" className={active ? 'is-active' : ''} onClick={onClick}>
      {icon}
      {children}
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field-row">
      <span>{label}</span>
      {children}
    </label>
  )
}

function Toggle({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden />
    </label>
  )
}

function NumberInput({
  value,
  suffix,
  onChange
}: {
  value: number
  suffix: string
  onChange: (value: number) => void
}) {
  return (
    <span className="number-input">
      <input
        type="number"
        min="0"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <small>{suffix}</small>
    </span>
  )
}

function EmptyState({ text, compact = false }: { text: string; compact?: boolean }) {
  return <div className={`empty-state ${compact ? 'is-compact' : ''}`}>{text}</div>
}

function ChartTooltip({
  active,
  payload,
  label,
  metric
}: {
  active?: boolean
  payload?: Array<{ name?: string; value?: number; color?: string }>
  label?: string
  metric: 'tokens' | 'cache' | 'speed' | 'tools'
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="chart-tooltip">
      <strong>{label}</strong>
      {payload.map((item) => (
        <span key={item.name}>
          <i style={{ background: item.color }} />
          {item.name}: {formatChartValue(Number(item.value ?? 0), metric)}
        </span>
      ))}
    </div>
  )
}

function formatChartValue(
  value: number,
  metric: 'tokens' | 'cache' | 'speed' | 'tools'
): string {
  if (metric === 'cache') return `${compactNumber(value)}%`
  if (metric === 'speed') return formatSpeed(value)
  if (metric === 'tools') return formatDuration(value)
  return formatTokens(value)
}

function formatChartAxis(
  value: number,
  metric: 'tokens' | 'cache' | 'speed' | 'tools'
): string {
  if (metric === 'cache') return `${compactNumber(value)}%`
  if (metric === 'speed') return compactNumber(value)
  if (metric === 'tools') {
    if (value >= 60_000) return `${compactNumber(value / 60_000)}m`
    if (value >= 1_000) return `${compactNumber(value / 1_000)}s`
    return `${Math.round(value)}ms`
  }
  return formatTokens(value)
}

function compactNumber(value: number): string {
  return Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right))
}
