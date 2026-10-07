# 02 — Target Architecture (Craftoria v2)

Status: **Proposed**, 2026-10-07. This is the binding spec for every plan in `docs/superpowers/plans/`. When a plan and this document disagree, this document wins. Raise the conflict; don't silently pick one.

Companion documents:
- `03-api-and-event-contracts.md`: every endpoint, DTO, error code and event payload.
- `04-data-model.md`: Postgres schema per service.
- `05-engineering-standards.md`: repo layout, service template, testing and Definition of Done.

---

## 1. Goals and non-goals

**Product goal.** Craftoria v2 is a **multi-vendor marketplace for handmade Indian crafts**. Artisans (sellers) apply, are approved by an admin, list products, and fulfil their own orders. Buyers buy from several artisans in one checkout. The platform takes a commission and pays sellers out.

**Engineering goals**, in priority order:
1. **Money and stock are always correct.** Server-computed prices, webhook-verified payments, transactional stock reservation, an idempotent everything.
2. **Secure by default.** OWASP ASVS L1 baseline, least privilege between services, no secrets in git.
3. **Near-zero running cost.** It runs on Oracle Cloud Always Free + Cloudflare free tier. The only fixed cost is the domain.
4. **Low operational burden** for a team with no ops experience: Docker Compose everywhere, managed SaaS free tiers for observability, a one-command deploy and a one-command rollback.
5. **Built by AI agents in parallel.** Contracts are defined up front, in a shared package, so services can be built independently.

**Non-goals for v2.0 (deferred):** guest checkout, coupons/discounts, return-after-delivery requests (only cancellations and admin refunds ship in v2.0), automated seller payouts via RazorpayX, courier API integration (sellers enter tracking manually), multi-currency, mobile apps, Elasticsearch, Kubernetes.

## 2. A note on microservices at this scale (read once)

At Craftoria's current size, a modular monolith would be the textbook choice. We're choosing microservices deliberately, as a learning and portfolio goal, so we contain the cost:
- **8 services, not 20.** Boundaries follow business capabilities with distinct data ownership, not CRUD entities.
- **One Postgres server, one database per service.** That gives logical isolation without paying for eight servers.
- **One shared `service-kit` package** so that logging, errors, auth, outbox and health are written once.
- **Async events for side effects, synchronous calls only on the checkout critical path** (5 internal endpoints in total).

If the operational cost ever hurts, the boundaries below map 1:1 to modules of a monolith, so merging back is cheap.

## 3. System context

```
                         ┌──────────────────────── Cloudflare (free) ──────────────────────────┐
 Buyer / Artisan / Admin │ DNS · CDN cache · WAF · Pages (console SPA) · R2 (media, backups)   │
        browser ────────▶│ Tunnel ─────────────────────────────┐                               │
                         └──────────────────────────────────────┼───────────────────────────────┘
                                                                ▼  (no inbound ports open on the VM)
 ┌──────────────────────── Oracle A1 VM "prod" (Docker Compose) ───────────────────────────────┐
 │ cloudflared ─▶ storefront (React Router 7 SSR :3000)                                         │
 │            └─▶ gateway (Express :8080) ─▶ identity :4001  catalog :4002  seller :4003        │
 │                                           cart :4004      order :4005    payment :4006       │
 │                                           notification :4007 (no public routes)              │
 │ postgres:17 (8 databases) · rabbitmq:4 (events) · valkey:8 (rate limits, cache) · alloy      │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
 External: Razorpay (payments, webhooks → gateway) · Resend (email) · Grafana Cloud free
 (logs/metrics/traces) · Sentry free (errors) · UptimeRobot free (uptime)
```

Domains (placeholders until bought): `craftoria.in` → storefront, `api.craftoria.in` → gateway, `console.craftoria.in` → Cloudflare Pages, `media.craftoria.in` → R2 public bucket.

## 4. Services and ownership

