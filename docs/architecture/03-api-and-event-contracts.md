# 03 — API and Event Contracts

This document is the source for the `@craftoria/contracts` package (plan 02, Tasks 4–5). Every shape below becomes a **zod schema** with the same name plus `Schema` (e.g. `ProductCard` → `ProductCardSchema`, type `ProductCard = z.infer<…>`). Field names are camelCase in JSON and snake_case in SQL.

Notation: `Paise` = non-negative safe integer; `Uuid` = UUID string; `IsoDate` = ISO-8601 UTC string; `?` = optional; `| null` = nullable.

---

## 1. Conventions

- Base path `/v1`. JSON only (`Content-Type: application/json`), except the Razorpay webhook (raw body).
- Auth header `Authorization: Bearer <accessToken>`. 🔓 = public, 🔑 = any authenticated user, 🎨 = `artisan`, 🛡 = `admin`, 🔒 = internal (`X-Internal-Token`).
- `Idempotency-Key: <uuid>` is **required** on `POST /v1/checkout` and `POST /v1/admin/refunds`, and optional on other POSTs.
- Success codes: 200 read/update, 201 create, 202 accepted-async, 204 no body.
- Error body (always):
  ```json
  { "error": { "code": "OUT_OF_STOCK", "message": "Human readable", "details": {}, "requestId": "01J…" } }
  ```

### 1.1 Error codes (`ErrorCode` enum)

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | zod failure; `details.issues[{path, message}]` |
| `UNAUTHENTICATED` | 401 | missing, invalid or expired access token |
| `INVALID_CREDENTIALS` | 401 | bad email/password (same message for unknown email) |
| `REFRESH_TOKEN_INVALID` | 401 | refresh cookie missing, expired, revoked or reused |
| `FORBIDDEN` | 403 | authenticated but not allowed |
| `EMAIL_NOT_VERIFIED` | 403 | action requires a verified email (checkout, seller apply) |
| `ACCOUNT_DISABLED` | 403 | user status disabled |
| `NOT_FOUND` | 404 | resource missing **or not owned by the caller** (never leak existence) |
| `EMAIL_TAKEN` | 409 | register with an existing email |
| `CONFLICT` | 409 | generic state conflict |
| `OUT_OF_STOCK` | 409 | `details.items[{productId, requested, available}]` |
| `IDEMPOTENCY_KEY_REUSED` | 409 | same key, different request body |
| `INVALID_STATE_TRANSITION` | 409 | `details {from, action}` |
| `ALREADY_REVIEWED` | 409 | one review per user per product |
| `CART_EMPTY` | 422 | checkout with no purchasable items |
| `PRODUCT_UNAVAILABLE` | 422 | product not active / seller suspended; `details.productIds` |
| `PURCHASE_REQUIRED` | 422 | review without a verified purchase |
| `PAYMENT_SIGNATURE_INVALID` | 422 | Razorpay signature mismatch |
| `BUSINESS_RULE_VIOLATED` | 422 | other domain rule; `details.rule` |
| `TOO_MANY_ATTEMPTS` | 429 | login throttle / rate limit; `Retry-After` header |
| `UPSTREAM_UNAVAILABLE` | 503 | a dependency timed out or the circuit is open |
| `INTERNAL` | 500 | anything unexpected (message is generic) |

### 1.2 Shared value objects

```ts
Money        = { amountPaise: Paise, currency: 'INR' }        // used only in display DTOs; internal math uses Paise
AddressInput = { fullName: string(2..80), phone: /^[6-9]\d{9}$/, line1: string(3..120), line2?: string(..120),
                 landmark?: string(..80), city: string(2..60), state: IndianState /* enum of 36 states+UTs */,
                 pincode: /^[1-9]\d{5}$/, country: 'IN' }
Address      = AddressInput & { id: Uuid, label: string(..30) | null, isDefault: boolean }
Page<T>      = { items: T[], page: number, limit: number, total: number }
CursorPage<T>= { items: T[], nextCursor: string | null }      // cursor = base64url of "<created_at ISO>|<id>"
Role         = 'buyer' | 'artisan' | 'admin'
```

