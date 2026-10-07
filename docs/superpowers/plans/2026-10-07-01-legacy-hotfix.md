# Legacy Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the exploitable payment, data-exposure and credential holes in the **live legacy app** (`backend/`, `frontend/`) so it can run safely until the v2 cutover.

**Architecture:** Minimal, surgical changes to the existing Express + MongoDB backend. The server computes the amount, Razorpay signature verification plus a webhook decide "paid", and the browser no longer creates orders. Also: field whitelisting, an ownership check, hardened middleware. No restructuring beyond extracting `createApp()` so the code can be tested.

**Tech Stack:** Node 20+ (CommonJS, as-is), Express 5, MongoDB driver 6, Razorpay SDK; tests with `node:test` + `supertest` + `mongodb-memory-server`.

**Spec:** `docs/architecture/01-current-state-audit.md` (defects C1–C8, B1–B4, B8). Skip this plan if decision D-4 says the legacy site takes no real payments (still do Task 5's credential rotation).

**Required skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`; plus the workflow skills `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use **only** the project skills in `.claude/skills/` (mirrored in `.agents/skills/`); no other skills or plugins. See `docs/architecture/05-engineering-standards.md` §8.

## Global Constraints

- Don't change the response shape of any `GET` endpoint the current frontend uses.
- Money: compute `amountPaise = Math.round(price * 100) * qty` **on the server** from the `products` collection; ignore every client amount, price, total and `isPaid`.
- Signature: `HMAC_SHA256(razorpay_order_id + "|" + razorpay_payment_id, RAZORPAY_KEY_SECRET)` hex, compared with `crypto.timingSafeEqual`.
- Webhook signature: `HMAC_SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET)` hex vs the `X-Razorpay-Signature` header.
- No new runtime dependencies except `helmet` and `express-rate-limit`.
- Work on branch `fix/legacy-hotfix`; never commit to `main`.

## Review Focus

1. Replaying `/api/payment/verify` with the same valid payload twice must return the same order, not two orders. (Task 2 test `verify is idempotent`.)
2. Verify and webhook arriving concurrently for the same payment must produce exactly one order. (Task 3 test `webhook after verify does not duplicate`.)
3. A cart item whose product was deleted must make `create-order` fail with 422, not 500. (Task 2 test `rejects cart with deleted product`.)
4. A non-ObjectId `:id` must return 404, not 500. (Task 4 test `invalid id returns 404`.)
5. A stock race after payment must not lose the order. The order is created with `stockConflict: true`. (Task 2 test `stock conflict still creates order`.)

---

### Task 1: Testable app, hardened middleware, no credential logging

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `backend/app.js`, `backend/test/helpers.js`, `backend/test/app.test.js`
- Modify: `backend/server.js` (bootstrap only), `backend/package.json` (scripts + devDeps)

**Interfaces:**
- Produces: `createApp({ db, razorpay, config }) → express.Application` in `backend/app.js`, where `config = { jwtSecret, corsOrigins: string[], razorpayKeyId, razorpayKeySecret, razorpayWebhookSecret, maintenanceMode: boolean, isProd: boolean }`. Controllers read `req.app.locals.db`, `req.app.locals.razorpay` and `req.app.locals.config`.
- Produces (test helper): `startTestApp(overrides?) → { app, db, mongo, tokenFor(user) , stop() }` using `mongodb-memory-server`.

- [ ] **Step 1: Add dev tooling.** `npm i -D supertest mongodb-memory-server` and `npm i helmet express-rate-limit` in `backend/`. Script `"test": "node --test test/"`.
- [ ] **Step 2: Write failing tests** in `backend/test/app.test.js`:
  ```js
  test('GET / returns 200', ...)                                         // "API is running"
  test('unknown error returns generic message in prod', ...)             // route that throws → 500 {message:'Internal server error'}; body must not contain the thrown text
  test('CORS rejects unknown origin', ...)                               // Origin: https://evil.test → no Access-Control-Allow-Origin header
  test('CORS allows configured origin', ...)                             // header echoes the configured origin
  test('body over 1mb is rejected', ...)                                 // 413
  test('login is rate limited after 10 attempts per minute', ...)        // 11th POST /api/auth/login → 429
  test('maintenance mode blocks writes but allows reads', ...)           // POST /api/cart/add → 503; GET /api/products → 200
  ```
- [ ] **Step 3: Run `npm test`.** Expected: FAIL (`createApp` is not defined).
- [ ] **Step 4: Implement `createApp`** by moving the routes from `server.js` into `app.js`. Add `helmet()`, `cors({ origin: config.corsOrigins })`, `express.json({ limit: '1mb' })`, a rate limit on `/api/auth/login` and `/api/auth/register` (10/min/IP), and a maintenance middleware (`maintenanceMode && method !== 'GET'` → 503 `{message:'Down for maintenance'}`). Add a final error middleware that logs the error and returns `{message: isProd ? 'Internal server error' : err.message}`. Change every controller `catch` to `next(err)`. `server.js`: build config from env (`CORS_ORIGINS` comma-separated, `MAINTENANCE_MODE=true|false`), connect Mongo, `createApp`, listen. **Delete the `console.log` of `MONGO_URI`**, the auth stub and the duplicate Razorpay instance.
- [ ] **Step 5: Run `npm test`.** Expected: PASS (7 tests).
- [ ] **Step 6: Commit** `fix(legacy): extract createApp, harden middleware, stop logging MONGO_URI`.

### Task 2: Server-priced checkout with signature verification

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Modify: `backend/controllers/paymentController.js`, `backend/routes/payment.js`, `backend/routes/order.js`, `backend/controllers/orderController.js`
- Create: `backend/services/checkoutService.js`, `backend/test/checkout.test.js`

**Interfaces:**
- Consumes: `createApp` and `startTestApp` (Task 1).
- Produces:
  - `POST /api/payment/create-order` (auth) body `{ shippingAddress: {name,address,city,state,zip,country,phone} }` → 200 `{ razorpayOrderId, amount /*paise*/, currency:'INR', keyId }`. Errors: 422 `{message:'Cart is empty'}`, 422 `{message:'Some products are no longer available', productIds}`, 409 `{message:'Out of stock', items:[{product, requested, available}]}`.
  - `POST /api/payment/verify` (auth) body `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }` → 201 order document (same shape as today's orders) | 400 `{message:'Invalid payment signature'}`.
  - `completeCheckout(db, { razorpayOrderId, razorpayPaymentId, userId? }) → order` in `checkoutService.js`. It is idempotent and shared with Task 3.
  - `POST /api/orders` now returns **410** `{message:'Use /api/payment/verify'}`.
  - Collection `checkouts`: `{ _id, user, items:[{product, name, qty, pricePaise}], amountPaise, shippingAddress, razorpayOrderId (unique index), status:'created'|'completed', orderId?, createdAt }`.

- [ ] **Step 1: Write failing tests** (`checkout.test.js`, with Razorpay replaced by a fake whose `orders.create` returns `{id:'order_test_1', amount, currency}`):
  ```js
  test('create-order uses DB prices, ignores body amount')  // product price 499.5, qty 2, body {amount:1} → fake called with amount 99900
  test('create-order rejects empty cart')                    // 422
  test('rejects cart with deleted product')                  // 422 with productIds
  test('create-order rejects insufficient stock')            // countInStock 1, qty 2 → 409
  test('verify rejects bad signature')                       // 400, no order created
  test('verify creates paid order from checkout snapshot')   // order.totalPrice === 999, isPaid true, paymentResult.id === payment id, cart emptied, stock decremented by 2
  test('verify is idempotent')                               // second call → same order _id, orders count 1, stock decremented once
  test('verify for another user\'s checkout is 404')
  test('stock conflict still creates order')                 // stock set to 0 between create-order and verify → order created with stockConflict:true
  test('POST /api/orders is gone')                           // 410
  ```
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.** `create-order` loads the cart, then products by `new ObjectId(id)` (invalid or missing → unavailable), computes paise, checks stock, creates the Razorpay order (`receipt` = checkout `_id` as a string), and inserts the checkout. `verify` checks the signature, then calls `completeCheckout`. `completeCheckout`: `findOneAndUpdate({razorpayOrderId, status:'created'}, {$set:{status:'completing'}})`. If no document matched, return the existing order by `checkouts.orderId`, retrying up to 5 × 200 ms while the status is `completing`. Otherwise decrement stock per item with `updateOne({_id, countInStock:{$gte:qty}}, {$inc:{countInStock:-qty}})` and record a conflict on failure; insert the order (prices in rupees for frontend compatibility: `pricePaise/100`); set the checkout to `completed` with `orderId`; clear the cart. Create a unique index on `checkouts.razorpayOrderId` at startup.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** `fix(legacy): server-priced checkout with Razorpay signature verification`.

### Task 3: Razorpay webhook (payment captured when the browser closes)

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `backend/routes/webhook.js`, `backend/test/webhook.test.js`
- Modify: `backend/app.js` (mount `/api/payment/webhook` with `express.raw({type:'application/json'})` **before** `express.json`)

**Interfaces:**
- Consumes: `completeCheckout` (Task 2).
- Produces: `POST /api/payment/webhook` → 200 `{ok:true}` | 400 on a bad signature. Handles `payment.captured` (`payload.payment.entity.order_id`, `.id`). Other events → 200, ignored. Needs env `RAZORPAY_WEBHOOK_SECRET`.

- [ ] **Step 1: Write failing tests:**
  ```js
  test('rejects bad webhook signature')                 // 400
  test('payment.captured completes checkout')           // order exists, isPaid
  test('webhook after verify does not duplicate')       // verify then webhook → 1 order
  test('unknown event type is acknowledged')            // 200
  ```
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(legacy): add Razorpay webhook as source of truth for payment capture`.

### Task 4: Orders and products — ownership, missing route, mass assignment

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Modify: `backend/controllers/orderController.js`, `backend/routes/order.js`, `backend/controllers/productController.js`
- Create: `backend/test/orders.test.js`, `backend/test/products.test.js`

**Interfaces:**
- Produces: `GET /api/orders/:id` → own order, or any order for an admin; otherwise 404. `PUT /api/orders/:id/deliver` (admin) body `{isDelivered: boolean}` → updated order (sets/unsets `deliveredAt`). Product create/update accept only `name, description, price, image, category, countInStock`. Validation: `name` 1..120 chars, `price` a number in 1..100000, `countInStock` an integer 0..100000, `image` an `https://` URL or a `data:image/(jpeg|png|webp);base64,` string ≤ 2 MB.

- [ ] **Step 1: Write failing tests:**
  ```js
  test('owner can read order'), test('other user gets 404'), test('admin can read any order')
  test('invalid id returns 404')
  test('admin marks delivered'), test('non-admin cannot mark delivered')   // 403
  test('create product ignores unknown fields')                            // body {name,...,isAdmin:true,_id:'x'} → stored doc has no isAdmin, server _id
  test('create product rejects negative price')                            // 400
  ```
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (`ObjectId.isValid` guard; `new ObjectId`; `pick()` whitelist + manual validation). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(legacy): order ownership check, deliver route, product field whitelist`.

### Task 5: Frontend adoption, dependency hygiene, deploy and rotate secrets

**Skills:** `safe-backend-changes` (the backend contract it consumes), `vercel-react-best-practices`. **Do not redesign the legacy UI**; `redesign-existing-projects` and the design skills are not used here; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Modify: `frontend/src/pages/CartPage.jsx` (payment handler), `frontend/src/features/admin/AdminDashboard.jsx` (`PUT /orders/:id/deliver`), `frontend/package.json`, root `package.json`
- Delete: `frontend/src/main.js`, `frontend/src/route.jsx`, `frontend/src/features/payment/PaymentPage.jsx` and its `/pay` route in `App.jsx`

**Interfaces:**
- Consumes: the endpoints from Tasks 2 and 4.

- [ ] **Step 1:** `CartPage` sends `{shippingAddress}` to `/payment/create-order`, opens Razorpay with `order_id: data.razorpayOrderId, amount: data.amount, key: data.keyId`, and the handler POSTs the three `razorpay_*` fields to `/payment/verify`. It no longer calls `/orders` or `/cart/clear` (the server clears the cart).
- [ ] **Step 2:** Move `jwt-decode`, `react-select`, `rc-slider`, `react-image-magnify`, `tailwindcss` from the root `package.json` into `frontend/package.json` with the same versions; remove `mongodb` from root. Run `npm install` in `frontend/`, then `npm run build`. Expected: build succeeds.
- [ ] **Step 3:** Manual test against Razorpay **test mode** locally: add to cart → pay with test card `4111 1111 1111 1111` → the order appears in "My orders" and admin "mark delivered" works. Record the result in the PR.
- [ ] **Step 4: Commit** `fix(legacy-frontend): use verified checkout flow; make frontend self-contained`.
- [ ] **Step 5: Owner checklist (manual, not an agent):** (a) rotate the MongoDB Atlas password and update `MONGO_URI` on Render; (b) set a new random 64-byte `JWT_SECRET` on Render (this logs everyone out); (c) create a Razorpay webhook to `https://<render-host>/api/payment/webhook` for `payment.captured`, and set `RAZORPAY_WEBHOOK_SECRET`; (d) set `CORS_ORIGINS` to the Netlify URL; (e) in Atlas, create a unique index on `users.email`; (f) deploy, then place one real ₹1 test order and refund it from the Razorpay dashboard.
