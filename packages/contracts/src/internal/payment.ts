import { z } from 'zod'

import { IndianPhoneSchema } from '../common/address'
import { UuidSchema } from '../common/ids'
import { CurrencySchema, PaiseSchema } from '../common/money'

/** order → payment: POST /internal/payment-intents (idempotent per orderId). */
export const CreatePaymentIntentSchema = z.object({
  orderId: UuidSchema,
  userId: UuidSchema,
  /** ₹1 to ₹5,00,000. */
  amountPaise: z.number().int().min(100).max(50_000_000),
  customer: z.object({
    name: z.string().min(1).max(80),
    email: z.string().max(254),
    phone: IndianPhoneSchema,
  }),
})
export type CreatePaymentIntent = z.infer<typeof CreatePaymentIntentSchema>

export const PaymentIntentOutSchema = z.object({
  paymentIntentId: UuidSchema,
  provider: z.literal('razorpay'),
  keyId: z.string(),
  gatewayOrderId: z.string(),
  amountPaise: PaiseSchema,
  currency: CurrencySchema,
})
export type PaymentIntentOut = z.infer<typeof PaymentIntentOutSchema>