---

## 2. Identity service (`/v1/auth`, `/v1/me`, `/v1/admin/users`)

```ts
PublicUser = { id: Uuid, email: string, name: string, phone: string | null, emailVerified: boolean,
               roles: Role[], sellerId: Uuid | null, createdAt: IsoDate }
AuthResult = { user: PublicUser, accessToken: string, accessTokenExpiresAt: IsoDate }
AdminUser  = PublicUser & { status: 'active' | 'disabled' | 'deleted' }
// Emails are trimmed and lower-cased. Password rules (10..128) apply to register, reset and change only;
// login and confirmation fields accept any non-empty value so the policy is not revealed.
```

| Method | Path | Auth | Body → Response |
|---|---|---|---|
| POST | `/v1/auth/register` | 🔓 | `{name: 2..80, email, password: 10..128}` → 201 `AuthResult` + sets `cr_rt` cookie; emits `user.registered`, `user.email_verification_requested` |
| POST | `/v1/auth/login` | 🔓 | `{email, password}` → 200 `AuthResult` + cookie |
| POST | `/v1/auth/refresh` | cookie + `X-Requested-With` | → 200 `{accessToken, accessTokenExpiresAt}` + rotated cookie |
| POST | `/v1/auth/logout` | cookie + `X-Requested-With` | → 204, family revoked, cookie cleared |
| POST | `/v1/auth/verify-email` | 🔓 | `{token}` → 204 |
| POST | `/v1/auth/resend-verification` | 🔑 | → 202 (max 3/hour) |
| POST | `/v1/auth/forgot-password` | 🔓 | `{email}` → 202 **always** (no enumeration) |
| POST | `/v1/auth/reset-password` | 🔓 | `{token, password}` → 204; revokes all refresh tokens |
| GET | `/v1/me` | 🔑 | → `PublicUser` |
| PATCH | `/v1/me` | 🔑 | `{name?, phone?}` → `PublicUser` |
| POST | `/v1/me/change-password` | 🔑 | `{currentPassword, newPassword}` → 204; revokes other sessions |
| DELETE | `/v1/me` | 🔑 | `{password}` → 204; anonymise, emits `user.deleted` |
| GET | `/v1/me/addresses` | 🔑 | → `Address[]` (max 10) |
| POST | `/v1/me/addresses` | 🔑 | `AddressInput & {label?, isDefault?}` → 201 `Address` |
| PATCH | `/v1/me/addresses/:id` | 🔑 | partial → `Address` |
| DELETE | `/v1/me/addresses/:id` | 🔑 | → 204 |
| GET | `/.well-known/jwks.json` | 🔓 | → JWKS (`Cache-Control: public, max-age=600`) |
| GET | `/v1/admin/users` | 🛡 | `?q&role&status&cursor&limit` → `CursorPage<AdminUser>` |
| PATCH | `/v1/admin/users/:id` | 🛡 | `{status: 'active'|'disabled'}` → 200; disabling revokes sessions |
| POST | `/v1/admin/users/:id/roles` | 🛡 | `{role: 'admin'}` → 204 (only `admin` is grantable here) |

Access-token claims type: `AccessTokenClaims = { sub, email, name, emailVerified: boolean, roles: Role[], sellerId?: Uuid, sid: Uuid, iss, aud, iat, exp }`. After `verify-email` succeeds, the frontend calls `/v1/auth/refresh` so the new claim takes effect.

---

## 3. Catalog service

