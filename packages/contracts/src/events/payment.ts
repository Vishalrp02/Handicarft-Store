import { z } from 'zod'

import { IsoDateSchema, UuidSchema } from '../common/ids'
import { PaiseSchema } from '../common/money'

export const PaymentCapturedV1Schema = z.object({
  paymentIntentId: UuidSchema,
  orderId: UuidSchema,
  amountPaise: PaiseSchema.min(1),
  gatewayPaymentId: z.string(),
  method: z.string().nullable(),
  capturedAt: IsoDateSchema,
})
export type PaymentCapturedV1 = z.infer<typeof PaymentCapturedV1Schema>

export const PaymentFailedV1Schema = z.object({
  paymentIntentId: UuidSchema,
  orderId: UuidSchema,
  gatewayPaymentId: z.string(),
  reason: z.string(),
})
export type PaymentFailedV1 = z.infer<typeof PaymentFailedV1Schema>

/**
 * order_refund: money returned for the order itself (cancellations, late payment, admin refunds).
 * duplicate_payment: the buyer paid the same order twice and the extra payment was returned;
 * order status and seller ledgers must NOT change for this kind.
 */
export const RefundKindSchema = z.enum(['order_refund', 'duplicate_payment'])
export type RefundKind = z.infer<typeof RefundKindSchema>

const refundFields = {
  refundId: UuidSchema,
  orderId: UuidSchema,
  sellerOrderId: UuidSchema.nullable(),
  amountPaise: PaiseSchema.min(1),
  kind: RefundKindSchema,
  reason: z.string(),
}

export const RefundProcessedV1Schema = z.object(refundFields)
export type RefundProcessedV1 = z.infer<typeof RefundProcessedV1Schema>

export const RefundFailedV1Schema = z.object(refundFields)
export type RefundFailedV1 = z.infer<typeof RefundFailedV1Schema>
