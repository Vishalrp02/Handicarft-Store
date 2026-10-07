# Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the monorepo, the shared `contracts` and `service-kit` packages, a service template, the local Docker Compose infrastructure and CI, so the eight services (plans 03–10) can be built **in parallel** against stable interfaces.

**Architecture:** pnpm workspaces + Turborepo. `@craftoria/contracts` holds every zod schema (DTOs, internal APIs, events, error codes). `@craftoria/service-kit` holds every cross-cutting runtime concern (HTTP app, errors, auth, DB, migrations, outbox/inbox, HTTP client, idempotency, jobs, telemetry, test helpers). Each service is generated from `templates/service`.

**Tech Stack:** Node 24 LTS, pnpm 10, Turborepo 2, TypeScript 5 (strict, ESM), Express 5, zod 4, `@asteasolutions/zod-to-openapi` 8, Kysely + `pg`, `amqplib`, `jose`, `pino`/`pino-http`, `prom-client`, `undici`, `@opentelemetry/sdk-node`, Vitest 3, supertest, `@testcontainers/postgresql`, `@testcontainers/rabbitmq`, tsup (packages), Docker Compose v2.

**Spec:** `docs/architecture/02-target-architecture.md` (§5, §6, §9), `03-api-and-event-contracts.md` (all), `04-data-model.md` §0, `05-engineering-standards.md` (all).

**Required skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; plus the workflow skills `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use **only** the project skills in `.claude/skills/` (mirrored in `.agents/skills/`); no other skills or plugins. See `docs/architecture/05-engineering-standards.md` §8.

## Global Constraints

- Packages build with `tsup` to `dist/` (ESM + `.d.ts`); services build with `tsc`. `package.json` `exports` point to `dist`.
- `@craftoria/contracts` depends **only** on `zod`. Frontends import it too, so it must never use Node built-ins.
- Every public function in `service-kit` has a unit or integration test.
- Ports: gateway 8080, identity 4001, catalog 4002, seller 4003, cart 4004, order 4005, payment 4006, notification 4007, storefront 3000, console 5173; postgres 5432, rabbitmq 5672/15672, valkey 6379, mailpit 1025/8025, minio 9000/9001.
- The legacy app (`backend/`, `frontend/`) was **removed on 2026-10-07** (nothing was live). Its reusable data files are in `docs/legacy-assets/`; the code is only in git history.

## Review Focus

1. A consumer handler that throws must not record the event in `inbox`, so redelivery retries it. (Task 8 test `failed handler leaves no inbox row`.)
2. The outbox relay running in two processes at once must publish each row once per success. (Task 8 test `two relays do not double-publish a row`, using `SKIP LOCKED`.)
3. An idempotent replay must return the original status code and body, and a 5xx must not be cached. (Task 9 tests.)
4. An expired token, a wrong `aud` or a token signed by another key → 401 `UNAUTHENTICATED`, never 500. (Task 6 tests.)
5. `percentOfPaise` rounding at exactly .5 paise rounds up, and inputs above `Number.MAX_SAFE_INTEGER` throw. (Task 2 tests.)

---

### Task 1: Monorepo bootstrap

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc` (`24`), `.editorconfig`, `.prettierrc.json`, `.prettierignore`, `packages/tsconfig/{package.json,base.json,node.json,react.json}`, `packages/eslint-config/{package.json,index.js,react.js}`
- Modify: root `package.json`, `.gitignore`, `CLAUDE.md`, `AGENTS.md`

**Interfaces:**
- Produces: workspace globs `apps/*`, `services/*`, `packages/*`, `tools/*`, `e2e`. Root scripts: `dev, build, test, test:int, lint, typecheck, format, infra:up, infra:down, stack:up, stack:down, e2e, new:service`. Turbo tasks: `build` (dependsOn `^build`, outputs `dist/**`), `test` and `test:int` (dependsOn `^build`), `lint`, `typecheck` (dependsOn `^build`), `dev` (persistent, no cache).
- Produces: `@craftoria/tsconfig/node.json` (`module`/`moduleResolution` `NodeNext`, `target ES2023`, `strict`, `noUncheckedIndexedAccess`, `sourceMap`, `declaration`) and `react.json` (`moduleResolution: Bundler`, `jsx: react-jsx`). `@craftoria/eslint-config` is a flat config (typescript-eslint strict-type-checked, `no-console: error`, `@typescript-eslint/no-explicit-any: error`, import order).

