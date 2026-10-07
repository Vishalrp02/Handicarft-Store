import { z } from 'zod'

import { IsoDateSchema, UuidSchema } from '../common/ids'
import { PaiseSchema } from '../common/money'

/** order → catalog: POST /internal/reservations (reservationId = orderId). */
export const ReserveRequestSchema = z.object({
  reservationId: UuidSchema,
  items: z
    .array(z.object({ productId: UuidSchema, qty: z.number().int().min(1).max(10) }))
    .min(1)
    .max(50)
    .refine((items) => new Set(items.map((i) => i.productId)).size === items.length, {
      message: 'Each product may appear only once',
    }),
  ttlSeconds: z.number().int().min(60).max(3600),
})
export type ReserveRequest = z.infer<typeof ReserveRequestSchema>

/** Price locked at reservation time; the order is charged exactly this. */
export const PricedLineSchema = z.object({
  productId: UuidSchema,
  sellerId: UuidSchema,
  sellerDisplayName: z.string(),
  title: z.string(),
  slug: z.string(),
  imageUrl: z.string().nullable(),
  unitPricePaise: PaiseSchema.min(1),
  qty: z.number().int().min(1).max(10),
  taxRateBps: z.number().int(),
})
export type PricedLine = z.infer<typeof PricedLineSchema>

export const ReserveResponseSchema = z.object({
  reservationId: UuidSchema,
  expiresAt: IsoDateSchema,
  lines: z.array(PricedLineSchema).min(1),
})
export type ReserveResponse = z.infer<typeof ReserveResponseSchema>
