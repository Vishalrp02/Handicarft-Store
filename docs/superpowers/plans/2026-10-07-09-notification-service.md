# Notification Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `services/notification`: turn domain events into transactional emails (buyer, seller, admin), with an outbox-style `notifications` table, retries with backoff, and pluggable providers (Resend in prod, SMTP → Mailpit in dev/E2E, fake in tests).

**Architecture:** A template service with **no public HTTP routes** (only health, metrics and OpenAPI). Event handlers only **enqueue** rows in `notifications` (inside the inbox transaction). A delivery worker sends due rows outside any transaction. Templates are pure TypeScript functions returning `{subject, html, text}`.

**Tech Stack:** service-kit, Kysely, `nodemailer` (SMTP provider), `undici` (Resend API).

**Spec:** `03-api-and-event-contracts.md` §8 (all events consumed by notification); `04-data-model.md` §7; brand copy rules in `.claude/skills/handcrafted-storefront-ui/SKILL.md` ("Copy" section).

**Prerequisite:** plan 02 complete.

**Required skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `database-migration`, `handcrafted-storefront-ui` (email copy and tone, Task 2); plus the workflow skills `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use **only** the project skills in `.claude/skills/` (mirrored in `.agents/skills/`); no other skills or plugins. See `docs/architecture/05-engineering-standards.md` §8.

## Global Constraints

- Port 4007, database `craftoria_notification`.
- Config: `DATABASE_URL, RABBITMQ_URL, EMAIL_PROVIDER ('resend'|'smtp'|'fake'), RESEND_API_KEY?, SMTP_URL?, EMAIL_FROM='Craftoria <no-reply@craftoria.in>', ADMIN_ALERT_EMAIL, STOREFRONT_URL, CONSOLE_URL, DELIVERY_INTERVAL_MS=5000`.
- Retry backoff after failed attempts 1–5: 1 min, 5 min, 30 min, 2 h, 12 h; after the 6th failure → `failed`.
- Idempotency: the unique `(event_id, template, recipient)` row; the provider receives `idempotencyKey = notifications.id` (Resend `Idempotency-Key` header).
- Money in emails via `formatINR`; dates in IST (`Asia/Kolkata`), e.g. "7 Oct 2026".
- Every template has a plain-text part and no remote images except the logo at `${STOREFRONT_URL}/email/logo.png`.

| Template id | Trigger | Recipient |
|---|---|---|
| `welcome` | `user.registered` | user |
| `verify_email` | `user.email_verification_requested` | user |
| `password_reset` | `user.password_reset_requested` | user |
| `seller_application_admin` | `seller.applied` | `ADMIN_ALERT_EMAIL` |
| `seller_approved` | `seller.approved` | seller contact |
| `seller_rejected` | `seller.rejected` | seller contact |
| `order_confirmation` | `order.paid` | buyer |
| `new_order_seller` | `order.paid` (one per seller order) | seller contact |
| `order_shipped` / `order_delivered` / `order_cancelled` | `seller_order.status_changed` with `to` ∈ shipped, delivered, cancelled | buyer |
| `refund_processed` | `refund.processed` | buyer (via `order_contacts`) |
| `payout_paid` | `payout.paid` | seller contact |

## Review Focus

1. `order.paid` for a seller whose `seller_contacts` row doesn't exist yet → the handler throws (retry), so the seller email isn't silently dropped. (Task 3 test.)
2. A provider outage for an hour must not lose emails; the rows retry on schedule. (Task 4 test `backoff schedule`.)
3. A reset-password URL must never appear in logs. (Task 4 test `logs omit email body`.)
4. Two worker instances must not send the same row twice (`FOR UPDATE SKIP LOCKED` + status claim). (Task 4 test.)
5. A user name containing `<script>` is HTML-escaped in every template. (Task 2 test.)

---

### Task 1: Scaffold, schema, email providers

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `services/notification/**` via `pnpm new:service notification 4007`; `src/db/migrations/0002_notification_core.ts`; `src/providers/{email-provider.ts,resend.provider.ts,smtp.provider.ts,fake.provider.ts}`; `test/integration/providers.int.test.ts`
- Modify: compose files, `.env.example`

**Interfaces:**
- Produces: tables `notifications`, `order_contacts`, `seller_contacts` (`04-data-model.md` §7); `interface EmailProvider { send(m: { to: string; subject: string; html: string; text: string; idempotencyKey: string }): Promise<{ messageId: string }> }`. The Resend provider does `POST https://api.resend.com/emails` with Bearer auth and the `Idempotency-Key` header; 429/5xx throw a retryable error and 4xx a permanent `EmailRejectedError`. The SMTP provider uses nodemailer. `FakeEmailProvider` records `sent[]` and can be scripted to fail.

- [ ] **Step 1: Write failing tests:** `migrations round-trip`, `resend provider sends idempotency header` (stub server), `resend 422 → EmailRejectedError`, `smtp provider delivers to mailpit` (opt-in when `MAILPIT_URL` is set; asserts via the Mailpit API).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(notification): scaffold, schema and email providers`.

### Task 2: Templates

**Skills:** `handcrafted-storefront-ui` (first: copy, tone, palette for emails), `impeccable` (email layout), `web-design-guidelines` (accessible email HTML); workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/templates/{layout.ts,escape.ts,index.ts}`, one file per template id (e.g. `src/templates/order-confirmation.ts`), `src/templates/templates.test.ts`, `src/templates/__snapshots__/`

**Interfaces:**
- Produces: `renderTemplate<T extends TemplateId>(id: T, data: TemplateData[T], ctx: { storefrontUrl: string; consoleUrl: string }): { subject: string; html: string; text: string }`. `TemplateData` is typed per template from the event payloads. Copy is concrete and short (brand skill). Examples: subject `Order CR-2610-000123 confirmed — ₹2,450`; `Your parcel from Bagru Prints is on its way`.

- [ ] **Step 1: Write failing tests:** a snapshot per template from the contracts fixture data; `escapes html in names`; `prices use Indian grouping`; `text part contains the action URL`; `order_confirmation lists every seller group`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS. Review the snapshots by eye; commit them.
- [ ] **Step 5: Commit** `feat(notification): email templates`.

### Task 3: Event handlers and contact projections

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `database-migration`, `handcrafted-storefront-ui` (email copy and tone, Task 2); workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/events/handlers/*.handler.ts` (one per consumed event), `src/modules/notifications/notifications.repository.ts`, `test/integration/handlers.int.test.ts`

**Interfaces:**
- Produces: `NotificationsRepository.enqueue(trx, { eventId; template: TemplateId; recipient: string; payload: unknown })` (`ON CONFLICT DO NOTHING`; template data is stored in `notifications.payload`). Handlers: `order.placed` → upsert `order_contacts`; `seller.approved` → upsert `seller_contacts` + enqueue; `user.deleted` → delete `order_contacts` for the user; the others → enqueue per the table in Global Constraints. A missing seller or order contact → throw (retry).

- [ ] **Step 1: Write failing tests:** for every consumed event, feed the fixture and assert the expected rows (template and recipient); `status_changed to accepted enqueues nothing`; `missing seller contact throws`; `duplicate event enqueues once`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(notification): event handlers and contact projections`.

### Task 4: Delivery worker

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `database-migration`, `handcrafted-storefront-ui` (email copy and tone, Task 2); workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/jobs/delivery.job.ts`, `src/modules/notifications/backoff.ts`, `src/modules/notifications/backoff.test.ts`, `test/integration/delivery.int.test.ts`

**Interfaces:**
- Produces: `nextAttemptDelayMs(attempts: number): number | null` (null → give up). The worker runs `runJob('email-delivery', DELIVERY_INTERVAL_MS)`: claim up to 20 due `queued` rows (`UPDATE … SET next_attempt_at = now() + interval '5 minutes' … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *`), render, send. Success → `sent`, `provider_message_id`, `sent_at`. Retryable failure → `attempts+1`, `next_attempt_at` by backoff, `last_error`. Permanent failure or exhausted → `failed`. Metrics: `emails_sent_total{template}`, `emails_failed_total{template}`. Logs include id, template and recipient domain only.

- [ ] **Step 1: Write failing tests:** `backoff schedule` (1→60000 … 5→43200000, 6→null), `sends due notification and marks sent`, `retryable failure reschedules`, `permanent failure marks failed`, `two workers never send same row` (parallel runs with `FakeEmailProvider` → `sent.length` equals the row count), `logs omit email body`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(notification): delivery worker with backoff`.
