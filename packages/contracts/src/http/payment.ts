import { z } from 'zod'

import { IsoDateSchema, UuidSchema } from '../common/ids'
import { CurrencySchema, PaiseSchema } from '../common/money'
import { CursorQuerySchema } from '../common/pagination'

export const PaymentIntentStatusSchema = z.enum([
  'created',
  'captured',
  'failed',
  'refunded',
  'partially_refunded',
])
export type PaymentIntentStatus = z.infer<typeof PaymentIntentStatusSchema>

export const RefundRecordStatusSchema = z.enum(['pending', 'processed', 'failed'])
export type RefundRecordStatus = z.infer<typeof RefundRecordStatusSchema>

// --- responses ----------------------------------------------------------------

/** Admin view of a payment intent (not defined in doc 03 before; added with this package). */
export const PaymentIntentSchema = z.object({
  id: UuidSchema,
  orderId: UuidSchema,
  userId: UuidSchema,
  amountPaise: PaiseSchema,
  currency: CurrencySchema,
  status: PaymentIntentStatusSchema,
  gatewayOrderId: z.string(),
  gatewayPaymentId: z.string().nullable(),
  method: z.string().nullable(),
  refundedPaise: PaiseSchema,
  failureReason: z.string().nullable(),
  capturedAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
})
export type PaymentIntent = z.infer<typeof PaymentIntentSchema>

export const RefundSchema = z.object({
  id: UuidSchema,
  orderId: UuidSchema,
  sellerOrderId: UuidSchema.nullable(),
  amountPaise: PaiseSchema,
  status: RefundRecordStatusSchema,
  reason: z.string(),
  createdAt: IsoDateSchema,
  processedAt: IsoDateSchema.nullable(),
})
export type Refund = z.infer<typeof RefundSchema>

export const VerifyPaymentResponseSchema = z.object({ status: PaymentIntentStatusSchema })
export type VerifyPaymentResponse = z.infer<typeof VerifyPaymentResponseSchema>

// --- requests -------------------------------------------------------------------

export const VerifyPaymentSchema = z.object({
  razorpayOrderId: z.string().min(1).max(100),
  razorpayPaymentId: z.string().min(1).max(100),
  razorpaySignature: z.string().min(1).max(200),
})
export type VerifyPayment = z.infer<typeof VerifyPaymentSchema>

export const AdminRefundRequestSchema = z.object({
  orderId: UuidSchema,
  sellerOrderId: UuidSchema.optional(),
  amountPaise: PaiseSchema.min(1),
  reason: z.string().trim().min(5).max(200),
})
export type AdminRefundRequest = z.infer<typeof AdminRefundRequestSchema>

export const AdminPaymentsQuerySchema = CursorQuerySchema.extend({
  orderId: UuidSchema.optional(),
  status: PaymentIntentStatusSchema.optional(),
})
export type AdminPaymentsQuery = z.infer<typeof AdminPaymentsQuerySchema>

export const AdminRefundsQuerySchema = CursorQuerySchema.extend({
  status: RefundRecordStatusSchema.optional(),
})
export type AdminRefundsQuery = z.infer<typeof AdminRefundsQuerySchema>