- [ ] **Step 1:** If root `package.json` still lists frontend dependencies (plan 01 Task 5 not done), move `jwt-decode`, `react-select`, `rc-slider`, `react-image-magnify`, `tailwindcss` into `frontend/package.json` and drop `mongodb`. Then rewrite root `package.json` as the private workspace root (`"packageManager": "pnpm@10"`, no `workspaces` field, no dependencies except devDeps `turbo`, `prettier`, `prettier-plugin-tailwindcss`, `typescript`).
- [ ] **Step 2:** Create the config files above. Add `**/.turbo`, `**/dist`, `.superpowers/`, `*.dec.env` to `.gitignore`.
- [ ] **Step 3:** Verify: `pnpm install && pnpm lint && pnpm typecheck`. Expected: exit 0 ("no tasks" is fine). `cd frontend && npm ci && npm run build` and `cd backend && npm ci` still succeed.
- [ ] **Step 4:** Replace the "Commands" section of `CLAUDE.md` and `AGENTS.md` with the table from `05-engineering-standards.md` §9 (keep the existing "Allowed skills" section untouched), and add the line "Architecture spec: `docs/architecture/` — read `05-engineering-standards.md` before any task."
- [ ] **Step 5: Commit** `chore: bootstrap pnpm + turbo monorepo`.

### Task 2: Contracts — primitives, money, errors, address

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `packages/contracts/{package.json,tsup.config.ts,vitest.config.ts,tsconfig.json}`, `packages/contracts/src/index.ts`, `src/common/{ids.ts,money.ts,pagination.ts,errors.ts,address.ts,indian-states.ts,roles.ts}`, `src/common/money.test.ts`, `src/common/address.test.ts`

**Interfaces:**
- Produces (all exported from `@craftoria/contracts`):
  - `UuidSchema`, `IsoDateSchema`, `PaiseSchema` (`z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)`), `SignedPaiseSchema`.
  - `assertPaise(n: number): asserts n is number`; `sumPaise(...values: number[]): number`; `multiplyPaise(unitPaise: number, qty: number): number`; `percentOfPaise(amountPaise: number, bps: number): number` (round half up); `formatINR(paise: number): string`. All throw `RangeError` on a non-safe-integer result.
  - `ErrorCode` (zod enum of every code in contracts §1.1), `ERROR_HTTP_STATUS: Record<ErrorCode, number>`, `ErrorBodySchema`.
  - `PageSchema(item)`, `CursorPageSchema(item)`, `CursorQuerySchema` (`cursor?: string, limit: 1..100 default 20`), `PageQuerySchema` (`page: 1..50 default 1, limit: 1..48 default 24`), `encodeCursor({createdAt: string, id: string}): string`, `decodeCursor(s: string): {createdAt, id}` (throws `ZodError` on garbage).
  - `IndianStateSchema` (36 states/UTs), `AddressInputSchema`, `AddressSchema` exactly as contracts §1.2. `RoleSchema`.

- [ ] **Step 1: Write failing tests:**
  ```ts
  it('percentOfPaise rounds half up', () => { expect(percentOfPaise(105, 1000)).toBe(11); expect(percentOfPaise(104, 1000)).toBe(10); expect(percentOfPaise(99900, 1000)).toBe(9990) })
  it('multiplyPaise rejects unsafe results', () => { expect(() => multiplyPaise(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError) })
  it('sumPaise rejects floats', () => { expect(() => sumPaise(100, 0.5)).toThrow(RangeError) })
  it('formatINR uses Indian grouping', () => { expect(formatINR(12450000)).toBe('₹1,24,500'); expect(formatINR(245050)).toBe('₹2,450.50') })
  it('AddressInput rejects pincode starting with 0', ...); it('AddressInput rejects phone not starting 6-9', ...)
  it('cursor round-trips', ...); it('decodeCursor rejects garbage', ...)
  it('every ErrorCode has an HTTP status', () => ErrorCode.options.forEach(c => expect(ERROR_HTTP_STATUS[c]).toBeGreaterThanOrEqual(400)))
  ```
- [ ] **Step 2:** `pnpm --filter @craftoria/contracts test`. Expected: FAIL.
- [ ] **Step 3:** Implement. `formatINR` uses `Intl.NumberFormat('en-IN', {style:'currency', currency:'INR', minimumFractionDigits: paise % 100 === 0 ? 0 : 2})`.
- [ ] **Step 4:** Run tests → PASS. `pnpm --filter @craftoria/contracts build` → `dist/index.js` and `dist/index.d.ts` exist.
- [ ] **Step 5: Commit** `feat(contracts): primitives, money, errors, address`.

### Task 3: Contracts — HTTP DTOs and internal APIs for all services

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `packages/contracts/src/auth/claims.ts`, `src/http/{identity,catalog,seller,cart,order,payment}.ts`, `src/internal/{catalog,cart,payment}.ts`, `src/http/http.test.ts`

