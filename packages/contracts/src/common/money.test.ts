import { describe, expect, it } from 'vitest'

import {
  assertPaise,
  formatINR,
  MoneySchema,
  multiplyPaise,
  PaiseSchema,
  percentOfPaise,
  SignedPaiseSchema,
  sumPaise,
} from './money'

describe('percentOfPaise', () => {
  it('rounds half up', () => {
    expect(percentOfPaise(105, 1000)).toBe(11)
    expect(percentOfPaise(104, 1000)).toBe(10)
    expect(percentOfPaise(99900, 1000)).toBe(9990)
  })

  it('handles zero and full rates', () => {
    expect(percentOfPaise(0, 1000)).toBe(0)
    expect(percentOfPaise(12345, 0)).toBe(0)
    expect(percentOfPaise(12345, 10000)).toBe(12345)
  })

  it('rejects non-integer basis points and negative amounts', () => {
    expect(() => percentOfPaise(100, 10.5)).toThrow(RangeError)
    expect(() => percentOfPaise(-100, 1000)).toThrow(RangeError)
  })

  it('rejects intermediate overflow', () => {
    expect(() => percentOfPaise(Number.MAX_SAFE_INTEGER, 5000)).toThrow(RangeError)
  })
})

describe('multiplyPaise', () => {
  it('multiplies unit price by quantity', () => {
    expect(multiplyPaise(49950, 2)).toBe(99900)
  })

  it('rejects unsafe results', () => {
    expect(() => multiplyPaise(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError)
  })

  it('rejects fractional quantities and prices', () => {
    expect(() => multiplyPaise(100, 1.5)).toThrow(RangeError)
    expect(() => multiplyPaise(99.5, 2)).toThrow(RangeError)
  })
})

describe('sumPaise', () => {
  it('adds integers, including signed ledger amounts', () => {
    expect(sumPaise(100, 250, -50)).toBe(300)
    expect(sumPaise()).toBe(0)
  })

  it('rejects floats', () => {
    expect(() => sumPaise(100, 0.5)).toThrow(RangeError)
  })

  it('rejects unsafe totals', () => {
    expect(() => sumPaise(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError)
  })
})

describe('assertPaise', () => {
  it('accepts non-negative safe integers', () => {
    expect(() => {
      assertPaise(0)
    }).not.toThrow()
    expect(() => {
      assertPaise(99900)
    }).not.toThrow()
  })

  it('rejects negatives, floats, NaN and unsafe numbers', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => {
        assertPaise(bad)
      }).toThrow(RangeError)
    }
  })
})

describe('formatINR', () => {
  it('uses Indian grouping', () => {
    expect(formatINR(12450000)).toBe('₹1,24,500')
    expect(formatINR(245050)).toBe('₹2,450.50')
  })

  it('shows paise only when present', () => {
    expect(formatINR(9900)).toBe('₹99')
    expect(formatINR(9901)).toBe('₹99.01')
    expect(formatINR(0)).toBe('₹0')
  })

  it('formats negative ledger amounts', () => {
    expect(formatINR(-1000000)).toBe('-₹10,000')
  })

  it('rejects non-integer paise', () => {
    expect(() => formatINR(10.5)).toThrow(RangeError)
  })
})

describe('schemas', () => {
  it('PaiseSchema accepts non-negative safe integers only', () => {
    expect(PaiseSchema.safeParse(99900).success).toBe(true)
    expect(PaiseSchema.safeParse(-1).success).toBe(false)
    expect(PaiseSchema.safeParse(1.5).success).toBe(false)
    expect(PaiseSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false)
  })

  it('SignedPaiseSchema allows negatives', () => {
    expect(SignedPaiseSchema.safeParse(-500).success).toBe(true)
    expect(SignedPaiseSchema.safeParse(-0.5).success).toBe(false)
  })

  it('MoneySchema only allows INR', () => {
    expect(MoneySchema.safeParse({ amountPaise: 100, currency: 'INR' }).success).toBe(true)
    expect(MoneySchema.safeParse({ amountPaise: 100, currency: 'USD' }).success).toBe(false)
  })
})