| Service | Owns (source of truth) | Public API prefix | Publishes | Consumes |
|---|---|---|---|---|
| **gateway** | nothing (stateless) | all `/v1/*`, `/.well-known/*` | — | — |
| **identity** | users, credentials, roles, sessions/refresh tokens, email tokens, address book | `/v1/auth`, `/v1/me`, `/v1/admin/users` | `user.registered`, `user.email_verification_requested`, `user.password_reset_requested`, `user.deleted` | `seller.approved` |
| **catalog** | categories, products, images, **inventory and reservations**, reviews, search | `/v1/categories`, `/v1/products`, `/v1/seller/products`, `/v1/admin/products`, `/v1/admin/categories`, `/v1/admin/reviews` | `product.published`, `product.updated`, `product.unpublished`, `inventory.commit_failed` | `order.paid`, `order.cancelled`, `seller.approved`, `seller.suspended`, `seller.reinstated`, `user.deleted` |
| **seller** | seller profiles, applications, bank details (encrypted), commission rates, **seller ledger**, payouts | `/v1/seller` (except `/products`, `/orders`), `/v1/sellers/:slug`, `/v1/admin/sellers`, `/v1/admin/payouts` | `seller.applied`, `seller.approved`, `seller.rejected`, `seller.suspended`, `payout.paid` | `order.paid`, `seller_order.delivered`, `refund.processed` |
| **cart** | carts, wishlists, product snapshot projection | `/v1/cart`, `/v1/wishlist` | — | `product.*`, `order.paid`, `user.deleted` |
| **order** | orders, seller orders (fulfilment), order items, status history, checkout | `/v1/checkout`, `/v1/orders`, `/v1/seller/orders`, `/v1/admin/orders`, `/v1/admin/seller-orders`, `/v1/admin/stats` | `order.placed`, `order.paid`, `order.cancelled`, `order.refund_required`, `seller_order.status_changed`, `seller_order.delivered` | `payment.captured`, `payment.failed`, `inventory.commit_failed`, `refund.processed`, `refund.failed`, `user.deleted` |
| **payment** | payment intents, gateway mapping, webhook log, refunds | `/v1/payments`, `/v1/webhooks/razorpay`, `/v1/admin/payments`, `/v1/admin/refunds` | `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed` | `order.refund_required` |
| **notification** | notification log, templates, seller and order contact projections | none (health only) | — | `user.*`, `order.placed`, `order.paid`, `seller_order.status_changed`, `seller.*`, `refund.processed`, `payout.paid` |

Rules:
- A service **never** reads another service's database. Data it needs is either sent in an event and kept as a local **projection** (e.g. cart's `product_snapshots`, catalog's `sellers`), or fetched from an `/internal/*` endpoint (checkout path only).
- Admin features live **in the owning service** under `/v1/admin/*`, guarded by the `admin` role. There is no "admin service".

## 5. Communication

### 5.1 Synchronous (HTTP/JSON)
- Public traffic: browser → Cloudflare → gateway → service.
- Internal calls go service → service directly over the Docker network (`http://catalog:4002`), never through the gateway. Every internal route is under `/internal/*`, needs the `X-Internal-Token` header (one shared secret per environment, `INTERNAL_API_TOKEN`), and the gateway **refuses** any public request whose path starts with `/internal`.
- The complete list of internal endpoints (anything else is a design change):
  1. `order → cart`: `GET /internal/carts/:userId`
  2. `order → catalog`: `POST /internal/reservations`
  3. `order → catalog`: `POST /internal/reservations/:id/release`
  4. `order → payment`: `POST /internal/payment-intents`
  5. `gateway → identity`: `GET /.well-known/jwks.json` (public anyway)
- The client (`service-kit/http-client`) uses a 3 s timeout, 2 retries with jitter **only for GET and for POSTs that carry an `Idempotency-Key`**, propagates `x-request-id` and `traceparent`, and opens a circuit breaker after 5 consecutive failures for 30 s.

