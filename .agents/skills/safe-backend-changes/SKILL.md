---
name: safe-backend-changes
description: Use before ANY change to the handicraft marketplace backend (Node.js/Express API, PostgreSQL schema, migrations, auth, orders, payments, inventory). Guardrails so AI-assisted changes never break existing behaviour or lose data.
---

# Safe Backend Changes

Goal: every backend change is small, tested, reversible and leaves existing features working.

## Before writing code
1. Read the relevant routes, services, models and tests first. State in 2-3 lines what exists and what will change.
2. For anything bigger than one function: use `brainstorming` then `writing-plans`. Get the plan approved before coding.
3. Work on a git branch (`using-git-worktrees` for larger work). Never commit straight to `main`.

## Architecture rules (keep them consistent)
- Layers: `routes` (HTTP only) → `controllers` (validate input, shape response) → `services` (business logic) → `repositories` (SQL only). No SQL in routes/controllers; no `req`/`res` in services.
- Validate every input at the edge (zod/joi). Never trust client prices, totals, discounts or stock counts — recompute on the server.
- One error format for the whole API: `{ error: { code, message } }`, with correct HTTP status. Central error middleware; no swallowed errors.
- Config from environment variables only; never hardcode secrets; never log tokens, passwords, or full payment payloads.
- Do not rename/remove existing endpoints or response fields. Add new versions/fields instead and mark old ones deprecated.

## Database rules
- Every schema change is a new migration file. Never edit a migration that has already run anywhere.
- Migrations must have a working `down`. Run `up → down → up` locally before committing.
- Destructive changes use expand → migrate → contract across separate releases: add new column, backfill, switch code, only later drop the old one. Never `DROP`/`TRUNCATE`/rename a column in the same release that stops using it.
- Money: integer paise (`BIGINT`), never floats. Store currency.
- Inventory and orders: decrement stock inside a transaction with `SELECT … FOR UPDATE` (or a conditional `UPDATE … WHERE stock >= qty`) so two buyers can't purchase the same one-of-a-kind item.
- Add foreign keys, `NOT NULL`, `CHECK` constraints and indexes for every column used in `WHERE`/`JOIN`.
- Never run migrations against production from an AI session.

## Payments & orders
- Order states are an explicit state machine (`pending → paid → packed → shipped → delivered`, plus `cancelled`/`refunded`). Only allowed transitions.
- Payment gateway webhooks: verify signature, make handlers idempotent (store the gateway event id; ignore duplicates). The webhook — not the browser redirect — marks an order paid.
- Seller payouts and commissions are computed from stored order data, never from client input.

## Working method
- `test-driven-development`: write a failing test for the behaviour first, then the minimal code.
- Bugs: `systematic-debugging` — reproduce, find root cause, then fix with a regression test. No guess-and-check edits.
- Keep each change small: one concern per commit.
- Before saying "done": `verification-before-completion` — run the full test suite, lint and type-check, and show the output. If anything fails, it is not done.
- Then `requesting-code-review` on the diff.

## Never, without the user explicitly approving in chat
- Delete files, tables, columns or data; force-push; rewrite git history.
- Change auth, password hashing, session/JWT handling, or payment code paths beyond the agreed plan.
- Upgrade major dependency versions.
- Disable or delete a failing test to make the suite pass.