**Interfaces:**
- Produces: one zod schema per type in contracts §2–§7, named `<Type>Schema`, with an exported inferred type `<Type>`. Request bodies use the names given there (`RegisterBodySchema`, `LoginBodySchema`, `ProductUpsertSchema`, `ProductUpdateSchema = ProductUpsertSchema.partial()`, `ProductSearchQuerySchema`, `ReserveRequestSchema`, `ReserveResponseSchema`, `PricedLineSchema`, `InternalCartSchema`, `CreatePaymentIntentSchema`, `PaymentIntentOutSchema`, `CheckoutRequestSchema`, `CheckoutResponseSchema`, `SellerOrderActionSchema`, `ShipBodySchema`, `CancelBodySchema`, `VerifyPaymentSchema`, `AdminRefundRequestSchema`, …). Enums: `ProductStatusSchema`, `SellerStatusSchema`, `OrderStatusSchema`, `SellerOrderStatusSchema`, `RefundStatusSchema`, `PaymentIntentStatusSchema`, `LedgerEntryTypeSchema`.
- `AccessTokenClaimsSchema` (contracts §2, including `emailVerified`).
- Query schemas coerce strings (`z.coerce.number()`) because they parse `req.query`.

- [ ] **Step 1: Write failing tests** (`http.test.ts`), one valid and one invalid sample per service:
  ```ts
  it('ProductUpsert rejects price below ₹1', ...)              // pricePaise 99 → error
  it('ProductUpsert rejects compareAt <= price', ...)
  it('ProductSearchQuery coerces numbers and defaults sort', ...) // {minPrice:'100'} → 100, sort 'relevance'
  it('ReserveRequest rejects qty 11 and 51 lines', ...)
  it('CheckoutRequest requires full address', ...)
  it('SellerApply validates GSTIN format', ...)                 // '27AAPFU0939F1ZV' ok, 'ABC' fails
  it('BankAccountIn validates IFSC', ...)                        // 'HDFC0001234' ok, 'HDFC1001234' fails
  it('Cart qty 0..10 only', ...)
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement every schema in contracts §2–§7 with the exact constraints listed. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(contracts): HTTP and internal API schemas`.

### Task 4: Contracts — event envelope, event payloads, registry, fixtures

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `packages/contracts/src/events/{envelope.ts,identity.ts,seller.ts,catalog.ts,order.ts,payment.ts,registry.ts}`, `packages/contracts/fixtures/*.v1.json` (one per event in contracts §8), `src/events/events.test.ts`
- Modify: `packages/contracts/package.json` (`"files": ["dist","fixtures"]`, export `./fixtures/*`)

**Interfaces:**
- Produces:
  - `ServiceNameSchema = z.enum(['gateway','identity','catalog','seller','cart','order','payment','notification'])`.
  - `EventEnvelopeSchema<T>(data: T)` → `{ id: uuid, type: string, version: int ≥1, occurredAt: iso, producer: ServiceName, correlationId: string, data: T }`.
  - One payload schema per event, named `<PascalType>V1Schema`, e.g. `OrderPaidV1Schema`, `PaymentCapturedV1Schema`, `ProductSnapshotSchema`.
  - `EventRegistry` const: `{ 'order.paid.v1': { type: 'order.paid', version: 1, schema: OrderPaidV1Schema, producer: 'order' }, … }` covering **every** row of contracts §8. Type helpers `EventKey = keyof typeof EventRegistry` and `EventData<K extends EventKey> = z.infer<(typeof EventRegistry)[K]['schema']>`.
  - `loadFixture<K extends EventKey>(key: K): EventEnvelope<EventData<K>>` (reads `fixtures/<key>.json`; Node-only, exported from the subpath `@craftoria/contracts/fixtures`).

- [ ] **Step 1: Write failing tests:**
  ```ts
  it('every registry key has a fixture that parses', () => { for (const k of Object.keys(EventRegistry)) expect(() => EventRegistry[k].schema.parse(loadFixture(k).data)).not.toThrow() })
  it('registry key matches type and version', ...)       // key === `${type}.v${version}`
  it('order.paid requires at least one sellerOrder', ...)
  it('envelope rejects unknown producer', ...)
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement the schemas and write realistic fixtures (₹ values in paise, UUID v7 ids, IST-friendly timestamps). **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(contracts): event envelope, payload schemas, registry, fixtures`.

### Task 5: service-kit — config, logger, request context, errors, HTTP app, route helper, OpenAPI

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `packages/service-kit/{package.json,tsup.config.ts,vitest.config.ts,vitest.int.config.ts,tsconfig.json}`, `src/index.ts`, `src/config.ts`, `src/logger.ts`, `src/context.ts`, `src/errors.ts`, `src/http/{create-http-app.ts,route.ts,request-id.ts,metrics.ts}`, `src/openapi.ts`, `src/clock.ts`, tests beside each file