### 5.2 Asynchronous (events)
- Broker: **RabbitMQ 4**, one durable topic exchange `craftoria.events`. Routing key = event type + version, e.g. `order.paid.v1`.
- Each consumer owns one **quorum queue** per service (`catalog.events`, `order.events`, …), bound to the routing keys it handles, with `x-delivery-limit: 5` and dead-lettering to the `craftoria.dlx` exchange → `<service>.dlq`.
- **Transactional outbox** (producer side). A service writes its state change and an `outbox` row in **one DB transaction**. A relay loop in the same process publishes unpublished rows (`FOR UPDATE SKIP LOCKED`, batch 100, every 500 ms) with publisher confirms, then sets `published_at`. Delivery is at least once.
- **Idempotent consumer** (consumer side). Each handler runs inside a DB transaction that first inserts the `event.id` into the `inbox` table. A unique violation means the event is a duplicate: ack it and skip.
- Event envelope (defined in `@craftoria/contracts`):
  ```ts
  { id: string /* uuid v7 */, type: string /* 'order.paid' */, version: number,
    occurredAt: string /* ISO-8601 UTC */, producer: ServiceName,
    correlationId: string /* request id of the originating HTTP call */,
    data: <payload validated by the event's zod schema> }
  ```
- Events are **facts in the past tense**, carry enough data for consumers to act without calling back, and are **versioned**. A breaking change means a new `vN+1` type published alongside the old one until all consumers migrate.

## 6. Identity, authentication, authorisation

- **Access token:** JWT signed with **EdDSA (Ed25519)** by identity, via the `jose` library. TTL 15 min. Claims: `sub` (user id), `email`, `name`, `emailVerified`, `roles: ('buyer'|'artisan'|'admin')[]`, `sellerId?` (present when the user is an approved seller), `sid` (session/family id), `iss: 'craftoria-identity'`, `aud: 'craftoria'`. The public key is served at `/.well-known/jwks.json`. Every service verifies tokens itself through `service-kit` (`requireAuth`), with a cached JWKS (10 min) and a 30 s clock tolerance. The gateway also verifies, so bad tokens fail early, but services never trust the gateway alone.
- **Refresh token:** an opaque 32-byte random value, stored only as SHA-256 in `refresh_tokens`, sent as cookie `cr_rt` (`HttpOnly; Secure; SameSite=Lax; Path=/v1/auth; Domain=api.craftoria.in; Max-Age=30d`). It rotates on every use. **Reuse detection:** presenting a revoked token revokes the whole family.
- **CSRF:** only `/v1/auth/refresh` and `/v1/auth/logout` read the cookie. Both require the `X-Requested-With: craftoria` header and an `Origin` in the CORS allowlist.
- **Frontends** keep the access token **in memory only**. On load they call `/v1/auth/refresh` to get one. There is no `localStorage` token.
- **Passwords:** argon2id (`memoryCost 19456, timeCost 2, parallelism 1`). Legacy bcrypt hashes (`$2a$/$2b$`) are accepted once and transparently rehashed to argon2id on successful login.
- **Brute-force protection:** a sliding window of 5 failed logins per (email, IP) per 15 min in Valkey, which returns `429 TOO_MANY_ATTEMPTS`. The gateway limits per IP: 300 req/min overall and 20 req/min on `/v1/auth/*`.
- **Roles:** every user has `buyer`. `artisan` is granted when identity consumes `seller.approved` (it also stores `seller_id`). `admin` is granted only by an existing admin or by the seed CLI. Seller-scoped endpoints (`/v1/seller/*`) require the `artisan` role and use `sellerId` from the token, **never** from the URL or body.

## 7. Core flows

### 7.1 Checkout and payment (the most important flow)

