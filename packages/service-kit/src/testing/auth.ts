import type { AccessTokenClaims } from '@craftoria/contracts'
import type { CryptoKey, JSONWebKeySet } from 'jose'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { v7 as uuidv7 } from 'uuid'

/** 40-character token that services are configured with in tests. */
export const TEST_INTERNAL_TOKEN = 'test-internal-token-0123456789abcdefghij'

const TEST_KID = 'test-key-1'

interface TestKeys {
  privateKey: CryptoKey
  jwks: JSONWebKeySet
}

let keysPromise: Promise<TestKeys> | undefined

/** One Ed25519 key pair per test process. */
export function testKeys(): Promise<TestKeys> {
  keysPromise ??= (async () => {
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true })
    const jwk = await exportJWK(publicKey)
    return { privateKey, jwks: { keys: [{ ...jwk, kid: TEST_KID, alg: 'EdDSA', use: 'sig' }] } }
  })()
  return keysPromise
}

/** The public key set matching makeTestToken; configure services under test with it. */
export async function testJwks(): Promise<JSONWebKeySet> {
  return (await testKeys()).jwks
}

export type TestTokenOptions = Partial<Omit<AccessTokenClaims, 'iat' | 'exp'>> & {
  /** jose duration, e.g. '15m', or negative like '-2m' for an expired token. */
  expiresIn?: string
}

/** Signs an access token like identity does. Defaults: a verified buyer, 15 minutes. */
export async function makeTestToken(opts: TestTokenOptions = {}): Promise<string> {
  const { privateKey } = await testKeys()
  const {
    expiresIn = '15m',
    sub = uuidv7(),
    iss = 'craftoria-identity',
    aud = 'craftoria',
    email = 'buyer@example.test',
    name = 'Test Buyer',
    emailVerified = true,
    roles = ['buyer'],
    sid = uuidv7(),
    sellerId,
  } = opts

  const payload: Record<string, unknown> = { email, name, emailVerified, roles, sid }
  if (sellerId) payload.sellerId = sellerId

  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid: TEST_KID })
    .setSubject(sub)
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
  if (expiresIn.startsWith('-')) {
    const seconds = durationToSeconds(expiresIn.slice(1))
    jwt.setExpirationTime(Math.floor(Date.now() / 1000) - seconds)
  } else {
    jwt.setExpirationTime(expiresIn)
  }
  return jwt.sign(privateKey)
}

function durationToSeconds(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value)
  if (!match?.[1] || !match[2]) throw new Error(`Unsupported duration: ${value}`)
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd']
  return Number(match[1]) * unit
}