**Interfaces:**
- Produces:
  - `BaseConfigSchema` (`NODE_ENV`, `SERVICE_NAME`, `PORT`, `LOG_LEVEL`, `JWKS_URL`, `JWT_ISSUER='craftoria-identity'`, `JWT_AUDIENCE='craftoria'`, `INTERNAL_API_TOKEN` (min 32 chars), `OTEL_EXPORTER_OTLP_ENDPOINT?`, `SENTRY_DSN?`); `loadConfig<S extends z.ZodTypeAny>(schema: S, env?: NodeJS.ProcessEnv): z.infer<S>`, which throws `ConfigError` listing every invalid key.
  - `createLogger({ service: string, level: string }): Logger` (pino) with `REDACT_PATHS` covering `req.headers.authorization`, `req.headers.cookie`, `*.password`, `*.newPassword`, `*.currentPassword`, `*.token`, `*.accessToken`, `*.refreshToken`, `*.accountNumber`, `*.razorpaySignature`, `*.razorpay_signature`. A mixin adds `requestId` and `userId` from the request context.
  - `requestContext: AsyncLocalStorage<{ requestId: string; userId?: string }>`, `getRequestId(): string | undefined`.
  - Errors: `class AppError extends Error { code: ErrorCode; status: number; details?: unknown }` and subclasses `ValidationError(issues)`, `UnauthenticatedError(code?)`, `ForbiddenError(code?)`, `NotFoundError(message?)`, `ConflictError(code, message, details?)`, `BusinessRuleError(code, message, details?)`, `TooManyAttemptsError(retryAfterSeconds)`, `UpstreamUnavailableError(dependency)`. `errorMiddleware(logger)` renders `ErrorBodySchema`; a `ZodError` → `VALIDATION_FAILED`; anything else → 500 `INTERNAL` with message "Something went wrong" (the original is logged at `error`).
  - `createHttpApp(opts: { service: string; logger: Logger; readiness: () => Promise<Record<string, boolean>>; configure: (app: Express) => void; rawBodyPaths?: string[]; jsonLimit?: string /* '100kb' */ }): Express`. Mounts, in order: request-id (reads or creates `x-request-id`, echoes it in the response), `pino-http`, `helmet`, raw/json body parsers, `GET /healthz` → `{status:'ok'}`, `GET /readyz` → 200 or 503 `{checks}`, `GET /metrics`, then `configure(app)`, then a 404 handler that renders `NOT_FOUND`, then `errorMiddleware`.
  - `route<B, Q, P>(spec: { body?: ZodType<B>; query?: ZodType<Q>; params?: ZodType<P>; status?: number }, fn: (ctx: { body: B; query: Q; params: P; auth: AuthContext | undefined; requestId: string; req: Request; res: Response }) => Promise<unknown>): RequestHandler`. A return value of `undefined` → 204; otherwise `res.status(spec.status ?? 200).json(value)`.
  - `Clock { now(): Date }`, `systemClock`, `createFakeClock(start: Date): Clock & { advance(ms: number): void }`.
  - `createOpenApi({ service, version })` → `{ registry, register(route: {method, path, summary, tags, auth: 'public'|'user'|'artisan'|'admin'|'internal', body?, query?, params?, responses: Record<number, ZodType | null>}), document(): OpenAPIObject }` and `serveOpenApi(app, openapi)` → `GET /openapi.json`.

- [ ] **Step 1: Write failing tests:**
  ```ts
  it('loadConfig lists all invalid keys', ...)                  // missing PORT and short INTERNAL_API_TOKEN → message contains both
  it('logger redacts authorization and password', ...)          // write to a stream, assert '[Redacted]'
  it('route returns 204 when handler returns undefined', ...)
  it('route validates body and returns VALIDATION_FAILED with issues', ...)
  it('unknown error becomes INTERNAL without leaking message', ...)  // throw new Error('db password xyz') → body.message !== contains 'xyz'
  it('AppError subclasses map to their status codes', ...)
  it('x-request-id is propagated or generated', ...)
  it('readyz returns 503 when a check fails', ...)
  it('unknown path returns NOT_FOUND error body', ...)
  it('openapi.json lists registered routes', ...)
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(service-kit): config, logging, errors, http app, route helper, openapi`.

