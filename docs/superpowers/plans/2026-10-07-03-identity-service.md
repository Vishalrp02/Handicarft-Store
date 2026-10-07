# Identity Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `services/identity`: registration, login, rotating refresh sessions, EdDSA access tokens with JWKS, email verification, password reset, profile, address book, account deletion, admin user management, and the `artisan` role grant on seller approval.

**Architecture:** A standard service from the template (plan 02 Task 10). Keys are stored encrypted in Postgres. Login throttling lives in Valkey. Every state change that other services care about is published through the outbox.

**Tech Stack:** service-kit, Kysely, `jose`, `argon2`, `bcryptjs` (legacy hash verification only), `iovalkey`, `cookie-parser`.

**Spec:** `02-target-architecture.md` §6; `03-api-and-event-contracts.md` §2 and events `user.*`, `seller.approved`; `04-data-model.md` §1.

**Prerequisite:** plan 02 complete.

**Required skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`, `auth-implementation-patterns`; plus the workflow skills `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use **only** the project skills in `.claude/skills/` (mirrored in `.agents/skills/`); no other skills or plugins. See `docs/architecture/05-engineering-standards.md` §8.

## Global Constraints

- Port 4001, database `craftoria_identity`, role `svc_identity`.
- Access token TTL 900 s; refresh TTL 30 days; cookie name `cr_rt`, `HttpOnly; Secure (COOKIE_SECURE); SameSite=Lax; Path=/v1/auth; Domain=COOKIE_DOMAIN`.
- argon2id parameters: `memoryCost: 19456, timeCost: 2, parallelism: 1`.
- Email verification tokens live 24 h; reset tokens 30 min; both single-use; only their SHA-256 is stored.
- Throttle: 5 failures per (email, IP) per 15 min → `429 TOO_MANY_ATTEMPTS` with `Retry-After`.
- Config added to `BaseConfigSchema`: `DATABASE_URL, RABBITMQ_URL, VALKEY_URL, JWT_KEY_ENCRYPTION_KEY (base64, 32 bytes), COOKIE_DOMAIN, COOKIE_SECURE (bool, default true), STOREFRONT_URL, ACCESS_TOKEN_TTL_SECONDS=900, REFRESH_TOKEN_TTL_DAYS=30`. Identity verifies its own tokens with `createLocalJwtVerifier` over its own JWKS, not over HTTP.

## Review Focus

1. Login with an unknown email must take about as long as with a wrong password (dummy argon2 verify). (Task 3 test `unknown email still runs a hash verify`.)
2. Two concurrent refreshes with the same token: exactly one succeeds, and the other triggers reuse detection, which revokes the family. (Task 4 test `concurrent refresh revokes family`.)
3. Emails differing only in case must not create two accounts. (Task 1 constraint test + Task 3 test `register is case-insensitive`.)
4. A password reset must invalidate all existing refresh tokens. (Task 5 test.)
5. A disabled user with a still-valid access token can't refresh. (Task 4 test `disabled user cannot refresh`.)

---

