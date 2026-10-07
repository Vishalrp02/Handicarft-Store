# Handicraft platform — AI skill pack

Skills for Claude Code (they also work in Cursor, Codex and other agents that read `SKILL.md`).
Two parts: **human-looking UI/UX** and **safe backend work**, plus two project-specific skills written for this platform.

## Install
Unzip into the root of your project so you get:

```
your-project/
├── CLAUDE.md            ← project rules, tells Claude which skill to use when
└── .claude/skills/...   ← all skills below
```

Start Claude Code in that folder and run `/skills` (or just ask "what skills do you have?") to confirm they loaded.
For global use across all projects, copy `.claude/skills/*` into `~/.claude/skills/` instead.

### Using the same skills in Google Antigravity
The zip also contains `.agents/skills/` (the folder Antigravity reads) and `AGENTS.md` (Antigravity's project rules file — same rules as `CLAUDE.md`).
- Claude Code reads `CLAUDE.md` + `.claude/skills/`; Antigravity reads `AGENTS.md` + `.agents/skills/`.
- Global install for Antigravity: copy `.agents/skills/*` into `~/.gemini/config/skills/`.
- Call a skill explicitly in Antigravity with `/<skill-name>`, e.g. `/impeccable`, `/safe-backend-changes`.
- If you edit a skill or the rules, change both copies (or keep one folder and delete the other if you only use one tool).

**Tip:** for automatic updates of the workflow skills, you can install Superpowers as a plugin instead of using the copies here:
`/plugin marketplace add obra/superpowers-marketplace` then `/plugin install superpowers@superpowers-marketplace`.

## UI/UX — "designed by a human" set
| Skill | Source | Use it for |
|---|---|---|
| `handcrafted-storefront-ui` | written for this project | Brand direction for a handmade-crafts store: palette, type, copy, commerce UX, AI tells to avoid |
| `impeccable` | pbakaus/impeccable (Apache-2.0) | Main design skill. Commands: `/impeccable critique`, `polish`, `typeset`, `layout`, `quieter`, `bolder`, `audit`… |
| `frontend-design` | anthropics/skills | Anthropic's official skill for distinctive, non-templated UI |
| `design-taste-frontend` | Leonxlnx/taste-skill (MIT) | Strict anti-slop rules + pre-flight checklist for landing pages |
| `redesign-existing-projects` | Leonxlnx/taste-skill (MIT) | Upgrading a page that already looks "AI-made" without breaking it |
| `web-design-guidelines` | vercel-labs/agent-skills | Final review of UI code (accessibility, UX rules) — fetches Vercel's latest rules |
| `vercel-react-best-practices` | vercel-labs/agent-skills (MIT) | React performance patterns |

## Backend — "don't destroy the backend" set
| Skill | Source | Use it for |
|---|---|---|
| `safe-backend-changes` | written for this project | Guardrails: layers, migrations, money in paise, stock locking, payments/webhooks, what needs your approval |
| `brainstorming`, `writing-plans`, `executing-plans` | obra/superpowers (MIT) | Design → approved plan → execution, instead of jumping into code |
| `test-driven-development` | obra/superpowers | Failing test first, then minimal code |
| `systematic-debugging` | obra/superpowers | Root-cause debugging, no random edits |
| `verification-before-completion` | obra/superpowers | Must run tests and show proof before saying "done" |
| `requesting-code-review`, `receiving-code-review` | obra/superpowers | Review loop on each change |
| `using-git-worktrees`, `finishing-a-development-branch`, `subagent-driven-development` | obra/superpowers | Isolated branches, clean merges |
| `nodejs-backend-patterns` | wshobson/agents (MIT) | Express structure, middleware, error handling |
| `api-design-principles` | wshobson/agents | REST design, versioning, pagination, errors |
| `architecture-patterns` | wshobson/agents | Clean/hexagonal architecture, layering |
| `postgresql-table-design` | wshobson/agents | Schema, types, constraints, indexes |
| `database-migration` | wshobson/agents | Zero-downtime migrations and rollbacks |
| `auth-implementation-patterns` | wshobson/agents | JWT/session/OAuth, RBAC (buyer / artisan / admin) |
| `e2e-testing-patterns` | wshobson/agents | Playwright/Cypress tests for checkout flows |

## How to prompt
- "Design the product detail page for a hand block-printed kurta. Use handcrafted-storefront-ui and impeccable." → then `/impeccable critique` and `/impeccable polish`.
- "Add a wishlist feature." → Claude brainstorms, writes a plan, waits for your OK, then does TDD.
- "Checkout sometimes charges twice." → `systematic-debugging`.

Each folder keeps its original LICENSE. These are third-party files copied on 2026-10-07; review them before use, as you would any dependency.
