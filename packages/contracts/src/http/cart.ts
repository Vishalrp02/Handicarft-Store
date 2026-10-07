import { z } from 'zod'

import { IsoDateSchema, UuidSchema } from '../common/ids'
import { PaiseSchema } from '../common/money'

/**
 * Cart service API shapes (the cart service itself is owner-built, plan 06).
 * Quantity per line is 1–10; at most 50 lines.
 */

export const CartProductSchema = z.object({
  title: z.string(),
  slug: z.string(),
  pricePaise: PaiseSchema,
  imageUrl: z.string().nullable(),
  sellerDisplayName: z.string(),
  isPurchasable: z.boolean(),
})
export type CartProduct = z.infer<typeof CartProductSchema>

export const CartLineSchema = z.object({
  productId: UuidSchema,
  qty: z.number().int().min(1).max(10),
  product: CartProductSchema,
})
export type CartLine = z.infer<typeof CartLineSchema>

export const CartSchema = z.object({
  items: z.array(CartLineSchema).max(50),
  /** Sum of qty over all lines. */
  itemCount: z.number().int().nonnegative(),
  /** Purchasable lines only. */
  subtotalPaise: PaiseSchema,
  updatedAt: IsoDateSchema.nullable(),
})
export type Cart = z.infer<typeof CartSchema>

export const WishlistItemSchema = z.object({
  productId: UuidSchema,
  addedAt: IsoDateSchema,
  product: CartProductSchema,
})
export type WishlistItem = z.infer<typeof WishlistItemSchema>

/** PUT /v1/cart/items/:productId — qty 0 removes the line. */
export const SetCartQtyBodySchema = z.object({ qty: z.number().int().min(0).max(10) })
export type SetCartQtyBody = z.infer<typeof SetCartQtyBodySchema>

export const CartItemInputSchema = z.object({ productId: UuidSchema, qty: z.number().int().min(1).max(10) })
export type CartItemInput = z.infer<typeof CartItemInputSchema>

/** POST /v1/cart/merge — the guest cart from the browser. */
export const CartMergeBodySchema = z.object({ items: z.array(CartItemInputSchema).max(50) })
export type CartMergeBody = z.infer<typeof CartMergeBodySchema>

export const ProductIdParamsSchema = z.object({ productId: UuidSchema })
export type ProductIdParams = z.infer<typeof ProductIdParamsSchema>
