import { z } from 'zod'

/**
 * Money is always integer paise (₹1 = 100 paise), never floats.
 * Every helper throws RangeError instead of returning an unsafe or fractional value.
 */

export const PaiseSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const SignedPaiseSchema = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)

export const CurrencySchema = z.literal('INR')

/** Display-only money value; internal maths uses plain paise numbers. */
export const MoneySchema = z.object({ amountPaise: PaiseSchema, currency: CurrencySchema })
export type Money = z.infer<typeof MoneySchema>

const BPS_PER_UNIT = 10_000

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer, got ${String(value)}`)
  }
}

/** Asserts a non-negative safe integer amount of paise. */
export function assertPaise(value: number): asserts value is number {
  assertSafeInteger(value, 'paise')
  if (value < 0) throw new RangeError(`paise must not be negative, got ${String(value)}`)
}

/** Sums signed paise amounts (ledger entries may be negative). */
export function sumPaise(...values: number[]): number {
  let total = 0
  for (const v of values) {
    assertSafeInteger(v, 'paise')
    total += v
  }
  assertSafeInteger(total, 'sum')
  return total
}

/** unit price × quantity, e.g. a line total. */
export function multiplyPaise(unitPaise: number, qty: number): number {
  assertPaise(unitPaise)
  assertSafeInteger(qty, 'quantity')
  if (qty < 0) throw new RangeError(`quantity must not be negative, got ${String(qty)}`)
  const result = unitPaise * qty
  assertSafeInteger(result, 'product')
  return result
}

/**
 * amount × bps / 10 000, rounded half up. 1000 bps = 10 %.
 * Used for commission: percentOfPaise(99_900, 1000) === 9_990.
 */
export function percentOfPaise(amountPaise: number, bps: number): number {
  assertPaise(amountPaise)
  assertSafeInteger(bps, 'basis points')
  if (bps < 0) throw new RangeError(`basis points must not be negative, got ${String(bps)}`)
  const scaled = amountPaise * bps + BPS_PER_UNIT / 2
  assertSafeInteger(scaled, 'intermediate product')
  return Math.floor(scaled / BPS_PER_UNIT)
}

const inrWhole = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})
const inrWithPaise = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** ₹ with Indian digit grouping: 12_450_000 → "₹1,24,500", 245_050 → "₹2,450.50". */
export function formatINR(paise: number): string {
  assertSafeInteger(paise, 'paise')
  const formatter = paise % 100 === 0 ? inrWhole : inrWithPaise
  return formatter.format(paise / 100)
}
