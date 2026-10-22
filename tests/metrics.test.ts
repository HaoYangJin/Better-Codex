import { describe, expect, it } from 'vitest'
import {
  addUsage,
  calculateTps,
  estimateContextBreakdown,
  normalizeUsage,
  unionDuration,
  weightedAverage
} from '../src/shared/metrics'

describe('usage metrics', () => {
  it('normalizes cached and uncached input without double counting total tokens', () => {
    const usage = normalizeUsage({
      input_tokens: 2_000,
      cached_input_tokens: 1_500,
      output_tokens: 300,
      reasoning_output_tokens: 120,
      total_tokens: 2_300
    })

    expect(usage).toMatchObject({
      input: 2_000,
      cachedInput: 1_500,
      uncachedInput: 500,
      output: 300,
      reasoningOutput: 120,
      total: 2_300
    })
  })

  it('adds usage snapshots without adding uncached tokens twice', () => {
    const result = addUsage(
      normalizeUsage({ input_tokens: 100, cached_input_tokens: 70, output_tokens: 20 }),
      normalizeUsage({ input_tokens: 200, cached_input_tokens: 150, output_tokens: 25 })
    )

    expect(result.input).toBe(300)
    expect(result.cachedInput).toBe(220)
    expect(result.uncachedInput).toBe(80)
    expect(result.total).toBe(345)
  })

  it('unions overlapping model and tool intervals', () => {
    expect(
      unionDuration([
        [100, 400],
        [350, 900],
        [1_100, 1_300]
      ])
    ).toBe(1_000)
  })

  it('calculates and weights output speed', () => {
    expect(calculateTps(500, 2_000)).toBe(250)
    expect(
      weightedAverage([
        { value: 200, weight: 2 },
        { value: 300, weight: 1 }
      ])
    ).toBeCloseTo(233.333, 2)
  })

  it('normalizes estimated context categories to the measured token count', () => {
    const result = estimateContextBreakdown(10_000, {
      system: 200,
      tools: 500,
      conversation: 300
    })

    expect(result.system).toBe(2_000)
    expect(result.tools).toBe(5_000)
    expect(result.conversation).toBe(3_000)
    expect(result.other).toBe(0)
    expect(result.system + result.tools + result.conversation + result.other).toBe(10_000)
    expect(result.estimated).toBe(true)
  })
})
