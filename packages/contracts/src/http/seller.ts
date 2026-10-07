import { z } from 'zod'

import { IndianPhoneSchema } from '../common/address'
import { HttpsUrlSchema, ReasonSchema } from '../common/fields'
import { IsoDateSchema, UuidSchema } from '../common/ids'
import { PaiseSchema, SignedPaiseSchema } from '../common/money'
import { CursorQuerySchema } from '../common/pagination'

export const SellerStatusSchema = z.enum(['applied', 'approved', 'rejected', 'suspended'])
export type SellerStatus = z.infer<typeof SellerStatusSchema>

/** 15-character GSTIN: state code, PAN, entity number, 'Z', checksum. */
export const GstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a valid 15-character GSTIN')

/** Commission in basis points, 0 to 50 %. */
export const CommissionBpsSchema = z.number().int().min(0).max(5000)

export const LedgerEntryTypeSchema = z.enum([
  'sale',
  'commission',
  'refund_reversal',
  'commission_reversal',
  'payout',
  'adjustment',
])
export type LedgerEntryType = z.infer<typeof LedgerEntryTypeSchema>

export const LedgerStatusSchema = z.enum(['pending', 'available', 'paid'])
export const PayoutStatusSchema = z.enum(['pending', 'paid', 'failed'])

// --- responses ----------------------------------------------------------------

export const SellerProfileSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  slug: z.string(),
  displayName: z.string(),
  bio: z.string().nullable(),
  craft: z.string(),
  region: z.string(),
  avatarUrl: z.string().nullable(),
  bannerUrl: z.string().nullable(),
  status: SellerStatusSchema,
  commissionBps: z.number().int(),
  contactEmail: z.string(),
  contactPhone: z.string(),
  gstin: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: IsoDateSchema,
  approvedAt: IsoDateSchema.nullable(),
})
export type SellerProfile = z.infer<typeof SellerProfileSchema>

export const PublicSellerSchema = SellerProfileSchema.pick({
  id: true,
  slug: true,
  displayName: true,
  bio: true,
  craft: true,
  region: true,
  avatarUrl: true,
  bannerUrl: true,
}).extend({ memberSince: IsoDateSchema })
export type PublicSeller = z.infer<typeof PublicSellerSchema>

export const BankAccountOutSchema = z.object({
  accountHolderName: z.string(),
  accountNumberLast4: z.string().length(4),
  ifsc: z.string(),
  updatedAt: IsoDateSchema,
})
export type BankAccountOut = z.infer<typeof BankAccountOutSchema>

export const LedgerEntrySchema = z.object({
  id: UuidSchema,
  sellerOrderId: UuidSchema.nullable(),
  orderNumber: z.string().nullable(),
  type: LedgerEntryTypeSchema,
  /** Signed: sales are positive, commission/refunds/payouts negative. */
  amountPaise: SignedPaiseSchema,
  status: LedgerStatusSchema,
  availableAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
})
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>

export const BalanceSchema = z.object({
  pendingPaise: SignedPaiseSchema,
  availablePaise: SignedPaiseSchema,
  paidPaise: SignedPaiseSchema,
})
export type Balance = z.infer<typeof BalanceSchema>

export const PayoutSchema = z.object({
  id: UuidSchema,
  sellerId: UuidSchema,
  sellerDisplayName: z.string(),
  amountPaise: PaiseSchema,
  status: PayoutStatusSchema,
  utr: z.string().nullable(),
  createdAt: IsoDateSchema,
  paidAt: IsoDateSchema.nullable(),
})
export type Payout = z.infer<typeof PayoutSchema>

// --- requests -------------------------------------------------------------------

export const SellerApplySchema = z.object({
  displayName: z.string().trim().min(3).max(60),
  bio: z.string().trim().max(2000).optional(),
  craft: z.string().trim().min(2).max(60),
  region: z.string().trim().min(2).max(80),
  contactPhone: IndianPhoneSchema,
  gstin: GstinSchema.optional(),
})
export type SellerApply = z.infer<typeof SellerApplySchema>

export const SellerProfilePatchSchema = z.object({
  bio: z.string().trim().max(2000).optional(),
  avatarUrl: HttpsUrlSchema.nullable().optional(),
  bannerUrl: HttpsUrlSchema.nullable().optional(),
  contactPhone: IndianPhoneSchema.optional(),
  gstin: GstinSchema.nullable().optional(),
})
export type SellerProfilePatch = z.infer<typeof SellerProfilePatchSchema>

export const BankAccountInSchema = z.object({
  accountHolderName: z.string().trim().min(2).max(100),
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{9,18}$/, 'Account number is 9 to 18 digits'),
  ifsc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid 11-character IFSC'),
})
export type BankAccountIn = z.infer<typeof BankAccountInSchema>

export const LedgerQuerySchema = CursorQuerySchema.extend({ status: LedgerStatusSchema.optional() })
export type LedgerQuery = z.infer<typeof LedgerQuerySchema>

export const AdminSellersQuerySchema = CursorQuerySchema.extend({
  status: SellerStatusSchema.optional(),
  q: z.string().trim().min(1).max(100).optional(),
})
export type AdminSellersQuery = z.infer<typeof AdminSellersQuerySchema>

export const ApproveSellerBodySchema = z.object({ commissionBps: CommissionBpsSchema.optional() })
export type ApproveSellerBody = z.infer<typeof ApproveSellerBodySchema>

export const SellerReasonBodySchema = z.object({ reason: ReasonSchema })
export type SellerReasonBody = z.infer<typeof SellerReasonBodySchema>

export const CommissionPatchBodySchema = z.object({ commissionBps: CommissionBpsSchema })
export type CommissionPatchBody = z.infer<typeof CommissionPatchBodySchema>

export const PayoutsQuerySchema = CursorQuerySchema.extend({ status: PayoutStatusSchema.optional() })
export type PayoutsQuery = z.infer<typeof PayoutsQuerySchema>

export const MarkPayoutPaidBodySchema = z.object({ utr: z.string().trim().min(6).max(30) })
export type MarkPayoutPaidBody = z.infer<typeof MarkPayoutPaidBodySchema>

export const MarkPayoutFailedBodySchema = z.object({ reason: ReasonSchema })
export type MarkPayoutFailedBody = z.infer<typeof MarkPayoutFailedBodySchema>
