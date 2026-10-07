import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { Express } from 'express'
import { generateKeyPair, SignJWT } from 'jose'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getRequestId, requestContext } from '../context'
import { createHttpApp } from '../http/create-http-app'
import { route } from '../http/route'
import { createLogger } from '../logger'
import { makeTestToken, TEST_INTERNAL_TOKEN, testJwks } from '../testing/auth'
import {
  optionalAuth,
  requireAuth,
  requireInternal,
  requireRole,
  requireSeller,
  requireVerifiedEmail,
} from './middleware'
import type { JwtVerifier } from './verifier'
import { createJwtVerifier, createLocalJwtVerifier } from './verifier'

const ISSUER = 'craftoria-identity'
const AUDIENCE = 'craftoria'
const SELLER_ID = '0192f7a4-3b6c-7d2e-8f10-000000000003'

let verifier: JwtVerifier
let app: Express
let seenUserIdInContext: string | undefined

beforeAll(async () => {
  verifier = createLocalJwtVerifier({ jwks: await testJwks(), issuer: ISSUER, audience: AUDIENCE })
  app = createHttpApp({
    service: 'test',
    logger: createLogger({ service: 'test', level: 'silent' }),
    readiness: () => Promise.resolve({}),
    configure: (a) => {
      a.get(
        '/me',
        requireAuth(verifier),
        route({}, ({ auth }) => {
          seenUserIdInContext = requestContext.getStore()?.userId
          return Promise.resolve({ auth, requestId: getRequestId() })
        }),
      )
      a.get(
        '/maybe',
        optionalAuth(verifier),
        route({}, ({ auth }) => Promise.resolve({ signedIn: auth !== undefined })),
      )
      a.get(
        '/admin',
        requireAuth(verifier),
        requireRole('admin'),
        route({}, () => Promise.resolve({ ok: true })),
      )
      a.get(
        '/seller',
        requireAuth(verifier),
        requireSeller(),
        route({}, () => Promise.resolve({ ok: true })),
      )
      a.get(
        '/checkout',
        requireAuth(verifier),
        requireVerifiedEmail(),
        route({}, () => Promise.resolve({ ok: true })),
      )
      a.get(
        '/internal/x',
        requireInternal(TEST_INTERNAL_TOKEN),
        route({}, () => Promise.resolve({ ok: true })),
      )
      a.get(
        '/no-auth-then-role',
        requireRole('admin'),
        route({}, () => Promise.resolve({ ok: true })),
      )
    },
  })
})

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

describe('verifier', () => {
  it('valid token yields AuthContext', async () => {
    const token = await makeTestToken({
      sub: '0192f7a4-3b6c-7d2e-8f10-000000000007',
      email: 'asha@example.in',
      name: 'Asha Rao',
      roles: ['buyer', 'artisan'],
      sellerId: SELLER_ID,
    })
    const auth = await verifier.verify(token)
    expect(auth).toMatchObject({
      userId: '0192f7a4-3b6c-7d2e-8f10-000000000007',
      email: 'asha@example.in',
      name: 'Asha Rao',
      emailVerified: true,
      roles: ['buyer', 'artisan'],
      sellerId: SELLER_ID,
    })
    expect(auth.sessionId).toEqual(expect.any(String))
  })

  it('sellerId is null when the claim is absent', async () => {
    expect((await verifier.verify(await makeTestToken())).sellerId).toBeNull()
  })
})

