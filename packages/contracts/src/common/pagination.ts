import { z } from 'zod'

import { IsoDateSchema, UuidSchema } from './ids'

/** Offset pages: catalog search only (page ≤ 50, ≤ 48 per page). */
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(50).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(24),
})
export type PageQuery = z.infer<typeof PageQuerySchema>

/** Keyset pages: every other list. */
export const CursorQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type CursorQuery = z.infer<typeof CursorQuerySchema>

export const PageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
    total: z.number().int().nonnegative(),
  })
export type Page<T> = { items: T[]; page: number; limit: number; total: number }

export const CursorPageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  })
export type CursorPage<T> = { items: T[]; nextCursor: string | null }

const CursorPayloadSchema = z.object({ createdAt: IsoDateSchema, id: UuidSchema })
export type CursorPayload = z.infer<typeof CursorPayloadSchema>

const toBase64Url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const fromBase64Url = (s: string) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
}

/** Opaque cursor = base64url("<createdAt ISO>|<id>"). Clients must not parse it. */
export function encodeCursor(payload: CursorPayload): string {
  const { createdAt, id } = CursorPayloadSchema.parse(payload)
  return toBase64Url(`${createdAt}|${id}`)
}

const CursorStringSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid cursor')
  .transform((s, ctx) => {
    try {
      const [createdAt, id, ...rest] = fromBase64Url(s).split('|')
      if (rest.length > 0) throw new Error('extra segments')
      return { createdAt, id }
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid cursor' })
      return z.NEVER
    }
  })
  .pipe(CursorPayloadSchema)

/** Throws ZodError for anything that isn't a cursor we issued. */
export function decodeCursor(cursor: string): CursorPayload {
  return CursorStringSchema.parse(cursor)
}
