import { describe, expect, it } from 'vitest'

import { createFakeClock, systemClock } from './clock'

describe('clock', () => {
  it('systemClock returns the current time', () => {
    const before = Date.now()
    const now = systemClock.now().getTime()
    expect(now).toBeGreaterThanOrEqual(before)
  })

  it('fake clock starts where told and advances', () => {
    const clock = createFakeClock(new Date('2026-10-07T00:00:00.000Z'))
    expect(clock.now().toISOString()).toBe('2026-10-07T00:00:00.000Z')
    clock.advance(30 * 60 * 1000)
    expect(clock.now().toISOString()).toBe('2026-10-07T00:30:00.000Z')
  })

  it('returns copies so callers cannot mutate the clock', () => {
    const clock = createFakeClock(new Date('2026-10-07T00:00:00.000Z'))
    clock.now().setFullYear(2000)
    expect(clock.now().getUTCFullYear()).toBe(2026)
  })
})
