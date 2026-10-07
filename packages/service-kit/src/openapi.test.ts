import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createHttpApp } from './http/create-http-app'
import { createLogger } from './logger'
import { createOpenApi, serveOpenApi } from './openapi'

describe('openapi', () => {
  it('openapi.json lists registered routes', async () => {
    const openapi = createOpenApi({ service: 'cart', version: '1.0.0' })
    openapi.register({
      method: 'put',
      path: '/v1/cart/items/:productId',
      summary: 'Set quantity of a product in the bag',
      tags: ['cart'],
      auth: 'user',
      params: z.object({ productId: z.uuid() }),
      body: z.object({ qty: z.number().int().min(0).max(10) }),
      responses: { 200: z.object({ itemCount: z.number() }), 422: null },
    })
    openapi.register({
      method: 'get',
      path: '/internal/carts/:userId',
      summary: 'Purchasable lines for checkout',
      auth: 'internal',
      responses: { 200: z.object({ items: z.array(z.unknown()) }) },
    })

    const app = createHttpApp({
      service: 'cart',
      logger: createLogger({ service: 'cart', level: 'silent' }),
      readiness: () => Promise.resolve({}),
      configure: (a) => {
        serveOpenApi(a, openapi)
      },
    })

    const res = await request(app).get('/openapi.json')
    expect(res.status).toBe(200)
    expect(res.body.openapi).toBe('3.1.0')
    expect(res.body.info).toMatchObject({ title: 'cart API', version: '1.0.0' })
    const put = res.body.paths['/v1/cart/items/{productId}'].put
    expect(put.summary).toBe('Set quantity of a product in the bag')
    expect(put.security).toEqual([{ bearerAuth: [] }])
    expect(put.requestBody.content['application/json'].schema.properties.qty).toBeDefined()
    expect(Object.keys(put.responses)).toEqual(expect.arrayContaining(['200', '422']))
    expect(res.body.paths['/internal/carts/{userId}'].get.security).toEqual([{ internalToken: [] }])
  })

  it('public routes have no security requirement', () => {
    const openapi = createOpenApi({ service: 'catalog', version: '1.0.0' })
    openapi.register({
      method: 'get',
      path: '/v1/categories',
      summary: 'List',
      auth: 'public',
      responses: { 200: null },
    })
    const doc = openapi.document()
    expect(doc.paths?.['/v1/categories']?.get?.security).toEqual([])
  })
})
