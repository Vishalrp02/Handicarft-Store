import type { DestinationStream, Logger } from 'pino'
import { pino } from 'pino'

import { requestContext } from './context'

export type { Logger } from 'pino'

const SECRET_FIELDS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'accountNumber',
  'razorpaySignature',
  'razorpay_signature',
]

/** Never logged: auth headers, cookies, passwords, tokens, bank numbers, payment signatures. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-internal-token"]',
  'res.headers["set-cookie"]',
  ...SECRET_FIELDS,
  ...SECRET_FIELDS.map((f) => `*.${f}`),
  ...SECRET_FIELDS.map((f) => `*.*.${f}`),
]

export interface LoggerOptions {
  service: string
  level: string
  /** Defaults to stdout. Tests pass a stream to capture lines. */
  destination?: DestinationStream
}

export function createLogger({ service, level, destination }: LoggerOptions): Logger {
  return pino(
    {
      level,
      base: { service },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
      formatters: { level: (label) => ({ level: label }) },
      mixin: () => {
        const ctx = requestContext.getStore()
        if (!ctx) return {}
        return ctx.userId ? { requestId: ctx.requestId, userId: ctx.userId } : { requestId: ctx.requestId }
      },
    },
    destination,
  )
}