```
Browser        gateway   order              cart       catalog                payment            Razorpay
  │ POST /v1/checkout (Idempotency-Key, shippingAddress)
  │───────────────────────▶│
  │                        │ GET /internal/carts/:uid ─▶│
  │                        │ POST /internal/reservations {reservationId=orderId, items, ttl=1800}
  │                        │───────────────────────────────────▶│ lock rows, check, reserve, return priced lines
  │                        │ compute totals (server), insert order(pending_payment) + seller_orders + items
  │                        │ + outbox(order.placed)   [one transaction]
  │                        │ POST /internal/payment-intents {orderId, amountPaise} ─────────▶│ create RZP order ─▶│
  │◀─ 201 {order, payment:{gatewayOrderId, keyId, amountPaise}}
  │ Razorpay Checkout (browser) ───────────────────────────────────────────────────────────────────────────────▶│
  │ POST /v1/payments/verify {rzp ids, signature} ─────────────────────────────────────────────▶│ verify HMAC
  │                                                                     Razorpay webhook payment.captured ─────▶│ verify HMAC, dedupe
  │                                                                        payment_intent=captured + outbox(payment.captured)
  │                        │◀──────────────── event payment.captured ─────────────────────────│
  │                        │ order → paid, seller_orders → awaiting_acceptance, outbox(order.paid)
  │      cart ◀── order.paid: remove purchased items         catalog ◀── order.paid: commit reservation, record verified purchases
  │      seller ◀── order.paid: ledger sale + commission      notification ◀── order.paid: buyer + seller emails
  │ GET /v1/orders/:id (poll every 2 s, up to 60 s, until status=paid)
```

Rules:
1. **The server computes all money.** Prices come from catalog at reservation time and are locked into the reservation. The client never sends a price or a total.
2. **The webhook is the source of truth for "paid".** `/v1/payments/verify` is a fast path. It verifies the signature and, if Razorpay reports the payment captured, runs the **same** idempotent `markCaptured` routine the webhook uses. Whichever arrives first wins; the second is a no-op.
3. **Timeouts.** Order-service cancels `pending_payment` orders 30 min after `placed_at` (job every 60 s) → `order.cancelled{reason:'payment_timeout'}` → catalog releases the reservation. Catalog has its own safety net: it releases reservations still `active` 45 min after creation.
4. **Late payment.** If `payment.captured` arrives for a `cancelled` order, order-service does **not** resurrect it. It publishes `order.refund_required{reason:'late_payment', amountPaise: total}` and payment-service refunds in full. The buyer gets an email.
5. **Commit failure.** If catalog cannot commit (the reservation expired and the stock was sold to someone else), it commits **nothing** (all or nothing) and publishes `inventory.commit_failed`. Order-service cancels **every** seller order of that order (`cancel_reason='stock_unavailable'`) and publishes `order.refund_required{sellerOrderId:null, amountPaise: total, reason:'commit_failed'}`, so the buyer gets a full refund and an apology email. This only happens when a payment arrives more than 45 min late, so a partial-fulfilment design is not worth its complexity.
6. **Idempotency.** `POST /v1/checkout` requires `Idempotency-Key` (a UUID). Replaying the same key returns the original response. The same key with a different body returns `409 IDEMPOTENCY_KEY_REUSED`. A checkout with an existing `pending_payment` order for the same cart returns that order instead of reserving twice.
7. **Empty or unpurchasable cart:** `422 CART_EMPTY`. Out of stock: `409 OUT_OF_STOCK` with `details.items[{productId, requested, available}]`. Nothing is reserved; it is all or nothing.

### 7.2 Order and fulfilment state machines

`orders.status`:
```
pending_payment ──payment.captured──▶ paid ──all seller orders terminal──▶ completed
pending_payment ──timeout / buyer cancel──▶ cancelled
```
`seller_orders.status` (one per seller in an order):
```
pending ──(order paid)──▶ awaiting_acceptance ──accept──▶ accepted ──pack──▶ packed ──ship{carrier,tracking}──▶ shipped ──deliver──▶ delivered
awaiting_acceptance | accepted | packed ──cancel{reason} (seller, buyer, admin)──▶ cancelled   (emits order.refund_required)
pending ──(order cancelled)──▶ cancelled
```
- Terminal states: `delivered`, `cancelled`. An order is `completed` when every seller order is terminal and at least one was delivered. If all were cancelled after payment, the order stays `paid` with `refund_status=refunded`. The derived display status is computed by the API.
- Who may transition: the seller (its own seller orders: accept, pack, ship, deliver, cancel), the buyer (cancel while `awaiting_acceptance|accepted`), and admin (any allowed transition, `reason` required). Every transition writes `order_status_history`.
- The transition table lives in **one pure function**, `nextSellerOrderStatus(current, action, actor)`, which is unit-tested exhaustively.

