import type { RouteConfig } from '@asteasolutions/zod-to-openapi'
import { OpenApiGeneratorV31, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi'
import type { Express } from 'express'
import type { z } from 'zod'

export type RouteAuth = 'public' | 'user' | 'artisan' | 'admin' | 'internal'

export interface RouteDoc {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete'
  /** Express-style path, e.g. /v1/orders/:id */
  path: string
  summary: string
  tags?: string[]
  auth: RouteAuth
  body?: z.ZodType
  query?: z.ZodObject
  params?: z.ZodObject
  /** status → response schema, or null for "no body / see error format". */
  responses: Record<number, z.ZodType | null>
}

export interface OpenApi {
  registry: OpenAPIRegistry
  register(route: RouteDoc): void
  document(): ReturnType<OpenApiGeneratorV31['generateDocument']>
}

const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')

export function createOpenApi({ service, version }: { service: string; version: string }): OpenApi {
  const registry = new OpenAPIRegistry()
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  })
  registry.registerComponent('securitySchemes', 'internalToken', {
    type: 'apiKey',
    in: 'header',
    name: 'X-Internal-Token',
  })

  return {
    registry,
    register(route) {
      const responses: RouteConfig['responses'] = {}
      for (const [status, schema] of Object.entries(route.responses)) {
        responses[status] = schema
          ? { description: `${status} response`, content: { 'application/json': { schema } } }
          : { description: `${status} response` }
      }
      const security =
        route.auth === 'public'
          ? []
          : route.auth === 'internal'
            ? [{ internalToken: [] }]
            : [{ bearerAuth: [] }]
      registry.registerPath({
        method: route.method,
        path: toOpenApiPath(route.path),
        summary: route.summary,
        tags: route.tags ?? [],
        security,
        description:
          route.auth === 'public' || route.auth === 'internal' ? undefined : `Requires role: ${route.auth}`,
        request: {
          ...(route.params ? { params: route.params } : {}),
          ...(route.query ? { query: route.query } : {}),
          ...(route.body ? { body: { content: { 'application/json': { schema: route.body } } } } : {}),
        },
        responses,
      })
    },
    document() {
      return new OpenApiGeneratorV31(registry.definitions).generateDocument({
        openapi: '3.1.0',
        info: { title: `${service} API`, version },
      })
    },
  }
}

/** GET /openapi.json — generated once on first request. */
export function serveOpenApi(app: Express, openapi: OpenApi): void {
  let cached: unknown
  app.get('/openapi.json', (_req, res) => {
    cached ??= openapi.document()
    res.json(cached)
  })
}
