# Legacy Data Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `tools/mongo-migrator`, a one-time, idempotent, dry-runnable CLI that moves legacy MongoDB data (users, wishlists, products and images, reviews, orders, carts) into the v2 Postgres databases, with a reconciliation report to sign off the cutover.

**Architecture:** A TypeScript CLI. It reads Mongo with a read-only user, transforms each document through pure mapping functions (validated with `@craftoria/contracts` where applicable), and writes **directly** to each service database with Kysely. This is the only sanctioned cross-database writer, and it runs only during the cutover window. IDs are deterministic (`uuidv5`), and every write is an upsert on `legacy_mongo_id` (or the natural key), so reruns are safe. No events are published, so the projections that events would normally fill (catalog `sellers`, cart `product_snapshots`, notification `seller_contacts`) are written directly.

**Tech Stack:** Node 24, TypeScript, `mongodb` 6, Kysely + `pg`, `uuid` (v5), `@craftoria/media` (extracted in Task 3), `@aws-sdk/client-s3`, Vitest, `mongodb-memory-server`, Testcontainers Postgres.

**Spec:** `01-current-state-audit.md` §1 (legacy shapes); `04-data-model.md` (`legacy_mongo_id` columns, `orders.source`); `02-target-architecture.md` §8 (money).

**Prerequisite:** plans 03, 04, 05, 06, 07, 08 Task 1 (schemas) complete.

