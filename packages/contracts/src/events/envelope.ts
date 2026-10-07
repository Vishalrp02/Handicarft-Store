import { z } from 'zod'

import { IsoDateSchema, UuidSchema } from '../common/ids'

export const ServiceNameSchema = z.enum([
  'gateway',
  'identity',
  'catalog',
  'seller',
  'cart',
  'order',
  'payment',
  'notification',
])
export type ServiceName = z.infer<typeof ServiceNameSchema>

/**
 * Every event on RabbitMQ is wrapped in this envelope (docs/architecture/02 §5.2).
 * Routing key = `<type>.v<version>`, e.g. `order.paid.v1`.
 */
export const EventEnvelopeSchema = <T extends z.ZodType>(data: T) =>
  z.object({
    /** UUID v7; consumers dedupe on it (inbox table). */
    id: UuidSchema,
    /** Past-tense fact, e.g. 'order.paid'. */
    type: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
    version: z.number().int().min(1),
    occurredAt: IsoDateSchema,
    producer: ServiceNameSchema,
    /** Request id of the HTTP call that caused it, for tracing across services. */
    correlationId: z.string().min(1).max(100),
    data,
  })

export type EventEnvelope<T> = {
  id: string
  type: string
  version: number
  occurredAt: string
  producer: ServiceName
  correlationId: string
  data: T
}
