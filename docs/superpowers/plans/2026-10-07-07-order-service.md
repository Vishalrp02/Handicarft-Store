# Order Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `services/order`: idempotent checkout (cart → reservation → priced order → payment intent), the order and seller-order state machines, buyer, seller and admin order APIs, payment/inventory/refund event handling, the payment-timeout job, and admin stats.

**Architecture:** A template service. All business rules live in pure functions under `src/domain/` (state machine, pricing, display status, refund amount), unit-tested exhaustively. Services orchestrate: they lock the order row (`SELECT … FOR UPDATE`), apply a domain function, write state + `order_status_history` + outbox in one transaction. Cross-service calls go through typed clients behind ports, with fakes for tests.

**Tech Stack:** service-kit (incl. `createServiceClient`, `idempotency`, `runJob`), Kysely.

**Spec:** `02-target-architecture.md` §7.1–§7.3, §8; `03-api-and-event-contracts.md` §6, internal APIs in §3, §5, §7, and events `order.*`, `seller_order.*`, `payment.*`, `inventory.commit_failed`, `refund.*`, `user.deleted`; `04-data-model.md` §5.

**Prerequisite:** plan 02 complete. Catalog, cart and payment need **not** be finished, because this plan uses fakes behind ports. Plan 15 runs the real end-to-end flow.