**Required skills:** `safe-backend-changes` (first), `database-migration`, `postgresql-table-design`, `nodejs-backend-patterns`; plus the workflow skills `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use **only** the project skills in `.claude/skills/` (mirrored in `.agents/skills/`); no other skills or plugins. See `docs/architecture/05-engineering-standards.md` §8.

## Global Constraints

- CLI: `pnpm --filter @craftoria/mongo-migrator start -- --mongo-uri <uri> --target-env <file> --studio-owner-email <email> (--dry-run | --execute) [--only users,products,orders,...] [--report out/migration-report.json]`.
- ID mapping: `legacyId(collection: string, oid: string) = uuidv5(`${collection}:${oid}`, NAMESPACE)` with `NAMESPACE = 'f4b7a1de-7c39-4c5e-9a43-1b0c5e2f6a10'`.
- Money: `toPaise(rupees: unknown): number | null` = `Math.round(Number(rupees) * 100)`, accepted only when it is a finite, safe, non-negative integer after rounding.
- **Craftoria Studio**: every legacy product belongs to one platform seller (`slug 'craftoria-studio'`, `commission_bps 0`, approved). It is owned by the user `--studio-owner-email`, who gets the `artisan` role and `seller_id`.
- Legacy users are marked `email_verified_at = migration time` (they have used the address for orders), keep their bcrypt hash (identity rehashes on first login, plan 03 Task 3), and get `buyer` (+ `admin` if `isAdmin`).
- Products that fail `ProductUpsertSchema` (short description, price out of range, no valid image) are imported as **`draft`**, listed in the report under `needs_attention`, never dropped.
- Legacy order mapping:

  | Legacy | `orders.status` | seller order status |
  |---|---|---|
  | `isPaid && isDelivered` | `completed` | `delivered` (`delivered_at = deliveredAt ?? paidAt`) |
  | `isPaid && !isDelivered` | `paid` | `awaiting_acceptance` (shows up in Studio's queue) |
  | `!isPaid` | `cancelled` (`cancel_reason 'legacy_unpaid'`) | `cancelled` |

  Totals: `items_subtotal = Σ toPaise(price) × qty`; `total = toPaise(totalPrice)`; `shipping = total - subtotal` when ≥ 0, else (anomaly: client-supplied total was too low) `total = subtotal`, `shipping = 0`, and report it. `source='legacy'`. A paid order also gets a `payment_intents` row (`status 'captured'`, `gateway_order_id 'legacy_<orderOid>'`, `gateway_payment_id = paymentResult.id ?? null`), so admins can refund through Razorpay later.
- The tool never deletes data in the targets. `--execute` refuses to run unless every target database has run its migrations to the latest version.

## Review Focus

1. Two legacy users with the same email in different case: one survives (the one with the most orders, then the oldest); the other's orders and reviews are re-pointed to the survivor; both appear in the report. (Task 2 test.)
2. A rerun after a partial failure must not duplicate rows or re-upload images. (Task 3 test `rerun skips existing images`.)
3. An order whose `totalPrice` is lower than the sum of its items (evidence of the C1 exploit) is imported, flagged `anomaly:'total_below_items'`, and counted separately in the report. (Task 4 test.)
4. A base64 image over 10 MB, corrupt, or not an image → the product is a draft without that image, and the run continues. (Task 3 test.)
5. A cart or wishlist item pointing at a deleted product is skipped and counted, not a crash. (Tasks 2 and 4 tests.)

---

### Task 1: Tool scaffold, readers, id mapping, report, test harness

**Skills:** `safe-backend-changes` (first), `database-migration`, `postgresql-table-design`, `nodejs-backend-patterns`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `tools/mongo-migrator/{package.json,tsconfig.json,vitest.config.ts,src/cli.ts,src/config.ts,src/ids.ts,src/money.ts,src/report.ts,src/targets.ts,src/source.ts,src/steps/types.ts}`, `test/harness.ts`, `src/*.test.ts`

**Interfaces:**
- Produces:
  - `legacyId(collection, oid): string`; `toPaise(v: unknown): number | null`.
  - `Report`: `{ startedAt; finishedAt; mode: 'dry-run'|'execute'; steps: Record<StepName, { read: number; written: number; skipped: number; anomalies: { id: string; kind: string; detail: string }[]; needsAttention: { id: string; reason: string }[] }> }` with `report.toMarkdown(): string`.
  - `Targets`: `{ identity: Kysely<any>; catalog; seller; cart; order; payment; notification }` built from the target env file; `assertMigrated(targets)`.
  - `Step = { name: StepName; dependsOn: StepName[]; run(ctx: { source: Db; targets: Targets; report: Report; dryRun: boolean; idMap: IdMap; log: Logger }): Promise<void> }`. `IdMap` caches legacy → new ids per collection (needed for cross-references).
  - `test/harness.ts`: `startHarness()` → `{ mongo (memory server with seed helpers), targets (fresh Postgres DBs migrated with every service's real migrations), objectStorage: InMemoryObjectStorage, stop() }`.

- [ ] **Step 1: Write failing tests:** `legacyId is deterministic and differs per collection`, `toPaise(499.995) → 50000; toPaise('12.5') → 1250; toPaise(-1) → null; toPaise(NaN) → null`, `report markdown lists anomalies`, `execute refuses when a target is not migrated`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(migrator): scaffold, id mapping, report, harness`.

### Task 2: Users, roles, wishlists

**Skills:** `safe-backend-changes` (first), `database-migration`, `postgresql-table-design`, `nodejs-backend-patterns`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/steps/users.step.ts`, `src/transform/user.ts`, tests

**Interfaces:**
- Produces: the `users` step writes identity `users` (`legacy_mongo_id`, lower-cased email, name default "Customer", bcrypt hash as-is, verified now, status active) and `user_roles`; it handles duplicate emails per Review Focus 1 (`idMap.users` maps **both** legacy ids to the survivor). The `wishlists` step (depends on `products`) writes cart `wishlist_items` for mapped products and skips the rest with a count.

- [ ] **Step 1: Write failing tests:** `migrates user with bcrypt hash that verifies via identity's verifyPassword`, `isAdmin gets admin role`, `case-duplicate emails merged and reported`, `rerun writes nothing new`, `wishlist skips missing products`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(migrator): users, roles and wishlists`.

### Task 3: Media package, Studio seller, categories, products, images, inventory, snapshots

**Skills:** `safe-backend-changes` (first), `database-migration`, `postgresql-table-design`, `nodejs-backend-patterns`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `packages/media/{package.json,src/index.ts,src/process-image.ts}` (moved from `services/catalog/src/modules/images/image-processor.ts`, with its tests); `tools/mongo-migrator/src/steps/{studio.step.ts,categories.step.ts,products.step.ts}`, `src/transform/product.ts`, tests
- Modify: `services/catalog/src/modules/images/images.service.ts` (import `processImage` from `@craftoria/media`), catalog `package.json`

**Interfaces:**
- Produces:
  - `@craftoria/media`: `processImage(input: Buffer): Promise<ProcessedImage>` (unchanged signature; the catalog tests must still pass).
  - `studio` step: seller DB `sellers` (approved, commission 0, contact = owner email), catalog `sellers` projection, notification `seller_contacts`, identity: the owner gets `artisan` + `seller_id`.
  - `categories` step: distinct legacy `category` strings → `slugify`, de-duplicated case-insensitively; empty → `uncategorised`.
  - `products` step: `transformProduct(doc, ctx): { product; inventory; images: { kind: 'dataUrl' | 'url'; value: string }[]; status: 'active' | 'draft'; needsAttention: string[] }`. Images: decode the data URL (≤ 10 MB) or download the URL (10 s timeout, ≤ 10 MB) → `processImage` → upload the variants to object storage under `p/<productId>/<imageId>-<w>.webp`, with `imageId = legacyId('product_images', oid + ':' + index)`. Skip the upload if `product_images` already has that id. Writes `products` (`published_at = createdAt` when active), `inventory(on_hand = max(0, countInStock))`, `product_images`, and cart `product_snapshots` for active products.

- [ ] **Step 1: Write failing tests:** `catalog image tests still pass after extraction` (run `pnpm --filter @craftoria/catalog test`), `valid product imported active with variants`, `short description imported as draft with needsAttention`, `corrupt base64 image → draft without image, run continues`, `price 0 → draft`, `rerun skips existing images` (object storage put count unchanged), `snapshot written for active only`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(migrator): studio seller, categories, products with images; extract @craftoria/media`.

### Task 4: Orders, payment intents, reviews, verified purchases, carts

**Skills:** `safe-backend-changes` (first), `database-migration`, `postgresql-table-design`, `nodejs-backend-patterns`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/steps/{orders.step.ts,reviews.step.ts,carts.step.ts}`, `src/transform/{order.ts,address.ts}`, tests

**Interfaces:**
- Produces:
  - `transformAddress(legacy: unknown): AddressLike` (object `{name,address,city,state,zip,country,phone}` → `{fullName, line1, city, state, pincode, country:'IN', phone}`; a string → `{line1: string}`; anything missing → empty strings, reported).
  - `orders` step: orders, one seller order (Studio) per order, items (title from the product, else "Legacy item"), status history (one `system` entry "Imported from legacy"), `order_number` = `CR-<YYMM of createdAt>-<seq>`, and payment intents for paid orders. An unknown user → skip + report.
  - `reviews` step: embedded product reviews → catalog `reviews` (`author_name` via catalog's `toAuthorName`, duplicated in the tool as a 5-line function with a test), then recompute `rating_avg`/`rating_count`. `verified_purchases` from paid orders.
  - `carts` step: cart items for purchasable mapped products, qty clamped 1..10.

- [ ] **Step 1: Write failing tests:** `paid delivered order → completed with delivered seller order`, `unpaid → cancelled legacy_unpaid`, `total below items flagged anomaly`, `paid order gets captured payment intent`, `review imported and rating recomputed`, `cart skips deleted products`, `order of unknown user skipped and reported`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(migrator): orders, payments, reviews, carts`.

### Task 5: Reconciliation and rehearsal runbook

**Skills:** `safe-backend-changes` (first), `database-migration`, `postgresql-table-design`, `nodejs-backend-patterns`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/reconcile.ts`, `src/reconcile.test.ts`, `tools/mongo-migrator/RUNBOOK.md`

**Interfaces:**
- Produces: `reconcile(source, targets): Promise<ReconcileResult>` checks: (1) per collection, source count = written + skipped; (2) Σ legacy paid `totalPrice` in paise = Σ `orders.total_paise` where `source='legacy' AND status IN ('paid','completed')`, adjusted by the reported anomalies; (3) every active product has an inventory row and ≥1 image; (4) a random sample of 20 orders compared field by field; (5) every migrated user can be looked up by lower-cased email. Exit code 1 if any check fails. `RUNBOOK.md`: prerequisites, a staging rehearsal from a fresh `mongodump` (record the duration), the production run order (`--dry-run` → review the report → `--execute` → `reconcile`), the sign-off checklist, and rollback (drop and recreate the target DBs before go-live only).

- [ ] **Step 1: Write failing tests:** `reconcile passes on clean harness data`, `reconcile fails when a paid order is missing`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS. Then run a rehearsal against staging with a real dump; attach the report summary (counts, anomalies, duration) to the task report.
- [ ] **Step 5: Commit** `feat(migrator): reconciliation checks and runbook`.
