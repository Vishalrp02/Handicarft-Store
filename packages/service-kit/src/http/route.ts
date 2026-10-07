import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { z } from 'zod'

import type { AuthContext } from '../auth/types'
import { getRequestId } from '../context'
import { ValidationError, zodIssuesToIssues } from '../errors'

type Out<T> = T extends z.ZodType ? z.output<T> : undefined

export interface RouteSpec<B, Q, P> {
  body?: B
  query?: Q
  params?: P
  /** Status for a non-undefined result. Default 200. */
  status?: number
}

export interface RouteContext<B, Q, P> {
  body: Out<B>
  query: Out<Q>
  params: Out<P>
  auth: AuthContext | undefined
  requestId: string
  req: Request
  res: Response
}

function parse(schema: z.ZodType | undefined, input: unknown, where: string): unknown {
  if (!schema) return undefined
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new ValidationError(
      zodIssuesToIssues(result.error.issues).map((i) => ({ ...i, path: i.path || where })),
    )
  }
  return result.data
}

/**
 * Typed Express handler: validates body/query/params with zod, then calls `fn`.
 * Returning undefined sends 204; anything else is sent as JSON with `spec.status` (default 200).
 */
export function route<
  B extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  P extends z.ZodType | undefined = undefined,
>(spec: RouteSpec<B, Q, P>, fn: (ctx: RouteContext<B, Q, P>) => Promise<unknown>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const run = async () => {
      const ctx: RouteContext<B, Q, P> = {
        params: parse(spec.params, req.params, 'params') as Out<P>,
        query: parse(spec.query, req.query, 'query') as Out<Q>,
        body: parse(spec.body, req.body, 'body') as Out<B>,
        auth: req.auth,
        requestId: getRequestId() ?? '',
        req,
        res,
      }
      const result = await fn(ctx)
      if (res.headersSent) return
      if (result === undefined) res.status(204).end()
      else res.status(spec.status ?? 200).json(result)
    }
    run().catch(next)
  }
}