**Required skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; plus the workflow skills `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use **only** the project skills in `.claude/skills/` (mirrored in `.agents/skills/`); no other skills or plugins. See `docs/architecture/05-engineering-standards.md` §8.

## Global Constraints

- Port 4005, database `craftoria_order`.
- Config: `DATABASE_URL, RABBITMQ_URL, CART_URL, CATALOG_URL, PAYMENT_URL, PAYMENT_TTL_SECONDS=1800, SHIPPING_FEE_PAISE=9900, FREE_SHIPPING_THRESHOLD_PAISE=99900, ORDER_EXPIRY_SWEEP_INTERVAL_MS=60000, BUSINESS_TIMEZONE='Asia/Kolkata'`.
- Order number: `'CR-' || to_char(now() AT TIME ZONE 'Asia/Kolkata','YYMM') || '-' || lpad(nextval('order_number_seq')::text, 6, '0')`.
- `expires_at = placed_at + PAYMENT_TTL_SECONDS`. The reservation TTL sent to catalog = `PAYMENT_TTL_SECONDS`.
- Customer snapshot at checkout: `customer_email` and `customer_name` from the token, `customer_phone` from `shippingAddress.phone`.
- Seller-order transition table (`nextSellerOrderStatus`). Anything not listed → `INVALID_STATE_TRANSITION`:

  | action | from | to | allowed actors |
  |---|---|---|---|
  | `activate` | pending | awaiting_acceptance | system |
  | `accept` | awaiting_acceptance | accepted | seller, admin |
  | `pack` | accepted | packed | seller, admin |
  | `ship` | accepted, packed | shipped | seller, admin |
  | `deliver` | shipped | delivered | seller, admin |
  | `cancel` | awaiting_acceptance, accepted | cancelled | buyer, seller, admin, system |
  | `cancel` | packed | cancelled | seller, admin, system |
  | `cancel` | pending | cancelled | system |

- Refund amount for a cancelled seller order = its `subtotal_paise`, **plus** `orders.shipping_paise` if no other seller order of the order remains non-cancelled.

## Review Focus

1. **Double-click checkout:** two concurrent `POST /v1/checkout` with **different** idempotency keys for the same cart → one order, because of the `orders_one_pending_per_cart` unique index; the loser releases its reservation and returns the winner's order. (Task 4 test `concurrent checkouts produce one order`.)
2. `payment.captured` racing the expiry job: exactly one of "paid" or "cancelled + late-payment refund" happens. (Task 7 test `expiry vs capture race`.)
3. Payment-intent creation fails after the order row is created → 503. A retry with the same `Idempotency-Key` must reuse the order and create the intent, not reserve twice. (Task 4 test `retry after payment outage reuses order`.)
4. A buyer cancelling a paid order with one seller order shipped and another accepted: only the accepted one is cancelled, and the refund excludes shipping. (Task 5 test.)
5. `payment.captured` with an amount different from `total_paise` must not mark the order paid; the handler throws, so the message ends in the DLQ for manual review. (Task 6 test `amount mismatch is not marked paid`.)

---

### Task 1: Scaffold and schema

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `services/order/**` via `pnpm new:service order 4005`; `src/db/migrations/0002_order_core.ts` (with `createPlatformTables(db, {idempotency: true})` already in 0001); `test/integration/schema.int.test.ts`
- Modify: compose files, `.env.example`

**Interfaces:**
- Produces: `order_number_seq`, `orders`, `seller_orders`, `order_items`, `order_status_history` per `04-data-model.md` §5, plus `nextOrderNumber(trx): Promise<string>` in `src/modules/orders/order-number.ts`.

- [ ] **Step 1: Write failing tests:** `migrations round-trip`, `total check enforces subtotal + shipping`, `line_total check`, `only one pending order per cart fingerprint`, `order number format CR-YYMM-000001`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(order): scaffold and schema`.

### Task 2: Domain — state machine, pricing, fingerprint, display status, refund amount

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/domain/{seller-order-state.ts,order-status.ts,pricing.ts,fingerprint.ts,refund-amount.ts}` with `*.test.ts` beside each

**Interfaces:**
- Produces:
  - `type Actor = 'buyer' | 'seller' | 'admin' | 'system'`; `type SoAction = SellerOrderAction | 'activate'`.
  - `nextSellerOrderStatus(current: SellerOrderStatus, action: SoAction, actor: Actor): SellerOrderStatus` (throws `ConflictError('INVALID_STATE_TRANSITION', …, {from: current, action})`, or `ForbiddenError` when the transition exists but the actor is not allowed).
  - `deriveOrderStatus(status: OrderStatus, soStatuses: SellerOrderStatus[]): OrderStatus` (`paid` → `completed` when all are terminal and ≥1 is `delivered`).
  - `displayStatus(order: { status: OrderStatus; refundStatus: RefundStatus }, sos: { status: SellerOrderStatus }[]): string`. Values: `'Awaiting payment' | 'Cancelled' | 'Confirmed' | 'Partially shipped' | 'Shipped' | 'Delivered' | 'Cancelled — refund pending' | 'Cancelled — refunded' | 'Partially cancelled'`.
  - `priceOrder(lines: PricedLine[], rules: { shippingFeePaise: number; freeShippingThresholdPaise: number }): { itemsSubtotalPaise: number; shippingPaise: number; totalPaise: number; groups: { sellerId: string; sellerDisplayName: string; subtotalPaise: number; lines: (PricedLine & { lineTotalPaise: number })[] }[] }` (groups ordered by `sellerId`; uses contracts money helpers).
  - `cartFingerprint(items: { productId: string; qty: number }[]): string` (sha256 hex of sorted `productId:qty` joined by `,`).
  - `refundAmountForCancellation(order: { shippingPaise: number }, sos: { id: string; status: SellerOrderStatus; subtotalPaise: number }[], cancellingId: string): number`.

- [ ] **Step 1: Write failing tests:** a table-driven test over **every** (status × action × actor) combination asserting the transition table in Global Constraints; `deriveOrderStatus` cases; `displayStatus` covering each value; `priceOrder` (subtotal 99,899 → shipping 9,900; 99,900 → 0; two sellers grouped; totals are safe integers); `cartFingerprint` is order-independent; `refundAmountForCancellation` (last active seller order includes shipping, otherwise not).
- [ ] **Step 2:** `pnpm --filter @craftoria/order test` → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(order): domain rules — state machine, pricing, display status`.

### Task 3: Service clients and fakes

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/clients/{cart.client.ts,catalog.client.ts,payment.client.ts,ports.ts}`, `src/clients/fakes.ts`, `test/integration/clients.int.test.ts`

**Interfaces:**
- Consumes: `createServiceClient`; contracts `InternalCartSchema`, `ReserveRequest/ResponseSchema`, `CreatePaymentIntentSchema`, `PaymentIntentOutSchema`.
- Produces (`ports.ts`):
  ```ts
  interface CartPort    { getCart(userId: string): Promise<InternalCart> }
  interface CatalogPort { reserve(req: ReserveRequest): Promise<ReserveResponse>; release(reservationId: string): Promise<void> }
  interface PaymentPort { createIntent(req: CreatePaymentIntent): Promise<PaymentIntentOut> }   // idempotencyKey = req.orderId
  ```
  HTTP implementations plus `FakeCart`, `FakeCatalog` (in-memory stock, can be scripted to throw `OUT_OF_STOCK`, `PRODUCT_UNAVAILABLE` or `UpstreamUnavailableError`) and `FakePayment` (returns `order_fake_<n>`, can be scripted to fail). `AppDeps` gains `cart`, `catalog`, `payment`.

- [ ] **Step 1: Write failing tests:** against a local stub HTTP server: `catalog client propagates OUT_OF_STOCK details`, `payment client sends Idempotency-Key = orderId`, `cart client validates response schema` (bad shape → `UpstreamUnavailableError`).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(order): typed clients for cart, catalog, payment with fakes`.

### Task 4: Checkout

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/checkout/{checkout.routes.ts,checkout.controller.ts,checkout.service.ts}`, `src/modules/orders/{orders.repository.ts,orders.mapper.ts,history.repository.ts}`, `test/integration/checkout.int.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `POST /v1/checkout` with middlewares `requireAuth`, `requireVerifiedEmail`, `idempotency({required:true, scope: req => req.auth.userId})`.
  - `CheckoutService.checkout(auth: AuthContext, body: CheckoutRequest): Promise<CheckoutResponse>`:
    1. `cart.getCart` → empty → 422 `CART_EMPTY`.
    2. `fp = cartFingerprint(items)`; existing `pending_payment` order for `(userId, fp)` with `expires_at > now` → `ensurePaymentIntent(order)` → return it.
    3. `orderId = uuidv7()`; `catalog.reserve({reservationId: orderId, items, ttlSeconds})` (errors propagate unchanged).
    4. `priceOrder`. In one transaction: insert order, seller orders (`pending`), items, history (`null → pending_payment`, actor buyer), `order.placed.v1`. On a unique violation of `orders_one_pending_per_cart`: `catalog.release(orderId)` and go back to step 2. On any other DB failure: `catalog.release(orderId)` (best effort), then rethrow.
    5. `ensurePaymentIntent(order)`: `payment.createIntent({orderId, userId, amountPaise: total, customer:{name, email, phone}})` → store `payment_intent_id`, `gateway_order_id`. Failure → `UpstreamUnavailableError('payment')` (503; the idempotency row is dropped because of the 5xx).
    6. Return `{ order: Order, payment: {provider:'razorpay', keyId, gatewayOrderId, amountPaise, currency:'INR'} }` with 201.
  - `OrdersRepository.lockById(trx, id)`, `.findPendingByFingerprint(userId, fp, now)`, `.insertAggregate(trx, aggregate)`, `.getOrder(id): Order` (with seller orders, items and the computed `displayStatus`), `.setPaymentIntent`.

- [ ] **Step 1: Write failing tests** (using fakes):
  ```ts
  it('creates pending order with server prices and returns payment details', ...)   // total = Σ fake catalog prices + shipping rule
  it('requires Idempotency-Key', ...)                                               // 400
  it('replay with same key returns same response without new reservation', ...)
  it('same key different body → 409 IDEMPOTENCY_KEY_REUSED', ...)
  it('empty cart → 422 CART_EMPTY', ...)
  it('out of stock → 409 OUT_OF_STOCK with details and no order row', ...)
  it('unverified email → 403 EMAIL_NOT_VERIFIED', ...)
  it('second checkout of same cart returns existing pending order', ...)            // different key
  it('concurrent checkouts produce one order', ...)                                 // 5 parallel, different keys → 1 order row; the extra reservations released
  it('retry after payment outage reuses order', ...)                                // FakePayment fails once → 503; retry same key → 201, same order id, reserve called once
  it('outbox has valid order.placed', ...)
  it('splits two sellers into two seller orders', ...)
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(order): idempotent checkout`.

### Task 5: Buyer order endpoints

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/buyer-orders/{buyer-orders.routes.ts,buyer-orders.controller.ts,buyer-orders.service.ts}`, `src/modules/orders/transitions.service.ts`, `test/integration/buyer-orders.int.test.ts`

**Interfaces:**
- Produces:
  - `TransitionsService.applySellerOrderAction(trx, { sellerOrderId, action, actor: Actor, actorId: string | null, reason?: string, tracking?: {carrier, trackingNumber} }): Promise<void>`. It locks, applies `nextSellerOrderStatus`, sets the matching timestamp and tracking, writes history, and enqueues `seller_order.status_changed.v1`. On `deliver` it also enqueues `seller_order.delivered.v1`. On `cancel` after payment it sets `refund_status='pending'` on the seller order and the order and enqueues `order.refund_required.v1` with `refundAmountForCancellation`. Finally it updates the order status via `deriveOrderStatus` (setting `completed_at`). **Reused by Tasks 6, 8, 9.**
  - `GET /v1/orders` (`CursorPage<OrderSummary>`), `GET /v1/orders/:id` (own only, else 404; includes `history`), `POST /v1/orders/:id/cancel`: for `pending_payment`, cancel the order and every seller order (system cancel), enqueue `order.cancelled.v1{reason:'buyer_cancelled'}`; for `paid`, cancel every seller order in `awaiting_acceptance|accepted` via `applySellerOrderAction(actor 'buyer')`, and if none is cancellable → 409 `INVALID_STATE_TRANSITION`. `POST /v1/orders/:id/payment` (`pending_payment` and not expired → `ensurePaymentIntent`, else 409).

- [ ] **Step 1: Write failing tests:** `lists own orders newest first with cursor`, `other user's order → 404`, `cancel pending order emits order.cancelled`, `cancel paid order with one shipped and one accepted cancels only accepted and refund excludes shipping`, `cancel paid order where all accepted refunds shipping on the last`, `cancel shipped-only order → 409`, `reopen payment for expired order → 409`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(order): buyer order endpoints and transition service`.

### Task 6: Event handlers (payment, inventory, refund, user)

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/events/handlers/{payment-captured,payment-failed,inventory-commit-failed,refund-processed,refund-failed,user-deleted}.handler.ts`, `test/integration/order-events.int.test.ts`

**Interfaces:**
- Produces:
  - `payment.captured`: lock the order. If `pending_payment`: an amount mismatch → throw `Error('amount mismatch')`. Otherwise → `paid`, `paid_at`, `activate` every seller order (system), history, enqueue `order.paid.v1` (full payload per contracts §8). If `paid|completed`: no-op. If `cancelled`: set `refund_status='pending'`, history (reason `late_payment`), enqueue `order.refund_required.v1{sellerOrderId:null, amountPaise: event amount, reason:'late_payment'}`.
  - `payment.failed`: history only (actor system, reason = event reason).
  - `inventory.commit_failed`: lock the order; system-cancel every non-cancelled seller order with reason `stock_unavailable`, **without** per-seller-order refunds; enqueue one `order.refund_required.v1{sellerOrderId:null, amountPaise: total, reason:'commit_failed'}`; `refund_status='pending'`.
  - `refund.processed`: with `sellerOrderId`, that seller order → `refunded`; without it, every cancelled seller order with `refund_status='pending'` → `refunded`. The order's `refund_status` → `refunded` when none is pending.
  - `refund.failed`: the matching `refund_status='failed'` (seller order and order).
  - `user.deleted`: anonymise the orders per contracts §8.

- [ ] **Step 1: Write failing tests:**
  ```ts
  it('payment.captured marks order paid and emits valid order.paid', ...)
  it('duplicate payment.captured is a no-op', ...)
  it('amount mismatch is not marked paid', ...)              // handler rejects → order still pending_payment
  it('late payment on cancelled order requests full refund', ...)
  it('commit_failed cancels all seller orders and requests one full refund', ...)
  it('refund.processed for one seller order updates statuses', ...)
  it('refund.failed sets failed', ...)
  it('user.deleted anonymises customer fields and address', ...)
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(order): handle payment, inventory, refund and user events`.

### Task 7: Payment-timeout expiry job

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/jobs/order-expiry.job.ts`, `test/integration/order-expiry.int.test.ts`

**Interfaces:**
- Produces: `runJob('order-expiry', ORDER_EXPIRY_SWEEP_INTERVAL_MS)`. Selects up to 100 ids `WHERE status='pending_payment' AND expires_at < now()` with `FOR UPDATE SKIP LOCKED`. For each, in its own transaction: re-lock, re-check the status, → `cancelled` (`cancel_reason='payment_timeout'`), system-cancel every seller order, history, enqueue `order.cancelled.v1{reason:'payment_timeout'}`.

- [ ] **Step 1: Write failing tests:** `expires only overdue pending orders` (fake clock), `expiry vs capture race` (run the job and the `payment.captured` handler concurrently 20 times on fresh orders → each order ends either `paid` with no refund event, or `cancelled` with exactly one `order.refund_required{reason:'late_payment'}`).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(order): payment timeout expiry job`.

### Task 8: Seller fulfilment endpoints

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/seller-orders/{seller-orders.routes.ts,seller-orders.controller.ts,seller-orders.service.ts,seller-orders.mapper.ts}`, `test/integration/seller-orders.int.test.ts`

**Interfaces:**
- Consumes: `TransitionsService` (Task 5).
- Produces: `GET /v1/seller/orders` (`?status`; default excludes `pending`), `GET /v1/seller/orders/:sellerOrderId`, `POST /v1/seller/orders/:sellerOrderId/:action`. Ownership via `seller_id = req.auth.sellerId` (else 404). `ship` requires `ShipBodySchema`; `cancel` requires `CancelBodySchema`. Returns `SellerOrderView` (customer name and shipping address included; no customer email or phone, apart from the phone inside the address needed for the courier).

- [ ] **Step 1: Write failing tests:** `seller sees only own seller orders`, `accept → pack → ship → deliver happy path emits status_changed each time and delivered once`, `ship without tracking → 400`, `deliver from accepted → 409`, `seller cancel after paid emits refund_required with subtotal`, `order becomes completed when all seller orders delivered`, `pending (unpaid) seller orders hidden from seller list`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(order): seller fulfilment endpoints`.

### Task 9: Admin orders and stats

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/admin-orders/{admin-orders.routes.ts,admin-orders.controller.ts,admin-orders.service.ts,stats.repository.ts}`, `test/integration/admin-orders.int.test.ts`

**Interfaces:**
- Produces: `GET /v1/admin/orders` (`status`, `q` = exact order number or customer email `ILIKE`, cursor), `GET /v1/admin/orders/:id` (+ customer fields + history), `POST /v1/admin/seller-orders/:id/:action` (`reason` required; actor admin), `GET /v1/admin/stats` → `AdminStats`. GMV = Σ `total_paise` of orders with `paid_at` in the window, minus nothing (refunds are reported separately). "Today" starts at local midnight in `BUSINESS_TIMEZONE`. `pendingAcceptance` = count of seller orders `awaiting_acceptance`; `awaitingShipment` = `accepted|packed`; `refundsPendingCount` = seller orders and orders with `refund_status='pending'`.

- [ ] **Step 1: Write failing tests:** `admin search by order number`, `admin search by email`, `admin override requires reason`, `stats today uses IST midnight` (fake clock at 2026-10-07T19:00Z = 00:30 IST next day), `buyer gets 403`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(order): admin order management and stats`.
