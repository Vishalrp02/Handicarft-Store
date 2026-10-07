# 04 — Data Model (PostgreSQL 17)

One Postgres server and **one database per service** (`craftoria_identity`, `craftoria_catalog`, `craftoria_seller`, `craftoria_cart`, `craftoria_order`, `craftoria_payment`, `craftoria_notification`). Each database has its own login role (`svc_identity`, …) that owns only that database. No cross-database queries, no foreign keys across services (cross-service ids are plain `uuid` columns, with "→ svc" noted in comments).

The DDL below is the **target state after the initial migrations**. Each service's plan turns it into Kysely migration files (`up` and `down`). Conventions:
- PK `id uuid` generated in the app (UUID v7). Timestamps `timestamptz NOT NULL DEFAULT now()`. Money columns are `bigint` paise with `CHECK (x >= 0)`.
- Every FK column and every column used in `WHERE`/`ORDER BY` of a listed query has an index.
- Enums are `text` + `CHECK (col IN (…))`, not Postgres `ENUM` types, because those are painful to migrate.
- `updated_at` is maintained by the trigger `set_updated_at()` (created in each DB's first migration).
- `legacy_mongo_id text UNIQUE` exists only on tables that receive migrated data (plan 13).

## 0. Shared tables (present in every service database)

```sql
CREATE TABLE outbox (
  id            uuid PRIMARY KEY,               -- = event envelope id
  type          text NOT NULL,                  -- 'order.paid'
  version       int  NOT NULL,
  routing_key   text NOT NULL,                  -- 'order.paid.v1'
  payload       jsonb NOT NULL,                 -- full envelope
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      int NOT NULL DEFAULT 0,
  last_error    text
);
CREATE INDEX outbox_unpublished_idx ON outbox (created_at) WHERE published_at IS NULL;

CREATE TABLE inbox (
  event_id     uuid PRIMARY KEY,
  type         text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (                 -- only in services with idempotent POSTs (order, payment)
  key           text NOT NULL,
  scope         text NOT NULL,                  -- user id or 'admin:<id>'
  request_hash  text NOT NULL,                  -- sha256 of method+path+canonical body
  status_code   int,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
-- rows older than 24 h are purged by a daily job
```

## 1. identity

```sql
CREATE TABLE users (
  id                uuid PRIMARY KEY,
  email             citext NOT NULL UNIQUE,      -- CREATE EXTENSION citext
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  phone             text,
  password_hash     text NOT NULL,               -- argon2id, or legacy bcrypt until first login
  email_verified_at timestamptz,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleted')),
  seller_id         uuid,                        -- → seller; set on seller.approved
  last_login_at     timestamptz,
  legacy_mongo_id   text UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('buyer','artisan','admin')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,                    -- = sid claim
  token_hash  bytea NOT NULL UNIQUE,            -- sha256(raw token)
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id),
  user_agent  text,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx   ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

CREATE TABLE email_tokens (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_tokens_user_idx ON email_tokens (user_id, purpose);

CREATE TABLE addresses (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      text,
  full_name  text NOT NULL, phone text NOT NULL,
  line1 text NOT NULL, line2 text, landmark text,
  city text NOT NULL, state text NOT NULL,
  pincode    text NOT NULL CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  country    text NOT NULL DEFAULT 'IN',
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX addresses_user_idx ON addresses (user_id);
CREATE UNIQUE INDEX addresses_one_default ON addresses (user_id) WHERE is_default;

CREATE TABLE signing_keys (                     -- Ed25519 keys for JWT; rotation keeps the old public key in JWKS for 1 day
  kid         text PRIMARY KEY,
  public_jwk  jsonb NOT NULL,
  private_jwk_encrypted bytea NOT NULL,         -- AES-256-GCM with JWT_KEY_ENCRYPTION_KEY
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz
);
```

## 2. catalog

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE categories (
  id          uuid PRIMARY KEY,
  parent_id   uuid REFERENCES categories(id) ON DELETE RESTRICT,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        text NOT NULL,
  description text,
  sort_order  int NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sellers (                          -- projection from seller.* events
  id           uuid PRIMARY KEY,                -- → seller
  slug         text NOT NULL UNIQUE,
  display_name text NOT NULL,
  region       text,
  status       text NOT NULL CHECK (status IN ('approved','suspended')),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id                     uuid PRIMARY KEY,
  seller_id              uuid NOT NULL REFERENCES sellers(id),
  category_id            uuid NOT NULL REFERENCES categories(id),
  slug                   text NOT NULL UNIQUE,  -- "<slugified-title>-<first 6 of id>"
  title                  text NOT NULL,
  description            text NOT NULL,
  craft_technique        text,
  materials              text[] NOT NULL DEFAULT '{}',
  origin_region          text,
  dimensions_cm          jsonb,                 -- {l,w,h}
  weight_grams           int CHECK (weight_grams > 0),
  care_instructions      text,
  making_time_days       int CHECK (making_time_days >= 0),
  price_paise            bigint NOT NULL CHECK (price_paise BETWEEN 100 AND 10000000),
  compare_at_price_paise bigint CHECK (compare_at_price_paise IS NULL OR compare_at_price_paise > price_paise),
  tax_rate_bps           int NOT NULL DEFAULT 500 CHECK (tax_rate_bps IN (0,500,1200,1800,2800)),
  hsn_code               text,
  status                 text NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','pending_review','active','rejected','archived')),
  rejection_reason       text,
  rating_avg             numeric(3,2),
  rating_count           int NOT NULL DEFAULT 0,
  search_vector          tsvector GENERATED ALWAYS AS (
                           setweight(to_tsvector('simple', unaccent_immutable(coalesce(title,''))), 'A') ||
                           setweight(to_tsvector('simple', unaccent_immutable(coalesce(craft_technique,'') || ' ' || coalesce(origin_region,''))), 'B') ||
                           setweight(to_tsvector('simple', unaccent_immutable(coalesce(description,''))), 'C')) STORED,
  published_at           timestamptz,
  legacy_mongo_id        text UNIQUE,
  created_at             timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
-- unaccent_immutable(text): IMMUTABLE SQL wrapper around unaccent('unaccent', $1), created in the same migration
CREATE INDEX products_search_idx   ON products USING gin (search_vector);
CREATE INDEX products_title_trgm   ON products USING gin (title gin_trgm_ops);
CREATE INDEX products_public_idx   ON products (category_id, status, published_at DESC);
CREATE INDEX products_price_idx    ON products (status, price_paise);
CREATE INDEX products_seller_idx   ON products (seller_id, status, updated_at DESC);

CREATE TABLE product_images (
  id           uuid PRIMARY KEY,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  storage_key  text NOT NULL,                   -- original key in R2
  variants     jsonb NOT NULL,                  -- [{width, key}]
  alt          text NOT NULL,
  position     int NOT NULL,
  width        int NOT NULL, height int NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE inventory (
  product_id uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  on_hand    int NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved   int NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reserved <= on_hand)
);

CREATE TABLE reservations (
  id          uuid PRIMARY KEY,                 -- = order id (→ order)
  status      text NOT NULL CHECK (status IN ('active','committed','released','expired')),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservations_active_expiry_idx ON reservations (expires_at) WHERE status = 'active';

CREATE TABLE reservation_items (
  reservation_id   uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  product_id       uuid NOT NULL REFERENCES products(id),
  seller_id        uuid NOT NULL,
  seller_display_name text NOT NULL,
  qty              int NOT NULL CHECK (qty BETWEEN 1 AND 10),
  unit_price_paise bigint NOT NULL CHECK (unit_price_paise > 0),
  tax_rate_bps     int NOT NULL,
  title            text NOT NULL, slug text NOT NULL, image_url text,
  PRIMARY KEY (reservation_id, product_id)
);

CREATE TABLE reviews (
  id          uuid PRIMARY KEY,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,                    -- → identity
  author_name text NOT NULL,
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title       text, body text,
  status      text NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden')),
  created_at  timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, user_id)
);
CREATE INDEX reviews_product_idx ON reviews (product_id, status, created_at DESC);

CREATE TABLE verified_purchases (               -- projection from order.paid
  user_id    uuid NOT NULL,
  product_id uuid NOT NULL,
  order_id   uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id, order_id)
);
```

## 3. seller

```sql
CREATE TABLE sellers (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL UNIQUE,         -- → identity
  slug             text NOT NULL UNIQUE,
  display_name     text NOT NULL,
  bio text, craft text NOT NULL, region text NOT NULL,
  avatar_url text, banner_url text,
  contact_email    citext NOT NULL,
  contact_phone    text NOT NULL,
  gstin            text,
  status           text NOT NULL CHECK (status IN ('applied','approved','rejected','suspended')),
  rejection_reason text, suspension_reason text,
  commission_bps   int NOT NULL DEFAULT 1000 CHECK (commission_bps BETWEEN 0 AND 5000),
  approved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sellers_status_idx ON sellers (status, created_at DESC);

CREATE TABLE seller_bank_accounts (
  seller_id                uuid PRIMARY KEY REFERENCES sellers(id) ON DELETE CASCADE,
  account_holder_name      text NOT NULL,
  account_number_encrypted bytea NOT NULL,      -- AES-256-GCM (iv|tag|ciphertext), key BANK_ENC_KEY
  account_number_last4     text NOT NULL,
  ifsc                     text NOT NULL,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (                   -- append-only; status is the only mutable column
  id              uuid PRIMARY KEY,
  seller_id       uuid NOT NULL REFERENCES sellers(id),
  order_id        uuid,                         -- → order
  seller_order_id uuid,                         -- → order
  order_number    text,
  refund_id       uuid,                         -- → payment
  payout_id       uuid,
  type            text NOT NULL CHECK (type IN ('sale','commission','refund_reversal','commission_reversal','payout','adjustment')),
  amount_paise    bigint NOT NULL,              -- signed
  status          text NOT NULL CHECK (status IN ('pending','available','paid')),
  available_at    timestamptz,
  memo            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ledger_sale_once     ON ledger_entries (seller_order_id, type) WHERE type IN ('sale','commission');
CREATE UNIQUE INDEX ledger_refund_once   ON ledger_entries (refund_id, seller_order_id, type) WHERE refund_id IS NOT NULL;
CREATE INDEX ledger_order_idx            ON ledger_entries (order_id);
CREATE INDEX ledger_seller_status_idx    ON ledger_entries (seller_id, status, created_at DESC);
CREATE INDEX ledger_due_idx              ON ledger_entries (available_at) WHERE status = 'pending' AND available_at IS NOT NULL;

CREATE TABLE payouts (
  id           uuid PRIMARY KEY,
  seller_id    uuid NOT NULL REFERENCES sellers(id),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  status       text NOT NULL CHECK (status IN ('pending','paid','failed')),
  utr          text,
  failure_reason text,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz
);
CREATE INDEX payouts_status_idx ON payouts (status, created_at DESC);
CREATE UNIQUE INDEX payouts_one_pending_per_seller ON payouts (seller_id) WHERE status = 'pending';
```

Ledger semantics:
- `pendingPaise` = Σ amount where `status='pending'`; `availablePaise` = Σ amount where `status='available'`; `paidPaise` = Σ `payouts.amount_paise` where `status='paid'`.
- **Payout created:** every `available` entry of the seller gets `payout_id`, and one `payout` entry `-amount` with status `available` and the same `payout_id` is appended. Available balance immediately nets to 0, so a second run can't pay twice.
- **Mark paid:** all entries with that `payout_id` → `paid`.
- **Mark failed:** append an `adjustment +amount` (status `available`, memo `payout <id> failed`) and clear `payout_id` on the included entries.
- **Refund reversal:** for each affected seller order, `refund_reversal = -min(refundAmount, remaining sale)` and `commission_reversal = +round(reversal × commission / sale)`, with the same status as the original sale entry (pending stays pending; available/paid → available). An order-level refund (`sellerOrderId = null`) reverses every seller order of that `order_id` in full. Balances may go negative; the next payout nets it.

## 4. cart

```sql
CREATE TABLE cart_items (
  user_id    uuid NOT NULL,                     -- → identity (no separate carts table)
  product_id uuid NOT NULL,
  qty        int  NOT NULL CHECK (qty BETWEEN 1 AND 10),
  added_at   timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE wishlist_items (
  user_id    uuid NOT NULL,
  product_id uuid NOT NULL,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE product_snapshots (                -- projection from product.* events
  product_id          uuid PRIMARY KEY,
  seller_id           uuid NOT NULL,
  seller_display_name text NOT NULL,
  slug text NOT NULL, title text NOT NULL,
  price_paise         bigint NOT NULL,
  image_url           text,
  is_purchasable      boolean NOT NULL,         -- status = 'active'
  source_event_at     timestamptz NOT NULL      -- ignore events older than this (out-of-order protection)
);
```

## 5. order

```sql
CREATE SEQUENCE order_number_seq;

CREATE TABLE orders (
  id                   uuid PRIMARY KEY,
  order_number         text NOT NULL UNIQUE,     -- 'CR-' || to_char(now(),'YYMM') || '-' || lpad(nextval::text, 6, '0')
  user_id              uuid NOT NULL,            -- → identity
  customer_email       text NOT NULL,
  customer_name        text NOT NULL,
  customer_phone       text NOT NULL,
  status               text NOT NULL CHECK (status IN ('pending_payment','paid','completed','cancelled')),
  refund_status        text NOT NULL DEFAULT 'none' CHECK (refund_status IN ('none','pending','refunded','failed')),
  items_subtotal_paise bigint NOT NULL CHECK (items_subtotal_paise >= 0),
  shipping_paise       bigint NOT NULL CHECK (shipping_paise >= 0),
  total_paise          bigint NOT NULL CHECK (total_paise = items_subtotal_paise + shipping_paise),
  currency             text NOT NULL DEFAULT 'INR',
  shipping_address     jsonb NOT NULL,
  cart_fingerprint     text NOT NULL,            -- sha256 of sorted (productId,qty); dedupes double checkout
  payment_intent_id    uuid, gateway_order_id text,
  placed_at            timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,     -- placed_at + 30 min
  paid_at              timestamptz,
  cancelled_at         timestamptz, cancel_reason text,
  completed_at         timestamptz,
  source               text NOT NULL DEFAULT 'web' CHECK (source IN ('web','legacy')),
  legacy_mongo_id      text UNIQUE,
  created_at           timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_idx    ON orders (user_id, placed_at DESC, id DESC);
CREATE INDEX orders_status_idx  ON orders (status, placed_at DESC);
CREATE INDEX orders_pending_exp ON orders (expires_at) WHERE status = 'pending_payment';
CREATE UNIQUE INDEX orders_one_pending_per_cart ON orders (user_id, cart_fingerprint) WHERE status = 'pending_payment';

CREATE TABLE seller_orders (
  id               uuid PRIMARY KEY,
  order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seller_id        uuid NOT NULL,                -- → seller
  seller_display_name text NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending','awaiting_acceptance','accepted','packed','shipped','delivered','cancelled')),
  subtotal_paise   bigint NOT NULL CHECK (subtotal_paise >= 0),
  refund_status    text NOT NULL DEFAULT 'none' CHECK (refund_status IN ('none','pending','refunded','failed')),
  tracking_carrier text, tracking_number text,
  cancel_reason    text,
  accepted_at timestamptz, packed_at timestamptz, shipped_at timestamptz, delivered_at timestamptz, cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, seller_id)
);
CREATE INDEX seller_orders_seller_idx ON seller_orders (seller_id, status, created_at DESC);

CREATE TABLE order_items (
  id               uuid PRIMARY KEY,
  order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seller_order_id  uuid NOT NULL REFERENCES seller_orders(id) ON DELETE CASCADE,
  product_id       uuid NOT NULL,                -- → catalog
  title text NOT NULL, slug text NOT NULL, image_url text,
  unit_price_paise bigint NOT NULL CHECK (unit_price_paise > 0),
  qty              int NOT NULL CHECK (qty > 0),
  line_total_paise bigint NOT NULL CHECK (line_total_paise = unit_price_paise * qty),
  tax_rate_bps     int NOT NULL
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_so_idx    ON order_items (seller_order_id);

CREATE TABLE order_status_history (
  id              uuid PRIMARY KEY,
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seller_order_id uuid REFERENCES seller_orders(id) ON DELETE CASCADE,
  from_status     text, to_status text NOT NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('buyer','seller','admin','system')),
  actor_id        uuid,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX osh_order_idx ON order_status_history (order_id, created_at);
-- + outbox, inbox, idempotency_keys
```

## 6. payment

```sql
CREATE TABLE payment_intents (
  id                 uuid PRIMARY KEY,
  order_id           uuid NOT NULL UNIQUE,       -- → order
  user_id            uuid NOT NULL,
  amount_paise       bigint NOT NULL CHECK (amount_paise > 0),
  currency           text NOT NULL DEFAULT 'INR',
  status             text NOT NULL CHECK (status IN ('created','captured','failed','refunded','partially_refunded')),
  provider           text NOT NULL DEFAULT 'razorpay',
  gateway_order_id   text NOT NULL UNIQUE,
  gateway_payment_id text UNIQUE,
  method             text,
  failure_reason     text,
  refunded_paise     bigint NOT NULL DEFAULT 0 CHECK (refunded_paise BETWEEN 0 AND amount_paise),
  captured_at        timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_intents_status_idx ON payment_intents (status, created_at DESC);

CREATE TABLE refunds (
  id                uuid PRIMARY KEY,
  payment_intent_id uuid NOT NULL REFERENCES payment_intents(id),
  gateway_payment_id text NOT NULL,            -- which captured payment is refunded (differs from the intent's for duplicate payments)
  order_id          uuid NOT NULL,
  seller_order_id   uuid,
  amount_paise      bigint NOT NULL CHECK (amount_paise > 0),
  reason            text NOT NULL,              -- 'seller_order_cancelled'|'late_payment'|'commit_failed'|'duplicate_payment'|'admin:<text>'
  counts_against_intent boolean NOT NULL DEFAULT true,  -- false for duplicate_payment refunds
  status            text NOT NULL CHECK (status IN ('pending','processed','failed')),
  gateway_refund_id text UNIQUE,
  idempotency_key   text NOT NULL UNIQUE,       -- 'refund:<orderId>:<sellerOrderId|all>:<reason>' or admin key
  failure_reason    text,
  requested_by      text NOT NULL,              -- 'system' | 'admin:<uuid>'
  created_at        timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz
);
CREATE INDEX refunds_order_idx  ON refunds (order_id);
CREATE INDEX refunds_status_idx ON refunds (status, created_at DESC);

CREATE TABLE webhook_events (
  id            text PRIMARY KEY,               -- X-Razorpay-Event-Id
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,                 -- stored as received; no card data is ever sent by Razorpay
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  error         text
);
-- + outbox, inbox, idempotency_keys
```

## 7. notification

```sql
CREATE TABLE notifications (
  id                  uuid PRIMARY KEY,
  event_id            uuid NOT NULL,
  template            text NOT NULL,           -- 'order_confirmation_buyer'
  channel             text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  recipient           text NOT NULL,
  payload             jsonb NOT NULL,          -- template data captured from the event
  status              text NOT NULL CHECK (status IN ('queued','sent','failed','skipped')),
  attempts            int NOT NULL DEFAULT 0,
  provider_message_id text,
  last_error          text,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  UNIQUE (event_id, template, recipient)
);
CREATE INDEX notifications_due_idx ON notifications (next_attempt_at) WHERE status = 'queued';

CREATE TABLE order_contacts (                   -- projection from order.placed
  order_id      uuid PRIMARY KEY,
  order_number  text NOT NULL,
  user_id       uuid NOT NULL,
  email         text NOT NULL,
  name          text NOT NULL
);
CREATE INDEX order_contacts_user_idx ON order_contacts (user_id);

CREATE TABLE seller_contacts (                  -- projection from seller.approved
  seller_id     uuid PRIMARY KEY,
  contact_email text NOT NULL,
  display_name  text NOT NULL
);
-- + inbox
```

## 8. Data lifecycle

| Data | Retention |
|---|---|
| `outbox` published rows | delete after 7 days (daily job) |
| `inbox` | delete after 30 days |
| `idempotency_keys` | delete after 24 h |
| `refresh_tokens` expired or revoked | delete after 30 days |
| `webhook_events` | keep 1 year |
| `notifications` | keep 180 days |
| orders, payments, refunds, ledger | keep ≥ 8 years (tax records); anonymise customer PII on `user.deleted` |