### Task 1: Scaffold and schema

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`, `auth-implementation-patterns`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `services/identity/**` via `pnpm new:service identity 4001`; `src/db/migrations/0002_identity_core.ts`; `test/integration/schema.int.test.ts`
- Modify: `infra/compose/docker-compose.yml` (add `identity` + `identity-migrate`), `infra/env/.env.example`

**Interfaces:**
- Produces: tables `users, user_roles, refresh_tokens, email_tokens, addresses, signing_keys` exactly as `04-data-model.md` §1 (with `CREATE EXTENSION IF NOT EXISTS citext`), and `updated_at` triggers. Regenerated `src/db/schema.ts`.

- [ ] **Step 1: Write failing tests:** `migrations round-trip` (latest → down to 0 → latest), `email unique ignores case` (insert `A@x.in` then `a@x.in` → unique violation), `only one default address per user`, `invalid role rejected by check`.
- [ ] **Step 2:** `pnpm --filter @craftoria/identity test:int` → FAIL. **Step 3:** Write the migration and run `db:types`. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(identity): scaffold service and core schema`.

### Task 2: Password hashing, opaque tokens, signing keys, JWKS, access tokens

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`, `auth-implementation-patterns`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/crypto/password.ts`, `src/modules/crypto/opaque-token.ts`, `src/modules/keys/{keys.repository.ts,key-store.ts,keys.routes.ts}`, `src/modules/tokens/access-token.ts`, `src/cli/keys-rotate.ts`, tests

**Interfaces:**
- Produces:
  - `hashPassword(plain: string): Promise<string>`; `verifyPassword(hash: string, plain: string): Promise<{ ok: boolean; needsRehash: boolean }>`. `$2a$`/`$2b$` hashes are verified with bcryptjs and always `needsRehash: true`. `DUMMY_HASH` is a precomputed argon2id hash used for unknown users.
  - `generateOpaqueToken(): { raw: string /* base64url, 32 bytes */; hash: Buffer /* sha256 */ }`; `hashOpaqueToken(raw: string): Buffer`.
  - `createKeyStore({ db, encryptionKey, clock }): KeyStore` with `{ ensureActiveKey(): Promise<void>; getSigningKey(): Promise<{ kid: string; key: KeyLike }>; getJwks(): Promise<JSONWebKeySet>; rotate(): Promise<string /* new kid */> }`. Keys are Ed25519 (`jose.generateKeyPair('EdDSA', {crv:'Ed25519', extractable:true})`), private JWK encrypted with `encryptAesGcm`. The JWKS includes active keys plus keys retired in the last 24 h. Cached in memory for 60 s.
  - `issueAccessToken(keyStore, claims: Omit<AccessTokenClaims,'iat'|'exp'|'iss'|'aud'>, ttlSeconds): Promise<{ token: string; expiresAt: Date }>` (header `{alg:'EdDSA', kid}`).
  - `GET /.well-known/jwks.json` → `Cache-Control: public, max-age=600`.
  - CLI `pnpm --filter @craftoria/identity keys:rotate`.
  - `main.ts` calls `keyStore.ensureActiveKey()` at boot.

- [ ] **Step 1: Write failing tests:**
  ```ts
  it('argon2 hash verifies and does not need rehash', ...)
  it('legacy bcrypt hash verifies and needs rehash', ...)          // bcryptjs.hashSync('secret123', 10)
  it('wrong password fails for both formats', ...)
  it('issued token verifies against served JWKS', ...)             // GET jwks → createLocalJwtVerifier → AuthContext matches claims
  it('rotation keeps old key in JWKS so old tokens still verify', ...)
  it('private key is not stored in plaintext', ...)                // signing_keys.private_jwk_encrypted does not contain '"d":'
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(identity): password hashing, signing keys, JWKS, access tokens`.

### Task 3: Register and login

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`, `auth-implementation-patterns`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/auth/{auth.routes.ts,auth.controller.ts,auth.service.ts}`, `src/modules/users/{users.repository.ts,users.mapper.ts}`, `src/modules/sessions/{sessions.repository.ts,sessions.service.ts,cookie.ts}`, `src/modules/auth/login-throttle.ts`, `test/integration/auth.int.test.ts`

**Interfaces:**
- Consumes: Task 2; contracts `RegisterBodySchema`, `LoginBodySchema`, `AuthResultSchema`, `PublicUserSchema`.
- Produces:
  - `POST /v1/auth/register` and `POST /v1/auth/login` per contracts §2.
  - `SessionsService.create(userId, meta: { userAgent?: string; ip?: string }): Promise<{ refreshRaw: string; familyId: string; expiresAt: Date }>`.
  - `setRefreshCookie(res, raw, expiresAt, config)`, `clearRefreshCookie(res, config)`.
  - `LoginThrottle { assertAllowed(email, ip): Promise<void>; recordFailure(email, ip): Promise<void>; reset(email, ip): Promise<void> }` (Valkey key `login_fail:<sha256(email)>:<ip>`, INCR + EXPIRE 900).
  - `UsersRepository.findByEmail`, `.findById`, `.insertWithRole`, `.getRoles`, `.updatePasswordHash`, `.touchLogin`. `toPublicUser(row, roles): PublicUser`.
  - Register publishes `user.registered.v1` and `user.email_verification_requested.v1` (`verifyUrl = ${STOREFRONT_URL}/verify-email?token=<raw>`) in the same transaction as the insert.

- [ ] **Step 1: Write failing tests:**
  ```ts
  it('register returns 201 AuthResult and sets cr_rt cookie', ...)   // cookie flags HttpOnly, SameSite=Lax, Path=/v1/auth
  it('register is case-insensitive', ...)                            // 'Asha@Example.in' then 'asha@example.in' → 409 EMAIL_TAKEN
  it('register writes two outbox events with valid payloads', ...)   // parse with EventRegistry schemas
  it('register rejects 9-char password', ...)                        // 400
  it('login succeeds and token has roles [buyer]', ...)
  it('login wrong password → 401 INVALID_CREDENTIALS', ...)
  it('unknown email still runs a hash verify', ...)                   // spy verifyPassword called with DUMMY_HASH
  it('sixth failed attempt → 429 with Retry-After', ...)
  it('legacy bcrypt user is rehashed to argon2 on login', ...)
  it('disabled user → 403 ACCOUNT_DISABLED', ...)
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(identity): register and login with throttling and refresh cookie`.

### Task 4: Refresh rotation, reuse detection, logout

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`, `auth-implementation-patterns`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Modify: `src/modules/sessions/sessions.service.ts`, `src/modules/auth/auth.routes.ts`
- Create: `test/integration/sessions.int.test.ts`