### Task 6: service-kit — authentication and authorisation

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`, `auth-implementation-patterns`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `packages/service-kit/src/auth/{verifier.ts,middleware.ts,internal.ts}`, `src/testing/auth.ts`, tests

**Interfaces:**
- Consumes: `AccessTokenClaimsSchema` (Task 3), errors (Task 5).
- Produces:
  - `type AuthContext = { userId: string; email: string; name: string; emailVerified: boolean; roles: Role[]; sellerId: string | null; sessionId: string }`.
  - `createJwtVerifier({ jwksUrl, issuer, audience }): JwtVerifier`, where `JwtVerifier = { verify(token: string): Promise<AuthContext> }`. Uses `jose.createRemoteJWKSet(url, { cacheMaxAge: 600_000, cooldownDuration: 30_000 })`, `algorithms: ['EdDSA']`, `clockTolerance: 30`. Any failure → `UnauthenticatedError()`.
  - `createLocalJwtVerifier({ jwks: JSONWebKeySet, issuer, audience }): JwtVerifier` (tests and gateway warm-up).
  - Middleware: `requireAuth(verifier)`, `optionalAuth(verifier)`, `requireRole(...roles: Role[])`, `requireSeller()` (role `artisan` + non-null `sellerId`, else `FORBIDDEN`), `requireVerifiedEmail()` (`EMAIL_NOT_VERIFIED`), `requireInternal(token: string)` (`X-Internal-Token`, compared with `crypto.timingSafeEqual` on equal-length buffers, else 401). `req.auth` is typed via declaration merging on `Express.Request`.
  - Testing (`@craftoria/service-kit/testing`): `testKeys(): Promise<{privateKey, jwks}>` (an Ed25519 pair generated once per process), `testJwks(): Promise<JSONWebKeySet>` (**async**: key generation is async in jose), `makeTestToken(claims?: Partial<AccessTokenClaims> & { expiresIn?: string }): Promise<string>` (defaults: random `sub`, `roles:['buyer']`, `emailVerified: true`, `iss`/`aud` defaults), `TEST_INTERNAL_TOKEN` (a 40-char constant).

- [ ] **Step 1: Write failing tests:**
  ```ts
  it('valid token yields AuthContext', ...)
  it('expired token → 401 UNAUTHENTICATED', ...)                 // expiresIn '-1m'
  it('wrong audience → 401', ...); it('token signed by other key → 401', ...); it('HS256 token → 401', ...)
  it('requireRole admin rejects buyer with 403 FORBIDDEN', ...)
  it('requireSeller rejects artisan without sellerId', ...)
  it('requireVerifiedEmail rejects unverified', ...)            // 403 EMAIL_NOT_VERIFIED
  it('requireInternal rejects missing and wrong token', ...)
  it('remote verifier fetches JWKS once for many requests', ...) // local http server counting hits
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(service-kit): JWT verification and auth middleware`.

### Task 7: service-kit — database, migrations, platform tables, test DB

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `packages/service-kit/src/db/{create-db.ts,migrate.ts,platform-tables.ts,errors.ts,cursor.ts}`, `src/testing/{postgres.ts,global-setup.ts}`, `test/db.int.test.ts`

**Interfaces:**
- Produces:
  - `createDb<DB>({ connectionString: string; max?: number /* 10 */; logger: Logger; statementTimeoutMs?: number /* 5000 */ }): Kysely<DB>`. `bigint` (OID 20) parses to `number` with a safe-integer guard; `timestamptz` stays a `Date`; `numeric` parses to `number`.
  - `type Executor<DB> = Kysely<DB> | Transaction<DB>`.
  - `runMigrations(db: Kysely<any>, migrationsDir: string, direction: 'latest' | 'down' | 'up'): Promise<{ name: string; status: string }[]>`, which throws on error. `migrateCli(db, migrationsDir, argv)` is used by each service's `src/migrate.ts` (`node dist/migrate.js latest|down|up|roundtrip`, where `roundtrip` = latest → down to zero → latest).
  - `createPlatformTables(db: Kysely<any>, opts: { idempotency: boolean }): Promise<void>` and `dropPlatformTables(db)`: create the `set_updated_at()` trigger function, `outbox`, `inbox`, and optionally `idempotency_keys`, exactly as `04-data-model.md` §0.
  - `addUpdatedAtTrigger(db, table: string)`.
  - `isUniqueViolation(err: unknown, constraint?: string): boolean`, `isForeignKeyViolation(err)`, `isCheckViolation(err, constraint?)`.
  - `keysetPage<T>(rows: T[], limit: number, cursorOf: (row: T) => { createdAt: Date; id: string }): { items: T[]; nextCursor: string | null }` (fetch `limit + 1` rows).
  - Testing: `postgresGlobalSetup` (Vitest `globalSetup`: starts one `postgres:17-alpine` container and provides `PG_ADMIN_URL` via `provide`), `createTestDb<DB>({ migrationsDir }): Promise<{ db: Kysely<DB>; url: string; destroy(): Promise<void> }>` (creates `test_<nanoid>` and runs migrations to latest).

- [ ] **Step 1: Write failing integration tests:**
  ```ts
  it('bigint columns come back as numbers', ...)
  it('bigint above MAX_SAFE_INTEGER throws', ...)
  it('platform tables migrate up and down cleanly', ...)       // tables exist, then absent
  it('isUniqueViolation detects named constraint', ...)
  it('statement timeout aborts long query', ...)               // SELECT pg_sleep(10) with 200ms timeout → rejects
  it('keysetPage returns nextCursor only when more rows', ...)
  ```
- [ ] **Step 2:** `pnpm --filter @craftoria/service-kit test:int` → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(service-kit): kysely db, migrations, platform tables, test db`.

