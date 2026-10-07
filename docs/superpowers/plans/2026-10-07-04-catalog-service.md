# Catalog Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `services/catalog`: categories, seller product management with moderation, image pipeline to R2, inventory with **race-safe reservations**, public search and browse, verified-purchase reviews, and the product events that keep carts in sync.

**Architecture:** A template service. Postgres full-text + trigram search. Inventory lives in an `inventory` row per product, reserved through conditional `UPDATE … WHERE on_hand - reserved >= qty` inside one transaction (all or nothing). Images go browser → R2 by presigned PUT, then `sharp` generates WebP variants on confirm. The seller projection comes from `seller.*` events.

**Tech Stack:** service-kit, Kysely, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, `sharp`, `iovalkey`, `slugify`.

**Spec:** `02-target-architecture.md` §4, §7.1 (rules 3–5), §7.4, §7.5, §9 (search, caching); `03-api-and-event-contracts.md` §3 and events `product.*`, `inventory.commit_failed`, `order.paid`, `order.cancelled`, `seller.*`, `user.deleted`; `04-data-model.md` §2.

**Prerequisite:** plan 02 complete.

**Required skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; plus the workflow skills `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use **only** the project skills in `.claude/skills/` (mirrored in `.agents/skills/`); no other skills or plugins. See `docs/architecture/05-engineering-standards.md` §8.

## Global Constraints

- Port 4002, database `craftoria_catalog`.
- Config: `DATABASE_URL, RABBITMQ_URL, VALKEY_URL, OBJECT_STORAGE_ENDPOINT, OBJECT_STORAGE_REGION ('auto'), OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_ACCESS_KEY_ID, OBJECT_STORAGE_SECRET_ACCESS_KEY, MEDIA_PUBLIC_BASE_URL, RESERVATION_GRACE_SECONDS=900, RESERVATION_SWEEP_INTERVAL_MS=60000`.
- **Visible product** = `products.status = 'active'` AND `sellers.status = 'approved'`. Public endpoints and reservations only ever see visible products.
- Content fields (a change on an `active` product → `pending_review`): `title, description, categoryId, craftTechnique, materials, originRegion, careInstructions`, plus any image add/delete/reorder. Commercial fields (stay `active`): `pricePaise, compareAtPricePaise, taxRateBps, hsnCode, dimensionsCm, weightGrams, makingTimeDays`.
- The slug is generated from the title while the product has never been published (`published_at IS NULL`), then frozen. Format: `slugify(title, {lower:true, strict:true}).slice(0,60) + '-' + id.slice(-6)`.
- Storage keys: original `uploads/<sellerId>/<productId>/<uuid>`; variants `p/<productId>/<imageId>-<width>.webp` with `Cache-Control: public, max-age=31536000, immutable`. Public URL = `${MEDIA_PUBLIC_BASE_URL}/<key>`.
- Lock order: when touching several inventory rows, always update them in ascending `product_id` order (deadlock avoidance).

## Review Focus

1. **One-of-a-kind race:** 50 concurrent reservations for a product with `on_hand=1` → exactly one succeeds and `reserved` ends at 1. (Task 9 test `concurrent reservations never oversell`.)
2. A partially satisfiable reservation (item A in stock, item B not) must reserve nothing. (Task 9 test `all-or-nothing reservation`.)
3. `order.paid` arriving after the safety net expired the reservation: commit if stock is still free, else publish `inventory.commit_failed` and change nothing. (Task 10 tests.)
4. A search query with special characters (`"blue & pottery" OR -`, `'; drop`) must not 500. (Task 8 test `search tolerates operator characters`.)
5. A seller must never read or modify another seller's product, including through image and inventory sub-routes. (Tasks 4–6 tests `other seller gets 404`.)

---

### Task 1: Scaffold and schema

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `services/catalog/**` via `pnpm new:service catalog 4002`; `src/db/migrations/0002_catalog_core.ts`; `test/integration/schema.int.test.ts`
- Modify: compose files and `.env.example`

**Interfaces:**
- Produces: extensions `pg_trgm` and `unaccent`; function `unaccent_immutable(text)` (`IMMUTABLE`, `SELECT public.unaccent('public.unaccent', $1)`); every table in `04-data-model.md` §2 with indexes and triggers.

