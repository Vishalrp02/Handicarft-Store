import { AsyncLocalStorage } from 'node:async_hooks'

export interface RequestContext {
  requestId: string
  userId?: string
}

/** Per-request values visible to every log line and outgoing call made while handling it. */
export const requestContext = new AsyncLocalStorage<RequestContext>()

export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId
}
