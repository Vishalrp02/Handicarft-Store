import { z } from 'zod'

/** Every error code the API may return (docs/architecture/03 §1.1). */
export const ERROR_HTTP_STATUS = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  REFRESH_TOKEN_INVALID: 401,
  FORBIDDEN: 403,
  EMAIL_NOT_VERIFIED: 403,
  ACCOUNT_DISABLED: 403,
  NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
  CONFLICT: 409,
  OUT_OF_STOCK: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  INVALID_STATE_TRANSITION: 409,
  ALREADY_REVIEWED: 409,
  CART_EMPTY: 422,
  PRODUCT_UNAVAILABLE: 422,
  PURCHASE_REQUIRED: 422,
  PAYMENT_SIGNATURE_INVALID: 422,
  BUSINESS_RULE_VIOLATED: 422,
  TOO_MANY_ATTEMPTS: 429,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const

type ErrorCodeKey = keyof typeof ERROR_HTTP_STATUS

export const ErrorCode = z.enum(Object.keys(ERROR_HTTP_STATUS) as [ErrorCodeKey, ...ErrorCodeKey[]])
export type ErrorCode = z.infer<typeof ErrorCode>

/** The one error shape every service returns. */
export const ErrorBodySchema = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
})
export type ErrorBody = z.infer<typeof ErrorBodySchema>
