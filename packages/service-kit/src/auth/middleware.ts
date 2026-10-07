import { createHash, timingSafeEqual } from 'node:crypto'

import type { Role } from '@craftoria/contracts'
import type { Request, RequestHandler } from 'express'

import { requestContext } from '../context'
import { ForbiddenError, UnauthenticatedError } from '../errors'
import type { AuthContext } from './types'
import type { JwtVerifier } from './verifier'

function bearerToken(req: Request): string | null {
  const header = req.header('authorization')
  if (!header) return null
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header)
  if (!match?.[1]) throw new UnauthenticatedError()
  return match[1]
}

function attach(req: Request, auth: AuthContext): void {
  req.auth = auth
  const ctx = requestContext.getStore()
  if (ctx) ctx.userId = auth.userId
}

function requireAuthed(req: Request): AuthContext {
  if (!req.auth) throw new UnauthenticatedError()
  return req.auth
}

/** 401 unless the request carries a valid access token. */
export function requireAuth(verifier: JwtVerifier): RequestHandler {
  return (req, _res, next) => {
    const run = async () => {
      const token = bearerToken(req)
      if (!token) throw new UnauthenticatedError()
      attach(req, await verifier.verify(token))
    }
    run().then(() => {
      next()
    }, next)
  }
}

/** Anonymous is fine; a token that is present must be valid. */
export function optionalAuth(verifier: JwtVerifier): RequestHandler {
  return (req, _res, next) => {
    const run = async () => {
      const token = bearerToken(req)
      if (token) attach(req, await verifier.verify(token))
    }
    run().then(() => {
      next()
    }, next)
  }
}

/** 403 unless the caller has at least one of the roles. Use after requireAuth. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    const auth = requireAuthed(req)
    if (!roles.some((r) => auth.roles.includes(r))) throw new ForbiddenError()
    next()
  }
}

/** Approved artisans only: the `artisan` role and a sellerId. Seller ids always come from here, never the URL. */
export function requireSeller(): RequestHandler {
  return (req, _res, next) => {
    const auth = requireAuthed(req)
    if (!auth.roles.includes('artisan') || !auth.sellerId) {
      throw new ForbiddenError('FORBIDDEN', 'This area is for approved artisans')
    }
    next()
  }
}

/** Checkout and seller applications need a verified email. */
export function requireVerifiedEmail(): RequestHandler {
  return (req, _res, next) => {
    if (!requireAuthed(req).emailVerified) throw new ForbiddenError('EMAIL_NOT_VERIFIED')
    next()
  }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest()

/**
 * Service-to-service calls (/internal/*) must carry X-Internal-Token.
 * Compared as SHA-256 digests with timingSafeEqual so neither content nor length leaks through timing.
 */
export function requireInternal(expectedToken: string): RequestHandler {
  if (expectedToken.length < 32) throw new Error('INTERNAL_API_TOKEN must be at least 32 characters')
  const expected = sha256(expectedToken)
  return (req, _res, next) => {
    const given = req.header('x-internal-token')
    if (!given || !timingSafeEqual(sha256(given), expected)) throw new UnauthenticatedError()
    next()
  }
}