```ts
Category     = { id: Uuid, slug: string, name: string, parentId: Uuid | null, description: string | null, productCount: number }
ImageVariant = { width: 400 | 800 | 1600, url: string }
ProductImage = { id: Uuid, alt: string, position: number, width: number, height: number, variants: ImageVariant[] }
SellerBadge  = { id: Uuid, slug: string, displayName: string, region: string | null }
ProductCard  = { id: Uuid, slug: string, title: string, pricePaise: Paise, compareAtPricePaise: Paise | null,
                 primaryImage: ProductImage | null, seller: SellerBadge, ratingAvg: number | null,
                 ratingCount: number, inStock: boolean, craftTechnique: string | null }
ProductDetail= ProductCard & { description: string, category: Category, images: ProductImage[],
                 materials: string[], originRegion: string | null, dimensionsCm: {l:number,w:number,h:number} | null,
                 weightGrams: number | null, careInstructions: string | null, makingTimeDays: number | null,
                 availableQty: number /* capped at 10 for display */, taxRateBps: number, publishedAt: IsoDate }
SellerProduct= ProductDetail & { status: ProductStatus, rejectionReason: string | null, onHand: number, reserved: number,
                 hsnCode: string | null, updatedAt: IsoDate }
               // overrides: publishedAt: IsoDate | null (drafts were never published); availableQty uncapped
ProductStatus= 'draft' | 'pending_review' | 'active' | 'rejected' | 'archived'
Review       = { id: Uuid, productId: Uuid, authorName: string, rating: 1|2|3|4|5, title: string | null,
                 body: string | null, verifiedPurchase: true, createdAt: IsoDate }
// authorName = first word of the user's name + initial of the last word, e.g. "Asha R." (privacy)
ProductUpsert= { title: 3..120, description: 20..5000, categoryId: Uuid, pricePaise: 100..10_000_000 (₹1..₹1,00,000),
                 compareAtPricePaise?: Paise (> pricePaise), craftTechnique?: ..60, materials?: string[] (..10),
                 originRegion?: ..80, dimensionsCm?, weightGrams?: 1..50_000, careInstructions?: ..1000,
                 makingTimeDays?: 0..365, taxRateBps?: 0|500|1200|1800|2800, hsnCode?: /^\d{4,8}$/ }
```

| Method | Path | Auth | Body → Response |
|---|---|---|---|
| GET | `/v1/categories` | 🔓 | → `Category[]` (flat; client builds the tree) |
| GET | `/v1/products` | 🔓 | `?q&category(slug)&seller(slug)&minPrice&maxPrice&inStock&sort=relevance|newest|price_asc|price_desc|rating&page&limit` → `Page<ProductCard>`. `minPrice`/`maxPrice` are **paise**; `inStock` is `true`/`false`; `q` ≤ 100 chars |
| GET | `/v1/products/:idOrSlug` | 🔓 | → `ProductDetail` (404 unless active and seller approved) |
| GET | `/v1/products/:id/reviews` | 🔓 | `?page&limit` → `ReviewPage = Page<Review> & { summary: { avg: number | null, count: number, distribution: [n1, n2, n3, n4, n5] } }` |
| POST | `/v1/products/:id/reviews` | 🔑 | `{rating, title?: ..100, body?: ..2000}` → 201 `Review` (`PURCHASE_REQUIRED`, `ALREADY_REVIEWED`) |
| GET | `/v1/seller/products` | 🎨 | `?status&cursor&limit` → `CursorPage<SellerProduct>` |
| POST | `/v1/seller/products` | 🎨 | `ProductUpsert` → 201 `SellerProduct` (status `draft`, onHand 0) |
| GET | `/v1/seller/products/:id` | 🎨 | → `SellerProduct` (own only) |
| PATCH | `/v1/seller/products/:id` | 🎨 | partial `ProductUpsert` → `SellerProduct` (content change on an active product → `pending_review`) |
| POST | `/v1/seller/products/:id/submit` | 🎨 | → `SellerProduct` (`draft`/`rejected` → `pending_review`; needs ≥1 image) |
| POST | `/v1/seller/products/:id/archive` | 🎨 | → `SellerProduct` |
| PUT | `/v1/seller/products/:id/inventory` | 🎨 | `{onHand: 0..100_000}` → `{onHand, reserved, available}` (`onHand < reserved` → 409 `CONFLICT`) |
| POST | `/v1/seller/products/:id/images/upload-url` | 🎨 | `{contentType: 'image/jpeg'|'image/png'|'image/webp', contentLength: 1..10_485_760}` → `{uploadUrl, storageKey, expiresAt}` |
| POST | `/v1/seller/products/:id/images` | 🎨 | `{storageKey, alt: 3..140}` → 201 `ProductImage` (max 8 images) |
| PATCH | `/v1/seller/products/:id/images/:imageId` | 🎨 | `{alt?, position?}` → `ProductImage` |
| DELETE | `/v1/seller/products/:id/images/:imageId` | 🎨 | → 204 |
| GET | `/v1/admin/products` | 🛡 | `?status&seller&cursor&limit` → `CursorPage<SellerProduct>` |
| POST | `/v1/admin/products/:id/approve` | 🛡 | → `SellerProduct` |
| POST | `/v1/admin/products/:id/reject` | 🛡 | `{reason: 5..500}` → `SellerProduct` |
| POST/PATCH/DELETE | `/v1/admin/categories[/:id]` | 🛡 | `{name, slug?, parentId?, description?, sortOrder?}`; delete only if 0 products |
| PATCH | `/v1/admin/reviews/:id` | 🛡 | `{status: 'published'|'hidden'}` → `Review` |

