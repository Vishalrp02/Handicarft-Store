# End-to-End Verification, Hardening and Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **[OWNER]** marks steps only the project owner can perform.

**Goal:** Prove the whole system works as one product (Playwright journeys across all services), prove it holds under concurrency (k6 stock race and checkout load), close the security gaps (scans, headers, checklist), get Razorpay live, and switch production from the legacy app to v2 with a rehearsed, reversible cutover.

**Architecture:** E2E runs against the full Compose stack (`PAYMENT_PROVIDER=fake`, `EMAIL_PROVIDER=smtp` → Mailpit, MinIO for R2), seeded through **public APIs and CLIs only** (no direct DB writes). Load tests run against staging. The cutover follows a written runbook with explicit go/no-go gates.

**Tech Stack:** Playwright, `@axe-core/playwright`, k6, OWASP ZAP baseline (GitHub Action), Trivy, gitleaks.

**Spec:** `02-target-architecture.md` (all of §7), `01-current-state-audit.md` §5, plan 13 `RUNBOOK.md`.

**Prerequisite:** plans 03–12 complete for Tasks 1–4; plan 14 complete for Tasks 3–6; plan 13 complete for Task 6.

**Required skills:** `e2e-testing-patterns`, `safe-backend-changes` (fixes in services), `web-design-guidelines` (a11y spec); plus the workflow skills `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use **only** the project skills in `.claude/skills/` (mirrored in `.agents/skills/`); no other skills or plugins. See `docs/architecture/05-engineering-standards.md` §8.

## Global Constraints

- The E2E suite must pass three consecutive runs in CI without retries before the cutover (flake budget: zero).
- Seeded data uses the email domain `@e2e.craftoria.test`; Mailpit is read via its REST API (`/api/v1/search?query=to:<email>`).
- Load targets on the **prod-shaped staging run** (staging resized temporarily to 3 OCPU / 18 GB, or prod before go-live): checkout p95 < 800 ms at 10 req/s for 5 min; browse/search p95 < 300 ms at 50 req/s; zero 5xx; zero oversell.
- Security exit criteria: ZAP baseline with no High alerts; Trivy with no unfixed-but-fixable CRITICAL/HIGH in our images; every item in `docs/security/asvs-l1-checklist.md` marked Pass or N/A with evidence.

## Review Focus

1. **Oversell under real network conditions:** 100 concurrent buyers checking out the last unit through the gateway → exactly 1 order reaches `paid`, the others get `409 OUT_OF_STOCK`, and the final `on_hand = 0`, `reserved = 0`. (Task 3.)
2. Payment timeout end-to-end: an abandoned checkout releases stock after expiry, and another buyer can then buy it. (Task 2, `payment-timeout.spec.ts`, with `PAYMENT_TTL_SECONDS=60` in the E2E env.)
3. The late-payment path end-to-end: pay after expiry → a refund row with `late_payment` → the buyer's refund email in Mailpit. (Task 2.)
4. The webhook path when the browser closes: capture via the fake webhook only (no verify call) → the order still becomes paid. (Task 1, `buyer-journey.spec.ts` variant.)
5. The cutover rollback window: if the go/no-go fails, DNS points back to legacy within 5 minutes and no v2 writes were accepted. (Task 6 rehearsal.)

---

### Task 1: E2E harness, seed, buyer journey

**Skills:** `e2e-testing-patterns` (first), `safe-backend-changes` (any service fix), `systematic-debugging`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `e2e/{package.json,playwright.config.ts,docker-compose.e2e.yml,global-setup.ts}`, `e2e/support/{api.ts,mailpit.ts,seed.ts}`, `e2e/specs/buyer-journey.spec.ts`, `.github/workflows/e2e.yml`

**Interfaces:**
- Produces:
  - `docker-compose.e2e.yml`: the dev stack plus a `console` container (`vite build` + `vite preview` on port 5173, `VITE_API_BASE_URL=http://localhost:8080`), with `PAYMENT_PROVIDER=fake`, `PUBLIC_PAYMENT_MODE=fake`, `PAYMENT_TTL_SECONDS=60`, `RESERVATION_GRACE_SECONDS=30`, sweep intervals of 5 s.
  - `mailpit.ts`: `waitForEmail(to: string, subjectIncludes: string, timeoutMs = 15000): Promise<{ subject: string; html: string; text: string }>`, `extractLink(email, pathPrefix: string): string`.
  - `seed.ts`: `seedWorld(): Promise<World>`. It registers an admin (verifying via Mailpit; admin role via `docker compose exec identity node dist/cli/seed-admin.js --email …`), creates categories, registers an artisan who applies and is approved by the admin, creates 6 products (with a fixture image upload through the presigned flow) and submits them, the admin approves them, and stock is set (one product with `onHand=1`). It returns credentials and ids.
  - `buyer-journey.spec.ts`: register → verify email (Mailpit link) → search → product page → add to bag (as a guest first, then log in to test the merge) → checkout with a new address (pincode autofill mocked via `page.route`) → fake pay success → the confirmation shows "Confirmed" → the order-confirmation email arrives → the artisan accepts, ships (tracking) and delivers in the console → the buyer sees "Delivered" and receives the shipped and delivered emails → the buyer writes a review → the review appears on the product page with "Verified purchase". Variant: `webhook-only capture` (call fake complete, skip verify; poll until paid).
  - `e2e.yml`: on PRs labelled `e2e` and nightly on `main`: `docker compose up --build --wait` → `pnpm e2e` → upload the trace and report on failure.

