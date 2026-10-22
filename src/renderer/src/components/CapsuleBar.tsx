import { BarChart3, Database, Gauge, Settings2, X } from 'lucide-react'
import type { OverlaySurface, SessionSnapshot } from '@shared/contracts'
import { formatPercent, formatSpeed, formatTokens } from '@shared/format'

interface CapsuleBarProps {
  snapshot: SessionSnapshot | null
  activeSurface: OverlaySurface
  indexing: boolean
  onSurface: (surface: OverlaySurface) => void
  onHide: () => void
}

export function CapsuleBar({
  snapshot,
  activeSurface,
  indexing,
  onSurface,
  onHide
}: CapsuleBarProps) {
  const contextPercent = snapshot?.contextPercent ?? null
  const hasSession = snapshot != null

  return (
    <div className="capsule-dock" aria-label="Codex 会话统计">
      <div className="session-signal">
        <span className={`signal-dot ${indexing ? 'is-indexing' : ''}`} />
        <span className="session-signal-label">
          {snapshot?.title ?? (indexing ? '正在读取会话' : '等待 Codex 会话')}
        </span>
      </div>

      <button
        type="button"
        className={`capsule ${activeSurface === 'stats' ? 'is-active' : ''}`}
        onClick={() => onSurface(activeSurface === 'stats' ? 'collapsed' : 'stats')}
        aria-label="打开会话统计"
      >
        <Gauge size={14} strokeWidth={1.8} />
        {hasSession ? (
          <span>
            <strong>{snapshot.rounds}</strong> 轮 <strong>{snapshot.steps}</strong> 步
            <span className="dot-separator">·</span>
            {formatSpeed(snapshot.latency.tps)}
          </span>
        ) : (
          <span>会话统计</span>
        )}
      </button>

      <button
        type="button"
        className={`capsule ${activeSurface === 'tokens' ? 'is-active' : ''}`}
        onClick={() => onSurface(activeSurface === 'tokens' ? 'collapsed' : 'tokens')}
        aria-label="打开 Token 用量"
      >
        <Database size={14} strokeWidth={1.8} />
        {hasSession ? (
          <span>
            {formatTokens(snapshot.usage.total)} tok
            <span className="dot-separator">·</span>
            缓存 {formatPercent(snapshot.cacheHitRate)}
          </span>
        ) : (
          <span>Token 用量</span>
        )}
      </button>

      <button
        type="button"
        className={`capsule context-capsule ${activeSurface === 'context' ? 'is-active' : ''}`}
        onClick={() => onSurface(activeSurface === 'context' ? 'collapsed' : 'context')}
        aria-label="打开上下文信息"
      >
        <ContextRing percent={contextPercent} />
        <span>{hasSession ? formatPercent(contextPercent) : '上下文'}</span>
      </button>

      <span className="capsule-divider" />

      <button
        type="button"
        className="icon-button dock-action"
        onClick={() => onSurface('analysis')}
        aria-label="打开分析中心"
        title="分析中心"
      >
        <BarChart3 size={16} />
      </button>
      <button
        type="button"
        className="icon-button dock-action"
        onClick={() => onSurface('settings')}
        aria-label="打开设置"
        title="设置"
      >
        <Settings2 size={16} />
      </button>
      <button
        type="button"
        className="icon-button dock-action subtle"
        onClick={onHide}
        aria-label="隐藏悬浮层"
        title="隐藏"
      >
        <X size={15} />
      </button>
    </div>
  )
}

function ContextRing({ percent }: { percent: number | null }) {
  const safePercent = percent == null ? 0 : Math.max(0, Math.min(1, percent))
  const size = 17
  const stroke = 2.2
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  return (
    <svg className="context-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - safePercent)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  )
}