- [ ] **Step 1: Write failing tests:** `migrations round-trip`, `inventory check prevents reserved > on_hand`, `search_vector is populated from title`, `review unique per user and product`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(catalog): scaffold and schema`.

### Task 2: Categories (public list, admin CRUD, cache)

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/categories/{categories.routes.ts,categories.controller.ts,categories.service.ts,categories.repository.ts,categories.mapper.ts}`, `src/infra/cache.ts`, `test/integration/categories.int.test.ts`

**Interfaces:**
- Produces: `GET /v1/categories` (cached in Valkey under `categories:v1` for 300 s; `productCount` counts visible products), `POST/PATCH/DELETE /v1/admin/categories[/:id]`. Delete with products → 409 `CONFLICT`. Setting `parentId` to itself or a descendant → 422 `BUSINESS_RULE_VIOLATED` (`rule:'category_cycle'`). Any write deletes the cache key.
  - `Cache { get<T>(key, schema): Promise<T | null>; set(key, value, ttlSeconds): Promise<void>; del(...keys): Promise<void> }`. Cache failures are logged and ignored (fail open).
  - `CategoriesRepository.descendantIds(categoryId): Promise<string[]>` (recursive CTE; used by Task 8).

- [ ] **Step 1: Write failing tests:** `lists active categories with counts`, `admin creates category with generated slug`, `duplicate slug → 409`, `cycle rejected`, `delete with products → 409`, `buyer cannot create (403)`, `cache invalidated after update`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(catalog): categories with admin CRUD and caching`.

### Task 3: Seller projection and product visibility events

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/sellers/sellers.repository.ts`, `src/modules/products/product-events.ts`, `src/modules/products/product-events.test.ts`, `src/events/handlers/{seller-approved,seller-suspended,seller-reinstated}.handler.ts`, `test/integration/seller-events.int.test.ts`, `test/factories.ts`

**Interfaces:**
- Produces:
  - `isVisible(p: { status: ProductStatus }, sellerStatus: 'approved' | 'suspended' | null): boolean`.
  - `productEventFor(before: VisibleState | null, after: VisibleState): { kind: 'published' | 'updated' | 'unpublished'; reason?: UnpublishReason } | null`, where `VisibleState = { visible: boolean; snapshot: ProductSnapshot; status: ProductStatus; sellerStatus }`. Hidden → visible: `published`. Visible → hidden: `unpublished` with a reason derived from `status`/`sellerStatus`. Visible → visible with any snapshot field changed: `updated`. Otherwise `null`.
  - `emitProductChange(trx, before, after): Promise<void>` (calls `enqueueEvent` with the right key).
  - `loadSnapshot(trx, productId): Promise<VisibleState>` (joins seller and primary image 400 px URL).
  - Handlers: `seller.approved` upserts `sellers` (status approved; also updates display name, slug, region). `seller.suspended` sets status suspended and emits `unpublished(seller_suspended)` for each of the seller's active products. `seller.reinstated` sets approved and emits `published` for each active product.
  - `test/factories.ts`: `insertSeller(db, overrides?)`, `insertCategory(db, overrides?)`, `insertProduct(db, overrides?)` (with inventory row), used by later tasks.

- [ ] **Step 1: Write failing tests:** unit tests for `productEventFor` (draft→active = published; active→pending_review = unpublished(pending_review); price change while active = updated; inventory-only change = null; active with seller suspended → unpublished(seller_suspended)); integration tests `seller.approved creates projection`, `suspension unpublishes active products` (outbox has N `product.unpublished.v1`, each valid against the registry), `reinstatement republishes`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(catalog): seller projection and product visibility events`.

### Task 4: Seller product management

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/seller-products/{seller-products.routes.ts,seller-products.controller.ts,seller-products.service.ts}`, `src/modules/products/{products.repository.ts,products.mapper.ts,slug.ts}`, `test/integration/seller-products.int.test.ts`

