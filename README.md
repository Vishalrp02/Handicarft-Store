# Handicarft-Store

Craftoria v2 — a multi-vendor marketplace for handmade Indian crafts. Artisans apply, list their work and fulfil orders; buyers shop across many artisans in one checkout; the platform takes a commission and pays sellers out.

**Stack:** TypeScript + Express microservices · PostgreSQL · RabbitMQ · React + Tailwind CSS v4 (React Router 7 SSR storefront, Vite console) · Razorpay · pnpm + Turborepo · Docker Compose on Oracle Cloud Always Free + Cloudflare.

## Status
Foundation in progress. The full plan is in [`docs/superpowers/plans/2026-10-07-00-roadmap.md`](docs/superpowers/plans/2026-10-07-00-roadmap.md).

## Docs
| Doc | |
|---|---|
| [Architecture](docs/architecture/README.md) | Services, flows, contracts, data model, engineering standards |
| [Implementation plans](docs/superpowers/plans/) | 15 plans, task by task, for humans and AI agents |
| [Skill pack](docs/skill-pack.md) | The project's AI skills (`.claude/skills`, `.agents/skills`) — the only skills agents may use |

## Getting started
Requirements: Node 24+, pnpm 10, Docker Desktop.

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

Agents and contributors: read [`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md) and [`docs/architecture/05-engineering-standards.md`](docs/architecture/05-engineering-standards.md) first.
