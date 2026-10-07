import type { z } from 'zod'

import {
  InventoryCommitFailedV1Schema,
  ProductPublishedV1Schema,
  ProductUnpublishedV1Schema,
  ProductUpdatedV1Schema,
} from './catalog'
import type { ServiceName } from './envelope'
import {
  UserDeletedV1Schema,
  UserEmailVerificationRequestedV1Schema,
  UserPasswordResetRequestedV1Schema,
  UserRegisteredV1Schema,
} from './identity'
import {
  OrderCancelledV1Schema,
  OrderPaidV1Schema,
  OrderPlacedV1Schema,
  OrderRefundRequiredV1Schema,
  SellerOrderDeliveredV1Schema,
  SellerOrderStatusChangedV1Schema,
} from './order'
import {
  PaymentCapturedV1Schema,
  PaymentFailedV1Schema,
  RefundFailedV1Schema,
  RefundProcessedV1Schema,
} from './payment'
import {
  PayoutPaidV1Schema,
  SellerAppliedV1Schema,
  SellerApprovedV1Schema,
  SellerReinstatedV1Schema,
  SellerRejectedV1Schema,
  SellerSuspendedV1Schema,
} from './seller'

interface RegistryEntry {
  type: string
  version: number
  producer: ServiceName
  schema: z.ZodType
}

const entry = <T extends string, V extends number, S extends z.ZodType>(
  type: T,
  version: V,
  producer: ServiceName,
  schema: S,
) => ({ type, version, producer, schema })

/**
 * Every event in the system, keyed by routing key `<type>.v<version>`.
 * Adding an event = schema + entry here + fixture in fixtures/<key>.json + doc 03 §8.
 */
export const EventRegistry = {
  'user.registered.v1': entry('user.registered', 1, 'identity', UserRegisteredV1Schema),
  'user.email_verification_requested.v1': entry(
    'user.email_verification_requested',
    1,
    'identity',
    UserEmailVerificationRequestedV1Schema,
  ),
  'user.password_reset_requested.v1': entry(
    'user.password_reset_requested',
    1,
    'identity',
    UserPasswordResetRequestedV1Schema,
  ),
  'user.deleted.v1': entry('user.deleted', 1, 'identity', UserDeletedV1Schema),

  'seller.applied.v1': entry('seller.applied', 1, 'seller', SellerAppliedV1Schema),
  'seller.approved.v1': entry('seller.approved', 1, 'seller', SellerApprovedV1Schema),
  'seller.rejected.v1': entry('seller.rejected', 1, 'seller', SellerRejectedV1Schema),
  'seller.suspended.v1': entry('seller.suspended', 1, 'seller', SellerSuspendedV1Schema),
  'seller.reinstated.v1': entry('seller.reinstated', 1, 'seller', SellerReinstatedV1Schema),
  'payout.paid.v1': entry('payout.paid', 1, 'seller', PayoutPaidV1Schema),

  'product.published.v1': entry('product.published', 1, 'catalog', ProductPublishedV1Schema),
  'product.updated.v1': entry('product.updated', 1, 'catalog', ProductUpdatedV1Schema),
  'product.unpublished.v1': entry('product.unpublished', 1, 'catalog', ProductUnpublishedV1Schema),
  'inventory.commit_failed.v1': entry('inventory.commit_failed', 1, 'catalog', InventoryCommitFailedV1Schema),

  'order.placed.v1': entry('order.placed', 1, 'order', OrderPlacedV1Schema),
  'order.paid.v1': entry('order.paid', 1, 'order', OrderPaidV1Schema),
  'order.cancelled.v1': entry('order.cancelled', 1, 'order', OrderCancelledV1Schema),
  'order.refund_required.v1': entry('order.refund_required', 1, 'order', OrderRefundRequiredV1Schema),
  'seller_order.status_changed.v1': entry(
    'seller_order.status_changed',
    1,
    'order',
    SellerOrderStatusChangedV1Schema,
  ),
  'seller_order.delivered.v1': entry('seller_order.delivered', 1, 'order', SellerOrderDeliveredV1Schema),

  'payment.captured.v1': entry('payment.captured', 1, 'payment', PaymentCapturedV1Schema),
  'payment.failed.v1': entry('payment.failed', 1, 'payment', PaymentFailedV1Schema),
  'refund.processed.v1': entry('refund.processed', 1, 'payment', RefundProcessedV1Schema),
  'refund.failed.v1': entry('refund.failed', 1, 'payment', RefundFailedV1Schema),
} as const satisfies Record<string, RegistryEntry>

export type EventRegistryType = typeof EventRegistry
export type EventKey = keyof EventRegistryType
export type EventData<K extends EventKey> = z.infer<EventRegistryType[K]['schema']>

export const EVENT_KEYS = Object.keys(EventRegistry) as EventKey[]

export function isEventKey(value: string): value is EventKey {
  return Object.hasOwn(EventRegistry, value)
}
