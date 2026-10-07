import { describe, expect, it } from 'vitest'

import { ERROR_HTTP_STATUS, ErrorBodySchema, ErrorCode } from './errors'
import { IsoDateSchema, UuidSchema } from './ids'
import { RoleSchema } from './roles'

describe('error codes', () => {
  it('every ErrorCode has an HTTP status', () => {
    for (const code of ErrorCode.options) {
      expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400)
    }
  })

  it('has the 22 codes from the contracts doc', () => {
    expect(ErrorCode.options).toHaveLength(22)
  })

  it('maps codes to the documented statuses', () => {
    expect(ERROR_HTTP_STATUS.VALIDATION_FAILED).toBe(400)
    expect(ERROR_HTTP_STATUS.OUT_OF_STOCK).toBe(409)
    expect(ERROR_HTTP_STATUS.CART_EMPTY).toBe(422)
    expect(ERROR_HTTP_STATUS.TOO_MANY_ATTEMPTS).toBe(429)
    expect(ERROR_HTTP_STATUS.UPSTREAM_UNAVAILABLE).toBe(503)
    expect(ERROR_HTTP_STATUS.INTERNAL).toBe(500)
  })

  it('ErrorBody validates the shared shape', () => {
    expect(
      ErrorBodySchema.safeParse({
        error: { code: 'OUT_OF_STOCK', message: 'Only 1 left', details: { items: [] }, requestId: 'req-1' },
      }).success,
    ).toBe(true)
    expect(ErrorBodySchema.safeParse({ error: { code: 'NOPE', message: 'x' } }).success).toBe(false)
    expect(ErrorBodySchema.safeParse({ message: 'legacy shape' }).success).toBe(false)
  })
})

describe('ids and roles', () => {
  it('UuidSchema accepts v7 and rejects junk', () => {
    expect(UuidSchema.safeParse('0192f7a4-3b6c-7d2e-8f10-1a2b3c4d5e6f').success).toBe(true)
    expect(UuidSchema.safeParse('64f1c2a9e1b2c3d4e5f60718').success).toBe(false)
  })

  it('IsoDateSchema requires UTC ISO-8601', () => {
    expect(IsoDateSchema.safeParse('2026-10-07T10:15:30.123Z').success).toBe(true)
    expect(IsoDateSchema.safeParse('07/10/2026').success).toBe(false)
  })

  it('RoleSchema has buyer, artisan, admin', () => {
    expect(RoleSchema.options).toEqual(['buyer', 'artisan', 'admin'])
  })
})
