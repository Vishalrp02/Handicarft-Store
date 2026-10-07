import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { BaseConfigSchema, ConfigError, loadConfig } from './config'

const valid = {
  SERVICE_NAME: 'order',
  PORT: '4005',
  JWKS_URL: 'http://identity:4001/.well-known/jwks.json',
  INTERNAL_API_TOKEN: 'x'.repeat(40),
}

describe('loadConfig', () => {
  it('parses and applies defaults', () => {
    const cfg = loadConfig(BaseConfigSchema, valid)
    expect(cfg.PORT).toBe(4005)
    expect(cfg.NODE_ENV).toBe('development')
    expect(cfg.LOG_LEVEL).toBe('info')
    expect(cfg.JWT_ISSUER).toBe('craftoria-identity')
    expect(cfg.JWT_AUDIENCE).toBe('craftoria')
  })

  it('lists all invalid keys', () => {
    const { PORT: _port, ...rest } = valid
    const env = { ...rest, INTERNAL_API_TOKEN: 'short' }
    expect(() => loadConfig(BaseConfigSchema, env)).toThrow(ConfigError)
    try {
      loadConfig(BaseConfigSchema, env)
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('PORT')
      expect(message).toContain('INTERNAL_API_TOKEN')
    }
  })

  it('never prints secret values in the error', () => {
    const secret = 'super-secret-value'
    try {
      loadConfig(BaseConfigSchema, { ...valid, INTERNAL_API_TOKEN: secret })
      expect.unreachable()
    } catch (err) {
      expect((err as Error).message).not.toContain(secret)
    }
  })

  it('treats empty optional variables as unset', () => {
    const cfg = loadConfig(BaseConfigSchema, { ...valid, OTEL_EXPORTER_OTLP_ENDPOINT: '', SENTRY_DSN: '' })
    expect(cfg.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined()
    expect(cfg.SENTRY_DSN).toBeUndefined()
  })

  it('is extendable per service', () => {
    const schema = BaseConfigSchema.extend({ DATABASE_URL: z.string().startsWith('postgres://') })
    expect(() => loadConfig(schema, valid)).toThrow(/DATABASE_URL/)
  })
})
