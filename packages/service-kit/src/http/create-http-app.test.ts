import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { ConflictError, TooManyAttemptsError } from '../errors'
import { createLogger } from '../logger'
import { createHttpApp } from './create-http-app'
import { route } from './route'

const logger = createLogger({ service: 'test', level: 'silent' })

function makeApp(overrides: Partial<Parameters<typeof createHttpApp>[0]> = {}) {
  return createHttpApp({
    service: 'test',
    logger,
    readiness: () => Promise.resolve({ db: true }),
    configure: (app) => {
      app.post(
        '/things',
        route({ body: z.object({ name: z.string().min(2) }), status: 201 }, ({ body }) =>
          Promise.resolve({ created: body.name }),
        ),
      )
      app.get(
        '/things/:id',
        route(
          { params: z.object({ id: z.uuid() }), query: z.object({ full: z.stringbool().optional() }) },
          (ctx) =>
            Promise.resolve({ id: ctx.params.id, full: ctx.query.full ?? false, requestId: ctx.requestId }),
        ),
      )
      app.delete(
        '/things/:id',
        route({}, () => Promise.resolve(undefined)),
      )
      app.get('/boom', () => {
        throw new Error('db password xyz leaked')
      })
      app.get(
        '/conflict',
        route({}, () =>
          Promise.reject(new ConflictError('OUT_OF_STOCK', 'Only 1 left', { items: [{ available: 1 }] })),
        ),
      )
      app.get(
        '/slow-down',
        route({}, () => Promise.reject(new TooManyAttemptsError(120))),
      )
      app.post('/webhook', (req, res) => {
        res.json({ isBuffer: Buffer.isBuffer(req.body), length: (req.body as Buffer).length })
      })
    },
    rawBodyPaths: ['/webhook'],
    ...overrides,
  })
}

describe('route helper', () => {
  it('returns the configured status with the handler result', async () => {
    const res = await request(makeApp()).post('/things').send({ name: 'vase' })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ created: 'vase' })
  })

  it('route returns 204 when handler returns undefined', async () => {
    const res = await request(makeApp()).delete('/things/0192f7a4-3b6c-7d2e-8f10-000000000001')
    expect(res.status).toBe(204)
    expect(res.text).toBe('')
  })

  it('route validates body and returns VALIDATION_FAILED with issues', async () => {
    const res = await request(makeApp()).post('/things').send({ name: 'x' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details.issues[0].path).toBe('name')
    expect(res.body.error.requestId).toEqual(expect.any(String))
  })

  it('validates params and coerces query', async () => {
    const bad = await request(makeApp()).get('/things/not-a-uuid')
    expect(bad.status).toBe(400)
    const ok = await request(makeApp()).get('/things/0192f7a4-3b6c-7d2e-8f10-000000000001?full=true')
    expect(ok.body).toMatchObject({ full: true })
  })
})

describe('errors', () => {
  it('unknown error becomes INTERNAL without leaking message', async () => {
    const res = await request(makeApp()).get('/boom')
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('INTERNAL')
    expect(JSON.stringify(res.body)).not.toContain('xyz')
  })

  it('AppError renders code, message and details', async () => {
    const res = await request(makeApp()).get('/conflict')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({
      code: 'OUT_OF_STOCK',
      message: 'Only 1 left',
      details: { items: [{ available: 1 }] },
    })
  })

  it('TooManyAttempts sets Retry-After', async () => {
    const res = await request(makeApp()).get('/slow-down')
    expect(res.status).toBe(429)
    expect(res.headers['retry-after']).toBe('120')
  })

  it('malformed JSON is a validation error, not a 500', async () => {
    const res = await request(makeApp())
      .post('/things')
      .set('Content-Type', 'application/json')
      .send('{"name":')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('oversized JSON is rejected with 413', async () => {
    const res = await request(makeApp({ jsonLimit: '1kb' }))
      .post('/things')
      .send({ name: 'x'.repeat(2000) })
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('unknown path returns NOT_FOUND error body', async () => {
    const res = await request(makeApp()).get('/nope')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })
})

describe('request id', () => {
  it('x-request-id is propagated', async () => {
    const res = await request(makeApp())
      .get('/things/0192f7a4-3b6c-7d2e-8f10-000000000001')
      .set('x-request-id', 'abc-123')
    expect(res.headers['x-request-id']).toBe('abc-123')
    expect(res.body.requestId).toBe('abc-123')
  })

  it('x-request-id is generated when missing or unsafe', async () => {
    const unsafe = await request(makeApp()).get('/healthz').set('x-request-id', '<script> bad id')
    expect(unsafe.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    const tooLong = await request(makeApp()).get('/healthz').set('x-request-id', 'a'.repeat(101))
    expect(tooLong.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    const missing = await request(makeApp()).get('/healthz')
    expect(missing.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('health, readiness, metrics', () => {
  it('healthz is ok', async () => {
    const res = await request(makeApp()).get('/healthz')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })

  it('readyz is 200 when checks pass', async () => {
    const res = await request(makeApp()).get('/readyz')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ready', checks: { db: true } })
  })

  it('readyz returns 503 when a check fails', async () => {
    const app = makeApp({ readiness: () => Promise.resolve({ db: true, broker: false }) })
    const res = await request(app).get('/readyz')
    expect(res.status).toBe(503)
    expect(res.body.checks).toEqual({ db: true, broker: false })
  })

  it('readyz returns 503 when the check throws', async () => {
    const app = makeApp({ readiness: () => Promise.reject(new Error('pool closed')) })
    expect((await request(app).get('/readyz')).status).toBe(503)
  })

  it('metrics expose an HTTP duration histogram', async () => {
    const app = makeApp()
    await request(app).get('/healthz')
    const res = await request(app).get('/metrics')
    expect(res.status).toBe(200)
    expect(res.text).toContain('http_request_duration_seconds')
  })

  it('sets security headers', async () => {
    const res = await request(makeApp()).get('/healthz')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-powered-by']).toBeUndefined()
  })
})

describe('raw body paths', () => {
  it('receive the exact bytes as a Buffer', async () => {
    const body = '{"event":"payment.captured",  "x":1}'
    const res = await request(makeApp()).post('/webhook').set('Content-Type', 'application/json').send(body)
    expect(res.body).toEqual({ isBuffer: true, length: Buffer.byteLength(body) })
  })
})
