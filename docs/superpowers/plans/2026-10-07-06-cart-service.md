# Cart Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `services/cart`: per-user cart and wishlist, guest-cart merge, a local product snapshot projection (so the cart renders without calling catalog), the internal cart read for checkout, and cleanup on `order.paid` and `user.deleted`.

**Architecture:** A template service. `product_snapshots` is fed by `product.*` events with out-of-order protection (`source_event_at`). The cart never stores prices; display prices come from snapshots, and checkout reprices through catalog.

**Tech Stack:** service-kit, Kysely.

**Spec:** `03-api-and-event-contracts.md` §5 and events `product.*`, `order.paid`, `user.deleted`; `04-data-model.md` §4; `02-target-architecture.md` §8 (cart limits).

**Prerequisite:** plan 02 complete.

**Required skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; plus the workflow skills `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use **only** the project skills in `.claude/skills/` (mirrored in `.agents/skills/`); no other skills or plugins. See `docs/architecture/05-engineering-standards.md` §8.

## Global Constraints

- Port 4004, database `craftoria_cart`.
- Limits: qty 1–10 per line, ≤ 50 lines per cart, ≤ 200 wishlist items.
- `itemCount` = Σ qty over all lines; `subtotalPaise` = Σ price × qty over **purchasable** lines only.
- Unknown or unpurchasable product on `PUT /v1/cart/items/:productId` → 422 `PRODUCT_UNAVAILABLE`. Wishlist accepts any product that has a snapshot (unknown → 422).

## Review Focus

1. A `product.updated` event arriving after a newer `product.unpublished` must not make the product purchasable again. (Task 2 test `older event is ignored`.)
2. `order.paid` must remove only the purchased lines, not items added to the cart after checkout began. (Task 5 test.)
3. Merging a guest cart that pushes past 50 lines must keep the first 50 and not error. (Task 3 test `merge caps at 50 lines`.)
4. A product that becomes unpurchasable stays visible in the cart, flagged and excluded from the subtotal and from the internal cart. (Task 3 test.)
5. Concurrent `PUT` on the same line from two tabs must not violate the primary key. (Task 3 test `concurrent upserts keep one line`, using `ON CONFLICT DO UPDATE`.)

---

### Task 1: Scaffold and schema

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `services/cart/**` via `pnpm new:service cart 4004`; `src/db/migrations/0002_cart_core.ts`; `test/integration/schema.int.test.ts`
- Modify: compose files, `.env.example`

**Interfaces:**
- Produces: `cart_items`, `wishlist_items`, `product_snapshots` per `04-data-model.md` §4.

- [ ] **Step 1: Write failing tests:** `migrations round-trip`, `qty check 1..10`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(cart): scaffold and schema`.

### Task 2: Product snapshot projection

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/snapshots/snapshots.repository.ts`, `src/events/handlers/{product-published,product-updated,product-unpublished}.handler.ts`, `test/integration/snapshots.int.test.ts`

**Interfaces:**
- Produces: `SnapshotsRepository.upsertFromEvent(trx, snapshot: ProductSnapshot, purchasable: boolean, occurredAt: Date)`, which only writes when `occurredAt > source_event_at` (`INSERT … ON CONFLICT (product_id) DO UPDATE … WHERE product_snapshots.source_event_at < EXCLUDED.source_event_at`). `.markUnpurchasable(trx, productId, occurredAt)` uses the same guard; an unknown product inserts nothing. `.getMany(productIds): Promise<Map<string, SnapshotRow>>`.

- [ ] **Step 1: Write failing tests:** `published creates purchasable snapshot`, `updated changes price`, `unpublished marks unpurchasable`, `older event is ignored`, `duplicate delivery idempotent`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(cart): product snapshot projection`.

### Task 3: Cart endpoints and internal cart

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/cart/{cart.routes.ts,cart.controller.ts,cart.service.ts,cart.repository.ts,cart.mapper.ts}`, `test/integration/cart.int.test.ts`

**Interfaces:**
- Produces: `GET /v1/cart`, `PUT /v1/cart/items/:productId` (`ON CONFLICT DO UPDATE`; `qty:0` removes; adding a new line when the cart has 50 → 422 `BUSINESS_RULE_VIOLATED` `rule:'cart_line_limit'`), `DELETE /v1/cart/items/:productId`, `DELETE /v1/cart`, `POST /v1/cart/merge`, `GET /internal/carts/:userId` → `InternalCart` (purchasable lines only). Every user endpoint returns `Cart` (except `DELETE /v1/cart` → 204). `buildCart(lines, snapshots): Cart` is a pure mapper.

- [ ] **Step 1: Write failing tests:**
  ```ts
  it('empty cart', ...)                                   // {items:[], itemCount:0, subtotalPaise:0, updatedAt:null}
  it('adds line and computes subtotal from snapshot', ...)
  it('qty 0 removes line', ...)
  it('unpurchasable product rejected on add', ...)        // 422 PRODUCT_UNAVAILABLE
  it('unpurchasable product stays flagged and excluded from subtotal', ...)
  it('51st line rejected', ...)
  it('merge takes max qty and caps at 10', ...)
  it('merge caps at 50 lines', ...)
  it('concurrent upserts keep one line', ...)
  it('internal cart requires internal token and returns purchasable lines only', ...)
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(cart): cart endpoints, guest merge, internal cart`.

### Task 4: Wishlist

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/wishlist/{wishlist.routes.ts,wishlist.controller.ts,wishlist.service.ts,wishlist.repository.ts}`, `test/integration/wishlist.int.test.ts`

**Interfaces:**
- Produces: `GET /v1/wishlist` (newest first, with the product snapshot), `PUT /v1/wishlist/:productId` (idempotent 204; the 201st item → 422 `rule:'wishlist_limit'`), `DELETE /v1/wishlist/:productId` (204 even if absent).

- [ ] **Step 1: Write failing tests:** `add is idempotent`, `list includes product snapshot`, `unknown product → 422`, `remove absent → 204`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(cart): wishlist`.

### Task 5: order.paid and user.deleted handlers

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/events/handlers/{order-paid,user-deleted}.handler.ts`, `test/integration/cart-events.int.test.ts`

**Interfaces:**
- Produces: `order.paid` → delete `cart_items` where `user_id = data.userId AND product_id IN (all purchased product ids)`. `user.deleted` → delete all cart and wishlist rows for the user.

- [ ] **Step 1: Write failing tests:** `order.paid removes only purchased lines`, `user.deleted clears cart and wishlist`, `duplicate event idempotent`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(cart): clean up on order.paid and user.deleted`.
