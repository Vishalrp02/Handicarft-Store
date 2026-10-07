import { z } from 'zod'

/** RFC 9562 UUID; services generate v7 (time-ordered). */
export const UuidSchema = z.uuid()

/** ISO-8601 timestamp in UTC, as produced by Date.prototype.toISOString(). */
export const IsoDateSchema = z.iso.datetime()