describe('requireAuth', () => {
  it('passes a valid token and puts the user id in the request context', async () => {
    const token = await makeTestToken({ sub: '0192f7a4-3b6c-7d2e-8f10-000000000009' })
    const res = await request(app).get('/me').set(bearer(token))
    expect(res.status).toBe(200)
    expect(res.body.auth.userId).toBe('0192f7a4-3b6c-7d2e-8f10-000000000009')
    expect(seenUserIdInContext).toBe('0192f7a4-3b6c-7d2e-8f10-000000000009')
  })

  it('missing token → 401 UNAUTHENTICATED', async () => {
    const res = await request(app).get('/me')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('non-bearer scheme → 401', async () => {
    expect((await request(app).get('/me').set('Authorization', 'Basic YTpi')).status).toBe(401)
  })

  it('expired token → 401 UNAUTHENTICATED', async () => {
    const token = await makeTestToken({ expiresIn: '-2m' })
    const res = await request(app).get('/me').set(bearer(token))
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('token expired less than 30 s ago is still accepted (clock tolerance)', async () => {
    const token = await makeTestToken({ expiresIn: '-10s' })
    expect((await request(app).get('/me').set(bearer(token))).status).toBe(200)
  })

  it('wrong audience → 401', async () => {
    const token = await makeTestToken({ aud: 'someone-else' })
    expect((await request(app).get('/me').set(bearer(token))).status).toBe(401)
  })

  it('wrong issuer → 401', async () => {
    const token = await makeTestToken({ iss: 'evil-identity' })
    expect((await request(app).get('/me').set(bearer(token))).status).toBe(401)
  })

  it('token signed by other key → 401', async () => {
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
    const token = await new SignJWT({
      email: 'x@x.in',
      name: 'X',
      emailVerified: true,
      roles: ['admin'],
      sid: '0192f7a4-3b6c-7d2e-8f10-000000000001',
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key-1' })
      .setSubject('0192f7a4-3b6c-7d2e-8f10-000000000002')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    expect((await request(app).get('/me').set(bearer(token))).status).toBe(401)
  })

  it('HS256 token → 401', async () => {
    const token = await new SignJWT({ roles: ['admin'] })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('0192f7a4-3b6c-7d2e-8f10-000000000002')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-shared-secret-that-is-long-enough'))
    expect((await request(app).get('/me').set(bearer(token))).status).toBe(401)
  })

  it('token missing required claims → 401', async () => {
    const token = await makeTestToken({ roles: [] })
    expect((await request(app).get('/me').set(bearer(token))).status).toBe(401)
  })

  it('garbage token → 401', async () => {
    expect((await request(app).get('/me').set(bearer('not.a.jwt'))).status).toBe(401)
  })
})

describe('optionalAuth', () => {
  it('lets anonymous requests through', async () => {
    const res = await request(app).get('/maybe')
    expect(res.body).toEqual({ signedIn: false })
  })

  it('reads a valid token', async () => {
    const res = await request(app)
      .get('/maybe')
      .set(bearer(await makeTestToken()))
    expect(res.body).toEqual({ signedIn: true })
  })

  it('rejects a present but invalid token', async () => {
    expect((await request(app).get('/maybe').set(bearer('broken'))).status).toBe(401)
  })
})

describe('roles and checks', () => {
  it('requireRole admin rejects buyer with 403 FORBIDDEN', async () => {
    const res = await request(app)
      .get('/admin')
      .set(bearer(await makeTestToken({ roles: ['buyer'] })))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('requireRole admin accepts admin', async () => {
    const res = await request(app)
      .get('/admin')
      .set(bearer(await makeTestToken({ roles: ['buyer', 'admin'] })))
    expect(res.status).toBe(200)
  })

  it('requireRole without requireAuth first is a 401, not a crash', async () => {
    expect((await request(app).get('/no-auth-then-role')).status).toBe(401)
  })

  it('requireSeller rejects artisan without sellerId', async () => {
    const res = await request(app)
      .get('/seller')
      .set(bearer(await makeTestToken({ roles: ['buyer', 'artisan'] })))
    expect(res.status).toBe(403)
  })

  it('requireSeller rejects buyer with a sellerId but no artisan role', async () => {
    const res = await request(app)
      .get('/seller')
      .set(bearer(await makeTestToken({ roles: ['buyer'], sellerId: SELLER_ID })))
    expect(res.status).toBe(403)
  })

  it('requireSeller accepts an approved artisan', async () => {
    const res = await request(app)
      .get('/seller')
      .set(bearer(await makeTestToken({ roles: ['buyer', 'artisan'], sellerId: SELLER_ID })))
    expect(res.status).toBe(200)
  })

  it('requireVerifiedEmail rejects unverified', async () => {
    const res = await request(app)
      .get('/checkout')
      .set(bearer(await makeTestToken({ emailVerified: false })))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED')
  })
})

describe('requireInternal', () => {
  it('accepts the shared internal token', async () => {
    const res = await request(app).get('/internal/x').set('X-Internal-Token', TEST_INTERNAL_TOKEN)
    expect(res.status).toBe(200)
  })

  it('requireInternal rejects missing and wrong token', async () => {
    expect((await request(app).get('/internal/x')).status).toBe(401)
    expect((await request(app).get('/internal/x').set('X-Internal-Token', 'wrong')).status).toBe(401)
    const almost = TEST_INTERNAL_TOKEN.slice(0, -1) + 'X'
    expect((await request(app).get('/internal/x').set('X-Internal-Token', almost)).status).toBe(401)
  })

  it('refuses to be configured with a short token', () => {
    expect(() => requireInternal('short')).toThrow()
  })
})

describe('remote JWKS', () => {
  let hits = 0
  let jwksUrl = ''
  const server = createServer((req, res) => {
    hits++
    void testJwks().then((jwks) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(jwks))
    })
  })

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    jwksUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/.well-known/jwks.json`
  })
  afterAll(() => {
    server.close()
  })

  it('remote verifier fetches JWKS once for many requests', async () => {
    const remote = createJwtVerifier({ jwksUrl, issuer: ISSUER, audience: AUDIENCE })
    for (let i = 0; i < 5; i++) {
      await remote.verify(await makeTestToken())
    }
    expect(hits).toBe(1)
  })
})
