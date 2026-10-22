import type { BetterCodexInfoApi } from '../shared/contracts'

declare global {
  interface Window {
    betterCodexInfo: BetterCodexInfoApi
  }
}

export {}
