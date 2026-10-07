import { z } from 'zod'

import { AddressInputSchema, IndianPhoneSchema } from '../common/address'
import { EmailSchema } from '../common/fields'
import { IsoDateSchema, UuidSchema } from '../common/ids'
import { CursorQuerySchema } from '../common/pagination'
import { RoleSchema } from '../common/roles'

const NameSchema = z.string().trim().min(2).max(80)
/** Policy for new passwords only (register, reset, change). */
const NewPasswordSchema = z.string().min(10).max(128)
/** Login and confirmations accept any length so the policy is not revealed. */
const AnyPasswordSchema = z.string().min(1).max(128)

export const UserStatusSchema = z.enum(['active', 'disabled', 'deleted'])
export type UserStatus = z.infer<typeof UserStatusSchema>

export const PublicUserSchema = z.object({
  id: UuidSchema,
  email: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  emailVerified: z.boolean(),
  roles: z.array(RoleSchema),
  sellerId: UuidSchema.nullable(),
  createdAt: IsoDateSchema,
})
export type PublicUser = z.infer<typeof PublicUserSchema>

export const AdminUserSchema = PublicUserSchema.extend({ status: UserStatusSchema })
export type AdminUser = z.infer<typeof AdminUserSchema>

export const AccessTokenResponseSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: IsoDateSchema,
})
export type AccessTokenResponse = z.infer<typeof AccessTokenResponseSchema>

export const AuthResultSchema = AccessTokenResponseSchema.extend({ user: PublicUserSchema })
export type AuthResult = z.infer<typeof AuthResultSchema>

// --- request bodies -------------------------------------------------------

export const RegisterBodySchema = z.object({
  name: NameSchema,
  email: EmailSchema,
  password: NewPasswordSchema,
})
export type RegisterBody = z.infer<typeof RegisterBodySchema>

export const LoginBodySchema = z.object({ email: EmailSchema, password: AnyPasswordSchema })
export type LoginBody = z.infer<typeof LoginBodySchema>

export const VerifyEmailBodySchema = z.object({ token: z.string().min(1).max(200) })
export type VerifyEmailBody = z.infer<typeof VerifyEmailBodySchema>

export const ForgotPasswordBodySchema = z.object({ email: EmailSchema })
export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBodySchema>

export const ResetPasswordBodySchema = z.object({
  token: z.string().min(1).max(200),
  password: NewPasswordSchema,
})
export type ResetPasswordBody = z.infer<typeof ResetPasswordBodySchema>

export const UpdateMeBodySchema = z.object({
  name: NameSchema.optional(),
  phone: IndianPhoneSchema.nullable().optional(),
})
export type UpdateMeBody = z.infer<typeof UpdateMeBodySchema>

export const ChangePasswordBodySchema = z
  .object({ currentPassword: AnyPasswordSchema, newPassword: NewPasswordSchema })
  .refine((b) => b.currentPassword !== b.newPassword, {
    message: 'New password must be different',
    path: ['newPassword'],
  })
export type ChangePasswordBody = z.infer<typeof ChangePasswordBodySchema>

export const DeleteMeBodySchema = z.object({ password: AnyPasswordSchema })
export type DeleteMeBody = z.infer<typeof DeleteMeBodySchema>

const AddressExtras = { label: z.string().trim().max(30).optional(), isDefault: z.boolean().optional() }

export const AddressCreateBodySchema = AddressInputSchema.extend(AddressExtras)
export type AddressCreateBody = z.infer<typeof AddressCreateBodySchema>

export const AddressUpdateBodySchema = AddressInputSchema.partial().extend(AddressExtras)
export type AddressUpdateBody = z.infer<typeof AddressUpdateBodySchema>

// --- admin ------------------------------------------------------------------

export const AdminUsersQuerySchema = CursorQuerySchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  role: RoleSchema.optional(),
  status: UserStatusSchema.optional(),
})
export type AdminUsersQuery = z.infer<typeof AdminUsersQuerySchema>

export const AdminUserPatchBodySchema = z.object({ status: z.enum(['active', 'disabled']) })
export type AdminUserPatchBody = z.infer<typeof AdminUserPatchBodySchema>

/** Only `admin` is grantable through the API; `artisan` comes from seller approval. */
export const GrantRoleBodySchema = z.object({ role: z.literal('admin') })
export type GrantRoleBody = z.infer<typeof GrantRoleBodySchema>
