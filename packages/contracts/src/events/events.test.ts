import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { loadFixture } from '../fixtures'
import { EventEnvelopeSchema } from './envelope'
import { EVENT_KEYS, EventRegistry, isEventKey } from './registry'

const fixturesDir = fileURLToPath(new URL('../../fixtures/', import.meta.url))

/** The 24 events in docs/architecture/03 §8. */
const DOCUMENTED = [
  'user.registered.v1',
  'user.email_verification_requested.v1',
  'user.password_reset_requested.v1',
  'user.deleted.v1',
  'seller.applied.v1',
  'seller.approved.v1',
  'seller.rejected.v1',
  'seller.suspended.v1',
  'seller.reinstated.v1',
  'product.published.v1',
  'product.updated.v1',
  'product.unpublished.v1',
  'inventory.commit_failed.v1',
  'order.placed.v1',
  'order.paid.v1',
  'order.cancelled.v1',
  'order.refund_required.v1',
  'seller_order.status_changed.v1',
  'seller_order.delivered.v1',
  'payment.captured.v1',
  'payment.failed.v1',
  'refund.processed.v1',
  'refund.failed.v1',
  'payout.paid.v1',
]

describe('event registry', () => {
  it('covers exactly the documented events', () => {
    expect([...EVENT_KEYS].sort()).toEqual([...DOCUMENTED].sort())
  })

  it('registry key matches type and version', () => {
    for (const key of EVENT_KEYS) {
      const e = EventRegistry[key]
      expect(key).toBe(`${e.type}.v${String(e.version)}`)
    }
  })

  it('isEventKey narrows strings', () => {
    expect(isEventKey('order.paid.v1')).toBe(true)
    expect(isEventKey('order.paid.v2')).toBe(false)
    expect(isEventKey('toString')).toBe(false)
  })
})

describe('fixtures', () => {
  it('every registry key has a fixture that parses', () => {
    for (const key of EVENT_KEYS) {
      expect(() => loadFixture(key), key).not.toThrow()
    }
  })

  it('fixture envelope matches its registry entry', () => {
    for (const key of EVENT_KEYS) {
      const f = loadFixture(key)
      const e = EventRegistry[key]
      expect(f.type, key).toBe(e.type)
      expect(f.version, key).toBe(e.version)
      expect(f.producer, key).toBe(e.producer)
    }
  })

  it('has no orphan fixture files', () => {
    const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'))
    expect(files.map((f) => f.replace(/\.json$/, '')).sort()).toEqual([...EVENT_KEYS].sort())
  })

  it('fixture event ids are unique', () => {
    const ids = EVENT_KEYS.map((k) => loadFixture(k).id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('payload rules', () => {
  const paid = () => loadFixture('order.paid.v1')

  it('order.paid requires at least one sellerOrder', () => {
    const data = { ...paid().data, sellerOrders: [] }
    expect(EventRegistry['order.paid.v1'].schema.safeParse(data).success).toBe(false)
  })

  it('order.paid amounts must be integer paise', () => {
    const data = { ...paid().data, totalPaise: 2450.5 }
    expect(EventRegistry['order.paid.v1'].schema.safeParse(data).success).toBe(false)
  })

  it('order.cancelled is only ever for unpaid orders', () => {
    const data = { ...loadFixture('order.cancelled.v1').data, wasPaid: true }
    expect(EventRegistry['order.cancelled.v1'].schema.safeParse(data).success).toBe(false)
  })

  it('refund.processed must say whether it was a duplicate payment', () => {
    const { kind: _kind, ...withoutKind } = loadFixture('refund.processed.v1').data
    expect(EventRegistry['refund.processed.v1'].schema.safeParse(withoutKind).success).toBe(false)
  })

  it('status_changed uses real seller-order statuses', () => {
    const data = { ...loadFixture('seller_order.status_changed.v1').data, to: 'teleported' }
    expect(EventRegistry['seller_order.status_changed.v1'].schema.safeParse(data).success).toBe(false)
  })
})

describe('envelope', () => {
  const schema = EventEnvelopeSchema(EventRegistry['user.deleted.v1'].schema)
  const base = loadFixture('user.deleted.v1')

  it('accepts a valid envelope', () => {
    expect(schema.safeParse(base).success).toBe(true)
  })

  it('rejects unknown producer', () => {
    expect(schema.safeParse({ ...base, producer: 'billing' }).success).toBe(false)
  })

  it('rejects a non-UUID id, version 0 and an empty correlationId', () => {
    expect(schema.safeParse({ ...base, id: 'evt_1' }).success).toBe(false)
    expect(schema.safeParse({ ...base, version: 0 }).success).toBe(false)
    expect(schema.safeParse({ ...base, correlationId: '' }).success).toBe(false)
  })

  it('loadFixture rejects a key that is not registered', () => {
    expect(() => loadFixture('order.shipped.v1' as never)).toThrow()
  })
})
