# Payment Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `services/payment`: Razorpay order creation, signature-verified payment confirmation, an idempotent webhook (the source of truth for "paid"), duplicate-payment protection, refunds dispatched to Razorpay by a background job, admin payment and refund APIs, and a fake provider for development and E2E.

**Architecture:** A template service. Razorpay sits behind a `PaymentGateway` port (`RazorpayGateway` over plain HTTPS, plus `FakeGateway`). One idempotent routine, `markCaptured`, is shared by the verify endpoint and the webhook. Refunds are written as `pending` rows (from events or admin), and a dispatcher job calls Razorpay outside any DB transaction, deduplicating through refund `notes.craftoriaRefundId`.

**Tech Stack:** service-kit, Kysely, `undici` (Razorpay REST), Node `crypto`.

**Spec:** `02-target-architecture.md` §7.1 (rules 2, 4), §7.3; `03-api-and-event-contracts.md` §7 and events `payment.*`, `refund.*`, `order.refund_required`; `04-data-model.md` §6.

**Prerequisite:** plan 02 complete.

**Required skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; plus the workflow skills `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use **only** the project skills in `.claude/skills/` (mirrored in `.agents/skills/`); no other skills or plugins. See `docs/architecture/05-engineering-standards.md` §8.

## Global Constraints

- Port 4006, database `craftoria_payment`.
- Config: `DATABASE_URL, RABBITMQ_URL, PAYMENT_PROVIDER ('razorpay'|'fake'), RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, RAZORPAY_API_BASE='https://api.razorpay.com', REFUND_DISPATCH_INTERVAL_MS=30000`. The schema refuses `PAYMENT_PROVIDER=fake` when `NODE_ENV=production`.
- Payment signature: `hex(HMAC_SHA256(key_secret, "<razorpay_order_id>|<razorpay_payment_id>"))`. Webhook signature: `hex(HMAC_SHA256(webhook_secret, rawBody))`. Compare with `timingSafeEqual` (different lengths → false).
  - **Test vectors:** secret `test_key_secret_123`, order `order_RZP123`, payment `pay_RZP456` → `d6d45cd4093b06586749d0a925d630401e56cecd082ee2a465bcf01503bdfb4d`. Webhook secret `test_webhook_secret_456`, body `{"event":"payment.captured","payload":{}}` → `127f36f8b2e8ec57deb2be94321c5d2f46c51b543718b3eabdf8e0ed66bc8edb`.
- Razorpay order: `amount` in paise, `currency 'INR'`, `receipt` = the order id (36 chars ≤ 40), `notes {orderId, userId}`. Auto-capture must be enabled on the Razorpay account (owner checklist, plan 15).
- Webhook route mounted with `rawBodyPaths: ['/v1/webhooks/razorpay']`. It responds 200 for every correctly signed request (including unknown orders and ignored event types) so Razorpay doesn't retry forever. Only a bad signature gets 400.
- Never log full webhook bodies at `info`. Log the event id, type and order id only.

## Review Focus

1. **Duplicate payment:** two captured payments for the same Razorpay order (two tabs). The first marks the intent captured; the second is auto-refunded in full as `duplicate_payment` and does not count against the intent. (Task 4 test.)
2. Webhook delivered three times with the same `x-razorpay-event-id` → processed once. (Task 5 test.)
3. The verify endpoint is called with a valid signature while Razorpay still reports `authorized`, not `captured` → returns `created` and doesn't mark captured. (Task 4 test.)
4. A refund request exceeding the remaining refundable amount is not sent to Razorpay; the handler throws → DLQ. (Task 6 test `over-refund rejected`.)
5. The dispatcher crashes after Razorpay created the refund but before saving `gateway_refund_id`: the next run finds it through `listRefunds` notes and doesn't create a second refund. (Task 6 test `dispatcher is crash-safe`.)

---

### Task 1: Scaffold and schema

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `services/payment/**` via `pnpm new:service payment 4006` (platform tables with idempotency); `src/db/migrations/0002_payment_core.ts`; `test/integration/schema.int.test.ts`
- Modify: compose files, `.env.example`

**Interfaces:**
- Produces: `payment_intents`, `refunds` (including `gateway_payment_id`, `counts_against_intent`), `webhook_events` per `04-data-model.md` §6.

- [ ] **Step 1: Write failing tests:** `migrations round-trip`, `refunded_paise cannot exceed amount`, `one intent per order`, `refund idempotency key unique`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(payment): scaffold and schema`.

### Task 2: Gateway port, signatures, Razorpay and fake gateways

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/gateway/{payment-gateway.ts,signatures.ts,signatures.test.ts,razorpay.gateway.ts,fake.gateway.ts}`, `test/integration/razorpay-gateway.int.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface PaymentGateway {
    readonly keyId: string
    createOrder(i: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<{ id: string; amountPaise: number; currency: 'INR' }>
    verifyPaymentSignature(i: { orderId: string; paymentId: string; signature: string }): boolean
    verifyWebhookSignature(rawBody: Buffer, signature: string): boolean
    fetchPayment(paymentId: string): Promise<GatewayPayment>   // { id, orderId, status: 'created'|'authorized'|'captured'|'refunded'|'failed', amountPaise, method: string|null, createdAt: Date }
    listRefunds(paymentId: string): Promise<GatewayRefund[]>    // { id, amountPaise, status: 'pending'|'processed'|'failed', notes }
    createRefund(i: { paymentId: string; amountPaise: number; notes: Record<string, string> }): Promise<GatewayRefund>
  }
  ```
  `signPayment(secret, orderId, paymentId): string`, `signWebhook(secret, body: Buffer): string`, `safeEqualHex(a, b): boolean`.
  `RazorpayGateway({ keyId, keySecret, webhookSecret, apiBase, timeoutMs: 10000 })` uses Basic auth: `POST /v1/orders`, `GET /v1/payments/:id`, `GET /v1/payments/:id/refunds`, `POST /v1/payments/:id/refund`. Non-2xx → `UpstreamUnavailableError('razorpay')`, with Razorpay's `error.description` logged.
  `FakeGateway({ keySecret, webhookSecret })` keeps in-memory orders and payments, generates `order_fake_*`, `pay_fake_*`, `rfnd_fake_*`, and exposes `simulateCapture(orderId): { paymentId, signature, webhookBody: Buffer, webhookSignature }` and `simulateFailure(orderId)`.

- [ ] **Step 1: Write failing tests:** `payment signature matches test vector`, `webhook signature matches test vector`, `safeEqualHex false on length mismatch`; against a stub Razorpay HTTP server: `createOrder sends amount in paise and basic auth`, `fetchPayment maps status`, `non-2xx → UpstreamUnavailableError`; fake: `simulateCapture produces verifiable signatures`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(payment): gateway port, signatures, razorpay and fake gateways`.

### Task 3: Internal payment-intent creation

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/intents/{intents.routes.ts,intents.controller.ts,intents.service.ts,intents.repository.ts,intents.mapper.ts}`, `test/integration/intents.int.test.ts`

**Interfaces:**
- Produces: `POST /internal/payment-intents` (`requireInternal`) → 201 `PaymentIntentOut`. An existing intent for `orderId` → 200 with the same body (no new Razorpay order). The same `orderId` with a different amount → 409 `CONFLICT`. Flow: check existing → `gateway.createOrder` (outside a transaction) → insert (a unique violation from a concurrent call → return the winner's row).

- [ ] **Step 1: Write failing tests:** `creates intent with razorpay order`, `second call returns same intent without calling gateway`, `amount mismatch → 409`, `concurrent calls create one intent`, `gateway failure → 503`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(payment): internal payment intent creation`.

### Task 4: Capture core and verify endpoint

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/capture/{capture.service.ts,verify.routes.ts,verify.controller.ts}`, `test/integration/capture.int.test.ts`

**Interfaces:**
- Produces:
  - `CaptureService.markCaptured(trx, p: { gatewayOrderId; gatewayPaymentId; amountPaise; method: string | null; capturedAt: Date }): Promise<'captured' | 'duplicate_ignored' | 'duplicate_refunded' | 'unknown_order'>`. Lock the intent by `gateway_order_id`. Unknown → `unknown_order`. Status `created|failed` → `captured` + enqueue `payment.captured.v1`. Already captured with the same payment id → `duplicate_ignored`. Captured with a **different** payment id → insert a refund (`reason 'duplicate_payment'`, `counts_against_intent=false`, `gateway_payment_id` = the new payment, idempotency key `dup:<paymentId>`, full amount) → `duplicate_refunded`.
  - `CaptureService.markFailed(trx, { gatewayOrderId, gatewayPaymentId, reason })`: only from `created` → `failed` + `payment.failed.v1` (a later capture can still succeed).
  - `POST /v1/payments/verify` (`requireAuth`): signature invalid → 422 `PAYMENT_SIGNATURE_INVALID`. Intent not owned by the caller → 404. `gateway.fetchPayment` → if `captured` and `orderId` matches → `markCaptured`. Respond `{status}` with the intent's current status.

- [ ] **Step 1: Write failing tests:**
  ```ts
  it('verify with valid signature and captured payment marks captured and emits payment.captured', ...)
  it('verify with bad signature → 422', ...)
  it('verify for another user\'s intent → 404', ...)
  it('verify while authorized returns created and does not capture', ...)
  it('markCaptured twice with same payment is duplicate_ignored', ...)
  it('second distinct payment is auto-refunded as duplicate_payment', ...)
  it('payment.failed then captured ends captured', ...)
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(payment): capture core and verify endpoint`.

### Task 5: Razorpay webhook (payment events)

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/webhooks/{webhooks.routes.ts,webhooks.controller.ts,webhooks.service.ts,razorpay-payload.ts}`, `test/integration/webhooks.int.test.ts`

**Interfaces:**
- Produces: `POST /v1/webhooks/razorpay`. Steps: verify `X-Razorpay-Signature` against the raw body (400 if bad); parse JSON with `RazorpayWebhookSchema` (event, `payload.payment.entity {id, order_id, amount, method, status, error_description}`, `payload.refund.entity {id, payment_id, amount, status, notes}`); event id = header `x-razorpay-event-id` (fallback: sha256 of the body). `INSERT webhook_events … ON CONFLICT DO NOTHING`; if it already exists with `processed_at` set → 200. Then, in a transaction: `payment.captured` → `markCaptured`; `payment.failed` → `markFailed`; `refund.*` → `WebhookRefundHandler` (a no-op until Task 6); others → ignored. Set `processed_at`, or `error` on exception (and still return 200 after logging at `error`, so the admin dashboard surfaces it).
  - `WebhooksService.handle(rawBody: Buffer, headers): Promise<void>`. Also used by the fake checkout in Task 7.

- [ ] **Step 1: Write failing tests:** `bad signature → 400 and nothing stored`, `payment.captured webhook captures`, `same event id three times processed once`, `unknown order acknowledged with error recorded`, `unhandled event type acknowledged`, `webhook after verify does not double emit`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(payment): idempotent razorpay webhook`.

### Task 6: Refunds — requests, dispatcher, refund webhooks, admin refunds

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/refunds/{refunds.service.ts,refunds.repository.ts,refunds.routes.ts,refunds.controller.ts,refunds.mapper.ts}`, `src/events/handlers/order-refund-required.handler.ts`, `src/jobs/refund-dispatcher.job.ts`, `test/integration/refunds.int.test.ts`
- Modify: `src/modules/webhooks/webhooks.service.ts` (wire `refund.processed`/`refund.failed`)

**Interfaces:**
- Produces:
  - `RefundsService.request(trx, { orderId; sellerOrderId: string | null; amountPaise; reason: string; requestedBy: string; idempotencyKey: string }): Promise<Refund>`. The intent must be `captured|partially_refunded` (else `BusinessRuleError('BUSINESS_RULE_VIOLATED', {rule:'not_captured'})`). Guard: Σ(pending + processed refunds with `counts_against_intent`) + amount ≤ `amount_paise` (else `rule:'over_refund'`). Inserts `pending` with `ON CONFLICT (idempotency_key) DO NOTHING` (returns the existing row on replay).
  - Handler `order.refund_required` → `request(...)` with key `refund:<orderId>:<sellerOrderId|'all'>:<reason>`.
  - `POST /v1/admin/refunds` (`requireRole('admin')` + `idempotency({required:true})`) → 202 `Refund` (`reason 'admin:<text>'`, `requestedBy 'admin:<id>'`). `GET /v1/admin/refunds`.
  - Dispatcher job (`runJob 'refund-dispatcher'`): for up to 20 `pending` refunds with `gateway_refund_id IS NULL`: `listRefunds(gateway_payment_id)` → if one has `notes.craftoriaRefundId === refund.id`, adopt its id; else `createRefund({paymentId, amountPaise, notes:{craftoriaRefundId, orderId}})` → save `gateway_refund_id`. Errors are logged and retried next tick.
  - Webhook `refund.processed` → find by `gateway_refund_id` (or `notes.craftoriaRefundId`) → `processed`, `processed_at`. If `counts_against_intent`: `refunded_paise += amount`, intent status `refunded` (when equal to the amount) or `partially_refunded`. Enqueue `refund.processed.v1` with `kind = counts_against_intent ? 'order_refund' : 'duplicate_payment'`. `refund.failed` → `failed` + `refund.failed.v1` (same `kind` rule).

- [ ] **Step 1: Write failing tests:**
  ```ts
  it('order.refund_required creates pending refund once', ...)          // duplicate event → one row
  it('over-refund rejected', ...)                                          // handler throws; no row
  it('dispatcher creates gateway refund and stores id', ...)
  it('dispatcher is crash-safe', ...)                                       // fake gateway already has refund with notes.craftoriaRefundId → adopted, createRefund not called
  it('refund.processed webhook updates intent and emits refund.processed', ...)
  it('duplicate_payment refund does not change refunded_paise', ...)
  it('admin refund requires Idempotency-Key and admin role', ...)
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(payment): refunds with crash-safe dispatcher`.

### Task 7: Admin payments and fake checkout endpoint

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/admin-payments/{admin-payments.routes.ts,admin-payments.controller.ts}`, `src/modules/fake-checkout/{fake-checkout.routes.ts,fake-checkout.controller.ts}`, `test/integration/fake-checkout.int.test.ts`

**Interfaces:**
- Produces:
  - `GET /v1/admin/payments` (`?orderId&status&cursor`).
  - **Only when `PAYMENT_PROVIDER=fake`:** `POST /v1/payments/fake/complete` (`requireAuth`) with body `{ gatewayOrderId: string; outcome: 'success' | 'failure' }`. On success: `fake.simulateCapture` → `WebhooksService.handle(webhookBody, signed headers)` → respond `{ razorpayOrderId, razorpayPaymentId, razorpaySignature }` so the storefront can call `/v1/payments/verify` exactly as with real Razorpay. On failure → `simulateFailure` + a failed webhook → `{ error }`. The route is **not mounted** otherwise (404).

- [ ] **Step 1: Write failing tests:** `fake complete success leads to captured intent and verify succeeds`, `fake complete failure emits payment.failed`, `fake route absent when provider is razorpay`, `admin list filters by status`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(payment): admin payments and fake checkout for dev/e2e`.
