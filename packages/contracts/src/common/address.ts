import { z } from 'zod'

import { UuidSchema } from './ids'
import { IndianStateSchema } from './indian-states'

const text = (min: number, max: number) => z.string().trim().min(min).max(max)

/** Indian mobile: 10 digits starting 6–9, without +91. */
export const IndianPhoneSchema = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, 'Enter a 10-digit mobile number')

/** 6-digit PIN code; the first digit is never 0. */
export const PincodeSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{5}$/, 'Enter a 6-digit PIN code')

export const AddressInputSchema = z.object({
  fullName: text(2, 80),
  phone: IndianPhoneSchema,
  line1: text(3, 120),
  line2: z.string().trim().max(120).optional(),
  landmark: z.string().trim().max(80).optional(),
  city: text(2, 60),
  state: IndianStateSchema,
  pincode: PincodeSchema,
  country: z.literal('IN'),
})
export type AddressInput = z.infer<typeof AddressInputSchema>

export const AddressSchema = AddressInputSchema.extend({
  id: UuidSchema,
  label: z.string().trim().max(30).nullable(),
  isDefault: z.boolean(),
})
export type Address = z.infer<typeof AddressSchema>
