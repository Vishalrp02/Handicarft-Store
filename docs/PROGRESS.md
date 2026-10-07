# Craftoria v2: progress and working agreement

**Read this first in every new session.** Then `CLAUDE.md`, then `docs/architecture/05-engineering-standards.md`.
Last updated: 2026-10-08.

## Where we are

| Plan | Status |
|---|---|
| 01 Legacy hotfix | **Closed.** Tasks 1–3 done, then the legacy app was deleted (nothing was live) |
| 02 Platform foundation | **Tasks 1–6 done.** Next: **Task 7** (service-kit database: Kysely, migrations, platform tables, test DB). Needs Docker, so it runs on the dev VM |
| 03–05, 07–12, 14–15 | Not started |
| 06 Cart service | **Owner-built by hand.** Agents never write code in `services/cart/` |
| 13 Data migration | **Skipped** (old data deleted, decision D-6) |

Overview page with every task: https://claude.ai/artifact/5Fqrcj35oyDhLXbjQBsvPJ (owner's account).

### Done so far

| Task | Branch | What |
|---|---|---|
| 02-1 | (initial commit on `main`) | pnpm + turbo monorepo, `@craftoria/tsconfig`, `@craftoria/eslint-config` |
| 02-2 | `feat/02-02-contracts-primitives` | contracts: money (paise, `formatINR`), 22 error codes, Indian address, pagination |
| 02-3 | `feat/02-03-contracts-http` | contracts: HTTP DTOs and internal APIs for every service |
| 02-4 | `feat/02-04-contracts-events` | contracts: event envelope, 24 events, registry, fixtures |
| 02-5 | `feat/02-05-service-kit-core` | service-kit: config, logger, errors, HTTP app, `route()`, OpenAPI, clock |
| 02-6 | `feat/02-06-service-kit-auth` | service-kit: JWT verifier, auth middleware, `@craftoria/service-kit/testing` |

Branches are **stacked**: each one starts from the previous one, so the newest branch contains everything. Nothing is merged to `main` yet (decision pending, see below).

## Decisions made by the owner

| ID | Decision |
|---|---|
| Business model | Multi-vendor marketplace |
| Stack | Node 24 + TypeScript + Express, PostgreSQL, RabbitMQ, React + **Tailwind CSS v4 only** |
| Hosting | Docker Compose; Oracle Cloud Always Free + Cloudflare, about ₹0 |
| D-1 | Public repo: github.com/Vishalrp02/Handicarft-Store |
| D-3 | Default business rules: ₹99 shipping, free above ₹999, 10 % commission, ₹500 min payout, 7-day returns |
| D-4 | Legacy app was not live; deleted |
| D-6 | No legacy data migration (plan 13 skipped) |
| D-7 | Development happens on an **Oracle dev VM** (2 OCPU / 12 GB) via VS Code Remote-SSH; the laptop is too weak for Docker. Prod later gets the other 2 OCPU / 12 GB |
| Git author | Keep `Vishal <vishalrajpurohit02@gmail.com>` |

## Still open (ask the owner)

1. **Domain name** (D-2/D-5): a placeholder `craftoria.in` is used until then. Only needed for Plan 14.
2. **How work reaches GitHub:** PR per task (recommended) or direct merge to `main`.

## Working agreement (how the owner wants us to work)

1. **One task at a time.** Finish it, verify it, commit it, **report to the owner, and wait for "start"** before the next task.
2. **Test-first, strictly** (`test-driven-development` skill): failing test → see it fail → code → see it pass. If it ever slips, say so in the report.
3. **Verify with real exit codes** (`set -o pipefail`; never hide a failure behind `| tail`). Lint, typecheck, test, build and `pnpm format:check` must all exit 0 before committing.
4. **Only the project's skill pack** (`.claude/skills/`), as listed on each task's **Skills:** line.
5. **Never touch `services/cart/`**: the owner writes it.
6. **Never commit to `main`.** One branch per task: `feat/<plan>-<task>-<slug>`.
7. **Spec gaps or bugs found while building:** fix them in `docs/architecture/03-*` (and the affected plans) in the same commit, and mention them in the report.
8. **Reports are plain-language:** what was built, what it means for the product, issues hit, what's next.

## Environment notes

- The tooling pins **TypeScript 5.9** and **ESLint 9** (TS 7 and ESLint 10 break typescript-eslint / jsx-a11y).
- Bundled packages (`contracts`, `service-kit`) use `moduleResolution: Bundler`; services built with `tsc` will use `NodeNext` (`.js` import suffixes).
- `zod` 4, `@asteasolutions/zod-to-openapi` 9, `jose` 6 (EdDSA), Vitest 5, Express 5.
