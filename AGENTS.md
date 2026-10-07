# Handicraft Marketplace — project rules (Antigravity, Cursor, Codex, Claude Code)

Stack: React + Tailwind CSS v4 (frontend), Node.js + TypeScript + Express (services), PostgreSQL, RabbitMQ. pnpm + Turborepo monorepo.

## Always
- Frontend / any visible UI → follow `handcrafted-storefront-ui`, build with `impeccable` (or `frontend-design`), review with `web-design-guidelines` before done.
- Backend / database / payments → follow `safe-backend-changes` first, then the specific skill (`nodejs-backend-patterns`, `postgresql-table-design`, `api-design-principles`, `database-migration`, `auth-implementation-patterns`).
- New feature → `brainstorming` → `writing-plans` → `test-driven-development` → `verification-before-completion` → `requesting-code-review`.
- Bug → `systematic-debugging`. Find the root cause before changing code.

## Commands
Architecture spec: `docs/architecture/` — read `05-engineering-standards.md` before any task. Plans: `docs/superpowers/plans/` (start with `2026-10-07-00-roadmap.md`).

| Purpose | Command |
|---|---|
| Install | `pnpm install` (pnpm 10, Node 24+) |
| Start infra (pg, rabbit, valkey) | `pnpm infra:up` |
| All services in watch mode | `pnpm dev` (turbo) |
| One service | `pnpm --filter @craftoria/order dev` |
| Tests | `pnpm test` / `pnpm test:int` |
| Lint / types | `pnpm lint` / `pnpm typecheck` |
| Format | `pnpm format` |
| Migrate (one service, dev) | `pnpm --filter @craftoria/order migrate` / `migrate:down` |
| Full stack in containers | `pnpm stack:up` / `pnpm stack:down` |
| E2E | `pnpm e2e` |

## Allowed skills (mandatory and exclusive)
Use ONLY the skills in this repo's skill pack (`.claude/skills/` for Claude Code, `.agents/skills/` for Antigravity/Cursor/Codex). Do not use any other skill, plugin or global skill for this project, even if it looks relevant. If something is missing, say so instead of using an outside skill.
- **Frontend** (storefront, console, emails): `handcrafted-storefront-ui` (brand authority, load first for buyer-facing UI) → build with `impeccable` (or `frontend-design`) → `design-taste-frontend` only for landing pages (home, /sell, /about) → `vercel-react-best-practices` for React code → final review with `web-design-guidelines`. `redesign-existing-projects` is not used for v2.
- **Backend** (services, packages, tools, infra): `safe-backend-changes` first, always → `nodejs-backend-patterns`, `architecture-patterns`, `api-design-principles`, `postgresql-table-design`, `database-migration`, `auth-implementation-patterns` (auth work) → `e2e-testing-patterns` for E2E.
- **Workflow** (every task): `using-git-worktrees`, `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`, `receiving-code-review`, `finishing-a-development-branch`; orchestration via `subagent-driven-development` / `executing-plans`; `brainstorming` → `writing-plans` only for features not already planned.
- Every plan task in `docs/superpowers/plans/` has a **Skills:** line: load exactly those. Full table and precedence rules: `docs/architecture/05-engineering-standards.md` §8.

## Hard rules
- Never edit an already-run migration; never drop/rename columns in the same release.
- Money in integer paise. Stock decrements in a transaction.
- No secrets in code. No commits to `main`. Show test output before claiming done.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