### Task 8: service-kit — RabbitMQ, outbox, inbox consumer

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `packages/service-kit/src/messaging/{broker.ts,outbox.ts,relay.ts,consumer.ts}`, `src/testing/rabbit.ts`, `test/messaging.int.test.ts`

**Interfaces:**
- Consumes: `EventRegistry`, `EventEnvelopeSchema` (Task 4); `createDb`, `createPlatformTables` (Task 7).
- Produces:
  - `createBroker({ url, logger }): Promise<Broker>`, where `Broker = { publish(routingKey: string, envelope: unknown): Promise<void> /* confirm channel */; channel(): Promise<amqp.Channel>; onReconnect(cb): void; close(): Promise<void>; isHealthy(): boolean }`. Asserts exchanges `craftoria.events` (topic, durable) and `craftoria.dlx` (direct, durable). Reconnects with exponential backoff (max 30 s).
  - `enqueueEvent<K extends EventKey>(trx: Transaction<any>, key: K, data: EventData<K>, meta: { producer: ServiceName; correlationId?: string }): Promise<EventEnvelope<EventData<K>>>`. Validates `data` against the registry (throws a programming error if invalid), builds the envelope (`id` = uuidv7, `occurredAt` = now, `correlationId` = arg ?? `getRequestId()` ?? id) and inserts into `outbox`.
  - `startOutboxRelay({ db, broker, logger, intervalMs?: 500, batchSize?: 100 }): { stop(): Promise<void> }`. Each tick, in a transaction: `SELECT … WHERE published_at IS NULL ORDER BY created_at LIMIT n FOR UPDATE SKIP LOCKED` → publish each → set `published_at` (failures: `attempts += 1`, `last_error`). Gauge metric `outbox_unpublished_count`.
  - `startConsumer({ service: ServiceName; broker; db; logger; prefetch?: 10; handlers: Partial<{ [K in EventKey]: (event: EventEnvelope<EventData<K>>, trx: Transaction<any>) => Promise<void> }> }): Promise<{ stop(): Promise<void> }>`. Asserts quorum queue `<service>.events` (`x-queue-type: quorum`, `x-delivery-limit: 5`, `x-dead-letter-exchange: craftoria.dlx`, `x-dead-letter-routing-key: <service>.dlq`), queue `<service>.dlq` bound to `craftoria.dlx` with key `<service>.dlq`, and one binding per handler key. Per message: parse the envelope + payload (invalid → `nack(requeue=false)` → DLQ); then `db.transaction()`: `INSERT INTO inbox … ON CONFLICT DO NOTHING RETURNING event_id` → if no row, skip as a duplicate; else run the handler; commit → `ack`. Handler throws → rollback → `nack(requeue=true)`. Counter `consumer_messages_total{event,outcome}`.
  - Testing: `rabbitGlobalSetup` (provides `RABBITMQ_URL`), `waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 5000)`.

- [ ] **Step 1: Write failing integration tests:**
  ```ts
  it('enqueueEvent rejects payload that violates schema', ...)
  it('relay publishes outbox rows and marks them', ...)          // consumer on a test queue receives envelope; published_at set
  it('two relays do not double-publish a row', ...)              // 200 rows, 2 relays concurrently, received ids are unique, count 200
  it('consumer processes event once even if delivered twice', ...) // publish same envelope twice → handler called once
  it('failed handler leaves no inbox row and is redelivered', ...) // throws first time, succeeds second → inbox has 1 row
  it('poison message goes to DLQ after 5 deliveries', ...)        // always throws → message lands in <service>.dlq
  it('invalid payload goes straight to DLQ', ...)
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(service-kit): rabbitmq broker, transactional outbox, idempotent consumer`.

### Task 9: service-kit — HTTP client, idempotency middleware, jobs, crypto, telemetry, graceful shutdown

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `packages/service-kit/src/http-client.ts`, `src/idempotency.ts`, `src/jobs.ts`, `src/telemetry.ts`, `src/lifecycle.ts`, `src/crypto.ts`, tests

