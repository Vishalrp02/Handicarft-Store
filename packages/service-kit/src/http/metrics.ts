import type { RequestHandler } from 'express'
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client'

export interface HttpMetrics {
  registry: Registry
  middleware: RequestHandler
}

/** One registry per app so several apps can live in one process (tests). */
export function createHttpMetrics(service: string): HttpMetrics {
  const registry = new Registry()
  registry.setDefaultLabels({ service })
  collectDefaultMetrics({ register: registry })

  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  })

  const middleware: RequestHandler = (req, res, next) => {
    const end = duration.startTimer()
    res.on('finish', () => {
      // matched route pattern (e.g. /v1/orders/:id), never the raw URL, to keep label cardinality low
      const routePath = (req.route as { path?: string } | undefined)?.path
      const route = routePath ? `${req.baseUrl}${routePath}` : 'unmatched'
      end({ method: req.method, route, status_code: String(res.statusCode) })
    })
    next()
  }

  return { registry, middleware }
}