### 7.3 Refunds
- Triggered by `order.refund_required` (seller-order cancellation after payment, late payment, commit failure) or by admin `POST /v1/admin/refunds`.
- Amount for a seller-order cancellation = that seller order's `subtotal_paise`, **plus the order's `shipping_paise` if this cancellation leaves no non-cancelled seller order**.
- Payment-service calls the Razorpay refunds API with an idempotency key `refund:{orderId}:{sellerOrderId|'all'}:{reason}` and stores the refund `pending`. The Razorpay webhook `refund.processed` marks it `processed` and publishes `refund.processed`. Seller-service writes ledger reversals; order-service sets `refund_status`.

- **No automatic restock on cancellation (v2.0).** A seller who cancels may no longer have the piece (it broke, or was sold offline), so the seller corrects stock in the console. A cancelled *unpaid* order releases its reservation automatically, because that stock was never committed.

### 7.4 Seller onboarding and payouts
- A buyer applies (`POST /v1/seller/apply`). Admin approves → `seller.approved` → identity adds the `artisan` role and `seller_id` (it appears in the token at the next refresh; the console forces a refresh after approval), and catalog's seller projection marks the seller active.
- Products: draft → `pending_review` (seller submits) → `active` (admin approves) or `rejected{reason}`. A seller's later edits to title, description or images set the product back to `pending_review`. **Price and stock edits do not.** Products of a `suspended` seller are hidden from public queries and the seller cannot create or edit products, but keeps the `artisan` role to fulfil already-paid seller orders.
- **Ledger** (seller-service, append-only). On `order.paid`, for each seller order it writes `sale +subtotal` and `commission −round_half_up(subtotal × commission_bps / 10000)`, both `pending`. On `seller_order.delivered` it sets `available_at = delivered_at + 7 days`. A job (hourly) flips due entries to `available`. Refunds write reversing entries.
- **Payouts** (v2.0 is manual). Admin runs a payout batch → one `payout` per seller with available balance ≥ ₹500 (50,000 paise) → CSV export → admin pays by bank transfer → `mark-paid {utr}` → entries become `paid` and `payout.paid` is emitted. RazorpayX automation is deferred.

### 7.5 Media
- A seller requests a presigned **PUT URL** to R2 (`POST /v1/seller/products/:id/images/upload-url`, content type `image/jpeg|png|webp`, ≤ 10 MB, valid for 5 min). The browser uploads directly to R2, and the seller then confirms (`POST …/images`).
- On confirm, catalog downloads the original, validates it really is an image (`sharp` metadata), strips EXIF, generates WebP variants at 400, 800 and 1600 px wide, uploads them, and stores keys and dimensions. Public URLs look like `https://media.craftoria.in/p/{productId}/{imageId}-{w}.webp`, cached by Cloudflare.
- Never base64 in the DB. Never proxy uploads through the API.

## 8. Money, tax and business rules (configurable)

- All amounts are **integer paise** (`bigint` in Postgres, `number` in TS, guarded by `Number.isSafeInteger`). Currency is always `INR` in v2.0. Rounding is round-half-up via `money.percentOf(amount, bps)`.
- Prices are **GST-inclusive** (Indian B2C display convention). Each product stores `tax_rate_bps` (default 500 = 5 %) and `hsn_code`, so invoices can show the tax component. Tax is not added on top.
- Shipping, per order: `0` if items subtotal ≥ `FREE_SHIPPING_THRESHOLD_PAISE` (default 99,900), else `SHIPPING_FEE_PAISE` (default 9,900). The platform pays logistics; shipping is not part of seller earnings.
- Commission: `commission_bps` per seller, default 1,000 (10 %).
- Cart limits: 1–10 per line, ≤ 50 lines.
- ⚠️ **Compliance to confirm with a CA before launch** (not encoded as rules): TCS under GST section 52 for e-commerce operators, TDS under 194-O, seller GSTIN requirements, invoice format. Seller profiles store an optional `gstin` so this can be added later.

