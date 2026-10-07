import { z } from 'zod'

import { UuidSchema } from '../common/ids'
import { PaiseSchema } from '../common/money'
import { ProductStatusSchema } from '../http/catalog'

/** What other services keep about a product (cart uses it to render bags). */
export const ProductSnapshotSchema = z.object({
  productId: UuidSchema,
  sellerId: UuidSchema,
  sellerDisplayName: z.string(),
  slug: z.string(),
  title: z.string(),
  pricePaise: PaiseSchema,
  imageUrl: z.string().nullable(),
  status: ProductStatusSchema,
})
export type ProductSnapshot = z.infer<typeof ProductSnapshotSchema>

export const ProductPublishedV1Schema = ProductSnapshotSchema
export type ProductPublishedV1 = z.infer<typeof ProductPublishedV1Schema>

export const ProductUpdatedV1Schema = ProductSnapshotSchema
export type ProductUpdatedV1 = z.infer<typeof ProductUpdatedV1Schema>

export const ProductUnpublishedV1Schema = z.object({
  productId: UuidSchema,
  reason: z.enum(['archived', 'rejected', 'seller_suspended', 'pending_review']),
})
export type ProductUnpublishedV1 = z.infer<typeof ProductUnpublishedV1Schema>

/** Payment arrived after the reservation expired and the stock is gone: nothing was committed. */
export const InventoryCommitFailedV1Schema = z.object({
  /** = orderId */
  reservationId: UuidSchema,
  items: z
    .array(
      z.object({
        productId: UuidSchema,
        requested: z.number().int().min(1),
        available: z.number().int().nonnegative(),
      }),
    )
    .min(1),
})
export type InventoryCommitFailedV1 = z.infer<typeof InventoryCommitFailedV1Schema>