**Internal (🔒):**
```ts
ReserveRequest  = { reservationId: Uuid /* = orderId */, items: {productId: Uuid, qty: 1..10}[] (1..50, productIds unique), ttlSeconds: 60..3600 }
// catalog stores expires_at = now + ttlSeconds + 900 s grace (the safety net)
PricedLine      = { productId, sellerId, sellerDisplayName, title, slug, imageUrl: string | null, unitPricePaise: Paise, qty, taxRateBps }
ReserveResponse = { reservationId, expiresAt: IsoDate, lines: PricedLine[] }
```
| POST | `/internal/reservations` | 🔒 | `ReserveRequest` → 201 `ReserveResponse`; same `reservationId` again → 200 with the same lines (idempotent); `409 OUT_OF_STOCK`; `422 PRODUCT_UNAVAILABLE` |
| POST | `/internal/reservations/:id/release` | 🔒 | → 204 (idempotent; no-op unless `active`) |

---

## 4. Seller service

```ts
SellerStatus   = 'applied' | 'approved' | 'rejected' | 'suspended'
SellerProfile  = { id: Uuid, userId: Uuid, slug: string, displayName: string, bio: string | null, craft: string,
                   region: string, avatarUrl: string | null, bannerUrl: string | null, status: SellerStatus,
                   commissionBps: number, contactEmail: string, contactPhone: string, gstin: string | null,
                   rejectionReason: string | null, createdAt: IsoDate, approvedAt: IsoDate | null }
PublicSeller   = Pick<SellerProfile,'id'|'slug'|'displayName'|'bio'|'craft'|'region'|'avatarUrl'|'bannerUrl'> & { memberSince: IsoDate }
SellerApply    = { displayName: 3..60, bio?: ..2000, craft: 2..60, region: 2..80, contactPhone: /^[6-9]\d{9}$/,
                   gstin?: /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/ }
BankAccountIn  = { accountHolderName: 2..100, accountNumber: /^\d{9,18}$/, ifsc: /^[A-Z]{4}0[A-Z0-9]{6}$/ }
BankAccountOut = { accountHolderName, accountNumberLast4: string, ifsc, updatedAt: IsoDate }
LedgerEntry    = { id, sellerOrderId: Uuid | null, orderNumber: string | null, type: 'sale'|'commission'|'refund_reversal'|'commission_reversal'|'payout'|'adjustment',
                   amountPaise: number /* signed */, status: 'pending'|'available'|'paid', availableAt: IsoDate | null, createdAt: IsoDate }
Balance        = { pendingPaise: number, availablePaise: number, paidPaise: number }
Payout         = { id, sellerId, sellerDisplayName, amountPaise: Paise, status: 'pending'|'paid'|'failed', utr: string | null,
                   createdAt: IsoDate, paidAt: IsoDate | null }
```

