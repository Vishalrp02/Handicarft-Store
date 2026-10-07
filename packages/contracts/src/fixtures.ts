import { readFileSync } from 'node:fs'

import type { EventEnvelope } from './events/envelope'
import { EventEnvelopeSchema } from './events/envelope'
import type { EventData, EventKey } from './events/registry'
import { EventRegistry, isEventKey } from './events/registry'

/**
 * Node-only (tests): loads `fixtures/<key>.json` and validates it against the registry.
 * Import from '@craftoria/contracts/fixtures' — never from browser code.
 */
export function loadFixture<K extends EventKey>(key: K): EventEnvelope<EventData<K>> {
  if (!isEventKey(key)) throw new Error(`Unknown event key: ${String(key)}`)
  const url = new URL(`../fixtures/${key}.json`, import.meta.url)
  const raw: unknown = JSON.parse(readFileSync(url, 'utf8'))
  return EventEnvelopeSchema(EventRegistry[key].schema).parse(raw) as EventEnvelope<EventData<K>>
}