**Interfaces:**
- Produces:
  - `SessionsService.rotate(raw: string, meta): Promise<{ userId: string; familyId: string; refreshRaw: string; expiresAt: Date }>`. Inside a transaction, `SELECT … FOR UPDATE` by hash. Not found or expired → `UnauthenticatedError('REFRESH_TOKEN_INVALID')`. Already revoked → revoke the whole family, then throw the same error. Otherwise revoke the old token, insert a new one (same family) and set `replaced_by`.
  - `SessionsService.revokeFamily(familyId)`, `.revokeAllForUser(userId, exceptFamilyId?)`.
  - `POST /v1/auth/refresh` and `POST /v1/auth/logout` (both require `X-Requested-With: craftoria`, else 403 `FORBIDDEN`).

- [ ] **Step 1: Write failing tests:**
  ```ts
  it('refresh returns new access token and rotates cookie', ...)
  it('old refresh token is rejected after rotation and family is revoked', ...)  // reuse → 401; the newest token also stops working
  it('concurrent refresh revokes family', ...)                                    // Promise.all two refreshes → one 200, one 401; then the 200 token also fails
  it('refresh without X-Requested-With → 403', ...)
  it('expired refresh token → 401', ...)                                          // fake clock + 31 days
  it('disabled user cannot refresh', ...)
  it('logout revokes family and clears cookie', ...)
  it('refreshed token reflects new roles', ...)                                   // insert artisan role, refresh → roles include artisan
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(identity): refresh token rotation with reuse detection, logout`.

### Task 5: Email verification and password reset

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`, `auth-implementation-patterns`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/email-tokens/{email-tokens.repository.ts,email-tokens.service.ts}`, `test/integration/email-flows.int.test.ts`
- Modify: `src/modules/auth/*`

**Interfaces:**
- Produces: `POST /v1/auth/verify-email`, `/resend-verification` (max 3/hour per user via Valkey), `/forgot-password` (always 202; publishes `user.password_reset_requested.v1` only if an active user exists; `resetUrl = ${STOREFRONT_URL}/reset-password?token=<raw>`), `/reset-password` (sets argon2 hash, marks the token used, `revokeAllForUser`). `EmailTokensService.issue(trx, userId, purpose): Promise<string /* raw */>`, `.consume(raw, purpose): Promise<string /* userId */>` (invalid, expired or used → 400 `VALIDATION_FAILED` with message "This link is invalid or has expired").

- [ ] **Step 1: Write failing tests:**
  ```ts
  it('verify-email sets email_verified_at', ...)
  it('verification token cannot be used twice', ...)
  it('expired verification token rejected', ...)
  it('forgot-password returns 202 for unknown email and writes no event', ...)
  it('forgot-password writes reset event with URL for known email', ...)
  it('reset-password changes password and revokes all refresh tokens', ...)
  it('resend-verification limited to 3 per hour', ...)   // 4th → 429
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(identity): email verification and password reset`.

