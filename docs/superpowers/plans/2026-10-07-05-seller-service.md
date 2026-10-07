# Seller Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `services/seller`: artisan applications and profiles, admin approval lifecycle, encrypted bank accounts, an append-only seller ledger driven by order and refund events, and manual payout batches with CSV export.

**Architecture:** A template service. The ledger is append-only (only `status` and `payout_id` mutate). Every money figure is derived from ledger rows, never stored as a running balance.

**Tech Stack:** service-kit, Kysely, `slugify`.

**Spec:** `02-target-architecture.md` §7.4, §8; `03-api-and-event-contracts.md` §4 and events `seller.*`, `payout.paid`, `order.paid`, `seller_order.delivered`, `refund.processed`; `04-data-model.md` §3 (including "Ledger semantics").

**Prerequisite:** plan 02 complete.

**Required skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; plus the workflow skills `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use **only** the project skills in `.claude/skills/` (mirrored in `.agents/skills/`); no other skills or plugins. See `docs/architecture/05-engineering-standards.md` §8.

## Global Constraints

- Port 4003, database `craftoria_seller`.
- Config: `DATABASE_URL, RABBITMQ_URL, BANK_ENC_KEY (base64, 32 bytes), RETURN_WINDOW_DAYS=7, PAYOUT_MINIMUM_PAISE=50000, DEFAULT_COMMISSION_BPS=1000, LEDGER_MATURITY_INTERVAL_MS=3600000`.
- Commission = `percentOfPaise(subtotalPaise, commission_bps)` where `commission_bps` is read **when `order.paid` is processed** (rate changes apply to future orders).
- Bank account numbers are only ever returned as `accountNumberLast4`, except in the admin payout CSV.
- Seller slug: `slugify(displayName,{lower:true,strict:true})`; on collision append `-2`, `-3`, ….

## Review Focus

1. `order.paid` delivered twice must not double-credit. (Task 5 test `duplicate order.paid does not double credit`, enforced by the unique index.)
2. Running payouts twice in a row must not pay anyone twice. (Task 6 test `second run creates no payouts`.)
3. A refund after the seller was paid out must make the balance negative, and the next payout must net it. (Task 6 test `negative balance nets into next payout`.)
4. `order.paid` for a seller not yet in the seller DB (impossible in practice, but events can race) must retry, not drop. (Task 5 test `unknown seller throws so message is retried`.)
5. A tampered `account_number_encrypted` must make the CSV export fail loudly for that row, not export garbage. (Task 6 test.)

---

### Task 1: Scaffold and schema

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `services/seller/**` via `pnpm new:service seller 4003`; `src/db/migrations/0002_seller_core.ts`; `test/integration/schema.int.test.ts`
- Modify: compose files, `.env.example`

**Interfaces:**
- Produces: `sellers`, `seller_bank_accounts`, `ledger_entries` (including `order_id` and its indexes), `payouts` exactly as `04-data-model.md` §3; `citext` extension.

- [ ] **Step 1: Write failing tests:** `migrations round-trip`, `one seller per user`, `ledger sale unique per seller order`, `one pending payout per seller`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(seller): scaffold and schema`.

### Task 2: Apply, profile, public profile

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/profile/{profile.routes.ts,profile.controller.ts,profile.service.ts,sellers.repository.ts,sellers.mapper.ts,slug.ts}`, `test/integration/profile.int.test.ts`

**Interfaces:**
- Produces: `POST /v1/seller/apply` (`requireAuth` + `requireVerifiedEmail`; `contactEmail` = the token email; re-apply allowed only when `rejected`, which resets to `applied`; emits `seller.applied.v1`), `GET /v1/seller/profile` (`requireAuth`; by `userId`), `PATCH /v1/seller/profile` (`requireSeller`), `GET /v1/sellers/:slug` (public; approved only, else 404). `SellersRepository.findByUserId`, `.findById`, `.findBySlug`, `.insert`, `.update`. `toSellerProfile`, `toPublicSeller`.

- [ ] **Step 1: Write failing tests:** `apply creates applied profile and emits seller.applied`, `unverified email → 403 EMAIL_NOT_VERIFIED`, `second apply while applied → 409 CONFLICT`, `re-apply after rejection allowed`, `slug collision gets suffix`, `public profile hidden until approved`, `patch requires artisan`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(seller): applications and profiles`.

### Task 3: Admin seller lifecycle

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/admin-sellers/{admin-sellers.routes.ts,admin-sellers.controller.ts,admin-sellers.service.ts,seller-lifecycle.ts,seller-lifecycle.test.ts}`, `test/integration/admin-sellers.int.test.ts`

**Interfaces:**
- Produces:
  - `nextSellerStatus(current: SellerStatus, action: 'approve' | 'reject' | 'suspend' | 'reinstate'): SellerStatus` (throws `ConflictError('INVALID_STATE_TRANSITION')`). Allowed: applied→approved, applied→rejected, approved→suspended, suspended→approved (reinstate).
  - Endpoints from contracts §4 (`/v1/admin/sellers*`). Events in the same transaction: approve → `seller.approved.v1`; reject → `seller.rejected.v1`; suspend → `seller.suspended.v1`; reinstate → `seller.reinstated.v1`. `PATCH` updates `commission_bps` only.

- [ ] **Step 1: Write failing tests:** unit tests for every allowed and disallowed transition; integration tests `approve sets approved_at, commission and emits seller.approved with contactEmail`, `reject requires reason`, `suspend and reinstate emit events`, `approve rejected seller → 409`, `non-admin 403`, `list filters by status applied`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(seller): admin approval lifecycle`.

### Task 4: Bank account

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/bank/{bank.routes.ts,bank.controller.ts,bank.service.ts,bank.repository.ts}`, `test/integration/bank.int.test.ts`

**Interfaces:**
- Consumes: `encryptAesGcm`/`decryptAesGcm` (service-kit).
- Produces: `PUT/GET /v1/seller/bank-account` → `BankAccountOut`. `BankRepository.getDecrypted(sellerId): Promise<{ accountHolderName; accountNumber; ifsc } | null>` (used only by the payout CSV).

- [ ] **Step 1: Write failing tests:** `stores encrypted and returns last4 only`, `ciphertext does not contain the account number`, `invalid IFSC → 400`, `GET without account → 404`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(seller): encrypted bank account`.

### Task 5: Ledger from events, maturity job, seller ledger and balance

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/ledger/{ledger.repository.ts,ledger.service.ts,ledger.routes.ts,ledger.controller.ts,ledger.mapper.ts,reversal.ts,reversal.test.ts}`, `src/events/handlers/{order-paid,seller-order-delivered,refund-processed}.handler.ts`, `src/jobs/ledger-maturity.job.ts`, `test/integration/ledger.int.test.ts`

**Interfaces:**
- Produces:
  - `order.paid` → per seller order: `sale +subtotal` and `commission -percentOfPaise(subtotal, bps)` (both `pending`, with `order_id`, `seller_order_id`, `order_number`; `ON CONFLICT DO NOTHING`). An unknown `sellerId` → throw (retry, then DLQ).
  - `seller_order.delivered` → set `available_at = deliveredAt + RETURN_WINDOW_DAYS` on that seller order's `sale`/`commission` rows.
  - `refund.processed` → **ignore `kind: 'duplicate_payment'`** (the seller never received that money); otherwise reversals per `04-data-model.md` "Ledger semantics", computed by the pure function `computeReversal({ refundAmountPaise, salePaise, commissionPaise, alreadyReversedPaise }): { saleReversal: number; commissionReversal: number }`.
  - Maturity job (`runJob 'ledger-maturity'`): `pending` → `available` where `available_at <= now`.
  - `GET /v1/seller/ledger`, `GET /v1/seller/balance` (contracts §4).

- [ ] **Step 1: Write failing tests:**
  ```ts
  it('computeReversal full refund mirrors sale and commission', ...)   // sale 100000, commission -10000 → -100000, +10000
  it('computeReversal partial refund is proportional and bounded', ...)
  it('order.paid credits sale and commission per seller', ...)          // 2 sellers → 4 rows; commission 10% rounded half up
  it('duplicate order.paid does not double credit', ...)
  it('unknown seller throws so message is retried', ...)
  it('delivered sets available_at +7 days; maturity job makes it available', ...)  // fake clock
  it('order-level refund reverses every seller order', ...)
  it('duplicate_payment refund leaves the ledger unchanged', ...)
  it('balance sums by status', ...)
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(seller): event-driven ledger and balances`.

### Task 6: Payouts

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/payouts/{payouts.routes.ts,payouts.controller.ts,payouts.service.ts,payouts.repository.ts,payouts-csv.ts}`, `test/integration/payouts.int.test.ts`

**Interfaces:**
- Consumes: `BankRepository.getDecrypted` (Task 4), `LedgerRepository` (Task 5).
- Produces: `POST /v1/admin/payouts/run` (one transaction per seller: lock the seller's available entries `FOR UPDATE`; if Σ ≥ `PAYOUT_MINIMUM_PAISE`, a bank account exists and there is no pending payout → create the payout, tag the entries, append the payout entry), `GET /v1/admin/payouts` (JSON or `text/csv` via `Accept`; the CSV amount is in rupees with 2 decimals), `POST …/:id/mark-paid {utr}` (→ `payout.paid.v1`), `POST …/:id/mark-failed {reason}`, `GET /v1/seller/payouts`.

- [ ] **Step 1: Write failing tests:** `run creates payout for eligible seller only` (below minimum and no-bank sellers skipped), `second run creates no payouts`, `mark-paid sets entries paid and emits payout.paid`, `mark-failed restores available balance`, `negative balance nets into next payout`, `csv contains full account number and rupee amount`, `tampered ciphertext makes csv export fail with 500 INTERNAL and logs payout id`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(seller): manual payout batches with CSV export`.
