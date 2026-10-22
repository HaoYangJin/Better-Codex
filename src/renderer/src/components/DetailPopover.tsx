import { ArrowUpRight, Clock3, Info, Wrench, X, Zap } from 'lucide-react'
import type { OverlaySurface, SessionSnapshot } from '@shared/contracts'
import {
  formatDuration,
  formatPercent,
  formatSpeed,
  formatTokens
} from '@shared/format'

interface DetailPopoverProps {
  surface: Exclude<OverlaySurface, 'collapsed' | 'analysis'>
  snapshot: SessionSnapshot
  onClose: () => void
  onAnalysis: () => void
}

export function DetailPopover({
  surface,
  snapshot,
  onClose,
  onAnalysis
}: DetailPopoverProps) {
  const title =
    surface === 'stats'
      ? '会话统计'
      : surface === 'tokens'
        ? 'Token 用量'
        : '上下文已用'

  return (
    <section className="popover" aria-label={title}>
      <header className="popover-header">
        <div>
          <p className="eyebrow">最近活动会话</p>
          <h2>{title}</h2>
          <p className="session-subtitle" title={snapshot.title}>
            {snapshot.title}
          </p>
        </div>
        <div className="popover-header-actions">
          <span className={`status-label status-${snapshot.status}`}>{statusText(snapshot.status)}</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭弹层">
            <X size={16} />
          </button>
        </div>
      </header>

      {surface === 'stats' ? <StatsBody snapshot={snapshot} /> : null}
      {surface === 'tokens' ? <TokensBody snapshot={snapshot} /> : null}
      {surface === 'context' ? <ContextBody snapshot={snapshot} /> : null}

      <footer className="popover-footer">
        <span className="muted">
          {snapshot.approximateTiming ? '部分时序为近似值' : '统计更新于本地会话日志'}
        </span>
        <button type="button" className="text-action" onClick={onAnalysis}>
          查看分析中心 <ArrowUpRight size={14} />
        </button>
      </footer>
    </section>
  )
}

function StatsBody({ snapshot }: { snapshot: SessionSnapshot }) {
  return (
    <div className="metric-list">
      <MetricRow
        icon={<Clock3 size={15} />}
        label="模型用时"
        value={formatDuration(snapshot.latency.modelMs)}
      />
      <MetricRow icon={<Wrench size={15} />} label="工具调用用时" value={formatDuration(snapshot.latency.toolMs)} />
      <MetricRow
        icon={<Zap size={15} />}
        label="首 Token 平均（TTFT）"
        value={formatDuration(snapshot.latency.averageTtftMs)}
        hint="来自 Codex 轮次完成事件；缺失时按首条回复区估算"
      />
      <MetricRow icon={<Zap size={15} />} label="输出速度（TPS）" value={formatSpeed(snapshot.latency.tps)} />
      <MetricRow
        icon={<Wrench size={15} />}
        label="最长工具"
        value={
          snapshot.latency.longestTool
            ? `${snapshot.latency.longestTool.name} · ${formatDuration(snapshot.latency.longestTool.durationMs)}`
            : '—'
        }
      />
      <div className="inline-stats">
        <span>{snapshot.rounds} 轮对话</span>
        <span>{snapshot.steps} 次模型请求</span>
        <span>{snapshot.toolCalls} 次工具调用</span>
      </div>
    </div>
  )
}

function TokensBody({ snapshot }: { snapshot: SessionSnapshot }) {
  const usage = snapshot.usage
  const rows = [
    ['输入总量', usage.input, '#717887'],
    ['缓存读取', usage.cachedInput, '#8fa9ff'],
    ['未缓存输入', usage.uncachedInput, '#5ac8a8'],
    ['输出', usage.output, '#d7a05c'],
    ['其中推理输出', usage.reasoningOutput, '#b58cdf'],
    ['缓存写入', usage.cacheWriteInput, '#d46b76']
  ] as const

  return (
    <div>
      <div className="token-total">
        <span>会话累计</span>
        <strong>{formatTokens(usage.total)} tok</strong>
        <span className="cache-badge">缓存命中 {formatPercent(snapshot.cacheHitRate, 1)}</span>
      </div>
      <div className="token-rows">
        {rows.map(([label, value, color]) => (
          <div className="token-row" key={label}>
            <span className="token-label">
              <i style={{ background: color }} />
              {label}
            </span>
            <span className="tabular">{value.toLocaleString('zh-CN')}</span>
          </div>
        ))}
      </div>
      <div className="callout">
        <Info size={14} />
        会话累计 Token 与上下文 Token 分开计算，多次工具调用不会重复累加快照。
      </div>
    </div>
  )
}

function ContextBody({ snapshot }: { snapshot: SessionSnapshot }) {
  const context = snapshot.contextBreakdown
  const total = Math.max(
    1,
    context.system + context.tools + context.conversation + context.other
  )
  const segments = [
    ['系统与开发者指令', context.system, '#b9bec9'],
    ['工具定义', context.tools, '#a889ee'],
    ['对话消息', context.conversation, '#74a8ee'],
    ['其他 / 预留', context.other, '#666b76']
  ] as const

  return (
    <div>
      <div className="context-summary">
        <div>
          <span>上下文已用</span>
          <strong>{formatPercent(snapshot.contextPercent, 1)}</strong>
        </div>
        <p>
          约 {formatTokens(snapshot.contextUsed)} /{' '}
          {snapshot.contextWindow ? formatTokens(snapshot.contextWindow) : '—'}
        </p>
      </div>
      <div className="segmented-bar" aria-label="上下文构成">
        {segments.map(([, value, color]) => (
          <span
            key={color}
            style={{ width: `${Math.max(value > 0 ? 1 : 0, (value / total) * 100)}%`, background: color }}
          />
        ))}
      </div>
      <div className="context-legend">
        {segments.map(([label, value, color]) => (
          <div key={label}>
            <span className="token-label">
              <i style={{ background: color }} />
              {label}
            </span>
            <strong>{formatTokens(value)}</strong>
          </div>
        ))}
      </div>
      <div className="callout">
        <Info size={14} />
        构成按本地提示、工具 schema 与消息长度的比例归一化到真实输入 Token，属于近似估算。
        {snapshot.compactions > 0 ? ` 本会话已压缩 ${snapshot.compactions} 次。` : ''}
      </div>
    </div>
  )
}

function MetricRow({
  icon,
  label,
  value,
  hint
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="metric-row" title={hint}>
      <span className="metric-label">
        {icon}
        {label}
      </span>
      <strong className="tabular">{value}</strong>
    </div>
  )
}

function statusText(status: SessionSnapshot['status']): string {
  return {
    running: '进行中',
    completed: '已完成',
    interrupted: '已中断',
    failed: '失败',
    unknown: '已记录'
  }[status]
}