| Method | Path | Auth | Body → Response |
|---|---|---|---|
| POST | `/v1/seller/apply` | 🔑 (email verified) | `SellerApply` → 201 `SellerProfile` (one per user; re-apply allowed only from `rejected`) |
| GET | `/v1/seller/profile` | 🔑 | → `SellerProfile` (404 if never applied) |
| PATCH | `/v1/seller/profile` | 🎨 | `{bio?, avatarUrl?, bannerUrl?, contactPhone?, gstin?}` → `SellerProfile` |
| PUT | `/v1/seller/bank-account` | 🎨 | `BankAccountIn` → `BankAccountOut` |
| GET | `/v1/seller/bank-account` | 🎨 | → `BankAccountOut` |
| GET | `/v1/seller/ledger` | 🎨 | `?cursor&limit&status` → `CursorPage<LedgerEntry>` |
| GET | `/v1/seller/balance` | 🎨 | → `Balance` |
| GET | `/v1/seller/payouts` | 🎨 | `?cursor` → `CursorPage<Payout>` |
| GET | `/v1/sellers/:slug` | 🔓 | → `PublicSeller` (approved only) |
| GET | `/v1/admin/sellers` | 🛡 | `?status&q&cursor` → `CursorPage<SellerProfile>` |
| POST | `/v1/admin/sellers/:id/approve` | 🛡 | `{commissionBps?: 0..5000}` → `SellerProfile` |
| POST | `/v1/admin/sellers/:id/reject` | 🛡 | `{reason}` → `SellerProfile` |
| POST | `/v1/admin/sellers/:id/suspend` | 🛡 | `{reason}` → `SellerProfile` |
| POST | `/v1/admin/sellers/:id/reinstate` | 🛡 | → `SellerProfile` |
| PATCH | `/v1/admin/sellers/:id` | 🛡 | `{commissionBps}` → `SellerProfile` (applies to future orders only) |
| POST | `/v1/admin/payouts/run` | 🛡 | → 201 `Payout[]` (sellers with available ≥ 50,000 paise and a bank account) |
| GET | `/v1/admin/payouts` | 🛡 | `?status&cursor` → `CursorPage<Payout>`; `Accept: text/csv` → CSV `payout_id,seller,account_holder,account_number,ifsc,amount_inr` |
| POST | `/v1/admin/payouts/:id/mark-paid` | 🛡 | `{utr: 6..30}` → `Payout` |
| POST | `/v1/admin/payouts/:id/mark-failed` | 🛡 | `{reason}` → `Payout` (entries return to `available`) |

---

## 5. Cart service

```ts
CartLine = { productId: Uuid, qty: number, product: { title, slug, pricePaise, imageUrl: string | null,
             sellerDisplayName: string, isPurchasable: boolean } }
Cart     = { items: CartLine[], itemCount: number /* sum of qty */, subtotalPaise: Paise /* purchasable lines only */, updatedAt: IsoDate | null }
WishlistItem = { productId, addedAt: IsoDate, product: CartLine['product'] }
```