**Interfaces:**
- Produces:
  - `createServiceClient({ service: string; baseUrl: string; internalToken: string; logger: Logger; timeoutMs?: 3000; retries?: 2; breaker?: { failureThreshold: 5; resetMs: 30000 } }): ServiceClient`, where `ServiceClient = { get<T>(path: string, schema: ZodType<T>): Promise<T>; post<T>(path: string, body: unknown, schema: ZodType<T> | null, opts?: { idempotencyKey?: string }): Promise<T> }`. Sends `X-Internal-Token`, `x-request-id`, `traceparent`. A 4xx with an `ErrorBody` re-throws as an `AppError` with the **same code, status and details**. Timeouts, 5xx and network errors → retry (GET, or POST with `idempotencyKey`) with 100 ms × 2^n + jitter → finally `UpstreamUnavailableError(service)`. An open breaker fails fast with `UpstreamUnavailableError`.
  - `idempotency({ db, scope: (req: Request) => string, required: boolean }): RequestHandler` per `04-data-model.md` §0. Missing key with `required` → 400 `VALIDATION_FAILED`. Same key + different hash → 409 `IDEMPOTENCY_KEY_REUSED`. Same key, still in progress → 409 `CONFLICT`. Completed → replays the stored status and body with header `Idempotent-Replayed: true`. Responses with status ≥ 500 delete the row.
  - `runJob({ name: string; intervalMs: number; db: Kysely<any>; logger: Logger; fn: () => Promise<void> }): { stop(): Promise<void> }`. Uses `pg_try_advisory_xact_lock(hashtext(name))` inside a transaction (the job body runs in the same connection); overlapping ticks are skipped.
  - `initTelemetry({ service: string; endpoint?: string }): void`: OTel NodeSDK with http, express, pg and amqplib instrumentations. A no-op without an endpoint. It must be the first import in `main.ts`.
  - `encryptAesGcm(plaintext: Buffer, keyBase64: string): Buffer` (layout `iv(12) | tag(16) | ciphertext`; key must decode to 32 bytes) and `decryptAesGcm(blob: Buffer, keyBase64: string): Buffer` (throws on tampering). Used by identity (signing keys) and seller (bank accounts).
  - `onShutdown(logger, ...closers: Array<() => Promise<void>>)`: on SIGTERM/SIGINT, runs closers in order with a 10 s total deadline, then `process.exit(0)`.

- [ ] **Step 1: Write failing tests:**
  ```ts
  it('client maps upstream 409 OUT_OF_STOCK to AppError with details', ...)
  it('client retries GET on 503 then succeeds', ...)
  it('client does not retry POST without idempotency key', ...)
  it('breaker opens after 5 failures and fails fast', ...)
  it('client times out after timeoutMs', ...)
  it('idempotency replays first response', ...)               // handler counter stays 1, second response has Idempotent-Replayed
  it('idempotency rejects reused key with different body', ...)
  it('idempotency does not cache 500', ...)                    // first 500, second runs handler again
  it('runJob does not overlap across two runners', ...)        // two runners, slow fn → max concurrency 1
  it('aes-gcm round-trips and detects tampering', ...)         // flip one ciphertext byte → decrypt throws
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(service-kit): service client, idempotency, jobs, telemetry, shutdown`.

### Task 10: Service template and generator

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `templates/service/**` (the layout from `05-engineering-standards.md` §2 with placeholders `__name__`, `__Name__`, `__port__`), `tools/create-service/index.mjs`, `tools/create-service/package.json`

**Interfaces:**
- Consumes: everything in Tasks 5–9.
- Produces: `pnpm new:service <name> <port>` creates `services/<name>` containing:
  - `src/config.ts`: `ConfigSchema = BaseConfigSchema.extend({ DATABASE_URL, RABBITMQ_URL })`.
  - `src/deps.ts`: `AppDeps = { config: Config; logger: Logger; db: Kysely<DB>; verifier: JwtVerifier; clock: Clock; openapi: OpenApi }`.
  - `src/app.ts`: `buildApp(deps: AppDeps): Express` (`createHttpApp` + `serveOpenApi` + a `registerRoutes(app, deps)` stub).
  - `src/main.ts`: telemetry → config → logger → db → broker → `buildApp` → listen → `startOutboxRelay` → `startConsumer` (empty handlers) → `onShutdown`.
  - `src/migrate.ts`, `src/db/migrations/0001_platform.ts` (`createPlatformTables` up / `dropPlatformTables` down), `src/db/schema.ts`.
  - `test/integration/health.int.test.ts` (healthz 200, readyz 200, openapi.json 200, unknown route 404 body).
  - `vitest.config.ts` (unit), `vitest.int.config.ts` (globalSetup: postgres + rabbit).
  - `Dockerfile`: stage 1 `turbo prune @craftoria/<name> --docker`; stage 2 `pnpm install --frozen-lockfile` + `turbo build --filter=@craftoria/<name>...`; stage 3 `pnpm deploy --filter=@craftoria/<name> --prod /out`; runtime `node:24-bookworm-slim`, `USER node`, `HEALTHCHECK` curl-less (`node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`), `CMD ["node","--enable-source-maps","dist/main.js"]`.
  - `package.json` scripts: `dev` (`tsx watch src/main.ts`), `build` (`tsc -p tsconfig.build.json`), `start`, `test`, `test:int`, `lint`, `typecheck`, `migrate` (`tsx src/migrate.ts latest`), `migrate:down`, `db:types` (`kysely-codegen --dialect postgres --out-file src/db/schema.ts`).