### Task 6: Profile, change password, delete account

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`, `auth-implementation-patterns`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/me/{me.routes.ts,me.controller.ts,me.service.ts}`, `test/integration/me.int.test.ts`

**Interfaces:**
- Produces: `GET/PATCH /v1/me`, `POST /v1/me/change-password` (verifies current; revokes all **other** families), `DELETE /v1/me` (verifies password, then in one transaction: email → `deleted+<id>@invalid.craftoria`, name → `Deleted user`, phone → null, password_hash → `!`, status → `deleted`; delete addresses and email tokens; revoke all sessions; publish `user.deleted.v1`). Then a `204` and the cookie is cleared.

- [ ] **Step 1: Write failing tests:**
  ```ts
  it('GET /v1/me returns PublicUser', ...)
  it('PATCH /v1/me rejects invalid phone', ...)
  it('change-password with wrong current → 401 INVALID_CREDENTIALS', ...)
  it('change-password keeps current session, revokes others', ...)
  it('delete account anonymises and emits user.deleted', ...)
  it('deleted user cannot log in', ...)                       // 401 INVALID_CREDENTIALS
  it('deleted email can register again', ...)
  ```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(identity): profile, change password, account deletion`.

### Task 7: Address book

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`, `auth-implementation-patterns`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/addresses/{addresses.routes.ts,addresses.controller.ts,addresses.service.ts,addresses.repository.ts,addresses.mapper.ts}`, `test/integration/addresses.int.test.ts`

**Interfaces:**
- Produces: `GET/POST /v1/me/addresses`, `PATCH/DELETE /v1/me/addresses/:id` per contracts §2. Max 10 per user (11th → 422 `BUSINESS_RULE_VIOLATED` `details.rule='max_addresses'`). Setting `isDefault: true` unsets the previous default in the same transaction. The first address is always the default. Deleting the default promotes the most recently created remaining address.

- [ ] **Step 1: Write failing tests:** `create first address becomes default`, `setting default unsets previous`, `cannot read another user's address (404)`, `11th address rejected`, `deleting default promotes newest`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(identity): address book`.

### Task 8: Admin user management and bootstrap CLI

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`, `auth-implementation-patterns`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/modules/admin-users/{admin-users.routes.ts,admin-users.controller.ts,admin-users.service.ts}`, `src/cli/seed-admin.ts`, `test/integration/admin-users.int.test.ts`

**Interfaces:**
- Produces: `GET /v1/admin/users` (`q` matches email/name `ILIKE`, `role`, `status`, cursor), `PATCH /v1/admin/users/:id` (disable → `revokeAllForUser`; an admin cannot disable themself → 422), `POST /v1/admin/users/:id/roles` (`admin` only). CLI `pnpm --filter @craftoria/identity seed:admin --email <email>` grants `admin` to an existing user and prints a confirmation (used once in each environment).

- [ ] **Step 1: Write failing tests:** `buyer gets 403`, `admin lists users with cursor`, `filter by role artisan`, `disable revokes sessions`, `admin cannot disable self`, `grant admin role`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(identity): admin user management and seed-admin CLI`.

### Task 9: Consume seller.approved

**Skills:** `safe-backend-changes` (first), `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`, `auth-implementation-patterns`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `src/events/handlers/seller-approved.handler.ts`, `test/integration/events.int.test.ts`
- Modify: `src/events/consumers.ts`

**Interfaces:**
- Consumes: `seller.approved.v1` fixture.
- Produces: the handler inserts role `artisan` (`ON CONFLICT DO NOTHING`) and sets `users.seller_id`. Unknown `userId` → log a warning and ack (the user was deleted).

- [ ] **Step 1: Write failing tests:** `seller.approved grants artisan and sets seller_id` (feed the fixture through `startConsumer` with a test broker), `duplicate delivery is a no-op`, `unknown user is acked without error`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(identity): grant artisan role on seller.approved`.
