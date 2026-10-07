import { z } from 'zod'

import { UuidSchema } from '../common/ids'
import { RoleSchema } from '../common/roles'

/** Payload of the EdDSA access token issued by identity (docs/architecture/02 §6). */
export const AccessTokenClaimsSchema = z.object({
  sub: UuidSchema,
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
  roles: z.array(RoleSchema).min(1),
  sellerId: UuidSchema.optional(),
  sid: UuidSchema,
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  iat: z.number().int(),
  exp: z.number().int(),
})
export type AccessTokenClaims = z.infer<typeof AccessTokenClaimsSchema>
