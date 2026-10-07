import { z } from 'zod'

import { AddressInputSchema } from '../common/address'
import { IsoDateSchema, UuidSchema } from '../common/ids'
import { CurrencySchema, PaiseSchema } from '../common/money'
import { CursorQuerySchema } from '../common/pagination'

export const OrderStatusSchema = z.enum(['pending_payment', 'paid', 'completed', 'cancelled'])
export type OrderStatus = z.infer<typeof OrderStatusSchema>

export const SellerOrderStatusSchema = z.enum([
  'pending',
  'awaiting_acceptance',
  'accepted',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
])
export type SellerOrderStatus = z.infer<typeof SellerOrderStatusSchema>

export const RefundStatusSchema = z.enum(['none', 'pending', 'refunded', 'failed'])
export type RefundStatus = z.infer<typeof RefundStatusSchema>

export const SellerOrderActionSchema = z.enum(['accept', 'pack', 'ship', 'deliver', 'cancel'])
export type SellerOrderAction = z.infer<typeof SellerOrderActionSchema>

export const ActorTypeSchema = z.enum(['buyer', 'seller', 'admin', 'system'])
export type ActorType = z.infer<typeof ActorTypeSchema>

// --- responses ----------------------------------------------------------------

export const OrderItemSchema = z.object({
  id: UuidSchema,
  productId: UuidSchema,
  title: z.string(),
  slug: z.string(),
  imageUrl: z.string().nullable(),
  unitPricePaise: PaiseSchema,
  qty: z.number().int().positive(),
  lineTotalPaise: PaiseSchema,
  taxRateBps: z.number().int(),
})
export type OrderItem = z.infer<typeof OrderItemSchema>

export const SellerOrderSchema = z.object({
  id: UuidSchema,
  sellerId: UuidSchema,
  sellerDisplayName: z.string(),
  status: SellerOrderStatusSchema,
  subtotalPaise: PaiseSchema,
  items: z.array(OrderItemSchema),
  trackingCarrier: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  refundStatus: RefundStatusSchema,
  cancelReason: z.string().nullable(),
  acceptedAt: IsoDateSchema.nullable(),
  shippedAt: IsoDateSchema.nullable(),
  deliveredAt: IsoDateSchema.nullable(),
  cancelledAt: IsoDateSchema.nullable(),
})
export type SellerOrder = z.infer<typeof SellerOrderSchema>

export const OrderSchema = z.object({
  id: UuidSchema,
  orderNumber: z.string(),
  status: OrderStatusSchema,
  displayStatus: z.string(),
  itemsSubtotalPaise: PaiseSchema,
  shippingPaise: PaiseSchema,
  totalPaise: PaiseSchema,
  currency: CurrencySchema,
  shippingAddress: AddressInputSchema,
  sellerOrders: z.array(SellerOrderSchema),
  placedAt: IsoDateSchema,
  paidAt: IsoDateSchema.nullable(),
  expiresAt: IsoDateSchema.nullable(),
  cancelledAt: IsoDateSchema.nullable(),
  cancelReason: z.string().nullable(),
})
export type Order = z.infer<typeof OrderSchema>

export const StatusHistoryEntrySchema = z.object({
  from: z.string().nullable(),
  to: z.string(),
  actorType: ActorTypeSchema,
  reason: z.string().nullable(),
  at: IsoDateSchema,
})
export type StatusHistoryEntry = z.infer<typeof StatusHistoryEntrySchema>

export const OrderWithHistorySchema = OrderSchema.extend({ history: z.array(StatusHistoryEntrySchema) })
export type OrderWithHistory = z.infer<typeof OrderWithHistorySchema>

export const OrderSummarySchema = OrderSchema.pick({
  id: true,
  orderNumber: true,
  status: true,
  displayStatus: true,
  totalPaise: true,
  placedAt: true,
}).extend({ itemCount: z.number().int().nonnegative(), firstItemImageUrl: z.string().nullable() })
export type OrderSummary = z.infer<typeof OrderSummarySchema>

export const PaymentDetailsSchema = z.object({
  provider: z.literal('razorpay'),
  keyId: z.string(),
  gatewayOrderId: z.string(),
  amountPaise: PaiseSchema,
  currency: CurrencySchema,
})
export type PaymentDetails = z.infer<typeof PaymentDetailsSchema>

export const CheckoutResponseSchema = z.object({ order: OrderSchema, payment: PaymentDetailsSchema })
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>

export const SellerOrderViewSchema = SellerOrderSchema.extend({
  orderId: UuidSchema,
  orderNumber: z.string(),
  placedAt: IsoDateSchema,
  shippingAddress: AddressInputSchema,
  customerName: z.string(),
})
export type SellerOrderView = z.infer<typeof SellerOrderViewSchema>

export const AdminOrderSummarySchema = OrderSummarySchema.extend({ customerEmail: z.string() })
export type AdminOrderSummary = z.infer<typeof AdminOrderSummarySchema>

export const AdminOrderDetailSchema = OrderWithHistorySchema.extend({
  customerEmail: z.string(),
  customerName: z.string(),
})
export type AdminOrderDetail = z.infer<typeof AdminOrderDetailSchema>

const Count = z.number().int().nonnegative()

export const AdminStatsSchema = z.object({
  gmvPaise: z.object({ today: PaiseSchema, last7d: PaiseSchema, last30d: PaiseSchema }),
  orders: z.object({ today: Count, last7d: Count, pendingAcceptance: Count, awaitingShipment: Count }),
  refundsPendingCount: Count,
})
export type AdminStats = z.infer<typeof AdminStatsSchema>

// --- requests -------------------------------------------------------------------

/** The client sends only the address; every amount is computed on the server. */
export const CheckoutRequestSchema = z.object({ shippingAddress: AddressInputSchema })
export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>

export const OrderCancelBodySchema = z.object({ reason: z.string().trim().max(200).optional() })
export type OrderCancelBody = z.infer<typeof OrderCancelBodySchema>

export const ShipBodySchema = z.object({
  carrier: z.string().trim().min(2).max(40),
  trackingNumber: z.string().trim().min(4).max(40),
})
export type ShipBody = z.infer<typeof ShipBodySchema>

export const CancelBodySchema = z.object({ reason: z.string().trim().min(5).max(200) })
export type CancelBody = z.infer<typeof CancelBodySchema>

/** Admin override: a reason is always required; ship also needs tracking. */
export const AdminSellerOrderActionBodySchema = z.object({
  reason: z.string().trim().min(5).max(200),
  carrier: z.string().trim().min(2).max(40).optional(),
  trackingNumber: z.string().trim().min(4).max(40).optional(),
})
export type AdminSellerOrderActionBody = z.infer<typeof AdminSellerOrderActionBodySchema>

export const SellerOrderActionParamsSchema = z.object({ id: UuidSchema, action: SellerOrderActionSchema })
export type SellerOrderActionParams = z.infer<typeof SellerOrderActionParamsSchema>

export const SellerOrdersQuerySchema = CursorQuerySchema.extend({
  status: SellerOrderStatusSchema.optional(),
})
export type SellerOrdersQuery = z.infer<typeof SellerOrdersQuerySchema>

export const AdminOrdersQuerySchema = CursorQuerySchema.extend({
  status: OrderStatusSchema.optional(),
  /** Exact order number or customer email (partial). */
  q: z.string().trim().min(1).max(100).optional(),
})
export type AdminOrdersQuery = z.infer<typeof AdminOrdersQuerySchema>
