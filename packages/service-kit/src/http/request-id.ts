import type { RequestHandler } from 'express'
import { v7 as uuidv7 } from 'uuid'

import { requestContext } from '../context'

const SAFE_ID = /^[A-Za-z0-9._-]{1,100}$/

/** Reuses a safe incoming x-request-id (from the gateway) or creates one, and echoes it back. */
export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id')
  const requestId = incoming && SAFE_ID.test(incoming) ? incoming : uuidv7()
  res.setHeader('x-request-id', requestId)
  requestContext.run({ requestId }, () => {
    next()
  })
}