## 9. Cross-cutting concerns

| Concern | Decision |
|---|---|
| Runtime | Node.js **24 LTS**, TypeScript 5 (`strict`), **Express 5**, ESM |
| Data access | **Kysely** (type-safe SQL builder) + `pg`; types generated by `kysely-codegen`; migrations with the Kysely `Migrator` (TS files with `up` **and** `down`) |
| Validation and contracts | **zod** schemas in `@craftoria/contracts`; OpenAPI 3.1 generated per service with `@asteasolutions/zod-to-openapi` at `/openapi.json` |
| Errors | `{ "error": { "code": "OUT_OF_STOCK", "message": "…", "details": {…}?, "requestId": "…" } }`; codes are listed in contracts |
| IDs | UUID **v7** (time-ordered) generated in the app; human order numbers `CR-YYMM-NNNNNN` from a Postgres sequence |
| Time | `timestamptz` everywhere, UTC in the API (ISO-8601), formatted in IST in the UI |
| Pagination | Lists: cursor (`?cursor=&limit=`, max 100) returning `{ items, nextCursor }`. Catalog search: `?page=&limit=` (max 48 per page, page ≤ 50) returning `{ items, page, limit, total }` |
| Logging | `pino` JSON to stdout; fields `service, level, time, requestId, userId?, msg`; redacted: `authorization`, `cookie`, `password*`, `*token*`, `*secret*`, `account_number`, Razorpay signatures |
| Metrics | `prom-client` at `/metrics` (default + HTTP histograms + outbox lag + consumer failures) |
| Tracing | OpenTelemetry SDK with auto-instrumentation (http, express, pg, amqplib) → OTLP → Grafana Cloud Tempo |
| Health | `GET /healthz` (process up) and `GET /readyz` (DB and broker reachable); Compose healthchecks use `/readyz` |
| Config | Env vars validated by zod at boot (fail fast). Secrets encrypted in git with **sops + age** (`infra/env/*.enc.env`) |
| Graceful shutdown | On SIGTERM: stop accepting HTTP, finish in-flight requests (10 s), stop consumers, drain the outbox relay, close pools |
| Caching | Valkey: public category tree (5 min), product detail (60 s, invalidated on update). Cloudflare edge: SSR public pages `s-maxage=60, stale-while-revalidate=600` |
| Search | Postgres full-text (`tsvector` generated column, `websearch_to_tsquery('simple', …)`) + `pg_trgm` similarity fallback for typos |
| Privacy (DPDP Act 2023) | Account deletion = anonymise PII in identity, emit `user.deleted`; consumers anonymise their copies. Orders are kept (legal retention) with the customer name/email replaced |

## 10. Deployment topology and cost

| Item | Choice | Cost |
|---|---|---|
| Compute | Oracle Cloud **Always Free Ampere A1** (arm64): `prod` VM 3 OCPU / 18 GB, `staging` VM 1 OCPU / 6 GB, Ubuntu 24.04 | ₹0 ¹ |
| Ingress | **Cloudflare Tunnel** (`cloudflared` container). No public inbound ports; SSH only via **Tailscale** | ₹0 |
| DNS, CDN, WAF | Cloudflare free | ₹0 |
| Static hosting | Cloudflare Pages (console SPA) | ₹0 |
| Object storage | Cloudflare R2 (10 GB free, zero egress): buckets `craftoria-media`, `craftoria-backups` | ₹0 within the free tier |
| Database | Postgres 17 container on the VM, data on the boot/block volume; nightly encrypted `pg_dump` → R2, kept 7 daily / 4 weekly / 6 monthly; restore tested weekly | ₹0 |
| Email | Resend free (3,000/month, 100/day) behind an `EmailProvider` interface | ₹0 |
| Observability | Grafana Cloud free (logs, metrics, traces via Grafana Alloy), Sentry free, UptimeRobot free | ₹0 |
| CI/CD | GitHub Actions; images in GHCR; arm64 builds (see decision D-1) | ₹0 |
| Domain | `.in` domain | ~₹800/year |