| Method | Path | Auth | Body → Response |
|---|---|---|---|
| GET | `/v1/cart` | 🔑 | → `Cart` |
| PUT | `/v1/cart/items/:productId` | 🔑 | `{qty: 0..10}` → `Cart` (0 = remove; unknown product → 422 `PRODUCT_UNAVAILABLE`) |
| DELETE | `/v1/cart/items/:productId` | 🔑 | → `Cart` |
| DELETE | `/v1/cart` | 🔑 | → 204 |
| POST | `/v1/cart/merge` | 🔑 | `{items: {productId, qty}[] (..50)}` → `Cart` (guest cart from the browser; qty = max(existing, incoming), capped at 10) |
| GET | `/v1/wishlist` | 🔑 | → `WishlistItem[]` |
| PUT | `/v1/wishlist/:productId` | 🔑 | → 204 (idempotent) |
| DELETE | `/v1/wishlist/:productId` | 🔑 | → 204 |
| GET | `/internal/carts/:userId` | 🔒 | → `{ items: {productId, qty}[] }` (purchasable lines only) |

---

## 6. Order service

```ts
OrderStatus       = 'pending_payment' | 'paid' | 'completed' | 'cancelled'
SellerOrderStatus = 'pending' | 'awaiting_acceptance' | 'accepted' | 'packed' | 'shipped' | 'delivered' | 'cancelled'
RefundStatus      = 'none' | 'pending' | 'refunded' | 'failed'
SellerOrderAction = 'accept' | 'pack' | 'ship' | 'deliver' | 'cancel'
OrderItem   = { id, productId, title, slug, imageUrl: string | null, unitPricePaise, qty, lineTotalPaise, taxRateBps }
SellerOrder = { id, sellerId, sellerDisplayName, status: SellerOrderStatus, subtotalPaise, items: OrderItem[],
                trackingCarrier: string | null, trackingNumber: string | null, refundStatus: RefundStatus,
                cancelReason: string | null, acceptedAt, shippedAt, deliveredAt, cancelledAt: IsoDate | null }
Order       = { id, orderNumber: string, status: OrderStatus, displayStatus: string, itemsSubtotalPaise, shippingPaise,
                totalPaise, currency: 'INR', shippingAddress: AddressInput, sellerOrders: SellerOrder[],
                placedAt: IsoDate, paidAt: IsoDate | null, expiresAt: IsoDate | null, cancelledAt: IsoDate | null, cancelReason: string | null }
OrderSummary= Pick<Order,'id'|'orderNumber'|'status'|'displayStatus'|'totalPaise'|'placedAt'> & { itemCount: number, firstItemImageUrl: string | null }
CheckoutRequest  = { shippingAddress: AddressInput }
CheckoutResponse = { order: Order, payment: { provider: 'razorpay', keyId: string, gatewayOrderId: string, amountPaise: Paise, currency: 'INR' } }
SellerOrderView  = SellerOrder & { orderId, orderNumber, placedAt, shippingAddress: AddressInput, customerName: string }
StatusHistoryEntry = { from: string | null, to: string, actorType: 'buyer'|'seller'|'admin'|'system', reason: string | null, at: IsoDate }
AdminStats  = { gmvPaise: {today, last7d, last30d}, orders: {today, last7d, pendingAcceptance, awaitingShipment}, refundsPendingCount }
```

| Method | Path | Auth | Body → Response |
|---|---|---|---|
| POST | `/v1/checkout` | 🔑 (email verified) + `Idempotency-Key` | `CheckoutRequest` → 201 `CheckoutResponse` |
| GET | `/v1/orders` | 🔑 | `?cursor&limit` → `CursorPage<OrderSummary>` |
| GET | `/v1/orders/:id` | 🔑 | → `Order` + `history: StatusHistoryEntry[]` (own only, else 404) |
| POST | `/v1/orders/:id/cancel` | 🔑 | `{reason?: ..200}` → `Order` (`pending_payment` → cancelled; `paid` → cancels every seller order in `awaiting_acceptance|accepted`) |
| POST | `/v1/orders/:id/payment` | 🔑 | → `CheckoutResponse['payment']` (re-open payment for a `pending_payment` order that has not expired) |
| GET | `/v1/seller/orders` | 🎨 | `?status&cursor&limit` → `CursorPage<SellerOrderView>` |
| GET | `/v1/seller/orders/:sellerOrderId` | 🎨 | → `SellerOrderView` |
| POST | `/v1/seller/orders/:sellerOrderId/:action` | 🎨 | action ∈ `accept|pack|ship|deliver|cancel`; `ship` body `{carrier: 2..40, trackingNumber: 4..40}`, `cancel` body `{reason: 5..200}` → `SellerOrderView` |
| GET | `/v1/admin/orders` | 🛡 | `?status&q(orderNumber/email)&cursor` → `CursorPage<OrderSummary & {customerEmail}>` |
| GET | `/v1/admin/orders/:id` | 🛡 | → `Order & {customerEmail, customerName, history}` |
| POST | `/v1/admin/seller-orders/:id/:action` | 🛡 | same actions, body `{reason: 5..200, carrier?, trackingNumber?}` (carrier + tracking required for `ship`) → `SellerOrderView` |
| GET | `/v1/admin/stats` | 🛡 | → `AdminStats` |

