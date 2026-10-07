import { z } from 'zod'

import { UuidSchema } from './ids'

/** Lower-cased, trimmed email. */
export const EmailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email())

/** https:// URLs only (avatars, banners). */
export const HttpsUrlSchema = z.url({ protocol: /^https$/ }).max(2048)

/** URL slug: lower-case words joined by single hyphens. */
export const SlugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lower-case letters, digits and single hyphens')

/** Free-text reason for admin/seller actions (reject, suspend, cancel…). */
export const ReasonSchema = z.string().trim().min(5).max(500)

export const IdParamsSchema = z.object({ id: UuidSchema })
export type IdParams = z.infer<typeof IdParamsSchema>