**Interfaces:**
- Consumes: Task 3 (`emitProductChange`, `loadSnapshot`, factories); `requireSeller()`.
- Produces: `GET/POST /v1/seller/products`, `GET/PATCH /v1/seller/products/:id`, `POST …/:id/submit`, `POST …/:id/archive` per contracts §3. The seller id **always** comes from `req.auth.sellerId`. A suspended seller → 403 `FORBIDDEN` on writes. Create also inserts `inventory(on_hand 0)`. Submit needs ≥1 image (else 422 `BUSINESS_RULE_VIOLATED` `rule:'image_required'`) and status `draft|rejected`. A content-field change on `active` → `pending_review`. Every write calls `emitProductChange` in the same transaction and deletes the cache key `product:<id>`.
  - `ProductsRepository.findForSeller(sellerId, id)`, `.listForSeller(sellerId, {status, cursor, limit})`, `.insert`, `.update`, `.getSellerProduct(id): SellerProduct`.
  - `toSellerProduct(row, images, inventory): SellerProduct`.

- [ ] **Step 1: Write failing tests:**
  ```ts
  it('creates draft product with slug and zero stock', ...)
  it('rejects price above ₹1,00,000', ...)
  it('other seller gets 404 on read and patch', ...)
  it('buyer without artisan role gets 403', ...)
  it('submit without image → 422 image_required', ...)
  it('editing title of active product moves it to pending_review and emits unpublished', ...)
  it('editing price of active product stays active and emits updated', ...)
  it('slug is frozen after first publish', ...)
  it('archive emits unpublished(archived)', ...)
  it('suspended seller cannot create', ...)
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(catalog): seller product management`.

### Task 5: Seller inventory

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/inventory/{inventory.routes.ts,inventory.controller.ts,inventory.service.ts,inventory.repository.ts}`, `test/integration/inventory.int.test.ts`

**Interfaces:**
- Produces: `PUT /v1/seller/products/:id/inventory` `{onHand}` → `{onHand, reserved, available}`. `onHand < reserved` → 409 `CONFLICT` (`details:{reserved}`). Implemented as `UPDATE inventory SET on_hand=$1 WHERE product_id=$2 AND reserved <= $1`. Also produces `InventoryRepository` methods used by Task 9: `reserveLine(trx, productId, qty): Promise<boolean>`, `availableOf(trx, productIds): Promise<Map<string, number>>`, `commitLine(trx, productId, qty)`, `releaseLine(trx, productId, qty)`, `forceCommitLine(trx, productId, qty): Promise<boolean>` (`on_hand -= qty WHERE on_hand - reserved >= qty`).

- [ ] **Step 1: Write failing tests:** `sets on hand`, `cannot set below reserved`, `other seller gets 404`, plus repository tests `reserveLine fails when insufficient`, `commitLine decrements both`, `releaseLine decrements reserved only`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(catalog): seller inventory and inventory repository`.

### Task 6: Product images (R2 presigned upload, WebP variants)

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/infra/object-storage.ts` (`S3ObjectStorage`), `src/infra/object-storage.fake.ts` (`InMemoryObjectStorage`), `src/modules/images/{images.routes.ts,images.controller.ts,images.service.ts,images.repository.ts,image-processor.ts}`, `test/integration/images.int.test.ts`, `test/fixtures/{sample.jpg,not-an-image.jpg}`

**Interfaces:**
- Produces:
  - `ObjectStorage { presignPut(key: string, contentType: string, contentLength: number, expiresSeconds: number): Promise<string>; get(key: string): Promise<Buffer | null>; put(key: string, body: Buffer, contentType: string, cacheControl: string): Promise<void>; delete(keys: string[]): Promise<void> }`.
  - `processImage(input: Buffer): Promise<{ width: number; height: number; variants: { width: 400 | 800 | 1600; body: Buffer }[] }>`. Uses `sharp`: `.rotate()` (EXIF orientation) → strip metadata → for each width ≤ the original width (always at least 400), `resize({width, withoutEnlargement:true}).webp({quality:80})`. Rejects non-images, > 40 megapixels, or < 400 px wide with 422 `BUSINESS_RULE_VIOLATED` (`rule:'invalid_image'`).
  - Endpoints from contracts §3: `upload-url`, `POST images` (confirm), `PATCH`/`DELETE` image. Max 8 images. Confirm requires the `storageKey` to begin with `uploads/<sellerId>/<productId>/`. The original object is deleted after the variants are stored. Image changes on an active product → `pending_review` (Global Constraints).

- [ ] **Step 1: Write failing tests:** `upload-url returns key scoped to seller and product`, `rejects 11MB content length`, `confirm creates variants 400/800/1600 for 2000px image`, `confirm rejects text file renamed .jpg`, `confirm rejects storageKey of another product`, `ninth image rejected`, `delete removes variant objects`, `reorder positions`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (tests use `InMemoryObjectStorage`; one opt-in test `@minio` runs against the compose MinIO when `MINIO_URL` is set). **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(catalog): product images via presigned upload and webp variants`.