- [ ] **Step 1:** Write the harness and the failing journey spec. **Step 2:** Run `pnpm e2e` and fix integration defects in the owning service (each fix gets its own regression test in that service, committed separately). **Step 3:** Three consecutive green runs locally. Paste the summary.
- [ ] **Step 4: Commit** `test(e2e): harness, seed and buyer journey`.

### Task 2: Remaining journeys

**Skills:** `e2e-testing-patterns` (first), `web-design-guidelines` (a11y spec), `safe-backend-changes` (any service fix); workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `e2e/specs/{seller-onboarding.spec.ts,multi-seller-cancel-refund.spec.ts,payment-timeout.spec.ts,late-payment.spec.ts,admin-payouts.spec.ts,account-security.spec.ts,a11y.spec.ts}`

**Interfaces:**
- Consumes: `seedWorld`, `mailpit`.
- Produces specs:
  - **seller-onboarding**: a buyer applies → the admin-alert email arrives → the admin approves → the applicant's console shows the seller area after a refresh → creates a product → it's pending review → the admin rejects with a reason → the seller edits and resubmits → it's approved → visible on the storefront.
  - **multi-seller-cancel-refund**: a cart with items from two artisans → pay → artisan A ships, and the buyer cancels B's part → refund row for B's subtotal only (no shipping) → the fake `refund.processed` webhook → the buyer gets the refund email → A's ledger has a sale, B's ledger has a sale and its reversal.
  - **payment-timeout**: checkout the `onHand=1` product without paying → a second buyer gets `OUT_OF_STOCK` → wait for expiry (≤ 90 s) → the second buyer checks out successfully.
  - **late-payment**: checkout → wait for expiry → fake complete → the order stays cancelled, a refund `late_payment` is requested, and the email arrives.
  - **admin-payouts**: a delivered order + fast-forward maturity (the E2E env sets `RETURN_WINDOW_DAYS=0` and `LEDGER_MATURITY_INTERVAL_MS=5000`) → the admin runs payouts → downloads the CSV (asserts the columns) → marks paid with a UTR → the seller sees "Paid" and the payout email.
  - **account-security**: login throttle (6th attempt shows the wait message), forgot/reset password via Mailpit, the old session is logged out, delete account → can't log in.
  - **a11y**: axe on the key storefront and console pages (0 serious or critical).

- [ ] **Step 1:** Write the specs. **Step 2:** Run, fix defects in the owning services with regression tests. **Step 3:** Three consecutive green full-suite runs.
- [ ] **Step 4: Commit** `test(e2e): seller, refund, timeout, late payment, payouts, security, a11y journeys`.

### Task 3: Load and race tests

**Skills:** `e2e-testing-patterns`, `safe-backend-changes`, `systematic-debugging`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `e2e/load/{oversell-race.js,checkout-load.js,browse-load.js,README.md}`, `e2e/load/seed-load.ts`

**Interfaces:**
- Produces: `seed-load.ts` creates 120 verified buyers (through the API and Mailpit, or on staging by `identity` CLI `seed:test-users --count 120 --domain e2e.craftoria.test`, a small CLI **added to identity in this task, gated to `NODE_ENV!=='production'`**) and 2,000 products for browse. `oversell-race.js` (k6 `shared-iterations`, 100 VUs, 1 iteration each): each VU logs in, puts the single-unit product in its cart, and checks out at the same moment (start barrier via a `setup()` timestamp). Thresholds: `checks{name:"one winner"}` — exactly one 201. A post-run script asserts `on_hand=1, reserved=1` until the one winner pays, then 0/0. `checkout-load.js` and `browse-load.js` use the Global Constraints thresholds.

- [ ] **Step 1:** Write the scripts. **Step 2 [OWNER]:** temporarily resize staging (or use prod before go-live) and run them. Paste the k6 summaries. Any threshold failure → investigate with `systematic-debugging`, fix in the owning service with a regression test, rerun.
- [ ] **Step 3: Commit** `test(load): oversell race and load profiles`.

### Task 4: Security hardening

**Skills:** `safe-backend-changes` (first), `auth-implementation-patterns`, `api-design-principles`, `web-design-guidelines` (security headers on UI); workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `docs/security/{asvs-l1-checklist.md,threat-model.md}`, `.github/workflows/security.yml`
- Modify: `.github/workflows/images.yml` (Trivy step)

