import type { Express } from 'express'
import express from 'express'
import helmet from 'helmet'
import { pinoHttp } from 'pino-http'

import { getRequestId } from '../context'
import { errorMiddleware, notFoundMiddleware } from '../errors'
import type { Logger } from '../logger'
import { createHttpMetrics } from './metrics'
import { requestIdMiddleware } from './request-id'

export interface HttpAppOptions {
  service: string
  logger: Logger
  /** Named checks for /readyz, e.g. { db: true, broker: false }. Throwing counts as not ready. */
  readiness: () => Promise<Record<string, boolean>>
  /** Mount routes here (runs after the shared middleware, before 404 and error handling). */
  configure: (app: Express) => void
  /** Paths that receive the raw body as a Buffer (e.g. payment webhooks that check signatures). */
  rawBodyPaths?: string[]
  /** JSON body limit. Default '100kb'. */
  jsonLimit?: string
  /** false = no body parsing at all (the gateway streams bodies to upstreams). Default true. */
  parseBodies?: boolean
}

/** The standard Express app every service uses. Order matters; see the comments. */
export function createHttpApp(opts: HttpAppOptions): Express {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)

  const metrics = createHttpMetrics(opts.service)

  // 1. request id first, so every later log line and error carries it
  app.use(requestIdMiddleware)
  // 2. one access-log line per request
  app.use(
    pinoHttp({
      logger: opts.logger,
      genReqId: () => getRequestId() ?? '',
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/metrics' },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    }),
  )
  // 3. security headers and metrics
  app.use(helmet())
  app.use(metrics.middleware)

  // 4. bodies: raw for signature-checked paths, JSON elsewhere
  if (opts.parseBodies !== false) {
    for (const path of opts.rawBodyPaths ?? []) {
      app.use(path, express.raw({ type: '*/*', limit: '1mb' }))
    }
    const rawPaths = new Set(opts.rawBodyPaths ?? [])
    const json = express.json({ limit: opts.jsonLimit ?? '100kb' })
    app.use((req, res, next) => {
      if (rawPaths.has(req.path)) {
        next()
        return
      }
      json(req, res, next)
    })
  }

  // 5. operational endpoints
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' })
  })
  app.get('/readyz', (_req, res) => {
    opts
      .readiness()
      .then((checks) => {
        const ready = Object.values(checks).every(Boolean)
        res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', checks })
      })
      .catch((err: unknown) => {
        opts.logger.warn({ err }, 'readiness check failed')
        res.status(503).json({ status: 'unavailable', checks: {} })
      })
  })
  app.get('/metrics', (_req, res, next) => {
    metrics.registry
      .metrics()
      .then((text) => {
        res.setHeader('Content-Type', metrics.registry.contentType)
        res.send(text)
      })
      .catch(next)
  })

  // 6. the service's own routes
  opts.configure(app)

  // 7. everything else is a 404, and every error goes through one renderer
  app.use(notFoundMiddleware)
  app.use(errorMiddleware(opts.logger))
  return app
}
