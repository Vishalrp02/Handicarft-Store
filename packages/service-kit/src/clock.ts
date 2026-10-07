/** Inject a Clock instead of calling `new Date()` so time-based rules are testable. */
export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

export interface FakeClock extends Clock {
  advance(ms: number): void
  set(date: Date): void
}

export function createFakeClock(start: Date): FakeClock {
  let current = start.getTime()
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms
    },
    set: (date) => {
      current = date.getTime()
    },
  }
}