**Interfaces:**
- Produces: `security.yml`, weekly and manual: ZAP baseline (`zaproxy/action-baseline`) against `https://staging.craftoria.in` and `https://api.staging.craftoria.in/v1/products`, using a Cloudflare Access service token passed as headers. The images workflow scans each image with Trivy (`severity: CRITICAL,HIGH`, `ignore-unfixed: true`, `exit-code: 1`). `threat-model.md`: STRIDE over the checkout, auth, seller payout and admin flows, each threat mapped to its mitigation and test (e.g. "Tampering — client price → server pricing — order Task 4 test `creates pending order with server prices`"). `asvs-l1-checklist.md`: each ASVS L1 requirement with Pass / N/A / Gap and evidence links (file, test, header capture).

- [ ] **Step 1:** Write the workflows and documents. **Step 2:** Run ZAP and Trivy; fix every High finding (each fix with a test in the owning package). **Step 3:** Verify the security headers with `curl -I` on storefront, console and API; paste the output into the checklist.
- [ ] **Step 4: Commit** `chore(security): zap and trivy scans, threat model, asvs checklist`.

### Task 5: Razorpay live mode and launch readiness [OWNER-heavy]

**Skills:** `safe-backend-changes` (payment configuration rules); workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `docs/launch/go-live-checklist.md`

**Interfaces:**
- Produces a checklist with a checkbox, an owner and evidence for each item:
  - Razorpay: KYC complete; website and policy pages reviewed by Razorpay (they check `/terms`, `/privacy`, `/returns`, `/shipping`, `/contact`); **auto-capture on**; live keys in `prod.enc.env`; a webhook to `https://api.craftoria.in/v1/webhooks/razorpay` for `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed` with its secret in env; a ₹1 live test product: buy → paid → refund → `refund.processed` received.
  - The legacy Razorpay webhook is disabled at cutover (plan 01 created it).
  - Email: the Resend domain is verified (SPF/DKIM/DMARC pass on mail-tester.com ≥ 9/10); `EMAIL_FROM` is correct.
  - Compliance: a CA has reviewed GST/TCS obligations (see `02-target-architecture.md` §8); a grievance officer is named on `/contact` (Consumer Protection (E-Commerce) Rules 2020); privacy policy DPDP alignment reviewed.
  - Ops: an admin account seeded in prod; the first artisan(s) onboarded; backups have run ≥ 3 nights with a restore test passing; alerts tested; UptimeRobot green for 72 h on staging.

- [ ] **Step 1 (agent):** Write the checklist with the exact steps and links. **Step 2 [OWNER]:** Complete it. Every item checked, with evidence.
- [ ] **Step 3: Commit** `docs(launch): go-live checklist`.

### Task 6: Cutover runbook, rehearsal, go-live, decommission

**Skills:** `safe-backend-changes` (first: deletions need explicit owner approval), `database-migration`, `finishing-a-development-branch`; workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `docs/launch/cutover-runbook.md`
- (The legacy code was already removed from the repo on 2026-10-07. If the legacy site was never live, Task 6 reduces to: final MongoDB export archived (only if plan 13 ran), delete the old Render/Netlify services and the Atlas cluster, then launch on the v2 domain.)

**Interfaces:**
- Produces `cutover-runbook.md` with timed steps (T-7d … T+30d):
  - **T-7d:** announce the maintenance window (banner on legacy); run the full rehearsal on staging with a fresh `mongodump`: `MAINTENANCE_MODE=true` on a legacy copy → migrator dry-run → execute → reconcile → E2E smoke on the migrated data → record the timings.
  - **T-0 (window, about 60–90 min):** (1) set `MAINTENANCE_MODE=true` on the legacy Render service (writes 503); (2) final `mongodump` (archived encrypted to R2 `backups/legacy/`); (3) migrator `--execute` → `reconcile` (must exit 0); (4) deploy the release tag to prod (already deployed, idle); (5) **go/no-go gate** (owner): smoke script green; log in as 3 migrated users; one live ₹1 purchase + refund; product images load from `media.craftoria.in`; (6) GO → switch DNS (`craftoria.in`, `www`) to the tunnel; put a 301 from the legacy Netlify domain to `https://craftoria.in`; disable the legacy Razorpay webhook. NO-GO → leave DNS on legacy, set `MAINTENANCE_MODE=false`, write the incident note (no v2 writes were accepted, so nothing is lost).
  - **T+1h … T+72h:** watch the dashboards; the first-login bcrypt→argon2 rehash rate; the error budget; a daily reconcile of new orders vs. payments.
  - **T+30d decommission gate:** no traffic to the legacy hosts for 14 days → delete the Render and Netlify services → keep the final Mongo dump in R2 for 1 year (then delete) → remove `backend/` and `frontend/` from the repo in a PR titled `chore: remove legacy app` → delete the MongoDB Atlas cluster.

- [ ] **Step 1 (agent):** Write the runbook. **Step 2 [OWNER + agent]:** Run the T-7d rehearsal; record the timings and fixes in the runbook. **Step 3 [OWNER]:** Execute the cutover. **Step 4 [OWNER]:** At T+30d, approve the decommission PR (the agent prepares it; deletion needs explicit owner approval per `safe-backend-changes`).
- [ ] **Step 5: Commit** `docs(launch): cutover runbook` (and later `chore: remove legacy app`).
