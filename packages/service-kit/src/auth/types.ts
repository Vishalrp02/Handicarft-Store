import type { Role } from '@craftoria/contracts'

/** Who is calling, taken from a verified access token (filled in by requireAuth, plan 02 Task 6). */
export interface AuthContext {
  userId: string
  email: string
  name: string
  emailVerified: boolean
  roles: Role[]
  sellerId: string | null
  sessionId: string
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express request augmentation
  namespace Express {
    interface Request {
      auth?: AuthContext
    }
  }
}
