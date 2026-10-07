import { describe, expect, it } from 'vitest'

import {
  AppError,
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyAttemptsError,
  UnauthenticatedError,
  UpstreamUnavailableError,
  ValidationError,
} from './errors'

describe('AppError subclasses map to their status codes', () => {
  it.each([
    [new ValidationError([{ path: 'email', message: 'Invalid email' }]), 400, 'VALIDATION_FAILED'],
    [new UnauthenticatedError(), 401, 'UNAUTHENTICATED'],
    [new UnauthenticatedError('INVALID_CREDENTIALS'), 401, 'INVALID_CREDENTIALS'],
    [new ForbiddenError(), 403, 'FORBIDDEN'],
    [new ForbiddenError('EMAIL_NOT_VERIFIED'), 403, 'EMAIL_NOT_VERIFIED'],
    [new NotFoundError(), 404, 'NOT_FOUND'],
    [new ConflictError('OUT_OF_STOCK', 'Only 1 left', { items: [] }), 409, 'OUT_OF_STOCK'],
    [new BusinessRuleError('CART_EMPTY', 'Your bag is empty'), 422, 'CART_EMPTY'],
    [new TooManyAttemptsError(90), 429, 'TOO_MANY_ATTEMPTS'],
    [new UpstreamUnavailableError('catalog'), 503, 'UPSTREAM_UNAVAILABLE'],
  ] as const)('%s → %i %s', (err, status, code) => {
    expect(err).toBeInstanceOf(AppError)
    expect(err.status).toBe(status)
    expect(err.code).toBe(code)
  })

  it('carries details and retry-after', () => {
    expect(new ConflictError('OUT_OF_STOCK', 'x', { items: [1] }).details).toEqual({ items: [1] })
    expect(new TooManyAttemptsError(90).retryAfterSeconds).toBe(90)
    expect(new ValidationError([{ path: 'a', message: 'b' }]).details).toEqual({
      issues: [{ path: 'a', message: 'b' }],
    })
  })
})
