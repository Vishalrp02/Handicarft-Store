import { z } from 'zod'

import { AddressInputSchema } from '../common/address'
import { IsoDateSchema, UuidSchema } from '../common/ids'
import { PaiseSchema } from '../common/money'
import { ActorTypeSchema, SellerOrderStatusSchema } from '../http/order'

export const OrderPlacedV1Schema = z.object({
  orderId: UuidSchema,
  orderNumber: z.string(),
  userId: UuidSchema,
  customerEmail: z.string(),
  customerName: z.string(),
  totalPaise: PaiseSchema,
})
export type OrderPlacedV1 = z.infer<typeof OrderPlacedV1Schema>

export const OrderPaidV1Schema = z.object({
  orderId: UuidSchema,
  orderNumber: z.string(),
  userId: UuidSchema,
  customerEmail: z.string(),
  customerName: z.string(),
  totalPaise: PaiseSchema,
  shippingPaise: PaiseSchema,
  paidAt: IsoDateSchema,
  shippingAddress: AddressInputSchema,
  sellerOrders: z
    .array(
      z.object({
        sellerOrderId: UuidSchema,
        sellerId: UuidSchema,
        subtotalPaise: PaiseSchema,
        items: z
          .array(
            z.object({
              productId: UuidSchema,
              title: z.string(),
              qty: z.number().int().min(1),
              unitPricePaise: PaiseSchema.min(1),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
})
export type OrderPaidV1 = z.infer<typeof OrderPaidV1Schema>

/** Only unpaid orders are cancelled as a whole; paid orders cancel per seller order. */
export const OrderCancelledV1Schema = z.object({
  orderId: UuidSchema,
  orderNumber: z.string(),
  userId: UuidSchema,
  reason: z.enum(['payment_timeout', 'buyer_cancelled', 'admin_cancelled']),
  wasPaid: z.literal(false),
})
export type OrderCancelledV1 = z.infer<typeof OrderCancelledV1Schema>

export const OrderRefundRequiredV1Schema = z.object({
  orderId: UuidSchema,
  /** null = refund the whole order (late payment, stock commit failure). */
  sellerOrderId: UuidSchema.nullable(),
  amountPaise: PaiseSchema.min(1),
  reason: z.enum(['seller_order_cancelled', 'late_payment', 'commit_failed']),
})
export type OrderRefundRequiredV1 = z.infer<typeof OrderRefundRequiredV1Schema>

export const SellerOrderStatusChangedV1Schema = z.object({
  sellerOrderId: UuidSchema,
  orderId: UuidSchema,
  orderNumber: z.string(),
  sellerId: UuidSchema,
  userId: UuidSchema,
  customerEmail: z.string(),
  from: SellerOrderStatusSchema,
  to: SellerOrderStatusSchema,
  actorType: ActorTypeSchema,
  trackingCarrier: z.string().optional(),
  trackingNumber: z.string().optional(),
  reason: z.string().optional(),
})
export type SellerOrderStatusChangedV1 = z.infer<typeof SellerOrderStatusChangedV1Schema>

export const SellerOrderDeliveredV1Schema = z.object({
  sellerOrderId: UuidSchema,
  orderId: UuidSchema,
  sellerId: UuidSchema,
  deliveredAt: IsoDateSchema,
})
export type SellerOrderDeliveredV1 = z.infer<typeof SellerOrderDeliveredV1Schema>