¹ Oracle caveats the plan handles: (a) idle Always Free instances can be reclaimed; **upgrade the account to Pay-As-You-Go** (Always Free resources stay free) to prevent it and to get better A1 capacity; (b) A1 capacity is sometimes unavailable in popular regions, so retry or pick a less busy home region at sign-up (the home region can't be changed later); (c) backups go to **Cloudflare R2, a different provider**, so losing the Oracle account doesn't lose data.

Deploy model: GitHub Actions → build and push images → SSH via Tailscale → `docker compose pull` → run each service's migrate container → `docker compose up -d --wait` → smoke check → automatic rollback to the previous image tags if the smoke check fails. Expect a few seconds of blip per restarted container; zero-downtime rollouts are a later improvement.

## 11. Architecture decisions (ADR summary)

| ID | Decision | Alternatives rejected (why) |
|---|---|---|
| ADR-1 | 8 services split by capability; inventory inside catalog | Separate inventory service (one more saga hop on the hottest path, little benefit at this scale) |
| ADR-2 | One Postgres instance, a database and role per service | One instance per service (RAM and ops cost); shared schema (couples services) |
| ADR-3 | RabbitMQ + transactional outbox/inbox | Kafka (heavy for one VM); Redis Streams (weaker DLQ/retry semantics); direct HTTP fan-out (lost side effects) |
| ADR-4 | Kysely + hand-written migrations with `down` | Prisma (heavy engine, no down migrations); Drizzle Kit (no down migrations, which the project rules require); TypeORM |
| ADR-5 | EdDSA JWT + rotating refresh cookie; each service verifies via JWKS | Gateway-only auth (single point of trust); server sessions (shared session store across services) |
| ADR-6 | Webhook-authoritative payments with reservation TTL | Client-confirmed payments (the legacy C1 exploit) |
| ADR-7 | React Router 7 SSR storefront | SPA only (poor SEO and **no WhatsApp/Instagram link previews**, which drive Indian craft commerce); Next.js (heavier, and the team already uses React Router) |
| ADR-11 | Tailwind CSS v4 for both frontends, tokens shared as a `@theme` in `@craftoria/ui` | CSS-in-JS (runtime cost, SSR complexity); component kits (generic look the brand skill rejects) |
| ADR-8 | Console (seller + admin) as a Vite SPA on Cloudflare Pages | Admin pages inside the storefront (bigger bundle, larger attack surface) |
| ADR-9 | Docker Compose on Oracle A1 + Cloudflare Tunnel | Kubernetes (ops burden); PaaS (not free at this footprint) |
| ADR-10 | pnpm workspaces + Turborepo monorepo | Polyrepo (contracts drift, too much overhead for agents) |

## 12. Open decisions for the project owner

| ID | Question | Default if not answered |
|---|---|---|
| D-1 | Can the GitHub repo be **public**? Public gets free arm64 runners (`ubuntu-24.04-arm`) and free GHCR storage. Private means images are built **on the VM** (`docker compose build`) by the deploy job instead | Public |
| D-2 | Real domain name | `craftoria.in` used as a placeholder in config |
| D-3 | Shipping fee, free-shipping threshold, default commission, payout minimum, return window | ₹99 / ₹999 / 10 % / ₹500 / 7 days |
| D-4 | Is the legacy site live with real payments? (decides whether plan 01 runs) | **Answered 2026-10-07: not live.** Plan 01 stopped after Task 3; legacy `backend/` and `frontend/` removed from the repo (kept in git history) |
| D-6 | Does the legacy MongoDB hold real data worth migrating? | Undecided. Plan 13 runs only if yes |
| D-5 | Transactional email sender domain (needs DNS SPF/DKIM on the real domain) | `no-reply@craftoria.in` |