### Task 7: Admin product moderation

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/admin-products/{admin-products.routes.ts,admin-products.controller.ts,admin-products.service.ts}`, `test/integration/admin-products.int.test.ts`

**Interfaces:**
- Produces: `GET /v1/admin/products`, `POST …/:id/approve` (only from `pending_review` → `active`, sets `published_at` if null, emits `published`), `POST …/:id/reject {reason}` (from `pending_review` → `rejected`, stores the reason). Any other source state → 409 `INVALID_STATE_TRANSITION`.

- [ ] **Step 1: Write failing tests:** `approve publishes and emits product.published`, `reject stores reason`, `approve from draft → 409`, `non-admin 403`, `list filters by status pending_review`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(catalog): admin product moderation`.

### Task 8: Public browse, search, product detail

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/public-products/{public-products.routes.ts,public-products.controller.ts,public-products.service.ts,search.repository.ts}`, `test/integration/public-products.int.test.ts`

**Interfaces:**
- Consumes: `CategoriesRepository.descendantIds` (Task 2), `Cache` (Task 2).
- Produces:
  - `GET /v1/products` per contracts §3. With `q`: match `search_vector @@ websearch_to_tsquery('simple', unaccent_immutable($q)) OR similarity(title, $q) > 0.3`; rank `ts_rank_cd(search_vector, query) + 0.5 * similarity(title, $q)`. `q` is trimmed and capped at 100 chars, and `websearch_to_tsquery` handles operators safely. `category` includes descendants. `inStock=true` → `on_hand - reserved > 0`. Sort `relevance` without `q` falls back to `newest`. `total` via `count(*) OVER()`. Only visible products.
  - `GET /v1/products/:idOrSlug` (UUID → id, else slug). Cached under `product:<id>` for 60 s. `availableQty = min(on_hand - reserved, 10)`. `inStock = availableQty > 0`.

- [ ] **Step 1: Write failing tests:**
  ```ts
  it('lists only visible products', ...)                         // draft, rejected, suspended-seller products absent
  it('search finds by craft technique and tolerates typo', ...)  // 'blockprint' and 'pottry' find seeded items
  it('search tolerates operator characters', ...)                // q = '"blue & pottery" OR -' and "'; drop" → 200
  it('category filter includes subcategories', ...)
  it('price range and sort price_asc', ...)
  it('inStock filter excludes fully reserved', ...)
  it('page 51 rejected', ...)                                    // 400
  it('detail by slug and by id', ...)
  it('detail of draft product → 404', ...)
  it('detail cache invalidated after seller price change', ...)
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS. Also run `EXPLAIN` on the search query with 10k seeded products and confirm the GIN index is used; note the plan in the task report.
- [ ] **Step 5: Commit** `feat(catalog): public browse, search and product detail`.

