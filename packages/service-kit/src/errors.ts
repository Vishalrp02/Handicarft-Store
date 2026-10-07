import type { ErrorBody, ErrorCode } from '@craftoria/contracts'
import { ERROR_HTTP_STATUS } from '@craftoria/contracts'
import type { ErrorRequestHandler, RequestHandler } from 'express'

import { getRequestId } from './context'
import type { Logger } from './logger'

/** Base class: throw these from services; errorMiddleware renders them. */
export class AppError extends Error {
  readonly status: number
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    status?: number,
  ) {
    super(message)
    this.name = new.target.name
    this.status = status ?? ERROR_HTTP_STATUS[code]
  }
}

export interface Issue {
  path: string
  message: string
}

export class ValidationError extends AppError {
  constructor(issues: Issue[], message = 'Some fields are invalid', status = 400) {
    super('VALIDATION_FAILED', message, { issues }, status)
  }
}

export class UnauthenticatedError extends AppError {
  constructor(code: 'UNAUTHENTICATED' | 'INVALID_CREDENTIALS' | 'REFRESH_TOKEN_INVALID' = 'UNAUTHENTICATED') {
    const messages = {
      UNAUTHENTICATED: 'Please sign in to continue',
      INVALID_CREDENTIALS: 'Email or password is incorrect',
      REFRESH_TOKEN_INVALID: 'Your session has ended, please sign in again',
    } as const
    super(code, messages[code])
  }
}

export class ForbiddenError extends AppError {
  constructor(code: 'FORBIDDEN' | 'EMAIL_NOT_VERIFIED' | 'ACCOUNT_DISABLED' = 'FORBIDDEN', message?: string) {
    const messages = {
      FORBIDDEN: 'You do not have access to this',
      EMAIL_NOT_VERIFIED: 'Please verify your email address first',
      ACCOUNT_DISABLED: 'This account has been disabled',
    } as const
    super(code, message ?? messages[code])
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super('NOT_FOUND', message)
  }
}

type ConflictCode = Extract<
  ErrorCode,
  | 'CONFLICT'
  | 'EMAIL_TAKEN'
  | 'OUT_OF_STOCK'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVALID_STATE_TRANSITION'
  | 'ALREADY_REVIEWED'
>

export class ConflictError extends AppError {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- narrows `code` to 409 codes
  constructor(code: ConflictCode, message: string, details?: unknown) {
    super(code, message, details)
  }
}

type BusinessRuleCode = Extract<
  ErrorCode,
  | 'CART_EMPTY'
  | 'PRODUCT_UNAVAILABLE'
  | 'PURCHASE_REQUIRED'
  | 'PAYMENT_SIGNATURE_INVALID'
  | 'BUSINESS_RULE_VIOLATED'
>

export class BusinessRuleError extends AppError {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- narrows `code` to 422 codes
  constructor(code: BusinessRuleCode, message: string, details?: unknown) {
    super(code, message, details)
  }
}

export class TooManyAttemptsError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super('TOO_MANY_ATTEMPTS', 'Too many attempts, please try again later', { retryAfterSeconds })
  }
}

export class UpstreamUnavailableError extends AppError {
  constructor(readonly dependency: string) {
    super('UPSTREAM_UNAVAILABLE', 'A service we depend on is unavailable, please try again', { dependency })
  }
}

function isZodLikeError(err: unknown): err is { issues: { path: PropertyKey[]; message: string }[] } {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'ZodError' &&
    Array.isArray((err as { issues?: unknown }).issues)
  )
}

export function zodIssuesToIssues(issues: { path: PropertyKey[]; message: string }[]): Issue[] {
  return issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))
}

/** body-parser errors carry `type` and `status`. */
function bodyParserError(err: unknown): AppError | null {
  if (typeof err !== 'object' || err === null) return null
  const { type } = err as { type?: unknown }
  if (type === 'entity.too.large') return new ValidationError([], 'Request body is too large', 413)
  if (type === 'entity.parse.failed') return new ValidationError([], 'Request body is not valid JSON')
  if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
    return new ValidationError([], 'Unsupported request encoding', 415)
  }
  return null
}

function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err
  if (isZodLikeError(err)) return new ValidationError(zodIssuesToIssues(err.issues))
  return bodyParserError(err)
}

/** Renders every error as `{ error: { code, message, details?, requestId } }`. */
export function errorMiddleware(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    const requestId = getRequestId()
    const appError = toAppError(err)

    if (!appError) {
      logger.error({ err }, 'unhandled error')
      const body: ErrorBody = { error: { code: 'INTERNAL', message: 'Something went wrong', requestId } }
      res.status(500).json(body)
      return
    }

    if (appError.status >= 500) logger.error({ err: appError }, appError.message)
    else logger.debug({ code: appError.code, status: appError.status }, appError.message)

    if (appError instanceof TooManyAttemptsError)
      res.setHeader('Retry-After', String(appError.retryAfterSeconds))
    const body: ErrorBody = {
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details === undefined ? {} : { details: appError.details }),
        requestId,
      },
    }
    res.status(appError.status).json(body)
  }
}

export const notFoundMiddleware: RequestHandler = (_req, _res, next) => {
  next(new NotFoundError('No such endpoint'))
}
