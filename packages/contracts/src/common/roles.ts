import { z } from 'zod'

export const RoleSchema = z.enum(['buyer', 'artisan', 'admin'])
export type Role = z.infer<typeof RoleSchema>
