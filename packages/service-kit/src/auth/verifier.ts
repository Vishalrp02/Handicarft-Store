import type { AccessTokenClaims } from '@craftoria/contracts'
import { AccessTokenClaimsSchema } from '@craftoria/contracts'
import type { JSONWebKeySet, JWTVerifyGetKey } from 'jose'
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose'

import { UnauthenticatedError } from '../errors'
import type { AuthContext } from './types'

export interface JwtVerifier {
  /** Resolves the caller, or throws UnauthenticatedError for any invalid token. */
  verify(token: string): Promise<AuthContext>
}

interface VerifierOptions {
  issuer: string
  audience: string
}

/** Only identity's EdDSA (Ed25519) keys are trusted; HS256/none/RS* tokens are rejected. */
const ALGORITHMS = ['EdDSA']
const CLOCK_TOLERANCE_SECONDS = 30

function toAuthContext(claims: AccessTokenClaims): AuthContext {
  return {
    userId: claims.sub,
    email: claims.email,
    name: claims.name,
    emailVerified: claims.emailVerified,
    roles: claims.roles,
    sellerId: claims.sellerId ?? null,
    sessionId: claims.sid,
  }
}

function buildVerifier(keys: JWTVerifyGetKey, { issuer, audience }: VerifierOptions): JwtVerifier {
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, keys, {
          issuer,
          audience,
          algorithms: ALGORITHMS,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          requiredClaims: ['sub', 'exp', 'iat'],
        })
        return toAuthContext(AccessTokenClaimsSchema.parse(payload))
      } catch {
        // never reveal why (expired vs forged) to the caller
        throw new UnauthenticatedError()
      }
    },
  }
}

/** Production: fetches identity's public keys and caches them for 10 minutes. */
export function createJwtVerifier(opts: VerifierOptions & { jwksUrl: string }): JwtVerifier {
  const keys = createRemoteJWKSet(new URL(opts.jwksUrl), {
    cacheMaxAge: 600_000,
    cooldownDuration: 30_000,
    timeoutDuration: 3_000,
  })
  return buildVerifier(keys, opts)
}

/** Identity itself and tests: verify against a key set held in memory. */
export function createLocalJwtVerifier(opts: VerifierOptions & { jwks: JSONWebKeySet }): JwtVerifier {
  return buildVerifier(createLocalJWKSet(opts.jwks), opts)
}
