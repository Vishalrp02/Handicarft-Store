import { z } from 'zod'

import { UuidSchema } from '../common/ids'

export const UserRegisteredV1Schema = z.object({
  userId: UuidSchema,
  email: z.string(),
  name: z.string(),
})
export type UserRegisteredV1 = z.infer<typeof UserRegisteredV1Schema>

export const UserEmailVerificationRequestedV1Schema = z.object({
  userId: UuidSchema,
  email: z.string(),
  name: z.string(),
  /** Contains a one-time token; never log it. */
  verifyUrl: z.url(),
})
export type UserEmailVerificationRequestedV1 = z.infer<typeof UserEmailVerificationRequestedV1Schema>

export const UserPasswordResetRequestedV1Schema = z.object({
  userId: UuidSchema,
  email: z.string(),
  name: z.string(),
  /** Contains a one-time token valid for 30 min; never log it. */
  resetUrl: z.url(),
})
export type UserPasswordResetRequestedV1 = z.infer<typeof UserPasswordResetRequestedV1Schema>

export const UserDeletedV1Schema = z.object({ userId: UuidSchema })
export type UserDeletedV1 = z.infer<typeof UserDeletedV1Schema>