---

## 7. Payment service

```ts
PaymentIntentStatus = 'created' | 'captured' | 'failed' | 'refunded' | 'partially_refunded'
CreatePaymentIntent = { orderId: Uuid, userId: Uuid, amountPaise: 100..50_000_000, customer: {name, email, phone} }
PaymentIntentOut    = { paymentIntentId: Uuid, provider: 'razorpay', keyId: string, gatewayOrderId: string, amountPaise, currency: 'INR' }
VerifyPayment       = { razorpayOrderId: string, razorpayPaymentId: string, razorpaySignature: string }
AdminRefundRequest  = { orderId: Uuid, sellerOrderId?: Uuid, amountPaise: Paise, reason: 5..200 }
Refund              = { id, orderId, sellerOrderId: Uuid | null, amountPaise, status: 'pending'|'processed'|'failed', reason, createdAt, processedAt }
PaymentIntent       = { id, orderId, userId, amountPaise, currency: 'INR', status: PaymentIntentStatus, gatewayOrderId,
                        gatewayPaymentId: string | null, method: string | null, refundedPaise, failureReason: string | null,
                        capturedAt: IsoDate | null, createdAt: IsoDate }   // admin list view
```

| Method | Path | Auth | Body → Response |
|---|---|---|---|
| POST | `/internal/payment-intents` | 🔒 | `CreatePaymentIntent` → 201 `PaymentIntentOut` (same `orderId` → 200, existing intent) |
| POST | `/v1/payments/verify` | 🔑 | `VerifyPayment` → 200 `{status: PaymentIntentStatus}` (`PAYMENT_SIGNATURE_INVALID`; intent of another user → 404) |
| POST | `/v1/webhooks/razorpay` | 🔓 + `X-Razorpay-Signature` | raw JSON → 200 always after signature check (400 on a bad signature) |
| GET | `/v1/admin/payments` | 🛡 | `?orderId&status&cursor` → `CursorPage<PaymentIntent>` |
| POST | `/v1/admin/refunds` | 🛡 + `Idempotency-Key` | `AdminRefundRequest` → 202 `Refund` (sum of refunds ≤ captured amount) |
| GET | `/v1/admin/refunds` | 🛡 | `?status&cursor` → `CursorPage<Refund>` |

Handled Razorpay webhook events: `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed`. Others are logged and ignored.

---

## 8. Events catalog

Envelope: see `02-target-architecture.md` §5.2. Every event lists its payload (`data`). Routing key = `<type>.v<version>`.

