import { z } from 'zod'

import { UuidSchema } from '../common/ids'
import { PaiseSchema } from '../common/money'
import { CommissionBpsSchema } from '../http/seller'

export const SellerAppliedV1Schema = z.object({
  sellerId: UuidSchema,
  userId: UuidSchema,
  displayName: z.string(),
})
export type SellerAppliedV1 = z.infer<typeof SellerAppliedV1Schema>

export const SellerApprovedV1Schema = z.object({
  sellerId: UuidSchema,
  userId: UuidSchema,
  slug: z.string(),
  displayName: z.string(),
  region: z.string(),
  contactEmail: z.string(),
  commissionBps: CommissionBpsSchema,
})
export type SellerApprovedV1 = z.infer<typeof SellerApprovedV1Schema>

export const SellerRejectedV1Schema = z.object({
  sellerId: UuidSchema,
  userId: UuidSchema,
  contactEmail: z.string(),
  reason: z.string(),
})
export type SellerRejectedV1 = z.infer<typeof SellerRejectedV1Schema>

export const SellerSuspendedV1Schema = z.object({
  sellerId: UuidSchema,
  userId: UuidSchema,
  reason: z.string(),
})
export type SellerSuspendedV1 = z.infer<typeof SellerSuspendedV1Schema>

export const SellerReinstatedV1Schema = z.object({ sellerId: UuidSchema, userId: UuidSchema })
export type SellerReinstatedV1 = z.infer<typeof SellerReinstatedV1Schema>

export const PayoutPaidV1Schema = z.object({
  payoutId: UuidSchema,
  sellerId: UuidSchema,
  amountPaise: PaiseSchema.min(1),
  utr: z.string(),
  contactEmail: z.string(),
})
export type PayoutPaidV1 = z.infer<typeof PayoutPaidV1Schema>
