# 01 — Current State Audit (legacy Craftoria, as of 2026-10-07)

Audited commit: `424d495` on `main`. Scope: `backend/` (Express 5 + MongoDB driver) and `frontend/` (React 19 + Vite + Tailwind 3).

## 1. What the system does today

A single-store handicraft shop. One admin manages products; buyers browse, wishlist, add to cart, pay with Razorpay, see their orders, and review products they bought.

| Area | Endpoints (prefix `/api`) | Notes |
|---|---|---|
| Auth | `POST /auth/register`, `POST /auth/login` | bcryptjs hash, JWT (HS256, 1 day) carrying `id, isAdmin, name, email` |
| Wishlist | `GET/POST/DELETE /auth/wishlist` | Array of product-id strings embedded in the user document |
| Products | `GET /products`, `GET /products/:id`, `POST/PUT/DELETE /products[/:id]` (admin), `POST /products/:id/reviews` | Reviews embedded in product; purchase check against `orders` |
| Cart | `GET /cart`, `POST /cart/add`, `/remove`, `/clear` | One cart doc per user; **client supplies the price** |
| Payment | `POST /payment/create-order` | Creates a Razorpay order for a **client-supplied amount** |
| Orders | `POST /orders`, `GET /orders/myorders`, `GET /orders` (admin), `GET /orders/:id` | Order created **by the browser** after Razorpay's JS handler fires |

Frontend routes: `/`, `/auth`, `/product/:id`, `/cart` (also the checkout + address form + Razorpay), `/wishlist`, `/orders`, `/admin`, `/admin/products`, `/pay` (a test page).
External calls from the browser: `api.postalpincode.in` (pincode lookup), `/india-state-districts.json` (static file), Razorpay Checkout script.
Hosting: backend on Render (`MONGO_URI` from Render env), frontend on Netlify (`public/_redirects`).

## 2. Critical defects (exploitable now)

| # | Defect | Where | Impact |
|---|---|---|---|
| C1 | `POST /orders` trusts `isPaid`, `paymentId`, `totalPrice`, item `price` from the client. No Razorpay signature verification, no webhook. | `orderController.createOrder` | Any logged-in user can create a **paid order without paying**, at any price. |
| C2 | `POST /payment/create-order` charges `req.body.amount`. | `paymentController.createOrder` | User can pay ₹1 for any cart. `amount * 100` on a float can also produce non-integer paise. |
| C3 | `server.js` logs `MONGO_URI` in full on every boot. | `server.js:22` | DB credentials are in the Render log history. **Rotate the Mongo password.** |
| C4 | `GET /orders/:id` has no ownership check (IDOR). It is currently masked by bug B1. | `orderController.getOrderById` | Once B1 is fixed, any user can read any order (name, address, phone). |
| C5 | `POST/PUT /products` writes `req.body` straight into Mongo (mass assignment). | `productController` | Admin-only, but a stolen admin token can write arbitrary fields. Images are stored as base64 data URLs inside documents. |
| C6 | `err.message` is returned to clients on every 500. | all controllers | Leaks internals (driver errors, stack hints). |
| C7 | `cors()` with no origin allowlist, no rate limiting, no helmet, no body-size limit. | `server.js` | Brute-force on `/auth/login`, oversized payloads. |
| C8 | JWT kept in `localStorage`; `isAdmin` is read from a decoded token on the client to show admin UI. | `AuthContext.jsx`, `Login.jsx` | Any XSS steals sessions; there is no refresh or revocation. |

## 3. Functional bugs

| # | Bug | Where |
|---|---|---|
| B1 | `ObjectId(req.params.id)` without `new` throws in driver v6, so `GET /orders/:id` always returns 500. | `orderController.getOrderById` |
| B2 | Admin dashboard calls `PUT /orders/:id`, which does not exist. "Mark delivered" never works. | `AdminDashboard.jsx:37` |
| B3 | Stock (`countInStock`) is never decremented. Two buyers can buy the same one-of-a-kind piece. | whole order flow |
| B4 | If the browser closes after payment but before `POST /orders`, money is captured and no order exists. | `CartPage.jsx` handler |
| B5 | Mongoose models in `models/Order.js` and `models/Product.js` are dead code (overwritten `module.exports`); `mongoose` is an unused dependency. | `models/` |
| B6 | Cart badge counts line items, not quantity; the cart/wishlist pages download **all products** to render a few. | `AuthContext`, `CartPage`, `WishlistPage` |
| B7 | `src/main.js` and `src/route.jsx` are unused duplicates; `/pay` is a leftover test page. | `frontend/src` |
| B8 | The frontend depends on packages declared only in the **root** `package.json` (`jwt-decode`, `react-select`, `rc-slider`, `react-image-magnify`, `tailwindcss`). The root also declares `mongodb`. | `package.json` |
| B9 | Money is a float of rupees everywhere. | all |
| B10 | No tests, no validation library, no lint for the backend, no CI, no migrations or indexes (e.g. no unique index on `users.email`, so a race creates duplicate accounts). | all |

## 4. What is worth keeping

- Domain understanding: verified-purchase reviews, wishlist, Indian address/pincode handling (`addressData.js`, `india-state-districts.json`, the pincode API idea).
- Razorpay as the gateway (it is right for India; only the integration is wrong).
- The project rules in `CLAUDE.md` and the skills (`safe-backend-changes`, `handcrafted-storefront-ui`), which already describe the target standards: integer paise, transactional stock, webhook-driven payment, a state machine for orders, and buyer/artisan/admin roles.

Nothing in the backend code is reusable as-is. It is a rewrite. Only the **data** (users, products, orders, reviews) must be carried over; see plan 13.

## 5. Immediate actions, independent of the rewrite

If the legacy site is live and taking real payments, run **plan 01 (legacy hotfix)** now. C1–C3 are actively exploitable. If it is a demo with no real customers, skip plan 01, rotate the Mongo password anyway (C3), and go straight to the rewrite.