| Type (v1) | Producer | Payload `data` | Consumers |
|---|---|---|---|
| `user.registered` | identity | `{userId, email, name}` | notification (welcome) |
| `user.email_verification_requested` | identity | `{userId, email, name, verifyUrl}` | notification |
| `user.password_reset_requested` | identity | `{userId, email, name, resetUrl}` (URL carries the one-time token; TTL 30 min) | notification |
| `user.deleted` | identity | `{userId}` | notification (delete `order_contacts`), cart (delete cart and wishlist), catalog (review author → "Former customer"), order (customer name → "Deleted user", email → `deleted+<userId>@invalid`, phone → `0000000000`, address name/phone/lines masked) |
| `seller.applied` | seller | `{sellerId, userId, displayName}` | notification (to admins: `ADMIN_ALERT_EMAIL`) |
| `seller.approved` | seller | `{sellerId, userId, slug, displayName, region, contactEmail, commissionBps}` | identity, catalog, notification |
| `seller.rejected` | seller | `{sellerId, userId, contactEmail, reason}` | notification |
| `seller.suspended` | seller | `{sellerId, userId, reason}` | catalog (hides products, blocks product writes). Identity keeps the `artisan` role so the seller can still fulfil already-paid orders |
| `seller.reinstated` | seller | `{sellerId, userId}` | catalog |
| `product.published` | catalog | `ProductSnapshot = {productId, sellerId, sellerDisplayName, slug, title, pricePaise, imageUrl, status}` | cart |
| `product.updated` | catalog | `ProductSnapshot` | cart |
| `product.unpublished` | catalog | `{productId, reason: 'archived'|'rejected'|'seller_suspended'|'pending_review'}` | cart |
| `inventory.commit_failed` | catalog | `{reservationId (=orderId), items: {productId, requested, available}[]}` | order |
| `order.placed` | order | `{orderId, orderNumber, userId, customerEmail, customerName, totalPaise}` | notification (`order_contacts` projection, used for refund and late-payment emails) |
| `order.paid` | order | `{orderId, orderNumber, userId, customerEmail, customerName, totalPaise, shippingPaise, paidAt, shippingAddress, sellerOrders: {sellerOrderId, sellerId, subtotalPaise, items: {productId, title, qty, unitPricePaise}[]}[]}` | catalog, cart, seller, notification |
| `order.cancelled` | order | `{orderId, orderNumber, userId, reason: 'payment_timeout'|'buyer_cancelled'|'admin_cancelled', wasPaid: false}` (`wasPaid` is always the literal `false`: paid orders are cancelled per seller order instead) | catalog (release) |
| `order.refund_required` | order | `{orderId, sellerOrderId: Uuid | null, amountPaise, reason: 'seller_order_cancelled'|'late_payment'|'commit_failed'}` | payment |
| `seller_order.status_changed` | order | `{sellerOrderId, orderId, orderNumber, sellerId, userId, customerEmail, from: SellerOrderStatus, to: SellerOrderStatus, actorType, trackingCarrier?, trackingNumber?, reason?}` | notification |
| `seller_order.delivered` | order | `{sellerOrderId, orderId, sellerId, deliveredAt}` | seller |
| `payment.captured` | payment | `{paymentIntentId, orderId, amountPaise, gatewayPaymentId, method, capturedAt}` | order |
| `payment.failed` | payment | `{paymentIntentId, orderId, gatewayPaymentId, reason}` | order (history only; the order stays payable until it expires) |
| `refund.processed` | payment | `{refundId, orderId, sellerOrderId: Uuid | null, amountPaise, kind: 'order_refund'|'duplicate_payment', reason}` | order, seller, notification. **`kind: 'duplicate_payment'`** = the buyer paid twice and the extra payment was returned: order and seller **must ignore it** (no status or ledger change); notification still emails the buyer |
| `refund.failed` | payment | `{refundId, orderId, sellerOrderId: Uuid | null, amountPaise, kind, reason}` | order (refund_status=failed → admin dashboard; ignores `duplicate_payment`, which ops handle in the payment admin list) |
| `payout.paid` | seller | `{payoutId, sellerId, amountPaise, utr, contactEmail}` | notification |

Contract test rule: the producer's integration test parses its outbox payload with the schema; the consumer's test feeds the shared fixture `contracts/fixtures/<type>.v1.json`. Both must pass against the same schema.
