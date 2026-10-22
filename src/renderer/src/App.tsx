import { useEffect, useRef, useState } from 'react'
import { AlertCircle, LoaderCircle } from 'lucide-react'
import type {
  AppSettings,
  BootstrapPayload,
  OverlaySurface,
  SessionSnapshot
} from '@shared/contracts'
import { AnalysisCenter } from './components/AnalysisCenter'
import { CapsuleBar } from './components/CapsuleBar'
import { DetailPopover } from './components/DetailPopover'

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null)
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null)
  const [surface, setSurfaceState] = useState<OverlaySurface>('collapsed')
  const [indexing, setIndexing] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const onboardingHandled = useRef(false)

  useEffect(() => {
    let alive = true
    void window.betterCodexInfo
      .getBootstrap()
      .then((payload) => {
        if (!alive) return
        setBootstrap(payload)
        setSnapshot(payload.snapshot)
        setIndexing(payload.indexing)
        if (!payload.settings.onboardingComplete && !onboardingHandled.current) {
          onboardingHandled.current = true
          setSurface('settings')
        }
      })
      .catch((loadError) => {
        if (alive) setError(loadError instanceof Error ? loadError.message : String(loadError))
      })

    const offSnapshot = window.betterCodexInfo.onSnapshot((next) => setSnapshot(next))
    const offIndex = window.betterCodexInfo.onIndexState(setIndexing)
    return () => {
      alive = false
      offSnapshot()
      offIndex()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && surface !== 'collapsed') setSurface('collapsed')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [surface])

  useEffect(() => {
    if (!bootstrap) return
    document.documentElement.dataset.theme = bootstrap.settings.theme
    document.documentElement.style.setProperty('--surface-opacity', String(bootstrap.settings.opacity))
  }, [bootstrap])

  const setSurface = (next: OverlaySurface): void => {
    setSurfaceState(next)
    void window.betterCodexInfo.setSurface(next)
    if (next === 'collapsed') {
      requestAnimationFrame(() => window.blur())
    }
  }

  const updateSettings = (settings: AppSettings): void => {
    setBootstrap((current) => (current ? { ...current, settings } : current))
  }

  if (error) {
    return (
      <div className="boot-state error-state">
        <AlertCircle size={18} />
        <span>{error}</span>
        <button type="button" className="secondary-button" onClick={() => window.location.reload()}>
          重试
        </button>
      </div>
    )
  }

  if (!bootstrap) {
    return (
      <div className="boot-state">
        <LoaderCircle className="spin" size={17} />
        <span>正在读取 Codex 会话…</span>
      </div>
    )
  }

  const expanded =
    surface === 'analysis' || surface === 'settings'

  return (
    <div className={`app-surface surface-${surface}`}>
      {expanded ? (
        <AnalysisCenter
          snapshot={snapshot}
          settings={bootstrap.settings}
          overview={bootstrap.overview}
          series={bootstrap.series}
          sessions={bootstrap.sessions}
          warnings={bootstrap.warnings}
          indexing={indexing}
          codexHome={bootstrap.codexHome}
          initialTab={surface === 'settings' ? 'settings' : 'overview'}
          onClose={() => setSurface('collapsed')}
          onSettings={updateSettings}
          onSnapshot={setSnapshot}
        />
      ) : null}

      {surface !== 'collapsed' && !expanded && snapshot ? (
        <DetailPopover
          surface={surface}
          snapshot={snapshot}
          onClose={() => setSurface('collapsed')}
          onAnalysis={() => setSurface('analysis')}
        />
      ) : null}

      {surface !== 'collapsed' && !expanded && !snapshot ? (
        <div className="empty-popover">
          <p className="eyebrow">Better Codex Info</p>
          <h2>等待本地会话数据</h2>
          <p>在 Codex 中继续一次对话后，统计会自动出现。</p>
        </div>
      ) : null}

      <CapsuleBar
        snapshot={snapshot}
        activeSurface={surface}
        indexing={indexing}
        onSurface={setSurface}
        onHide={() => void window.betterCodexInfo.hideOverlay()}
      />
    </div>
  )
}
