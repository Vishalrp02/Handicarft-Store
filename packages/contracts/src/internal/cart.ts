import { z } from 'zod'

import { UuidSchema } from '../common/ids'

/** order → cart: GET /internal/carts/:userId — purchasable lines only. */
export const InternalCartSchema = z.object({
  items: z.array(z.object({ productId: UuidSchema, qty: z.number().int().min(1).max(10) })).max(50),
})
export type InternalCart = z.infer<typeof InternalCartSchema>

export const UserIdParamsSchema = z.object({ userId: UuidSchema })
export type UserIdParams = z.infer<typeof UserIdParamsSchema>
