export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value >= 1_000_000) return `${compact(value / 1_000_000)}M`
  if (value >= 1_000) return `${compact(value / 1_000)}K`
  return Math.round(value).toLocaleString('zh-CN')
}

export function formatPercent(value: number | null, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1_000) return `${Math.round(ms)} 毫秒`
  if (ms < 60_000) return `${compact(ms / 1_000)} 秒`
  const totalSeconds = Math.round(ms / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`
}

export function formatSpeed(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${compact(value)} tok/s`
}

export function formatTime(timestamp: number): string {
  if (!timestamp) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

function compact(value: number): string {
  return Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: value >= 100 ? 0 : value >= 10 ? 1 : 2,
    notation: 'compact'
  }).format(value)
}
