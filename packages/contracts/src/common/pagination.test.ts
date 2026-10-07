import { describe, expect, it } from 'vitest'
import { z, ZodError } from 'zod'

import {
  CursorPageSchema,
  CursorQuerySchema,
  decodeCursor,
  encodeCursor,
  PageQuerySchema,
  PageSchema,
} from './pagination'

const cursor = { createdAt: '2026-10-07T10:15:30.123Z', id: '0192f7a4-3b6c-7d2e-8f10-1a2b3c4d5e6f' }

describe('cursor', () => {
  it('round-trips', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  it('is URL-safe base64 without padding', () => {
    expect(encodeCursor(cursor)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('rejects garbage with a ZodError', () => {
    const badId = btoa(`${cursor.createdAt}|nope`).replace(/=+$/, '')
    for (const bad of ['', 'not base64!', 'YWJj', badId]) {
      expect(() => decodeCursor(bad)).toThrow(ZodError)
    }
  })

  it('refuses to encode an invalid payload', () => {
    expect(() => encodeCursor({ ...cursor, id: 'nope' })).toThrow(ZodError)
  })

  it('rejects a cursor whose date is not ISO-8601', () => {
    const raw = btoa('yesterday|0192f7a4-3b6c-7d2e-8f10-1a2b3c4d5e6f').replace(/=+$/, '')
    expect(() => decodeCursor(raw)).toThrow(ZodError)
  })
})

describe('query schemas', () => {
  it('CursorQuery defaults limit to 20 and coerces strings', () => {
    expect(CursorQuerySchema.parse({})).toEqual({ limit: 20 })
    expect(CursorQuerySchema.parse({ limit: '50', cursor: 'abc' })).toEqual({ limit: 50, cursor: 'abc' })
  })

  it('CursorQuery limit is 1..100', () => {
    expect(CursorQuerySchema.safeParse({ limit: '0' }).success).toBe(false)
    expect(CursorQuerySchema.safeParse({ limit: '101' }).success).toBe(false)
  })

  it('PageQuery defaults to page 1, limit 24', () => {
    expect(PageQuerySchema.parse({})).toEqual({ page: 1, limit: 24 })
  })

  it('PageQuery caps page at 50 and limit at 48', () => {
    expect(PageQuerySchema.safeParse({ page: '51' }).success).toBe(false)
    expect(PageQuerySchema.safeParse({ limit: '49' }).success).toBe(false)
    expect(PageQuerySchema.safeParse({ page: '1.5' }).success).toBe(false)
  })
})

describe('page schemas', () => {
  const Item = z.object({ id: z.string() })

  it('PageSchema wraps items with page, limit, total', () => {
    const r = PageSchema(Item).safeParse({ items: [{ id: 'a' }], page: 1, limit: 24, total: 1 })
    expect(r.success).toBe(true)
  })

  it('CursorPageSchema allows a null nextCursor', () => {
    expect(CursorPageSchema(Item).safeParse({ items: [], nextCursor: null }).success).toBe(true)
    expect(CursorPageSchema(Item).safeParse({ items: [] }).success).toBe(false)
  })
})