### Task 9: Reservations (internal API)

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/reservations/{reservations.routes.ts,reservations.controller.ts,reservations.service.ts,reservations.repository.ts}`, `test/integration/reservations.int.test.ts`

**Interfaces:**
- Consumes: `InventoryRepository` (Task 5); contracts `ReserveRequestSchema`, `ReserveResponseSchema`.
- Produces:
  - `POST /internal/reservations` (`requireInternal`). Algorithm, in one transaction: (1) lock any existing reservation `FOR UPDATE`; if `active`, return its lines with 200; if closed, 409 `CONFLICT`. (2) Load the requested products; any not visible → 422 `PRODUCT_UNAVAILABLE` with `details.productIds`. (3) For items sorted by `productId`, `reserveLine`; collect failures. (4) Any failure → throw `ConflictError('OUT_OF_STOCK', …, {items:[{productId, requested, available}]})` (the transaction rolls back every line). (5) Insert the reservation with `expires_at = now + ttlSeconds + RESERVATION_GRACE_SECONDS` and the item snapshots (price, title, slug, 400 px image URL, tax rate, seller id, seller display name). Return 201.
  - `POST /internal/reservations/:id/release` → 204 (`active` → `released`, decrement reserved; otherwise a no-op).
  - `ReservationsService.commit(trx, reservationId): Promise<{ ok: true } | { ok: false; items: {productId, requested, available}[] }>`, used by Task 10. `active` → `commitLine` each item → `committed`. Already `committed` → ok (idempotent). `released`/`expired` → try `forceCommitLine` for every item in order; if any fails, roll back to a savepoint and return `ok:false` with availability.
  - `ReservationsService.release(trx, reservationId, finalStatus: 'released' | 'expired')`.

- [ ] **Step 1: Write failing tests:**
  ```ts
  it('reserves and returns server prices', ...)                   // lines[].unitPricePaise equals products.price_paise
  it('same reservationId twice returns same lines without double reserving', ...)
  it('all-or-nothing reservation', ...)                           // A ok, B short → 409 OUT_OF_STOCK, A.reserved unchanged
  it('concurrent reservations never oversell', ...)               // 50 parallel requests, on_hand 1 → exactly one 201
  it('hidden product → 422 PRODUCT_UNAVAILABLE', ...)
  it('missing internal token → 401', ...)
  it('release frees stock and is idempotent', ...)
  it('commit after expiry succeeds when stock still free', ...)
  it('commit after expiry fails cleanly when stock sold', ...)     // ok:false, on_hand unchanged
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(catalog): race-safe stock reservations`.

### Task 10: Order event handlers and reservation sweeper

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/events/handlers/{order-paid,order-cancelled}.handler.ts`, `src/jobs/reservation-sweeper.job.ts`, `test/integration/order-events.int.test.ts`

**Interfaces:**
- Consumes: `ReservationsService` (Task 9); fixtures `order.paid.v1`, `order.cancelled.v1`.
- Produces:
  - `order.paid` → `commit(trx, orderId)`. Ok → insert `verified_purchases` for every `(userId, productId, orderId)`. Not ok → `enqueueEvent('inventory.commit_failed.v1', {reservationId, items})` and still insert nothing.
  - `order.cancelled` → `release(trx, orderId, 'released')`.
  - The sweeper job (`runJob` named `reservation-sweeper`, interval `RESERVATION_SWEEP_INTERVAL_MS`) releases up to 100 `active` reservations with `expires_at < now()` as `expired`, using `FOR UPDATE SKIP LOCKED`.

- [ ] **Step 1: Write failing tests:** `order.paid commits stock and records verified purchases`, `order.paid twice is idempotent` (stock decremented once), `order.paid after sweep with stock sold emits inventory.commit_failed` (payload valid against the registry), `order.cancelled releases`, `sweeper expires overdue reservations only` (fake clock).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(catalog): commit/release on order events, reservation sweeper`.

### Task 11: Reviews

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/reviews/{reviews.routes.ts,reviews.controller.ts,reviews.service.ts,reviews.repository.ts,reviews.mapper.ts}`, `src/events/handlers/user-deleted.handler.ts`, `test/integration/reviews.int.test.ts`

**Interfaces:**
- Produces: `GET /v1/products/:id/reviews` → `ReviewPage` (published only, newest first, with a `summary`). `POST /v1/products/:id/reviews` needs a `verified_purchases` row (else 422 `PURCHASE_REQUIRED`); a duplicate → 409 `ALREADY_REVIEWED`; `authorName` = `toAuthorName(name)` ("Asha Rao Kumar" → "Asha K."; a single word stays as-is). It recomputes `rating_avg` (2 dp) and `rating_count` over published reviews in the same transaction, and invalidates the `product:<id>` cache. `PATCH /v1/admin/reviews/:id {status}` recomputes too. `user.deleted` sets `author_name = 'Former customer'` for that user's reviews.

- [ ] **Step 1: Write failing tests:** `buyer without purchase → 422`, `verified buyer creates review and rating updates`, `second review → 409`, `hidden review excluded from summary`, `toAuthorName formats`, `user.deleted anonymises author`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(catalog): verified-purchase reviews`.