- [ ] **Step 1:** Write the template and the generator (copy + placeholder replace; refuse if the target exists).
- [ ] **Step 2: Verify:** `pnpm new:service sample 4999 && pnpm install && pnpm --filter @craftoria/sample test:int && pnpm --filter @craftoria/sample typecheck && docker build -f services/sample/Dockerfile .`. Expected: health tests pass and the image builds. Then delete `services/sample`.
- [ ] **Step 3: Commit** `feat(tooling): service template and generator`.

### Task 11: Local infrastructure with Docker Compose

**Skills:** `safe-backend-changes` (first), `postgresql-table-design`, `database-migration`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `infra/compose/docker-compose.yml`, `infra/compose/docker-compose.dev.yml`, `infra/postgres/init/01-databases.sh`, `infra/postgres/postgresql.conf`, `infra/rabbitmq/{rabbitmq.conf,definitions.json}`, `infra/env/.env.example`, `infra/README.md`

**Interfaces:**
- Produces:
  - Base compose services: `postgres` (postgres:17-alpine, volume `pgdata`, healthcheck `pg_isready`), `rabbitmq` (rabbitmq:4-management-alpine, definitions loaded, healthcheck `rabbitmq-diagnostics -q ping`), `valkey` (valkey/valkey:8-alpine, `--maxmemory 256mb --maxmemory-policy allkeys-lru`). Plus one entry per service (`build: {context: ../.., dockerfile: services/<n>/Dockerfile}`, `env_file`, `depends_on: {postgres: {condition: service_healthy}, rabbitmq: …}`) and a matching `<n>-migrate` one-shot (`command: ["node","dist/migrate.js","latest"]`, `restart: "no"`) that the service `depends_on` with `condition: service_completed_successfully`. **Service entries are added by each service plan's Task 1**; this task adds a commented example.
  - Dev override: published ports (see Global Constraints), `mailpit` (axllent/mailpit), `minio` (minio/minio, bucket `craftoria-media` created by `minio-init` running `mc mb --ignore-existing` and `mc anonymous set download`).
  - `01-databases.sh`: for each name in `$SERVICE_DATABASES` (`identity catalog seller cart order payment notification`), create role `svc_<name>` with password `$PG_PASSWORD_<NAME>` and database `craftoria_<name>` owned by it; `REVOKE CONNECT … FROM PUBLIC`.
  - `.env.example`: every variable used by any service, grouped by service, with safe dev defaults (dev passwords = `dev_<name>`; `INTERNAL_API_TOKEN` = a 40-char dev string; `PAYMENT_PROVIDER=fake`; `EMAIL_PROVIDER=smtp` → mailpit; `OBJECT_STORAGE_ENDPOINT=http://minio:9000`).
  - Root scripts: `infra:up` = `docker compose --env-file infra/env/.env -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.dev.yml up -d postgres rabbitmq valkey mailpit minio minio-init`; `stack:up` = the same without a service filter, with `--build`.

- [ ] **Step 1:** Write the files.
- [ ] **Step 2: Verify:** `cp infra/env/.env.example infra/env/.env && pnpm infra:up`, then `docker compose … ps` shows all healthy; `psql postgres://svc_order:dev_order@localhost:5432/craftoria_order -c 'select 1'` succeeds; `psql postgres://svc_order:dev_order@localhost:5432/craftoria_identity -c 'select 1'` **fails** with a permission error; RabbitMQ UI at :15672 shows exchanges `craftoria.events` and `craftoria.dlx`; MinIO console shows bucket `craftoria-media`.
- [ ] **Step 3: Commit** `feat(infra): local docker compose with postgres, rabbitmq, valkey, mailpit, minio`.

### Task 12: Continuous integration

**Skills:** `safe-backend-changes` (first), `e2e-testing-patterns` (CI test stages); workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.github/workflows/codeql.yml`, `.github/pull_request_template.md`, `.gitleaks.toml`

**Interfaces:**
- Produces: the CI job `verify` on `pull_request` and on `push` to `main`. Steps: checkout (fetch-depth 0) → pnpm setup → Node 24 with pnpm cache → `pnpm install --frozen-lockfile` → `gitleaks detect` → `pnpm turbo run lint typecheck test --filter=...[origin/main]` → `pnpm turbo run test:int --filter=...[origin/main]` (Docker is available on `ubuntu-latest`) → for each changed service, `node dist/migrate.js roundtrip` against a CI Postgres service container → `pnpm turbo run build`. On `main`, the filter is all packages. Concurrency group cancels superseded runs. The PR template has the sections from `05-engineering-standards.md` §6.
- Dependabot: weekly npm (grouped minor/patch), GitHub Actions monthly, Docker monthly.

- [ ] **Step 1:** Write the workflows.
- [ ] **Step 2: Verify:** push the branch and open a draft PR. Expected: the `verify` job is green and gitleaks reports 0 leaks. Paste the run URL into the task report.
- [ ] **Step 3: Commit** `ci: lint, typecheck, unit, integration, migration round-trip, build`.
